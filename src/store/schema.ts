import type { DatabaseSync } from "node:sqlite";
import { LIST_KEYS } from "../lists.js";

/** Create or migrate every GroupCart table. Safe to run on every startup. */
export function initializeSchema(db: DatabaseSync, householdId: string, budgetCents: number): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      budget_cents INTEGER NOT NULL,
      checked_out_revision INTEGER
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      handle TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      owner_id TEXT NOT NULL REFERENCES members(id),
      participants_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      household_id TEXT NOT NULL REFERENCES households(id),
      revision INTEGER NOT NULL,
      member_id TEXT NOT NULL REFERENCES members(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY(household_id, revision, member_id)
    );
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      reply_text TEXT,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_clarifications (
      member_id TEXT PRIMARY KEY REFERENCES members(id),
      kind TEXT NOT NULL,
      original_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_item_cancellations (
      member_id TEXT PRIMARY KEY REFERENCES members(id),
      item_ids_json TEXT NOT NULL,
      query TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_cart_clears (
      member_id TEXT PRIMARY KEY REFERENCES members(id),
      requested_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_kroger_checkouts (
      household_id TEXT PRIMARY KEY REFERENCES households(id),
      requester_id TEXT NOT NULL REFERENCES members(id),
      revision INTEGER NOT NULL,
      selected_member_id TEXT REFERENCES members(id),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_kroger_replacements (
      household_id TEXT PRIMARY KEY REFERENCES households(id),
      issues_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cart_undo_history (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      actor_id TEXT NOT NULL REFERENCES members(id),
      action TEXT NOT NULL,
      revision_after INTEGER NOT NULL,
      items_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT OR IGNORE INTO households (id, revision, budget_cents) VALUES (?, 0, ?)",
  ).run(householdId, budgetCents);
  ensureCartColumns(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_product_choices (
      member_id TEXT PRIMARY KEY REFERENCES members(id),
      query TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      participant_ids_json TEXT NOT NULL,
      products_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_product_batches (
      member_id TEXT PRIMARY KEY REFERENCES members(id),
      requests_json TEXT NOT NULL,
      results_json TEXT,
      created_at TEXT NOT NULL
    );
    -- A sharing session splits every item any participant adds among all
    -- participants until someone stops it. Ended sessions keep ended_at.
    CREATE TABLE IF NOT EXISTS sharing_sessions (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      participant_ids_json TEXT NOT NULL,
      started_by TEXT NOT NULL REFERENCES members(id),
      started_at TEXT NOT NULL,
      ended_by TEXT REFERENCES members(id),
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sharing_sessions_active ON sharing_sessions(household_id, ended_at);
  `);
  // Per-item sharing was removed; a pending legacy "milk-shared" question now
  // resolves like any other milk clarification (sharing comes from sessions).
  db.prepare("UPDATE pending_clarifications SET kind = 'milk' WHERE kind = 'milk-shared'").run();
  ensureRecurringListTables(db, householdId);
  ensureSplitwiseTable(db);
  ensureGoogleCalendarTables(db);
}

function ensureCartColumns(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(cart_items)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("product_name")) db.exec("ALTER TABLE cart_items ADD COLUMN product_name TEXT");
  if (!columns.has("unit_price_cents")) db.exec("ALTER TABLE cart_items ADD COLUMN unit_price_cents INTEGER");
  if (!columns.has("price_source")) db.exec("ALTER TABLE cart_items ADD COLUMN price_source TEXT");
  if (!columns.has("upc")) db.exec("ALTER TABLE cart_items ADD COLUMN upc TEXT");
}

function ensureRecurringListTables(db: DatabaseSync, householdId: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_lists (
      household_id TEXT NOT NULL REFERENCES households(id),
      list_key TEXT NOT NULL,
      anchor_weekday INTEGER NOT NULL DEFAULT 0,
      anchor_date TEXT,
      day_of_month INTEGER NOT NULL DEFAULT 1,
      active_since TEXT,
      last_loaded_at TEXT,
      last_loaded_by TEXT,
      last_reminded_cycle TEXT,
      reminders_enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (household_id, list_key)
    );
    CREATE TABLE IF NOT EXISTS recurring_list_loads (
      undo_id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      list_key TEXT NOT NULL,
      prev_loaded_at TEXT,
      prev_loaded_by TEXT
    );
    CREATE TABLE IF NOT EXISTS recurring_list_items (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      list_key TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price_cents INTEGER,
      price_source TEXT NOT NULL,
      upc TEXT,
      size TEXT,
      added_by TEXT,
      created_at TEXT NOT NULL,
      quoted_at TEXT,
      UNIQUE (household_id, list_key, product_id)
    );
    CREATE TABLE IF NOT EXISTS pending_list_selections (
      member_id TEXT PRIMARY KEY REFERENCES members(id),
      list_key TEXT NOT NULL,
      requests_json TEXT NOT NULL,
      results_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_list_clears (
      member_id TEXT PRIMARY KEY REFERENCES members(id),
      list_key TEXT NOT NULL,
      list_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare("INSERT OR IGNORE INTO recurring_lists (household_id, list_key) VALUES (?, ?)");
  for (const key of LIST_KEYS) insert.run(householdId, key);
}

/** Splitwise expense log: one row per completed checkout (see src/store/splitwiseLog.ts). */
function ensureSplitwiseTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS splitwise_expenses (
      checkout_key TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      payer_member_id TEXT,
      payer_name TEXT,
      total_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      shares_json TEXT NOT NULL,
      request_json TEXT,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      note TEXT,
      expense_id TEXT,
      expense_url TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS splitwise_expenses_household_revision ON splitwise_expenses (household_id, revision);
  `);
}

/**
 * Google Calendar free/busy connections (see src/store/googleCalendarAccounts.ts). Refresh tokens stay in
 * this local SQLite file and are never returned by any dashboard API.
 */
function ensureGoogleCalendarTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_calendar_accounts (
      member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      refresh_token TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected',
      last_error TEXT,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
