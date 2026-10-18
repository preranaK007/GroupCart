import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CATALOG,
  extractCartRequests,
  isGenericMilkRequest,
  money,
  resolveMilkChoice,
  unsupportedBrandedRequest,
  type Product,
} from "./cart.js";
import type { KrogerCartAvailabilityIssue, KrogerProduct } from "./kroger.js";
import {
  LIST_COMMAND_NAMES,
  LIST_KEYS,
  LIST_LABELS,
  LIST_TITLES,
  addLocalDays,
  currentCycleStart,
  describeSchedule,
  friendlyDate,
  localDateKey,
  nextCycleStart,
  nextWeekdayAfter,
  parseListCommand,
  type ListCommand,
  type ListKey,
  type ListSchedule,
} from "./lists.js";

/** Exact cart commands; anything matching is never treated as a product search. */
const CART_COMMAND_PATTERN = /^(cart|show cart|review cart|dashboard|open dashboard|cart page|approve|approve cart|confirm cart|checkout|finish checkout|cancel checkout|clear mine|clear my items|clear my stuff|clear my groceries|clear everything for me|clear all|clear everything|clear cart|clear entire cart|empty cart|clear shared list|clear entire shared list|confirm clear all|cancel clear all|yes clear all|undo|undo last|revert|revert last change)$/i;
const PRICE_LIMIT_PATTERN = /\b(?:under|below|less than|at most|no more than|up to)\s+\$?\s*\d+(?:\.\d{1,2})?\s*(?:dollars?)?\b/gi;

type ListRow = {
  list_key: ListKey;
  anchor_weekday: number;
  anchor_date: string | null;
  day_of_month: number;
  active_since: string | null;
  last_loaded_at: string | null;
  last_loaded_by: string | null;
  last_reminded_cycle: string | null;
  reminders_enabled: number;
  revision: number;
};
type ListItemRow = {
  id: string;
  list_key: ListKey;
  product_id: string;
  product_name: string | null;
  quantity: number;
  unit_price_cents: number | null;
  price_source: string;
  upc: string | null;
  size: string | null;
  added_by: string | null;
  created_at: string;
  quoted_at: string | null;
};
type ListRequest = { query: string; quantity: number; maxPriceCents?: number; maxPriceInclusive?: boolean };
type PendingListSelection = { listKey: ListKey; requests: ListRequest[]; results: BatchProductResult[] | null };
type ListDueInfo = {
  cycleStart: Date;
  cycleKey: string;
  loadedThisCycle: boolean;
  dueNow: boolean;
  shouldRemind: boolean;
  nextReminderAt: Date | null;
};
type ProductQuote = { product: KrogerProduct | null; error?: string };

export type ProductQuoter = (productId: string) => Promise<KrogerProduct | null>;
export type ListReminderClaim = {
  text: string;
  claims: Array<{ listKey: ListKey; cycleKey: string; previous: string | null }>;
};
export type RecurringListSnapshot = {
  key: ListKey;
  title: string;
  command: string;
  schedule: string;
  active: boolean;
  remindersEnabled: boolean;
  dueNow: boolean;
  nextReminderAt: string | null;
  lastLoadedAt: string | null;
  lastLoadedByName: string | null;
  estimatedCents: number;
  items: Array<{ id: string; name: string; quantity: number; unitPriceCents: number | null; priceSource: "sample" | "kroger"; size: string | null; quotedAt: string | null }>;
};
export type CartStoreOptions = {
  /** Injectable clock for recurring-list cadence (tests); defaults to the real time. */
  now?: () => Date;
  /** Local hour (0-23) on a cycle's start day after which a due list is announced. */
  reminderHour?: number;
};

export type MemberConfig = { handle: string; name: string };
export type Member = { id: string; handle: string; name: string };
type ItemRow = {
  id: string;
  product_id: string;
  quantity: number;
  owner_id: string;
  participants_json: string;
  product_name: string | null;
  unit_price_cents: number | null;
  price_source: string | null;
  upc: string | null;
};

type PendingRetailerChoice = {
  query: string;
  quantity: number;
  products: KrogerProduct[];
};

type BatchRequest = {
  query: string;
  quantity: number;
  maxPriceCents?: number;
  maxPriceInclusive?: boolean;
};
type BatchProductResult = { total: number; products: KrogerProduct[] };
type SharingSession = { id: string; participantIds: string[]; startedBy: string; startedAt: string };

export type CartSnapshot = {
  householdId: string;
  revision: number;
  budgetCents: number;
  totalCents: number;
  items: Array<{
    id: string;
    productId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    priceSource: "sample" | "kroger";
    upc: string | null;
    ownerId: string;
    ownerName: string;
    participantIds: string[];
    participantNames: string[];
  }>;
  members: Array<{ id: string; name: string; handle: string; shareCents: number; approved: boolean }>;
  sharingSessions: Array<{ id: string; participantIds: string[]; participantNames: string[]; startedAt: string }>;
  checkedOutRevision: number | null;
};

export class CartStore {
  readonly #db: DatabaseSync;
  readonly #householdId: string;
  readonly #dashboardUrl: string;
  readonly #krogerCartEnabled: boolean;
  readonly #now: () => Date;
  readonly #reminderHour: number;

  constructor(
    databasePath: string,
    householdId: string,
    budgetCents: number,
    dashboardUrl = "http://127.0.0.1:3000",
    krogerCartEnabled = false,
    options: CartStoreOptions = {},
  ) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.#db = new DatabaseSync(absolutePath);
    this.#householdId = householdId;
    this.#dashboardUrl = dashboardUrl;
    this.#krogerCartEnabled = krogerCartEnabled;
    this.#now = options.now ?? (() => new Date());
    this.#reminderHour = Number.isInteger(options.reminderHour) && options.reminderHour! >= 0 && options.reminderHour! <= 23
      ? options.reminderHour!
      : 9;
    this.#db.exec(`
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
    this.#db.prepare(
      "INSERT OR IGNORE INTO households (id, revision, budget_cents) VALUES (?, 0, ?)",
    ).run(householdId, budgetCents);
    this.#ensureCartColumns();
    this.#db.exec(`
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
    this.#db.prepare("UPDATE pending_clarifications SET kind = 'milk' WHERE kind = 'milk-shared'").run();
    this.#ensureRecurringListTables();
  }

  registerMembers(configuredMembers: MemberConfig[]): Member[] {
    const insert = this.#db.prepare(
      "INSERT INTO members (id, household_id, handle, name) VALUES (?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET name = excluded.name",
    );
    for (const member of configuredMembers) {
      insert.run(this.memberId(member.handle), this.#householdId, member.handle, member.name);
    }
    return this.getMembers();
  }

  getMembers(): Member[] {
    return this.#db.prepare(
      "SELECT id, handle, name FROM members WHERE household_id = ? ORDER BY name COLLATE NOCASE",
    ).all(this.#householdId) as Member[];
  }

  memberForHandle(handle: string): Member | undefined {
    return this.#db.prepare(
      "SELECT id, handle, name FROM members WHERE household_id = ? AND handle = ?",
    ).get(this.#householdId, handle) as Member | undefined;
  }

  processIncomingText(messageId: string, memberId: string, text: string): string | null {
    const existing = this.#db.prepare(
      "SELECT reply_text FROM processed_messages WHERE message_id = ?",
    ).get(messageId) as { reply_text: string | null } | undefined;
    if (existing) return existing.reply_text;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const normalized = text.trim();
      let reply: string | null;
      const sharingCommand = this.#parseSharingCommand(normalized);
      const listReply = sharingCommand ? undefined : this.#catalogListTurn(memberId, normalized);

      if (sharingCommand) {
        reply = sharingCommand.action === "start"
          ? this.#startSharing(memberId, sharingCommand.names)
          : this.#stopSharing(memberId, sharingCommand.names);
      } else if (listReply !== undefined) {
        reply = listReply;
      } else if (/^(dashboard|open dashboard|cart page)$/i.test(normalized)) {
        reply = this.#dashboardMessage();
      } else if (this.#isHelpRequest(normalized)) {
        reply = this.#helpMessage();
      } else if (/^(cart|show cart|review cart)$/i.test(normalized)) {
        reply = this.formatSummary(memberId);
      } else if (/^(clear mine|clear my items|clear my stuff|clear my groceries|clear everything for me)$/i.test(normalized)) {
        reply = this.#clearMemberItems(memberId);
      } else if (/^(clear all|clear everything|clear cart|clear entire cart|empty cart|clear shared list|clear entire shared list)$/i.test(normalized)) {
        reply = this.#requestClearAll(memberId);
      } else if (/^(confirm clear all|yes,? clear all)$/i.test(normalized) || (/^yes$/i.test(normalized) && this.#hasPendingClearAll(memberId))) {
        reply = this.#confirmClearAll(memberId);
      } else if (/^(cancel clear all|cancel)$/i.test(normalized) && this.#hasPendingClearAll(memberId)) {
        this.#db.prepare("DELETE FROM pending_cart_clears WHERE member_id = ?").run(memberId);
        reply = "Okay, I left the shared cart unchanged.";
      } else if (/^(undo|undo last|revert|revert last change)$/i.test(normalized)) {
        reply = this.#undoLastCartChange(memberId);
      } else if (/^(approve|approve cart|confirm cart)$/i.test(normalized)) {
        reply = this.#approveCurrentRevision(memberId);
      } else if (/^(checkout|finish checkout)$/i.test(normalized)) {
        reply = this.#completeMockCheckout();
      } else {
        const pending = this.#db.prepare(
          "SELECT kind, original_text FROM pending_clarifications WHERE member_id = ?",
        ).get(memberId) as { kind: string; original_text: string } | undefined;
        if (pending?.kind === "milk") {
          if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
            this.#clearClarification(memberId);
            reply = "Okay, I didn’t add any milk.";
          } else if (unsupportedBrandedRequest(normalized)) {
            const productName = unsupportedBrandedRequest(normalized)!;
            this.#clearClarification(memberId);
            reply = `I heard “${productName}”, but live product lookup isn’t connected yet. I didn’t add a substitute or invent a live price.`;
          } else {
            const product = resolveMilkChoice(normalized);
            if (!product) {
              reply = "Which kind? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond milk. You can also say “cancel”. After you choose, I’ll look up matching store products if live search is configured.";
            } else {
              this.#clearClarification(memberId);
              const companionRequests = extractCartRequests(pending.original_text);
              const requests = [{ product, quantity: 1 }, ...companionRequests];
              const participantIds = this.#addRequests(memberId, requests);
              reply = this.formatSummary(memberId, requests.map(({ product: added }) => added.name), participantIds);
            }
          }
        } else if (unsupportedBrandedRequest(normalized)) {
          const productName = unsupportedBrandedRequest(normalized)!;
          reply = `I heard “${productName}”, but live product lookup isn’t connected yet. I didn’t substitute generic eggs or a made-up live price. Reply “generic eggs” to add the sample catalog item, or leave it for now.`;
        } else if (isGenericMilkRequest(normalized)) {
          this.#db.prepare(
            "INSERT INTO pending_clarifications (member_id, kind, original_text, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET kind = excluded.kind, original_text = excluded.original_text, created_at = excluded.created_at",
          ).run(memberId, "milk", normalized, new Date().toISOString());
          reply = "What kind of milk? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond. You can also type the kind you want, and I’ll look up matching store products.";
        } else {
          const requests = extractCartRequests(normalized);
          if (requests.length === 0) {
            reply = `I couldn’t match that to our sample catalog. Try milk, oat milk, eggs, bananas, pasta, tomato sauce, parmesan, bread, apples, or peanut butter. Text “help” to see examples and commands, or “cart” to review your basket.`;
          } else {
            const participantIds = this.#addRequests(memberId, requests);
            reply = `${this.formatSummary(memberId, requests.map(({ product }) => product.name), participantIds)}${this.#legacyShareHint(normalized, memberId)}`;
          }
        }
      }

      this.#db.prepare(
        "INSERT INTO processed_messages (message_id, reply_text, processed_at) VALUES (?, ?, ?)",
      ).run(messageId, reply, new Date().toISOString());
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async processLiveIncomingText(
    messageId: string,
    memberId: string,
    text: string,
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
    allowKrogerCartCheckout = false,
    checkCartAvailability?: (items: Array<{ id: string; name: string; upc: string; quantity: number }>) => Promise<KrogerCartAvailabilityIssue[]>,
    quoteProduct?: ProductQuoter,
  ): Promise<string | null> {
    const existing = this.#existingReply(messageId);
    if (existing !== undefined) return existing;

    const normalized = text.trim();
    // Sharing-session commands never touch the cart or Kroger, so they are
    // handled before any pending checkout, choice, list, or clarification state.
    if (this.#parseSharingCommand(normalized)) return this.processIncomingText(messageId, memberId, normalized);
    const listCommand = this.#listCommandFor(memberId, normalized);
    const isCommand = CART_COMMAND_PATTERN.test(normalized)
      || this.#isHelpRequest(normalized)
      || (/^yes$/i.test(normalized) && this.#hasPendingClearAll(memberId))
      || listCommand !== undefined;
    if (/^(checkout|finish checkout)$/i.test(normalized)) {
      if (!allowKrogerCartCheckout) return this.processIncomingText(messageId, memberId, normalized);
      return this.#startKrogerCheckout(messageId, memberId, locationId, checkCartAvailability);
    }
    if (/^cancel checkout$/i.test(normalized)) {
      return this.#cancelKrogerCheckout(messageId, memberId);
    }
    const pendingKrogerCheckout = this.#getPendingKrogerCheckout();
    // Recurring-list commands that do not touch the cart stay available while a
    // Kroger checkout is in progress; loading a list into the cart does not.
    const listOnlyCommand = listCommand !== undefined && listCommand.kind !== "load";
    if (pendingKrogerCheckout?.status === "adding") {
      if (!/^(cart|show cart|review cart|help|commands|hi|hello|hey|dashboard|open dashboard|cart page)$/i.test(normalized) && !listOnlyCommand) {
        const reply = "GroupCart is sending the approved list to Kroger right now. Please wait for the result before changing the cart.";
        this.#saveMessageReply(messageId, reply);
        return reply;
      }
    }
    if (pendingKrogerCheckout && pendingKrogerCheckout.requesterId === memberId
      && (pendingKrogerCheckout.status === "choosing_account" || pendingKrogerCheckout.status === "awaiting_oauth")
      && !isCommand) {
      return this.#handleKrogerAccountChoice(messageId, memberId, normalized, pendingKrogerCheckout);
    }
    if (pendingKrogerCheckout?.status === "replacement_review") {
      const selection = normalized.match(/^replace\s+(\d{1,2})\s+with\s+(\d{1,2})$/i);
      if (selection) return this.#handleKrogerReplacementChoice(messageId, memberId, Number(selection[1]), Number(selection[2]));
      if (!/^(cart|show cart|review cart|help|commands|hi|hello|hey|dashboard|open dashboard|cart page)$/i.test(normalized) && !listOnlyCommand) {
        const reply = "Kroger’s precheck found unavailable items. Choose a suggested option with “replace 1 with 2”, or text “cancel checkout” to leave GroupCart unchanged and manage the item yourself. No replacement is made unless you choose one.";
        return this.#saveAndReturnReply(messageId, reply);
      }
    }
    if (pendingKrogerCheckout && pendingKrogerCheckout.requesterId !== memberId
      && /^(\d+|cancel)$/i.test(normalized)) {
      const requester = this.getMembers().find((member) => member.id === pendingKrogerCheckout.requesterId)?.name ?? "the member who requested checkout";
      const reply = `Please have ${requester} finish the Kroger account selection, or ask them to text “cancel checkout”.`;
      this.#saveMessageReply(messageId, reply);
      return reply;
    }

    // Recurring household lists (weekly / biweekly / monthly). Kept in their own
    // section so the cart flows below are unchanged.
    if (listCommand) {
      return this.#handleLiveListCommand(messageId, memberId, listCommand, searchProducts, locationId, quoteProduct);
    }
    const pendingListSelection = this.#pendingListSelection(memberId);
    if (pendingListSelection && !isCommand) {
      if (this.#cancellationQuery(normalized)) {
        // A cart removal request supersedes an unfinished list selection, the
        // same way it supersedes an unfinished cart product choice.
        this.#db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
      } else {
        return this.#continueLiveListSelection(messageId, memberId, normalized, pendingListSelection, searchProducts, locationId);
      }
    }

    const pendingCancellation = this.#db.prepare(
      "SELECT item_ids_json, query FROM pending_item_cancellations WHERE member_id = ?",
    ).get(memberId) as { item_ids_json: string; query: string } | undefined;
    const cancellationQuery = this.#cancellationQuery(normalized);

    // Handle cancel intents before pending product choices or Kroger search. A
    // sentence like “I don't want bread anymore” is a cart change, not a query.
    if (cancellationQuery) {
      return this.#startItemCancellation(messageId, memberId, cancellationQuery);
    }

    if (pendingCancellation && !isCommand) {
      if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          this.#db.prepare("DELETE FROM pending_item_cancellations WHERE member_id = ?").run(memberId);
          const reply = "Okay, I left the cart unchanged.";
          this.#recordReply(messageId, reply);
          this.#db.exec("COMMIT");
          return reply;
        } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
      }
      const selection = normalized.match(/^\s*(\d{1,2})\s*$/);
      const itemIds = JSON.parse(pendingCancellation.item_ids_json) as string[];
      const index = Number(selection?.[1]) - 1;
      if (!selection || index < 0 || index >= itemIds.length) {
        return `Please reply with a number from 1 to ${itemIds.length}, or “cancel”. Nothing has been removed yet.`;
      }
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.prepare("DELETE FROM pending_item_cancellations WHERE member_id = ?").run(memberId);
        const result = this.#removeParticipant(itemIds[index]!, memberId);
        const reply = `${result}\n${this.formatSummary(memberId)}`;
        this.#recordReply(messageId, reply);
        this.#db.exec("COMMIT");
        return reply;
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }

    const pendingBatchRow = this.#db.prepare(
      "SELECT requests_json, results_json FROM pending_product_batches WHERE member_id = ?",
    ).get(memberId) as { requests_json: string; results_json: string | null } | undefined;
    if (pendingBatchRow && !isCommand) {
      if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          this.#db.prepare("DELETE FROM pending_product_batches WHERE member_id = ?").run(memberId);
          const reply = "Cancelled the multi-item search; nothing was added.";
          this.#recordReply(messageId, reply);
          this.#db.exec("COMMIT");
          return reply;
        } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
      }
      const requests = JSON.parse(pendingBatchRow.requests_json) as BatchRequest[];
      if (!pendingBatchRow.results_json) {
        const milkChoice = this.#milkSearchQuery(normalized);
        if (!milkChoice) {
          const reply = "Which kind of milk? Reply whole, 2%, oat, or almond, and I’ll continue searching the rest of your list. Or say “cancel”.";
          this.#saveMessageReply(messageId, reply);
          return reply;
        }
        const milkRequest = requests.find((request) => isGenericMilkRequest(request.query));
        if (!milkRequest) {
          const reply = "I lost the pending multi-item search. Please send your item list again.";
          this.#saveMessageReply(messageId, reply);
          return reply;
        }
        milkRequest.query = milkChoice;
        return this.#searchBatchAndPrompt(messageId, memberId, requests, searchProducts, locationId);
      }
      const results = JSON.parse(pendingBatchRow.results_json) as BatchProductResult[];
      const numbers = normalized.match(/^\s*\d+(?:\s*(?:,|\s)\s*\d+)*\s*$/)?.[0].trim().split(/[\s,]+/).map(Number);
      if (!numbers || numbers.length !== requests.length || numbers.some((number, index) => !Number.isInteger(number) || number < 1 || number > (results[index]?.products.length ?? 0))) {
        const reply = `Reply with one result number for each item, in order (for example “1, 2, 1”), or “cancel”. Nothing has been added yet.`;
        this.#saveMessageReply(messageId, reply);
        return reply;
      }
      return this.#addBatchSelections(messageId, memberId, requests, results, numbers);
    }

    if (!isCommand) {
      const batchRequests = this.#multiItemRequests(normalized);
      if (batchRequests.length > 1) {
        if (batchRequests.length > 5) {
          const reply = "I can search up to 5 grocery items from one message. Nothing was added; split the list into smaller batches or text “help”.";
          this.#saveMessageReply(messageId, reply);
          return reply;
        }
        const genericMilk = batchRequests.some((request) => isGenericMilkRequest(request.query));
        if (genericMilk) {
          this.#db.exec("BEGIN IMMEDIATE");
          try {
            this.#db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
            this.#db.prepare("INSERT INTO pending_product_batches (member_id, requests_json, results_json, created_at) VALUES (?, ?, NULL, ?) ON CONFLICT(member_id) DO UPDATE SET requests_json = excluded.requests_json, results_json = NULL, created_at = excluded.created_at")
              .run(memberId, JSON.stringify(batchRequests), new Date().toISOString());
            const reply = "I’ll look up the items together. First, which kind of milk? Reply whole, 2%, oat, or almond; then I’ll show choices for the full list. Or say “cancel”.";
            this.#recordReply(messageId, reply);
            this.#db.exec("COMMIT");
            return reply;
          } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
        }
        return this.#searchBatchAndPrompt(messageId, memberId, batchRequests, searchProducts, locationId, normalized);
      }
    }

    const pendingChoiceRow = this.#db.prepare(
      "SELECT query, quantity, products_json FROM pending_product_choices WHERE member_id = ?",
    ).get(memberId) as {
      query: string;
      quantity: number;
      products_json: string;
    } | undefined;
    if (pendingChoiceRow && !isCommand) {
      if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          this.#db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
          this.#recordReply(messageId, "Cancelled that product selection; nothing was added.");
          this.#db.exec("COMMIT");
          return "Cancelled that product selection; nothing was added.";
        } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
      }
      const pending: PendingRetailerChoice = {
        query: pendingChoiceRow.query,
        quantity: pendingChoiceRow.quantity,
        products: JSON.parse(pendingChoiceRow.products_json) as KrogerProduct[],
      };
      const selection = normalized.match(/^\s*(\d{1,2})\s*$/);
      const index = Number(selection?.[1]) - 1;
      if (!selection || index < 0 || index >= pending.products.length) {
        return `Please reply with a number from 1 to ${pending.products.length}, or “cancel”. I’m still waiting for you to choose a product.`;
      }
      const chosen = pending.products[index]!;
      const priceCents = this.#currentPrice(chosen);
      if (priceCents === null) {
        return `Kroger didn’t return a price for ${chosen.description} at the configured store, so I didn’t add it. Choose another numbered option or set a store with local pricing.`;
      }
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
        const undoSnapshot = this.#captureCartItems();
        const itemId = `kroger:${chosen.productId}`;
        // Sharing is decided when the item is actually added: whatever session
        // the sender is in at choice time, not at search time.
        const participantIds = this.#participantsFor(memberId);
        this.#db.prepare(
          "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          randomUUID(), this.#householdId, itemId, pending.quantity, memberId,
          JSON.stringify(participantIds), new Date().toISOString(), chosen.description,
          priceCents, "kroger", chosen.upc,
        );
        this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
          .run(this.#householdId);
        this.#recordUndo(memberId, `add ${chosen.description}`, undoSnapshot);
        const reply = `Added ${chosen.description} ${this.#assignmentPhrase(participantIds)} at ${money(priceCents)}${chosen.size ? ` (${chosen.size})` : ""}.\n${this.formatSummary(memberId)}`;
        this.#recordReply(messageId, reply);
        this.#db.exec("COMMIT");
        return reply;
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }

    if (isCommand || /^(cancel|never mind|nevermind)$/i.test(normalized)) {
      return this.processIncomingText(messageId, memberId, normalized);
    }

    const pendingMilk = this.#db.prepare(
      "SELECT kind, original_text FROM pending_clarifications WHERE member_id = ?",
    ).get(memberId) as { kind: string; original_text: string } | undefined;
    let query: string | undefined;
    let contextText = normalized;
    let quantity = 1;
    let maxPriceCents: number | undefined;
    let maxPriceInclusive = false;

    if (pendingMilk?.kind === "milk") {
      if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
        return this.processIncomingText(messageId, memberId, normalized);
      }
      const milkChoice = this.#milkSearchQuery(normalized);
      if (!milkChoice) {
        return this.processIncomingText(messageId, memberId, normalized);
      }
      query = milkChoice;
      contextText = pendingMilk.original_text;
      quantity = this.#quantityFromText(pendingMilk.original_text);
      const priceLimit = this.#priceLimit(pendingMilk.original_text);
      maxPriceCents = priceLimit?.cents;
      maxPriceInclusive = priceLimit?.inclusive ?? false;
    } else if (isGenericMilkRequest(normalized)) {
      if (extractCartRequests(normalized).length > 0) {
        const reply = "I couldn’t separate those items safely. Send a clear comma-separated list (for example “milk, bread, eggs”), and I’ll search them together. For milk by itself, I’ll ask which kind.";
        this.#saveMessageReply(messageId, reply);
        return reply;
      }
      return this.processIncomingText(messageId, memberId, normalized);
    } else {
      const requests = extractCartRequests(normalized);
      if (requests.length > 1) {
        const reply = "I couldn’t separate those items safely. Send a clear comma-separated list (for example “milk, bread, eggs”). I haven’t added anything.";
        this.#saveMessageReply(messageId, reply);
        return reply;
      }
      query = this.#retailerQuery(normalized);
      quantity = requests[0]?.quantity ?? this.#quantityFromText(normalized);
      const priceLimit = this.#priceLimit(normalized);
      maxPriceCents = priceLimit?.cents;
      maxPriceInclusive = priceLimit?.inclusive ?? false;
    }

    // A bare number list (e.g. a stray “1, 1” with nothing pending) is not a product search.
    if (!query || query.length < 2 || !/\p{L}/u.test(query)) return this.processIncomingText(messageId, memberId, normalized);

    let result: { total: number; products: KrogerProduct[] };
    try {
      result = await searchProducts(query);
    } catch (error) {
      const reply = `I couldn’t reach Kroger’s product search just now (${error instanceof Error ? error.message : "request failed"}). Nothing was added; please try again in a moment. Text “help” for available actions.`;
      this.#saveMessageReply(messageId, reply);
      return reply;
    }

    const matchingProducts = result.products.filter((product) => this.#meetsPriceLimit(product, maxPriceCents, maxPriceInclusive));
    const products = matchingProducts.slice(0, 5);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (pendingMilk) this.#clearClarification(memberId);
      if (!products.length) {
        const cap = maxPriceCents === undefined ? "" : ` within your ${maxPriceInclusive ? "up-to" : "under"} ${money(maxPriceCents)} item budget`;
        const reply = `I couldn’t find matching products${cap} at the configured Kroger-family store for “${query}”. Try a different description or raise the item budget. Nothing was added. Text “help” for examples and available actions.`;
        this.#recordReply(messageId, reply);
        this.#db.exec("COMMIT");
        return reply;
      }

      // participant_ids_json is an informational snapshot only; the add uses
      // the sender's sharing session at the moment they pick a number.
      const participantIds = this.#participantsFor(memberId);
      this.#db.prepare(
        "INSERT INTO pending_product_choices (member_id, query, quantity, participant_ids_json, products_json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET query = excluded.query, quantity = excluded.quantity, participant_ids_json = excluded.participant_ids_json, products_json = excluded.products_json, created_at = excluded.created_at",
      ).run(memberId, query, quantity, JSON.stringify(participantIds), JSON.stringify(products), new Date().toISOString());
      const lines = products.map((product, index) => {
        const currentPrice = this.#currentPrice(product);
        const price = currentPrice === null ? "price unavailable" : money(currentPrice);
        const sale = this.#isCurrentPromo(product) && product.regularPriceCents !== null && product.promoPriceCents !== null && product.promoPriceCents < product.regularPriceCents
          ? ` (regular ${money(product.regularPriceCents)}${product.promoExpiresAt && !product.promoExpiresAt.startsWith("9999") ? `; sale ends ${product.promoExpiresAt.slice(0, 10)}` : ""})` : "";
        return `${index + 1}) ${product.description}${product.size ? ` · ${product.size}` : ""} — ${price}${sale}`;
      });
      const storeNote = locationId ? ` at the selected Kroger store (${locationId})` : "; choose a store to get local prices";
      const cap = maxPriceCents === undefined ? "" : ` (showing options ${maxPriceInclusive ? "up to" : "under"} ${money(maxPriceCents)} each)`;
      const reply = `Kroger found ${products.length} matching options${cap} for “${query}”${storeNote}:\n${lines.join("\n")}\nReply 1-${products.length} to add your choice to GroupCart, or “cancel”.${this.#sharingNote(participantIds)}${this.#legacyShareHint(contextText, memberId)}`;
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  approveForMember(memberId: string): { ok: boolean; message: string } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#approveCurrentRevision(memberId);
      const ok = !result.startsWith("There isn’t a cart") && !result.startsWith("That member");
      this.#db.exec("COMMIT");
      return { ok, message: result };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  completeMockCheckout(): { ok: boolean; message: string } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#completeMockCheckout();
      const ok = result.startsWith("Mock checkout complete");
      this.#db.exec("COMMIT");
      return { ok, message: result };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  pendingKrogerCheckout(): { requesterId: string; revision: number; selectedMemberId: string | null; status: string } | undefined {
    return this.#getPendingKrogerCheckout();
  }

  async completeKrogerCartCheckout(
    memberId: string,
    addItemsToCart: (items: Array<{ upc: string; quantity: number }>) => Promise<void>,
  ): Promise<{ ok: boolean; message: string }> {
    this.#db.exec("BEGIN IMMEDIATE");
    let snapshot: CartSnapshot;
    try {
      const pending = this.#getPendingKrogerCheckout();
      if (!pending || pending.status !== "awaiting_oauth" || pending.selectedMemberId !== memberId) {
        this.#db.exec("ROLLBACK");
        return { ok: false, message: "This Kroger authorization no longer matches the pending checkout. Text “checkout” in the group to start again." };
      }
      snapshot = this.snapshot();
      if (!snapshot.items.length || snapshot.revision !== pending.revision || snapshot.members.some((member) => !member.approved)) {
        this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.#householdId);
        this.#db.exec("COMMIT");
        return { ok: false, message: "The cart changed or approvals expired while Kroger sign-in was open. The Kroger cart was not changed; review GroupCart and get fresh approvals." };
      }
      const missingUpc = snapshot.items.find((item) => !item.upc);
      if (missingUpc) {
        this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.#householdId);
        this.#db.exec("COMMIT");
        return { ok: false, message: `“${missingUpc.name}” has no Kroger UPC, so I did not send any items. Replace sample items with selected Kroger products and try again.` };
      }
      this.#db.prepare("UPDATE pending_kroger_checkouts SET status = 'adding' WHERE household_id = ?").run(this.#householdId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    try {
      await addItemsToCart(snapshot.items.map((item) => ({ upc: item.upc!, quantity: item.quantity })));
    } catch (error) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.#householdId);
        this.#db.exec("COMMIT");
      } catch (dbError) { this.#db.exec("ROLLBACK"); throw dbError; }
      const detail = error instanceof Error ? error.message : "Kroger request failed.";
      return { ok: false, message: `Kroger did not confirm adding the items (${detail}). GroupCart is unchanged. Check your Kroger cart before trying again, in case Kroger received the request but the response was lost.` };
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.snapshot();
      if (current.revision !== snapshot.revision) {
        this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.#householdId);
        this.#db.exec("COMMIT");
        return { ok: false, message: "The approved items were sent to Kroger, but GroupCart changed during the transfer. I left the current GroupCart untouched; review both carts before trying again." };
      }
      const accountName = this.getMembers().find((member) => member.id === memberId)?.name ?? "the selected member";
      this.#db.prepare("DELETE FROM cart_items WHERE household_id = ?").run(this.#householdId);
      this.#clearPendingCartIntents();
      this.#db.prepare("DELETE FROM cart_undo_history WHERE household_id = ?").run(this.#householdId);
      this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = ? WHERE id = ?")
        .run(snapshot.revision, this.#householdId);
      this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.#householdId);
      this.#db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.#householdId);
      const message = `Added ${snapshot.items.length} item${snapshot.items.length === 1 ? "" : "s"} to ${accountName}’s Kroger cart. No order was placed or payment charged. Open Kroger to review the cart and finish checkout there.`;
      this.#db.exec("COMMIT");
      return { ok: true, message };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot(): CartSnapshot {
    const household = this.#db.prepare(
      "SELECT revision, budget_cents, checked_out_revision FROM households WHERE id = ?",
    ).get(this.#householdId) as { revision: number; budget_cents: number; checked_out_revision: number | null };
    const members = this.getMembers();
    const products = new Map(CATALOG.map((product) => [product.id, product]));
    const memberNames = new Map(members.map((member) => [member.id, member.name]));
    const rows = this.#db.prepare(
      "SELECT id, product_id, quantity, owner_id, participants_json, product_name, unit_price_cents, price_source, upc FROM cart_items WHERE household_id = ? ORDER BY created_at, id",
    ).all(this.#householdId) as ItemRow[];
    const shares = new Map(members.map((member) => [member.id, 0]));
    let totalCents = 0;
    const items = rows.flatMap((row) => {
      const product = products.get(row.product_id);
      const productName = row.product_name ?? product?.name;
      const unitPriceCents = row.unit_price_cents ?? product?.priceCents;
      if (!productName || unitPriceCents === undefined) return [];
      const itemTotal = unitPriceCents * row.quantity;
      totalCents += itemTotal;
      const participantIds = JSON.parse(row.participants_json) as string[];
      this.#split(itemTotal, participantIds).forEach((amount, id) => {
        shares.set(id, (shares.get(id) ?? 0) + amount);
      });
      return [{
        id: row.id,
        productId: row.product_id,
        name: productName,
        quantity: row.quantity,
        unitPriceCents,
        totalCents: itemTotal,
        priceSource: row.price_source === "kroger" ? "kroger" as const : "sample" as const,
        upc: row.upc,
        ownerId: row.owner_id,
        ownerName: memberNames.get(row.owner_id) ?? "Member",
        participantIds,
        participantNames: participantIds.map((id) => memberNames.get(id) ?? "Member")
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
      }];
    });
    const approved = new Set((this.#db.prepare(
      "SELECT member_id FROM approvals WHERE household_id = ? AND revision = ?",
    ).all(this.#householdId, household.revision) as Array<{ member_id: string }>).map((row) => row.member_id));

    return {
      householdId: this.#householdId,
      revision: household.revision,
      budgetCents: household.budget_cents,
      totalCents,
      items,
      members: members.map((member) => ({
        ...member,
        shareCents: shares.get(member.id) ?? 0,
        approved: approved.has(member.id),
      })),
      sharingSessions: this.#activeSessions().map((session) => ({
        id: session.id,
        participantIds: session.participantIds,
        participantNames: session.participantIds.map((id) => memberNames.get(id) ?? "Member")
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
        startedAt: session.startedAt,
      })),
      checkedOutRevision: household.checked_out_revision,
    };
  }

  getCursor(): number {
    const row = this.#db.prepare("SELECT value FROM app_state WHERE key = 'photon_cursor'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  saveCursor(cursor: number): void {
    this.#db.prepare(
      "INSERT INTO app_state (key, value) VALUES ('photon_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(cursor));
  }

  close(): void {
    this.#db.close();
  }

  #ensureCartColumns(): void {
    const columns = new Set((this.#db.prepare("PRAGMA table_info(cart_items)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("product_name")) this.#db.exec("ALTER TABLE cart_items ADD COLUMN product_name TEXT");
    if (!columns.has("unit_price_cents")) this.#db.exec("ALTER TABLE cart_items ADD COLUMN unit_price_cents INTEGER");
    if (!columns.has("price_source")) this.#db.exec("ALTER TABLE cart_items ADD COLUMN price_source TEXT");
    if (!columns.has("upc")) this.#db.exec("ALTER TABLE cart_items ADD COLUMN upc TEXT");
  }

  #existingReply(messageId: string): string | null | undefined {
    const row = this.#db.prepare(
      "SELECT reply_text FROM processed_messages WHERE message_id = ?",
    ).get(messageId) as { reply_text: string | null } | undefined;
    return row ? row.reply_text : undefined;
  }

  #recordReply(messageId: string, reply: string | null): void {
    this.#db.prepare(
      "INSERT OR IGNORE INTO processed_messages (message_id, reply_text, processed_at) VALUES (?, ?, ?)",
    ).run(messageId, reply, new Date().toISOString());
  }

  #saveMessageReply(messageId: string, reply: string): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #currentPrice(product: KrogerProduct): number | null {
    return this.#isCurrentPromo(product) ? product.promoPriceCents : product.regularPriceCents;
  }

  #isCurrentPromo(product: KrogerProduct): boolean {
    const now = Date.now();
    const effectiveAt = product.promoEffectiveAt ? Date.parse(product.promoEffectiveAt) : 0;
    const expiresAt = product.promoExpiresAt && !product.promoExpiresAt.startsWith("9999")
      ? Date.parse(product.promoExpiresAt)
      : Number.POSITIVE_INFINITY;
    const promoIsCurrent = (Number.isNaN(effectiveAt) || effectiveAt <= now)
      && (Number.isNaN(expiresAt) || expiresAt > now);
    return promoIsCurrent && product.promoPriceCents !== null && product.promoPriceCents > 0;
  }

  #retailerQuery(text: string): string {
    let query = text.toLocaleLowerCase();
    query = query.replace(/\b(?:that\s+)?i\s+(?:also\s+)?want\s+to\s+share\b.*$/i, " ");
    query = query.replace(/\b(?:can|could)\s+i\s+(?:please\s+)?get\b|\bi\s+(?:would\s+like|want)\b|\bwe\s+need\b|\bplease\s+(?:get|add)\b|\badd\b/gi, " ");
    query = query.replace(/\b(?:under|below|less than|at most|no more than|up to)\s+\$?\s*\d+(?:\.\d{1,2})?\s*(?:dollars?)?\b/gi, " ");
    // Old per-item sharing phrases no longer change the split, but they would
    // still pollute product searches. Only strip “with …” after a share verb so
    // descriptions like “pasta with pesto” keep their meaning.
    query = query.replace(/\b(?:shared?|split)\s+(?:with|between|among)\b.*$/i, " ");
    query = query.replace(/\b(?:for everyone|for all of us|for us|for me|shared|share|please|thanks|thx)\b/gi, " ");
    for (const member of this.getMembers()) {
      const names = new Set([member.name, member.name.split(/\s+/)[0] ?? member.name]);
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        query = query.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "giu"), " ");
      }
    }
    query = query.replace(/\bfor\s*$/i, " ");
    query = query.replace(/^\s*\d+(?!\s*(?:%|percent\b))\s*(?:(?:x|×)\s*|\s+)/i, " ").replace(/\b(?:and|with|to)\b/gi, " ");
    return query.replace(/[.,!?;:]+/g, " ").replace(/\s+/g, " ").trim();
  }

  #priceLimit(text: string): { cents: number; inclusive: boolean } | undefined {
    const match = text.match(/\b(under|below|less than|at most|no more than|up to)\s+\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:dollars?)?\b/i);
    if (!match) return undefined;
    const dollars = Number(match[2]);
    if (!Number.isFinite(dollars) || dollars <= 0) return undefined;
    return {
      cents: Math.round(dollars * 100),
      inclusive: /^(?:at most|no more than|up to)$/i.test(match[1]!),
    };
  }

  #meetsPriceLimit(product: KrogerProduct, cents: number | undefined, inclusive: boolean): boolean {
    if (cents === undefined) return true;
    const price = this.#currentPrice(product);
    if (price === null) return false;
    return inclusive ? price <= cents : price < cents;
  }

  #cancellationQuery(text: string): string | undefined {
    const normalizedText = text.replace(/[’‘]/g, "'");
    if (/^cancel clear all$/i.test(normalizedText.trim())) return undefined;
    const patterns = [
      /\b(?:i|we)\s+(?:do\s+not|don't|dont)\s+(?:want|need)\s+(?:the\s+)?(.+?)(?:\s+(?:anymore|any\s+more|please))?(?:[.!?]|$)/i,
      /\b(?:remove|cancel|delete|drop)\s+(?:(?:the|my|our)\s+)?(.+?)(?:\s+from\s+(?:the\s+)?(?:cart|basket)|\s+please)?(?:[.!?]|$)/i,
      /\btake\s+(?:(?:the|my|our)\s+)?(.+?)\s+off(?:\s+(?:the\s+)?(?:cart|basket))?(?:[.!?]|$)/i,
    ];
    let target: string | undefined;
    for (const pattern of patterns) {
      const match = normalizedText.match(pattern);
      if (match?.[1]) { target = match[1]; break; }
    }
    if (!target) return undefined;
    const query = this.#retailerQuery(target)
      .replace(/\b(?:anymore|any more|now|item|items|thing|things)\b/gi, " ")
      .replace(/\s+/g, " ").trim();
    return query.length >= 2 ? query : undefined;
  }

  #captureCartItems(): string {
    const items = this.#db.prepare(
      "SELECT id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc FROM cart_items WHERE household_id = ? ORDER BY created_at, id",
    ).all(this.#householdId);
    return JSON.stringify(items);
  }

  #isHelpRequest(text: string): boolean {
    return /^(?:(?:hi|hello|hey)(?: there)?|help|commands|menu|start|show commands|what can you do)[!.?]*$/i.test(text.trim());
  }

  #getPendingKrogerCheckout(): { requesterId: string; revision: number; selectedMemberId: string | null; status: string } | undefined {
    const row = this.#db.prepare(
      "SELECT requester_id, revision, selected_member_id, status FROM pending_kroger_checkouts WHERE household_id = ?",
    ).get(this.#householdId) as { requester_id: string; revision: number; selected_member_id: string | null; status: string } | undefined;
    return row ? { requesterId: row.requester_id, revision: row.revision, selectedMemberId: row.selected_member_id, status: row.status } : undefined;
  }

  async #startKrogerCheckout(
    messageId: string,
    memberId: string,
    locationId?: string,
    checkCartAvailability?: (items: Array<{ id: string; name: string; upc: string; quantity: number }>) => Promise<KrogerCartAvailabilityIssue[]>,
  ): Promise<string> {
    const snapshot = this.snapshot();
    if (!snapshot.items.length) return this.#saveAndReturnReply(messageId, "There isn’t a cart to send to Kroger yet.");
    const pendingApprovals = snapshot.members.filter((member) => !member.approved).map((member) => member.name);
    if (pendingApprovals.length) {
      return this.#saveAndReturnReply(messageId, `Checkout is waiting for approval from: ${pendingApprovals.join(", ")}. Nothing was sent to Kroger.`);
    }
    const missingUpc = snapshot.items.find((item) => !item.upc);
    if (missingUpc) {
      return this.#saveAndReturnReply(messageId, `“${missingUpc.name}” is a sample item without a Kroger UPC. Replace sample items with live Kroger selections before sending this list to Kroger.`);
    }
    const pending = this.#getPendingKrogerCheckout();
    if (pending && pending.requesterId !== memberId) {
      const name = this.getMembers().find((member) => member.id === pending.requesterId)?.name ?? "another member";
      return this.#saveAndReturnReply(messageId, `Kroger checkout is already being prepared by ${name}. Ask them to finish or text “cancel checkout”.`);
    }
    if (pending?.status === "awaiting_oauth" && pending.selectedMemberId) {
      const chosen = this.getMembers().find((member) => member.id === pending.selectedMemberId);
      const reply = chosen
        ? `${chosen.name}’s Kroger account is selected. Sign in using this link to add the approved list: ${this.#krogerSignInUrl(chosen.id)}. This only adds items; it does not place an order.`
        : "The selected Kroger account is unavailable. Text “checkout” to start again.";
      return this.#saveAndReturnReply(messageId, reply);
    }
    if (pending?.status === "replacement_review") {
      const reply = this.#krogerReplacementPrompt();
      return this.#saveAndReturnReply(messageId, reply);
    }
    if (pending?.status === "adding") {
      return this.#saveAndReturnReply(messageId, "The approved list is currently being sent to Kroger. Please wait for the result.");
    }
    if (checkCartAvailability) {
      let issues: KrogerCartAvailabilityIssue[];
      try {
        issues = await checkCartAvailability(snapshot.items.map((item) => ({
          id: item.id,
          name: item.name,
          upc: item.upc!,
          quantity: item.quantity,
        })));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Kroger availability lookup failed.";
        return this.#saveAndReturnReply(messageId, `I couldn’t verify store availability (${detail}). Nothing was sent to Kroger. Check that GroupCart’s configured store matches the pickup/delivery store in the Kroger account, then try “checkout” again.`);
      }
      if (issues.length) {
        const storedIssues = issues.map((issue) => ({ ...issue, resolved: false }));
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          this.#db.prepare("INSERT INTO pending_kroger_checkouts (household_id, requester_id, revision, selected_member_id, status, created_at) VALUES (?, ?, ?, NULL, 'replacement_review', ?) ON CONFLICT(household_id) DO UPDATE SET requester_id = excluded.requester_id, revision = excluded.revision, selected_member_id = NULL, status = 'replacement_review', created_at = excluded.created_at")
            .run(this.#householdId, memberId, snapshot.revision, new Date().toISOString());
          this.#db.prepare("INSERT INTO pending_kroger_replacements (household_id, issues_json) VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET issues_json = excluded.issues_json")
            .run(this.#householdId, JSON.stringify(storedIssues));
          const reply = this.#formatKrogerReplacementSuggestions(storedIssues, locationId);
          this.#recordReply(messageId, reply);
          this.#db.exec("COMMIT");
          return reply;
        } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("INSERT INTO pending_kroger_checkouts (household_id, requester_id, revision, selected_member_id, status, created_at) VALUES (?, ?, ?, NULL, 'choosing_account', ?) ON CONFLICT(household_id) DO UPDATE SET requester_id = excluded.requester_id, revision = excluded.revision, selected_member_id = NULL, status = 'choosing_account', created_at = excluded.created_at")
        .run(this.#householdId, memberId, snapshot.revision, new Date().toISOString());
      const options = this.getMembers().map((member, index) => `${index + 1}) ${member.name}`).join("\n");
      const reply = `Everyone approved revision ${snapshot.revision}. Which household member’s Kroger account should receive the items?\n${options}\nReply with a number, or “cancel checkout”. You’ll sign in to Kroger to authorize adding the items. GroupCart will not place an order or charge anyone.`;
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #handleKrogerAccountChoice(
    messageId: string,
    memberId: string,
    text: string,
    pending: { requesterId: string; revision: number; selectedMemberId: string | null; status: string },
  ): string {
    if (/^(cancel|cancel checkout|never mind|nevermind)$/i.test(text)) {
      return this.#cancelKrogerCheckout(messageId, memberId);
    }
    if (pending.status === "awaiting_oauth" && pending.selectedMemberId) {
      const chosen = this.getMembers().find((member) => member.id === pending.selectedMemberId);
      const reply = chosen
        ? `Sign in to ${chosen.name}’s Kroger account using this link: ${this.#krogerSignInUrl(chosen.id)}. After consent, the approved items will be added to its cart; no order will be placed.`
        : "The selected Kroger account is unavailable. Text “checkout” to start again.";
      return this.#saveAndReturnReply(messageId, reply);
    }
    const selection = text.match(/^\s*(\d{1,2})\s*$/);
    const members = this.getMembers();
    const index = Number(selection?.[1]) - 1;
    if (!selection || index < 0 || index >= members.length) {
      const options = members.map((member, i) => `${i + 1}) ${member.name}`).join("; ");
      return this.#saveAndReturnReply(messageId, `Choose one of these Kroger accounts by number: ${options}. Reply “cancel checkout” to stop.`);
    }
    const chosen = members[index]!;
    const snapshot = this.snapshot();
    if (snapshot.revision !== pending.revision || !snapshot.items.length || snapshot.members.some((member) => !member.approved)) {
      this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.#householdId);
      return this.#saveAndReturnReply(messageId, "The cart changed or approvals expired. Nothing was sent to Kroger; review the cart and get fresh approvals before checkout.");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE pending_kroger_checkouts SET selected_member_id = ?, status = 'awaiting_oauth' WHERE household_id = ?")
        .run(chosen.id, this.#householdId);
      const reply = `Selected ${chosen.name}’s Kroger account. Sign in and approve access here: ${this.#krogerSignInUrl(chosen.id)}. After consent, GroupCart will add the approved items to that cart only; it will not place an order or charge anyone.`;
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #cancelKrogerCheckout(messageId: string, memberId: string): string {
    const pending = this.#getPendingKrogerCheckout();
    if (!pending) return this.#saveAndReturnReply(messageId, "There isn’t a pending Kroger checkout to cancel.");
    if (pending.requesterId !== memberId) return this.#saveAndReturnReply(messageId, "Only the member who started this checkout can cancel it.");
    this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ? AND status <> 'adding'").run(this.#householdId);
    this.#db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.#householdId);
    return this.#saveAndReturnReply(messageId, "Cancelled Kroger cart setup. GroupCart and Kroger carts were left unchanged.");
  }

  #formatKrogerReplacementSuggestions(
    issues: Array<KrogerCartAvailabilityIssue & { resolved?: boolean }>,
    locationId?: string,
  ): string {
    const lines = issues.map((issue, index) => {
      const suggestions = issue.alternatives.length
        ? issue.alternatives.map((product, optionIndex) => {
          const price = this.#currentPrice(product);
          return `   ${optionIndex + 1}) ${product.description}${product.size ? ` · ${product.size}` : ""}${price === null ? "" : ` — ${money(price)}`}`;
        }).join("\n")
        : "   No in-stock alternatives were returned. Cancel checkout, then remove or search for another product.";
      return `${index + 1}) ${issue.resolved ? "Resolved" : "Unavailable"}: ${issue.name}${locationId ? ` at store ${locationId}` : " at the configured store"}\n${issue.resolved ? "   Replacement selected by a household member." : suggestions}`;
    });
    const storeDescription = locationId ? `store ${locationId}` : "the configured store";
    return `Before checkout, Kroger’s availability check found ${issues.length} unavailable item${issues.length === 1 ? "" : "s"}. Suggested alternatives are not added automatically:\n${lines.join("\n")}\nTo choose one, text “replace 1 with 2” (unavailable-item number, then suggestion number). I’ll update GroupCart only after that explicit choice, and everyone must approve the changed cart again. Confirm the Kroger account uses the same store as GroupCart (${storeDescription}). Nothing has been sent to Kroger. Text “cancel checkout” to leave the cart unchanged.`;
  }

  #krogerReplacementPrompt(): string {
    const row = this.#db.prepare("SELECT issues_json FROM pending_kroger_replacements WHERE household_id = ?")
      .get(this.#householdId) as { issues_json: string } | undefined;
    if (!row) return "Kroger replacement suggestions expired. Text “checkout” to run the availability check again.";
    const issues = JSON.parse(row.issues_json) as Array<KrogerCartAvailabilityIssue & { resolved?: boolean }>;
    return this.#formatKrogerReplacementSuggestions(issues);
  }

  #handleKrogerReplacementChoice(messageId: string, memberId: string, itemNumber: number, optionNumber: number): string {
    const pending = this.#getPendingKrogerCheckout();
    const row = this.#db.prepare("SELECT issues_json FROM pending_kroger_replacements WHERE household_id = ?")
      .get(this.#householdId) as { issues_json: string } | undefined;
    if (!pending || pending.status !== "replacement_review" || !row) {
      return this.#saveAndReturnReply(messageId, "There isn’t an active Kroger replacement review. Text “checkout” to check the current cart.");
    }
    const current = this.snapshot();
    if (current.revision !== pending.revision) {
      this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.#householdId);
      this.#db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.#householdId);
      return this.#saveAndReturnReply(messageId, "The cart changed during the availability review. I discarded those suggestions and left the cart as-is; everyone must approve the current cart before a fresh checkout check.");
    }
    const issues = JSON.parse(row.issues_json) as Array<KrogerCartAvailabilityIssue & { resolved?: boolean }>;
    const issue = issues[itemNumber - 1];
    const product = issue?.alternatives[optionNumber - 1];
    if (!issue || issue.resolved || !product) {
      return this.#saveAndReturnReply(messageId, `That choice doesn’t match an unresolved item and its suggestions. Use “replace item-number with option-number” (for example “replace 1 with 2”).`);
    }
    const price = this.#currentPrice(product);
    if (price === null || !product.upc) {
      return this.#saveAndReturnReply(messageId, "Kroger didn’t return a current price and UPC for that suggestion, so I didn’t replace anything. Choose another option or cancel checkout.");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.#db.prepare("SELECT id FROM cart_items WHERE id = ? AND household_id = ?")
        .get(issue.itemId, this.#householdId) as { id: string } | undefined;
      if (!item) {
        this.#db.exec("ROLLBACK");
        return this.#saveAndReturnReply(messageId, "That item is no longer in GroupCart. Nothing was replaced; text “checkout” to check the current list.");
      }
      const undoSnapshot = this.#captureCartItems();
      this.#db.prepare("UPDATE cart_items SET product_id = ?, product_name = ?, unit_price_cents = ?, price_source = 'kroger', upc = ? WHERE id = ?")
        .run(`kroger:${product.productId}`, product.description, price, product.upc, issue.itemId);
      this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?").run(this.#householdId);
      this.#recordUndo(memberId, `replace unavailable ${issue.name} with ${product.description}`, undoSnapshot);
      issue.resolved = true;
      this.#db.prepare("UPDATE pending_kroger_replacements SET issues_json = ? WHERE household_id = ?")
        .run(JSON.stringify(issues), this.#householdId);
      const revision = this.snapshot().revision;
      this.#db.prepare("UPDATE pending_kroger_checkouts SET revision = ? WHERE household_id = ?")
        .run(revision, this.#householdId);
      const allResolved = issues.every((entry) => entry.resolved);
      if (allResolved) {
        this.#db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.#householdId);
        this.#db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.#householdId);
      }
      const reply = allResolved
        ? `You chose ${product.description}${product.size ? ` · ${product.size}` : ""} at ${money(price)}. I updated GroupCart only because you explicitly selected it. The cart changed, so everyone must approve revision ${revision} before checkout.\n${this.formatSummary(memberId)}`
        : `You chose ${product.description}${product.size ? ` · ${product.size}` : ""} at ${money(price)}. I updated GroupCart only because you explicitly selected it. Choose the remaining suggested replacements:\n${this.#formatKrogerReplacementSuggestions(issues)}`;
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #krogerSignInUrl(memberId: string): string {
    return `${this.#dashboardUrl.replace(/\/$/, "")}/api/kroger/oauth/start?memberId=${encodeURIComponent(memberId)}`;
  }

  #saveAndReturnReply(messageId: string, reply: string): string {
    this.#saveMessageReply(messageId, reply);
    return reply;
  }

  #helpMessage(): string {
    return [
      "Welcome to GroupCart! Tell me what groceries your group needs. I can search Kroger products and prices for your selected store, build a shared list, and split estimated costs.",
      "Add/search: send one item such as “Vital Farms organic eggs,” or up to 5 separated by commas/and, like “bread, bananas, and eggs.” Choose a numbered Kroger result for each item in order. For plain “milk,” I’ll ask what kind first.",
      "Item budgets: add a per-item unit-price limit, like “pasta under $5” or “pasta under $5, bread up to $3.” Under is strict; “up to” includes the limit. Options without a live price are excluded when a limit is set.",
      "Share: text “start sharing with Maya and Jordan” (household member names). From then on, every item any of you adds is split evenly among you until someone texts “stop sharing”. Items already in the cart keep their split.",
      "Review: “cart” shows items, total, budget, and each person’s share.",
      this.#dashboardMessage(),
      "Remove: say “remove bread” or “I don’t want bread anymore.” For all your items, say “clear mine.”",
      "Clear everyone’s cart: “clear all,” then “confirm clear all” (or “cancel clear all”).",
      "Undo: “undo” reverts the latest cart change; repeat to step back through recent changes.",
      "Recurring lists: the group shares a weekly, every-two-weeks (“biweekly”), and monthly list. Add with “weekly: milk, eggs” or “add paper towels to monthly list”; view with “weekly list” or “lists”; edit with “remove eggs from weekly list” or “set eggs on weekly list to 2”; clear with “clear weekly list”. “load weekly list” copies it into the cart as one undoable change. I’ll ask the group when a list is due; change timing with “weekly list on saturdays” / “monthly list on the 15th”, or “pause weekly reminders”. New here? Text “set up lists”.",
      this.#krogerCartEnabled
        ? "Approve/Kroger cart: everyone texts “approve,” then “checkout” checks availability at the configured store before asking whose Kroger account to use. If something appears unavailable, GroupCart suggests alternatives but never substitutes automatically; choose one with “replace 1 with 2.” Any changed list needs everyone’s approval again. After sign-in, available UPC items are added to Kroger; you finish ordering there. No order or payment is placed by GroupCart."
        : "Approve/checkout: in the local demo, checkout is simulated. Live Kroger cart transfer requires configured Kroger app credentials and Cart API access. GroupCart never places an order or charges anyone.",
      "Not sure what to say? Text “help” or “commands” anytime.",
    ].join("\n\n");
  }

  #dashboardMessage(): string {
    return `Dashboard: ${this.#dashboardUrl} (open this on the computer running GroupCart; it is local-only and not reachable from other devices).`;
  }

  #multiItemRequests(text: string): BatchRequest[] {
    let body = text.trim().replace(/^[\s,;]*(?:hi|hello|hey)[,:\s]+/i, "");
    body = body.replace(/^\s*(?:(?:can|could|may)\s+i\s+(?:please\s+)?(?:get|have|add)|(?:i|we)\s+(?:would\s+like|want|need)|please\s+(?:add|get)|add)\s+/i, "");
    // Drop old per-item sharing phrases (they no longer share) before splitting,
    // so “bread shared with Maya and Jordan” doesn't turn “Jordan” into an item.
    body = body.replace(/\s*\b(?:shared?|split)\s+(?:with|between|among)\b[^,;\n]*/gi, "");
    const segments = body.split(/\s*(?:,|;|\n)\s*|\s+and\s+/i)
      .map((segment) => segment.trim().replace(/^[,;\s]+|[.!?]+$/g, ""))
      .filter(Boolean);
    if (segments.length < 2) return [];
    const requests = segments.map((segment) => {
      const priceLimit = this.#priceLimit(segment);
      const itemText = segment
        .replace(/\b(?:under|below|less than|at most|no more than|up to)\s+\$?\s*\d+(?:\.\d{1,2})?\s*(?:dollars?)?\b/gi, " ")
        .trim();
      const extracted = extractCartRequests(itemText);
      return {
        query: this.#retailerQuery(itemText),
        quantity: extracted.length === 1 ? extracted[0]!.quantity : this.#quantityFromText(itemText),
        maxPriceCents: priceLimit?.cents,
        maxPriceInclusive: priceLimit?.inclusive,
      };
    });
    return requests.every((request) => request.query.length >= 2) ? requests : [];
  }

  async #searchBatchAndPrompt(
    messageId: string,
    memberId: string,
    requests: BatchRequest[],
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
    sourceText = "",
  ): Promise<string> {
    let results: BatchProductResult[];
    try {
      results = await Promise.all(requests.map(async (request) => {
        const result = await searchProducts(request.query);
        const matchingProducts = result.products.filter((product) => this.#meetsPriceLimit(
          product,
          request.maxPriceCents,
          request.maxPriceInclusive ?? false,
        ));
        return { total: matchingProducts.length, products: matchingProducts.slice(0, 3) };
      }));
    } catch (error) {
      const reply = `I couldn’t search the full list just now (${error instanceof Error ? error.message : "request failed"}). Nothing was added. Please retry the item list, or text “help”.`;
      this.#saveMessageReply(messageId, reply);
      return reply;
    }
    const missing = requests.flatMap((request, index) => results[index]!.products.length ? [] : [
      request.maxPriceCents === undefined
        ? `“${request.query}”`
        : `“${request.query}” under ${money(request.maxPriceCents)}`,
    ]);
    if (missing.length) {
      const reply = `I couldn’t find Kroger products for ${missing.join(" and ")}. Nothing from this list was added. Try a more specific description or raise the item budget, then resend the list.`;
      this.#saveMessageReply(messageId, reply);
      return reply;
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
      this.#db.prepare("INSERT INTO pending_product_batches (member_id, requests_json, results_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET requests_json = excluded.requests_json, results_json = excluded.results_json, created_at = excluded.created_at")
        .run(memberId, JSON.stringify(requests), JSON.stringify(results), new Date().toISOString());
      const sections = requests.map((request, index) => {
        const result = results[index]!;
        const options = result.products.map((product, optionIndex) => {
          const cents = this.#currentPrice(product);
          const price = cents === null ? "price unavailable" : money(cents);
          return `   ${optionIndex + 1}) ${product.description}${product.size ? ` · ${product.size}` : ""} — ${price}`;
        });
        const priceLimit = request.maxPriceCents === undefined
          ? ""
          : ` · ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)} each`;
        return `${index + 1}. ${request.quantity > 1 ? `${request.quantity} × ` : ""}${request.query}${priceLimit} (${result.total} options)\n${options.join("\n")}`;
      });
      const storeNote = locationId ? ` at selected store ${locationId}` : " at the configured Kroger-family store";
      const reply = `I found options for your ${requests.length} items${storeNote}:\n${sections.join("\n")}\nReply with one choice number per item in order, separated by commas (for example “1, 2, 1”). Nothing is added until all choices are selected. Reply “cancel” to discard this search.${this.#sharingNote(this.#participantsFor(memberId))}${this.#legacyShareHint(sourceText, memberId)}`;
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #addBatchSelections(
    messageId: string,
    memberId: string,
    requests: BatchRequest[],
    results: BatchProductResult[],
    selections: number[],
  ): string {
    const chosen = results.map((result, index) => result.products[selections[index]! - 1]!);
    const missingPrice = chosen.find((product) => this.#currentPrice(product) === null);
    if (missingPrice) {
      const reply = `Kroger didn’t return a price for ${missingPrice.description} at this store, so I didn’t add any items. Send the list again after configuring local store pricing.`;
      this.#saveMessageReply(messageId, reply);
      return reply;
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM pending_product_batches WHERE member_id = ?").run(memberId);
      const undoSnapshot = this.#captureCartItems();
      const chosenLines: string[] = [];
      const participantIds = this.#participantsFor(memberId);
      for (let index = 0; index < chosen.length; index += 1) {
        const product = chosen[index]!;
        const request = requests[index]!;
        const price = this.#currentPrice(product)!;
        const productId = `kroger:${product.productId}`;
        this.#db.prepare(
          "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(randomUUID(), this.#householdId, productId, request.quantity, memberId,
          JSON.stringify(participantIds), new Date().toISOString(), product.description,
          price, "kroger", product.upc);
        chosenLines.push(product.description);
      }
      this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
        .run(this.#householdId);
      this.#recordUndo(memberId, `add ${chosenLines.join(", ")}`, undoSnapshot);
      const reply = `Added all ${chosenLines.length} selected items to GroupCart ${this.#assignmentPhrase(participantIds)}.\n${this.formatSummary(memberId)}`;
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #recordUndo(memberId: string, action: string, itemsJson: string): void {
    const row = this.#db.prepare("SELECT revision FROM households WHERE id = ?")
      .get(this.#householdId) as { revision: number };
    this.#db.prepare(
      "INSERT INTO cart_undo_history (id, household_id, actor_id, action, revision_after, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), this.#householdId, memberId, action, row.revision, itemsJson, new Date().toISOString());
    this.#db.prepare(
      "DELETE FROM cart_undo_history WHERE id IN (SELECT id FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT -1 OFFSET 20)",
    ).run(this.#householdId);
  }

  #clearMemberItems(memberId: string): string {
    const snapshot = this.snapshot();
    const mine = snapshot.items.filter((item) => item.participantIds.includes(memberId));
    if (!mine.length) return "You don’t have any items or shares in the cart to clear.";
    const undoSnapshot = this.#captureCartItems();
    for (const item of mine) {
      if (item.participantIds.length <= 1) {
        this.#db.prepare("DELETE FROM cart_items WHERE id = ?").run(item.id);
      } else {
        const remaining = item.participantIds.filter((id) => id !== memberId);
        const ownerId = item.ownerId === memberId ? remaining[0]! : item.ownerId;
        this.#db.prepare("UPDATE cart_items SET participants_json = ?, owner_id = ? WHERE id = ?")
          .run(JSON.stringify(remaining), ownerId, item.id);
      }
    }
    this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
      .run(this.#householdId);
    const memberName = this.getMembers().find((member) => member.id === memberId)?.name ?? "your";
    this.#recordUndo(memberId, `clear ${memberName}'s items and shares`, undoSnapshot);
    return `Cleared ${mine.length} item${mine.length === 1 ? "" : "s"} assigned to you. Other members’ shares remain.\n${this.formatSummary(memberId)}`;
  }

  #hasPendingClearAll(memberId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM pending_cart_clears WHERE member_id = ?")
      .get(memberId));
  }

  #requestClearAll(memberId: string): string {
    const snapshot = this.snapshot();
    if (!snapshot.items.length) return "The shared cart is already empty.";
    this.#db.prepare(
      "INSERT INTO pending_cart_clears (member_id, requested_revision, created_at) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET requested_revision = excluded.requested_revision, created_at = excluded.created_at",
    ).run(memberId, snapshot.revision, new Date().toISOString());
    return `This will clear all ${snapshot.items.length} item lines (${money(snapshot.totalCents)}) for everyone. Reply “confirm clear all” to proceed, or “cancel clear all” to leave it unchanged. You can “undo” afterward.`;
  }

  #confirmClearAll(memberId: string): string {
    const pending = this.#db.prepare(
      "SELECT requested_revision FROM pending_cart_clears WHERE member_id = ?",
    ).get(memberId) as { requested_revision: number } | undefined;
    if (!pending) return "There isn’t a pending clear-all request. Text “clear all” first if you want to empty the shared cart.";
    const snapshot = this.snapshot();
    if (pending.requested_revision !== snapshot.revision) {
      this.#db.prepare("UPDATE pending_cart_clears SET requested_revision = ?, created_at = ? WHERE member_id = ?")
        .run(snapshot.revision, new Date().toISOString(), memberId);
      return `The cart changed since you asked. It now has ${snapshot.items.length} item lines totaling ${money(snapshot.totalCents)}. Reply “confirm clear all” again to clear this updated cart, or “cancel clear all”.`;
    }
    this.#db.prepare("DELETE FROM pending_cart_clears WHERE member_id = ?").run(memberId);
    if (!snapshot.items.length) return "The shared cart is already empty.";
    const undoSnapshot = this.#captureCartItems();
    this.#clearPendingCartIntents();
    this.#db.prepare("DELETE FROM cart_items WHERE household_id = ?").run(this.#householdId);
    this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
      .run(this.#householdId);
    this.#recordUndo(memberId, "clear the shared cart", undoSnapshot);
    return `Cleared the shared cart for everyone. Text “undo” to restore it.\n${this.formatSummary(memberId)}`;
  }

  #undoLastCartChange(memberId: string): string {
    const last = this.#db.prepare(
      "SELECT id, actor_id, action, revision_after, items_json FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(this.#householdId) as { id: string; actor_id: string; action: string; revision_after: number; items_json: string } | undefined;
    if (!last) return "There isn’t a recent cart change to undo.";
    const current = this.snapshot();
    if (last.revision_after !== current.revision) {
      return "I can’t safely undo that because the cart changed afterward. Make a new change and you can undo that latest change instead.";
    }
    const items = JSON.parse(last.items_json) as Array<{
      id: string; household_id: string; product_id: string; quantity: number; owner_id: string;
      participants_json: string; created_at: string; product_name: string | null;
      unit_price_cents: number | null; price_source: string | null; upc: string | null;
    }>;
    this.#db.prepare("DELETE FROM cart_items WHERE household_id = ?").run(this.#householdId);
    const insert = this.#db.prepare(
      "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of items) {
      insert.run(item.id, item.household_id, item.product_id, item.quantity, item.owner_id,
        item.participants_json, item.created_at, item.product_name, item.unit_price_cents,
        item.price_source, item.upc);
    }
    this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
      .run(this.#householdId);
    const nextRevision = this.snapshot().revision;
    this.#db.prepare("DELETE FROM cart_undo_history WHERE id = ?").run(last.id);
    this.#revertListLoad(last.id);
    this.#db.prepare(
      "UPDATE cart_undo_history SET revision_after = ? WHERE id = (SELECT id FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT 1)",
    ).run(nextRevision, this.#householdId);
    const actorName = this.getMembers().find((member) => member.id === last.actor_id)?.name ?? "a household member";
    return `Undid ${actorName}’s last change (${last.action}).\n${this.formatSummary(memberId)}`;
  }

  #clearPendingCartIntents(): void {
    const memberIds = "SELECT id FROM members WHERE household_id = ?";
    this.#db.prepare(`DELETE FROM pending_product_choices WHERE member_id IN (${memberIds})`).run(this.#householdId);
    this.#db.prepare(`DELETE FROM pending_product_batches WHERE member_id IN (${memberIds})`).run(this.#householdId);
    this.#db.prepare(`DELETE FROM pending_item_cancellations WHERE member_id IN (${memberIds})`).run(this.#householdId);
    this.#db.prepare(`DELETE FROM pending_clarifications WHERE member_id IN (${memberIds})`).run(this.#householdId);
    this.#db.prepare(`DELETE FROM pending_cart_clears WHERE member_id IN (${memberIds})`).run(this.#householdId);
  }

  #startItemCancellation(messageId: string, memberId: string, query: string): string {
    const snapshot = this.snapshot();
    const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matching = snapshot.items.filter((item) => {
      const name = item.name.toLocaleLowerCase();
      return tokens.every((token) => name.includes(token));
    });
    const eligible = matching.filter((item) => item.participantIds.includes(memberId));
    if (!eligible.length) {
      const reply = matching.length
        ? "That item is in the cart, but it isn’t assigned to you, so I left it unchanged. Ask the person who added it to remove it or change the share."
        : `I couldn’t find “${query}” in the cart, so nothing was removed. Text “cart” to review the current items.`;
      this.#saveMessageReply(messageId, reply);
      return reply;
    }
    if (eligible.length > 1) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.prepare(
          "INSERT INTO pending_item_cancellations (member_id, item_ids_json, query, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET item_ids_json = excluded.item_ids_json, query = excluded.query, created_at = excluded.created_at",
        ).run(memberId, JSON.stringify(eligible.map((item) => item.id)), query, new Date().toISOString());
        this.#db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
        const options = eligible.map((item, index) => `${index + 1}) ${item.name} — ${money(item.totalCents)} (${item.participantNames.length > 1 ? `shared by ${item.participantNames.join(", ")}` : `for ${item.ownerName}`})`);
        const reply = `Which “${query}” would you like to remove?\n${options.join("\n")}\nReply 1-${eligible.length}, or “cancel”. For a shared item, this removes only your share.`;
        this.#recordReply(messageId, reply);
        this.#db.exec("COMMIT");
        return reply;
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
      const result = this.#removeParticipant(eligible[0]!.id, memberId);
      const reply = `${result}\n${this.formatSummary(memberId)}`;
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #removeParticipant(itemId: string, memberId: string): string {
    const row = this.#db.prepare(
      "SELECT id, product_name, product_id, owner_id, participants_json FROM cart_items WHERE id = ? AND household_id = ?",
    ).get(itemId, this.#householdId) as { id: string; product_name: string | null; product_id: string; owner_id: string; participants_json: string } | undefined;
    if (!row) return "That cart item is no longer there; nothing else was changed.";
    const participants = JSON.parse(row.participants_json) as string[];
    if (!participants.includes(memberId)) return "Your share was already removed; the cart is unchanged.";
    const productName = row.product_name ?? CATALOG.find((product) => product.id === row.product_id)?.name ?? "item";
    const undoSnapshot = this.#captureCartItems();
    if (participants.length <= 1) {
      this.#db.prepare("DELETE FROM cart_items WHERE id = ?").run(itemId);
      this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?").run(this.#householdId);
      this.#recordUndo(memberId, `remove ${productName}`, undoSnapshot);
      return `Removed ${productName} from your cart.`;
    }
    const remaining = participants.filter((id) => id !== memberId);
    const newOwnerId = row.owner_id === memberId ? remaining[0]! : row.owner_id;
    this.#db.prepare("UPDATE cart_items SET participants_json = ?, owner_id = ? WHERE id = ?")
      .run(JSON.stringify(remaining), newOwnerId, itemId);
    this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?").run(this.#householdId);
    this.#recordUndo(memberId, `withdraw your share of ${productName}`, undoSnapshot);
    const names = this.getMembers().filter((member) => remaining.includes(member.id)).map((member) => member.name);
    return `Removed your share of ${productName}; ${names.join(" and ")} still ${names.length === 1 ? "has" : "have"} it.`;
  }

  #milkSearchQuery(text: string): string | undefined {
    const normalized = text.trim().toLocaleLowerCase();
    if (/^(?:1|whole(?:\s+milk)?|dairy(?:\s+milk)?)$/i.test(normalized)) return "whole milk";
    if (/^(?:2|2\s*(?:%|percent)(?:\s+milk)?|two\s+percent(?:\s+milk)?|reduced\s+fat(?:\s+milk)?)$/i.test(normalized)) return "2% milk";
    if (/^(?:3|oat(?:\s+milk)?)$/i.test(normalized)) return "oat milk";
    if (/^(?:4|almond(?:\s+milk)?)$/i.test(normalized)) return "almond milk";
    const branded = this.#retailerQuery(text);
    return /\bmilk\b/i.test(branded) ? branded : undefined;
  }

  #quantityFromText(text: string): number {
    const match = text.match(/^\s*(\d+)(?!\s*(?:%|percent\b))\s*(?:x|×)?\s+\S/i);
    const amount = Number(match?.[1] ?? 1);
    return Number.isSafeInteger(amount) ? Math.min(Math.max(amount, 1), 99) : 1;
  }

  private memberId(handle: string): string {
    return createHash("sha256").update(`${this.#householdId}:${handle}`).digest("hex").slice(0, 20);
  }

  #addRequests(memberId: string, requests: Array<{ product: Product; quantity: number }>): string[] {
    const member = this.#db.prepare(
      "SELECT id FROM members WHERE household_id = ? AND id = ?",
    ).get(this.#householdId, memberId);
    if (!member) throw new Error("Sender is not a configured household member.");

    const undoSnapshot = this.#captureCartItems();
    const participantIds = this.#participantsFor(memberId);
    const newRevision = this.snapshot().revision + 1;
    const insert = this.#db.prepare(
      "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const request of requests) {
      insert.run(randomUUID(), this.#householdId, request.product.id, request.quantity, memberId, JSON.stringify(participantIds), new Date().toISOString());
    }
    this.#db.prepare(
      "UPDATE households SET revision = ?, checked_out_revision = NULL WHERE id = ?",
    ).run(newRevision, this.#householdId);
    this.#recordUndo(memberId, `add ${requests.map(({ product }) => product.name).join(", ")}`, undoSnapshot);
    return participantIds;
  }

  #activeSessions(): SharingSession[] {
    const rows = this.#db.prepare(
      "SELECT id, participant_ids_json, started_by, started_at FROM sharing_sessions WHERE household_id = ? AND ended_at IS NULL ORDER BY started_at, rowid",
    ).all(this.#householdId) as Array<{ id: string; participant_ids_json: string; started_by: string; started_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      participantIds: JSON.parse(row.participant_ids_json) as string[],
      startedBy: row.started_by,
      startedAt: row.started_at,
    }));
  }

  #activeSessionFor(memberId: string): SharingSession | undefined {
    return this.#activeSessions().find((session) => session.participantIds.includes(memberId));
  }

  /** Who a newly added item is split among: the sender's active session, or just the sender. */
  #participantsFor(memberId: string): string[] {
    return this.#activeSessionFor(memberId)?.participantIds ?? [memberId];
  }

  #memberNames(ids: string[]): string[] {
    return this.getMembers().filter((member) => ids.includes(member.id)).map((member) => member.name);
  }

  #joinNames(names: string[]): string {
    if (names.length <= 1) return names.join("");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  #assignmentPhrase(participantIds: string[]): string {
    const names = this.#memberNames(participantIds);
    return participantIds.length > 1 ? `shared by ${this.#joinNames(names)}` : `for ${names[0] ?? "you"}`;
  }

  #sharingNote(participantIds: string[]): string {
    return participantIds.length > 1
      ? ` Your sharing session is on, so anything you add now is split among ${this.#joinNames(this.#memberNames(participantIds))}.`
      : "";
  }

  /** Point people still using the removed per-item phrases at sharing sessions. */
  #legacyShareHint(text: string, memberId: string): string {
    if (this.#activeSessionFor(memberId)) return "";
    if (!/\b(?:shared?|split)\s+(?:with|between|among)\b|\bfor\s+(?:everyone|all\s+of\s+us)\b/i.test(text)) return "";
    return "\nNote: sharing phrases on one item no longer split it. To split new items, first text “start sharing with” plus member names.";
  }

  #parseSharingCommand(text: string): { action: "start" | "stop"; names: string } | undefined {
    const match = text.trim().match(/^(start|stop)\s+sharing\b([\s\S]*)$/i);
    if (!match) return undefined;
    const rest = match[2]!.trim().replace(/[.!?]+$/, "").trim();
    return {
      action: match[1]!.toLocaleLowerCase() === "start" ? "start" : "stop",
      names: rest.replace(/^with\b/i, "").trim(),
    };
  }

  #resolveMemberNames(list: string, memberId: string): { ids: string[]; includesSelf: boolean } | { error: string } {
    const members = this.getMembers();
    const tokens = list.split(/\s*(?:,|&|\+|\band\b)\s*/i)
      .map((token) => token.trim().replace(/^[.!?;:]+|[.!?;:]+$/g, "").trim())
      .filter(Boolean);
    const ids = new Set<string>();
    const unknown: string[] = [];
    const ambiguous: string[] = [];
    let includesSelf = false;
    for (const token of tokens) {
      const lower = token.toLocaleLowerCase();
      if (/^(?:me|myself|i)$/.test(lower)) { includesSelf = true; continue; }
      const exact = members.filter((member) => member.name.toLocaleLowerCase() === lower);
      const candidates = exact.length
        ? exact
        : members.filter((member) => (member.name.split(/\s+/)[0] ?? member.name).toLocaleLowerCase() === lower);
      if (candidates.length === 1) {
        if (candidates[0]!.id === memberId) includesSelf = true;
        else ids.add(candidates[0]!.id);
      } else if (candidates.length > 1) {
        ambiguous.push(token);
      } else {
        unknown.push(token);
      }
    }
    const roster = this.#joinNames(members.filter((member) => member.id !== memberId).map((member) => member.name));
    if (unknown.length) {
      return { error: `I don’t recognize ${this.#joinNames(unknown.map((name) => `“${name}”`))} as ${unknown.length === 1 ? "a household member" : "household members"}. You can share with ${roster || "no other configured members"}. Nothing changed.` };
    }
    if (ambiguous.length) {
      return { error: `${this.#joinNames(ambiguous.map((name) => `“${name}”`))} matches more than one household member; use the full name. Nothing changed.` };
    }
    return { ids: [...ids], includesSelf };
  }

  #startSharing(memberId: string, list: string): string {
    const others = this.getMembers().filter((member) => member.id !== memberId).map((member) => member.name);
    const example = `“start sharing with ${others.slice(0, 2).join(" and ") || "Maya"}”`;
    if (!list) return `Who should share with you? Text ${example}. Nothing changed.`;
    const resolved = this.#resolveMemberNames(list, memberId);
    if ("error" in resolved) return resolved.error;
    if (resolved.includesSelf) {
      return `You’re included automatically, so name only the other members, like ${example}. Nothing changed.`;
    }
    if (!resolved.ids.length) return `Who should share with you? Text ${example}. Nothing changed.`;
    const participantIds = [...new Set([memberId, ...resolved.ids])].sort();
    const current = this.#activeSessionFor(memberId);
    if (current) {
      const sameSet = current.participantIds.length === participantIds.length
        && current.participantIds.every((id) => participantIds.includes(id));
      if (sameSet) {
        return `You’re already sharing: new items from ${this.#joinNames(this.#memberNames(participantIds))} are split among all of you. Text “stop sharing” to end it.`;
      }
      const currentOthers = this.#memberNames(current.participantIds.filter((id) => id !== memberId));
      return `You’re already sharing with ${this.#joinNames(currentOthers)}. Text “stop sharing” to end that session before starting a new one. Nothing changed.`;
    }
    const busy = resolved.ids.flatMap((id) => {
      const session = this.#activeSessionFor(id);
      return session ? [{ id, session }] : [];
    });
    if (busy.length) {
      const details = busy.map(({ id, session }) => {
        const name = this.#memberNames([id])[0] ?? "A member";
        const partners = this.#memberNames(session.participantIds.filter((other) => other !== id));
        return `${name} is already sharing with ${this.#joinNames(partners)}`;
      });
      return `${details.join("; ")}. Someone in that session needs to text “stop sharing” first. Nothing changed.`;
    }
    this.#db.prepare(
      "INSERT INTO sharing_sessions (id, household_id, participant_ids_json, started_by, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), this.#householdId, JSON.stringify(participantIds), memberId, new Date().toISOString());
    return `Started sharing for ${this.#joinNames(this.#memberNames(participantIds))}. From now on, every item any of you adds is split evenly among you until someone texts “stop sharing”. Items already in the cart keep their current split.`;
  }

  #stopSharing(memberId: string, list: string): string {
    const current = this.#activeSessionFor(memberId);
    if (!current) {
      return "You aren’t in a sharing session, so nothing changed. Start one with “start sharing with” plus member names.";
    }
    let namedSubset = false;
    if (list) {
      const resolved = this.#resolveMemberNames(list, memberId);
      if ("error" in resolved) return resolved.error;
      const outside = resolved.ids.filter((id) => !current.participantIds.includes(id));
      if (outside.length) {
        const currentOthers = this.#memberNames(current.participantIds.filter((id) => id !== memberId));
        return `${this.#joinNames(this.#memberNames(outside))} ${outside.length === 1 ? "isn’t" : "aren’t"} in your sharing session (you’re sharing with ${this.#joinNames(currentOthers)}). Text “stop sharing” to end it. Nothing changed.`;
      }
      namedSubset = resolved.ids.length > 0 && resolved.ids.length < current.participantIds.length - 1;
    }
    this.#db.prepare("UPDATE sharing_sessions SET ended_by = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL")
      .run(memberId, new Date().toISOString(), current.id);
    const names = this.#joinNames(this.#memberNames(current.participantIds));
    const restartHint = namedSubset
      ? " The whole session ended for everyone in it; start a new one with anyone you still want to share with."
      : "";
    return `Stopped sharing for ${names}. New items each of you adds are yours alone again; items added during the session stay split as they were.${restartHint}`;
  }

  #clearClarification(memberId: string): void {
    this.#db.prepare("DELETE FROM pending_clarifications WHERE member_id = ?").run(memberId);
  }

  #approveCurrentRevision(memberId: string): string {
    const snapshot = this.snapshot();
    if (!snapshot.items.length) return "There isn’t a cart to approve yet. Text a grocery request first.";
    if (!snapshot.members.some((member) => member.id === memberId)) return "That member isn’t in this household cart.";
    this.#db.prepare(
      "INSERT OR IGNORE INTO approvals (household_id, revision, member_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(this.#householdId, snapshot.revision, memberId, new Date().toISOString());
    const updated = this.snapshot();
    const pending = updated.members.filter((member) => !member.approved).map((member) => member.name);
    return pending.length
      ? `Your approval is saved for cart revision ${updated.revision}. Waiting for: ${pending.join(", ")}. Any cart change will require approvals again.`
      : this.#krogerCartEnabled
        ? `Everyone approved cart revision ${updated.revision}. Text “checkout” to choose a Kroger account and add these items to its cart.`
        : `Everyone approved cart revision ${updated.revision}. Text “checkout” to finish a simulated checkout.`;
  }

  #completeMockCheckout(): string {
    const snapshot = this.snapshot();
    if (!snapshot.items.length) return "There isn’t a cart to check out yet.";
    const pending = snapshot.members.filter((member) => !member.approved).map((member) => member.name);
    if (pending.length) return `Checkout is waiting for approval from: ${pending.join(", ")}. No payment has been made.`;
    this.#db.prepare("DELETE FROM cart_items WHERE household_id = ?").run(this.#householdId);
    this.#clearPendingCartIntents();
    // Checkout closes this list rather than leaving it as the starting point for
    // the next trip. Old approvals and undo entries must not carry forward.
    this.#db.prepare("DELETE FROM cart_undo_history WHERE household_id = ?").run(this.#householdId);
    this.#db.prepare(
      "UPDATE households SET revision = revision + 1, checked_out_revision = ? WHERE id = ?",
    ).run(snapshot.revision, this.#householdId);
    return `Mock checkout complete for ${money(snapshot.totalCents)}. No payment was charged. The cart is cleared for your next list.`;
  }

  #split(totalCents: number, participantIds: string[]): Map<string, number> {
    const unique = [...new Set(participantIds)].sort();
    const result = new Map<string, number>();
    if (unique.length === 0) return result;
    const base = Math.floor(totalCents / unique.length);
    let remainder = totalCents - base * unique.length;
    for (const id of unique) {
      result.set(id, base + (remainder > 0 ? 1 : 0));
      remainder -= remainder > 0 ? 1 : 0;
    }
    return result;
  }

  private formatSummary(memberId: string, addedNames: string[] = [], participantIds: string[] = [memberId]): string {
    const snapshot = this.snapshot();
    const mine = snapshot.members.find((member) => member.id === memberId);
    const lines = snapshot.items.slice(-8).map((item) =>
      `• ${item.quantity} × ${item.name} — ${money(item.totalCents)} (${item.priceSource === "kroger" ? "Kroger" : "sample"}; ${item.participantNames.length > 1 ? `shared: ${item.participantNames.join(", ")}` : `for ${item.ownerName}`})`,
    );
    const shares = snapshot.members.map((member) => `${member.name}: ${money(member.shareCents)}`).join(" · ");
    const prefix = addedNames.length
      ? `Added ${addedNames.join(", ")} ${participantIds.length > 1 ? this.#assignmentPhrase(participantIds) : `for ${mine?.name ?? "you"}`}.\n`
      : "";
    const session = this.#activeSessionFor(memberId);
    const sessionNote = session
      ? `\nSharing session on: ${this.#joinNames(this.#memberNames(session.participantIds))}. Text “stop sharing” to end it.`
      : "";
    const budgetNote = snapshot.totalCents > snapshot.budgetCents
      ? `\nOver the ${money(snapshot.budgetCents)} sample budget by ${money(snapshot.totalCents - snapshot.budgetCents)}.`
      : `\nWithin the ${money(snapshot.budgetCents)} sample budget.`;
    const priceNote = snapshot.items.some((item) => item.priceSource === "kroger")
      ? "Kroger prices are store-specific when a location is configured; sample items are marked."
      : "sample catalog prices";
    return `${prefix}Cart revision ${snapshot.revision} · ${priceNote}\n${lines.join("\n")}\nTotal: ${money(snapshot.totalCents)}\n${shares}${budgetNote}${sessionNote}\nText “cart”, “approve”, or “checkout”.`;
  }

  // ===========================================================================
  // Recurring household lists (weekly, every two weeks, monthly)
  //
  // The lists belong to the whole household. Items are saved with real Kroger
  // product IDs/UPCs in live mode (via the same numbered-choice search) or with
  // sample-catalog IDs in demo mode. Loading a list copies its items into the
  // cart as ordinary cart lines owned by the sender, as one undoable change.

  /** Read-only view of the three lists for the dashboard. */
  listsSnapshot(): RecurringListSnapshot[] {
    const now = this.#now();
    const memberNames = new Map(this.getMembers().map((member) => [member.id, member.name]));
    return LIST_KEYS.map((key) => {
      const row = this.#listRow(key);
      const info = this.#listDueInfo(row, now);
      const items = this.#listItems(key);
      return {
        key,
        title: LIST_TITLES[key],
        command: LIST_COMMAND_NAMES[key],
        schedule: describeSchedule(key, this.#listSchedule(row)),
        active: Boolean(row.active_since),
        remindersEnabled: row.reminders_enabled === 1,
        dueNow: info.dueNow,
        nextReminderAt: info.nextReminderAt?.toISOString() ?? null,
        lastLoadedAt: row.last_loaded_at,
        lastLoadedByName: row.last_loaded_by ? memberNames.get(row.last_loaded_by) ?? null : null,
        estimatedCents: this.#listEstimate(items).cents,
        items: items.map((item) => ({
          id: item.id,
          name: this.#listItemName(item),
          quantity: item.quantity,
          unitPriceCents: this.#listItemUnitPrice(item),
          priceSource: item.price_source === "kroger" ? "kroger" as const : "sample" as const,
          size: item.size,
          quotedAt: item.quoted_at,
        })),
      };
    });
  }

  /**
   * Atomically claim every list whose reminder is due for the current cycle and
   * return one group message for them. Each list is claimed at most once per
   * cycle; call `releaseListReminders` if the message could not be delivered.
   */
  claimDueListReminders(): ListReminderClaim | null {
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const claims: ListReminderClaim["claims"] = [];
      const parts: string[] = [];
      for (const key of LIST_KEYS) {
        const row = this.#listRow(key);
        const info = this.#listDueInfo(row, now);
        if (!info.shouldRemind) continue;
        claims.push({ listKey: key, cycleKey: info.cycleKey, previous: row.last_reminded_cycle });
        this.#db.prepare("UPDATE recurring_lists SET last_reminded_cycle = ? WHERE household_id = ? AND list_key = ?")
          .run(info.cycleKey, this.#householdId, key);
        parts.push(this.#reminderText(key));
      }
      this.#db.exec("COMMIT");
      if (!claims.length) return null;
      const pauseHint = claims.map(({ listKey }) => `“pause ${LIST_COMMAND_NAMES[listKey]} reminders”`).join(" or ");
      return { text: `${parts.join("\n\n")}\n(Text ${pauseHint} to stop these check-ins.)`, claims };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Undo a claim whose message was not delivered, so a later attempt can send it. */
  releaseListReminders(claim: ListReminderClaim): void {
    const update = this.#db.prepare(
      "UPDATE recurring_lists SET last_reminded_cycle = ? WHERE household_id = ? AND list_key = ? AND last_reminded_cycle = ?",
    );
    for (const entry of claim.claims) update.run(entry.previous, this.#householdId, entry.listKey, entry.cycleKey);
  }

  /** Persist the household group conversation the bot has received allowlisted messages from. */
  rememberGroupSpace(spaceId: string, phone?: string): void {
    const existing = this.groupSpace();
    if (existing && existing.id === spaceId && existing.phone === phone) return;
    this.#db.prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(`group_space:${this.#householdId}`, JSON.stringify({ id: spaceId, phone: phone ?? null, seenAt: this.#now().toISOString() }));
  }

  groupSpace(): { id: string; phone?: string } | undefined {
    const row = this.#db.prepare("SELECT value FROM app_state WHERE key = ?")
      .get(`group_space:${this.#householdId}`) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value) as { id?: unknown; phone?: unknown };
      if (typeof parsed.id !== "string" || !parsed.id) return undefined;
      return typeof parsed.phone === "string" && parsed.phone ? { id: parsed.id, phone: parsed.phone } : { id: parsed.id };
    } catch {
      return undefined;
    }
  }

  #ensureRecurringListTables(): void {
    this.#db.exec(`
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
    const insert = this.#db.prepare("INSERT OR IGNORE INTO recurring_lists (household_id, list_key) VALUES (?, ?)");
    for (const key of LIST_KEYS) insert.run(this.#householdId, key);
  }

  #listRow(list: ListKey): ListRow {
    return this.#db.prepare(
      "SELECT list_key, anchor_weekday, anchor_date, day_of_month, active_since, last_loaded_at, last_loaded_by, last_reminded_cycle, reminders_enabled, revision FROM recurring_lists WHERE household_id = ? AND list_key = ?",
    ).get(this.#householdId, list) as ListRow;
  }

  #listItems(list: ListKey): ListItemRow[] {
    return this.#db.prepare(
      "SELECT id, list_key, product_id, product_name, quantity, unit_price_cents, price_source, upc, size, added_by, created_at, quoted_at FROM recurring_list_items WHERE household_id = ? AND list_key = ? ORDER BY created_at, rowid",
    ).all(this.#householdId, list) as ListItemRow[];
  }

  #listSchedule(row: ListRow): ListSchedule {
    return { anchorWeekday: row.anchor_weekday, anchorDate: row.anchor_date, dayOfMonth: row.day_of_month };
  }

  #listItemName(item: ListItemRow): string {
    return item.product_name ?? CATALOG.find((product) => product.id === item.product_id)?.name ?? "item";
  }

  #listItemUnitPrice(item: ListItemRow): number | null {
    if (item.price_source === "sample") {
      return CATALOG.find((product) => product.id === item.product_id)?.priceCents ?? item.unit_price_cents;
    }
    return item.unit_price_cents;
  }

  #listEstimate(items: ListItemRow[]): { cents: number; unpriced: number } {
    let cents = 0;
    let unpriced = 0;
    for (const item of items) {
      const price = this.#listItemUnitPrice(item);
      if (price === null) unpriced += 1;
      else cents += price * item.quantity;
    }
    return { cents, unpriced };
  }

  /**
   * Cadence rules (server local time):
   * - A cycle starts at local midnight on the anchor day (weekly: anchor weekday;
   *   biweekly: every 14 days from the anchor date; monthly: day-of-month,
   *   clamped to short months).
   * - Only cycles that start after the list was activated count, so a new list
   *   is first announced at the next cycle start.
   * - A load within 2 days before a cycle start counts for that cycle.
   * - The reminder is sent once, at or after `reminderHour` on the cycle start day.
   */
  #listDueInfo(row: ListRow, now: Date): ListDueInfo {
    const schedule = this.#listSchedule(row);
    const cycleStart = currentCycleStart(row.list_key, schedule, now);
    const cycleKey = `${row.list_key}:${localDateKey(cycleStart)}`;
    const loadedAt = row.last_loaded_at ? new Date(row.last_loaded_at) : null;
    const loadedThisCycle = loadedAt !== null && loadedAt >= addLocalDays(cycleStart, -2);
    const activeSince = row.active_since ? new Date(row.active_since) : null;
    const remindAt = (start: Date): Date => new Date(start.getFullYear(), start.getMonth(), start.getDate(), this.#reminderHour);
    const cycleCounts = activeSince !== null && cycleStart > activeSince;
    const dueNow = cycleCounts && now >= remindAt(cycleStart) && !loadedThisCycle;
    const remindersOn = row.reminders_enabled === 1;
    const shouldRemind = dueNow && remindersOn && row.last_reminded_cycle !== cycleKey;
    let nextReminderAt: Date | null = null;
    if (activeSince && remindersOn) {
      nextReminderAt = cycleCounts && !loadedThisCycle && row.last_reminded_cycle !== cycleKey
        ? remindAt(cycleStart)
        : remindAt(nextCycleStart(row.list_key, schedule, cycleStart));
    }
    return { cycleStart, cycleKey, loadedThisCycle, dueNow, shouldRemind, nextReminderAt };
  }

  #pendingListSelection(memberId: string): PendingListSelection | undefined {
    const row = this.#db.prepare(
      "SELECT list_key, requests_json, results_json FROM pending_list_selections WHERE member_id = ?",
    ).get(memberId) as { list_key: ListKey; requests_json: string; results_json: string | null } | undefined;
    if (!row) return undefined;
    return {
      listKey: row.list_key,
      requests: JSON.parse(row.requests_json) as ListRequest[],
      results: row.results_json ? JSON.parse(row.results_json) as BatchProductResult[] : null,
    };
  }

  #savePendingListSelection(memberId: string, selection: PendingListSelection): void {
    this.#db.prepare(
      "INSERT INTO pending_list_selections (member_id, list_key, requests_json, results_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET list_key = excluded.list_key, requests_json = excluded.requests_json, results_json = excluded.results_json, created_at = excluded.created_at",
    ).run(memberId, selection.listKey, JSON.stringify(selection.requests), selection.results ? JSON.stringify(selection.results) : null, new Date().toISOString());
  }

  /**
   * One unfinished selection per member: starting a list selection discards any
   * unfinished cart selection so numbered replies can never go to the wrong place.
   */
  #replaceOtherPendingSelections(memberId: string): string {
    const tables = ["pending_product_choices", "pending_product_batches", "pending_clarifications", "pending_item_cancellations"];
    let hadPending = false;
    for (const table of tables) {
      const result = this.#db.prepare(`DELETE FROM ${table} WHERE member_id = ?`).run(memberId);
      if (Number(result.changes) > 0) hadPending = true;
    }
    return hadPending ? "(I discarded your unfinished cart selection.)\n" : "";
  }

  #hasOtherPendingIntent(memberId: string): boolean {
    const tables = ["pending_product_choices", "pending_product_batches", "pending_clarifications", "pending_item_cancellations", "pending_list_selections"];
    if (tables.some((table) => this.#db.prepare(`SELECT 1 FROM ${table} WHERE member_id = ?`).get(memberId))) return true;
    return this.#getPendingKrogerCheckout()?.requesterId === memberId;
  }

  /** Parse a list command, including bare “yes”/“cancel” replies to a pending list clear. */
  #listCommandFor(memberId: string, text: string): ListCommand | undefined {
    const command = parseListCommand(text);
    if (command) return command;
    const bare = text.trim().replace(/[.!?]+$/, "").trim();
    if (!/^(yes|confirm|cancel|never mind|nevermind)$/i.test(bare)) return undefined;
    if (!this.#db.prepare("SELECT 1 FROM pending_list_clears WHERE member_id = ?").get(memberId)) return undefined;
    if (this.#hasPendingClearAll(memberId) || this.#hasOtherPendingIntent(memberId)) return undefined;
    return /^(yes|confirm)$/i.test(bare) ? { kind: "confirmClear" } : { kind: "cancelClear" };
  }

  /** Demo / sample-catalog mode. Runs inside processIncomingText's transaction. */
  #catalogListTurn(memberId: string, text: string): string | undefined {
    const command = this.#listCommandFor(memberId, text);
    if (command) return this.#runListCommand(memberId, command, "catalog");
    const pending = this.#pendingListSelection(memberId);
    if (!pending) return undefined;
    if (CART_COMMAND_PATTERN.test(text) || this.#isHelpRequest(text) || (/^yes$/i.test(text) && this.#hasPendingClearAll(memberId))) {
      return undefined;
    }
    const label = LIST_LABELS[pending.listKey];
    if (/^(cancel|never mind|nevermind)$/i.test(text)) {
      this.#db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
      return `Okay, nothing was added to the ${label} list.`;
    }
    if (pending.results) return this.#saveListSelections(memberId, pending, text);
    const milk = resolveMilkChoice(text);
    if (!milk) {
      return `For the ${label} list: which kind of milk? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond, or “cancel”.`;
    }
    this.#db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
    return this.#saveCatalogListRequests(memberId, pending.listKey, pending.requests, milk);
  }

  async #handleLiveListCommand(
    messageId: string,
    memberId: string,
    command: ListCommand,
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
    quoteProduct?: ProductQuoter,
  ): Promise<string | null> {
    if (command.kind === "add") {
      return this.#liveListAdd(messageId, memberId, command.list, command.itemText, searchProducts, locationId);
    }
    if (command.kind === "load") {
      let quotes: Map<string, ProductQuote> | undefined;
      if (quoteProduct && !this.#listLoadBlocker(command.list, command.force)) {
        quotes = await this.#quoteListItems(command.list, quoteProduct);
      }
      return this.#transactReply(messageId, () => this.#loadListIntoCart(memberId, command.list, command.force, quotes, Boolean(quoteProduct)));
    }
    return this.#transactReply(messageId, () => this.#runListCommand(memberId, command, "live"));
  }

  /** Run `produce` in a transaction and record its reply for this message ID (idempotent). */
  #transactReply(messageId: string, produce: () => string): string | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#existingReply(messageId);
      if (existing !== undefined) {
        this.#db.exec("COMMIT");
        return existing;
      }
      const reply = produce();
      this.#recordReply(messageId, reply);
      this.#db.exec("COMMIT");
      return reply;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Synchronous list commands shared by demo and live mode; caller holds the transaction. */
  #runListCommand(memberId: string, command: ListCommand, mode: "catalog" | "live"): string {
    switch (command.kind) {
      case "overview": return this.#formatListsOverview();
      case "setup": return this.#listSetupPrompt(mode);
      case "view": return this.#formatListView(command.list);
      case "add":
        if (mode === "live") throw new Error("Live list additions must use the Kroger search flow.");
        return this.#catalogListAdd(memberId, command.list, command.itemText);
      case "remove": return this.#removeFromList(command.list, command.itemText);
      case "quantity": return this.#setListQuantity(command.list, command.itemText, command.quantity);
      case "clear": return this.#requestListClear(memberId, command.list);
      case "confirmClear": return this.#confirmListClear(memberId, command.list);
      case "cancelClear": return this.#cancelListClear(memberId, command.list);
      case "load": return this.#loadListIntoCart(memberId, command.list, command.force, undefined, false);
      case "start": return this.#startList(command.list);
      case "scheduleWeekday": return this.#setListWeekday(command.list, command.weekday);
      case "scheduleMonthDay": return this.#setListMonthDay(command.list, command.dayOfMonth);
      case "reminders": return this.#setListReminders(command.list, command.enabled);
    }
  }

  #parseListRequests(list: ListKey, itemText: string): ListRequest[] | string {
    const label = LIST_LABELS[list];
    const segments = itemText.split(/\s*(?:,|;|\n)\s*|\s+and\s+|\s+&\s+/i)
      .map((segment) => segment.trim().replace(/^(?:and|&)\s+/i, "").replace(/[.!?]+$/g, "").trim())
      .filter(Boolean);
    if (!segments.length) return `Tell me what to add to the ${label} list, for example “${LIST_COMMAND_NAMES[list]}: milk, eggs, bread”.`;
    if (segments.length > 5) {
      return `I can save up to 5 items from one message. Nothing was added to the ${label} list; split it into smaller batches.`;
    }
    const requests = segments.map((segment): ListRequest => {
      const priceLimit = this.#priceLimit(segment);
      const itemPart = segment.replace(PRICE_LIMIT_PATTERN, " ").replace(/\s+/g, " ").trim();
      const extracted = extractCartRequests(itemPart);
      return {
        query: this.#retailerQuery(itemPart),
        quantity: extracted.length === 1 ? extracted[0]!.quantity : this.#quantityFromText(itemPart),
        ...(priceLimit ? { maxPriceCents: priceLimit.cents, maxPriceInclusive: priceLimit.inclusive } : {}),
      };
    });
    if (requests.some((request) => request.query.length < 2)) {
      return `I couldn’t tell which items to add. Nothing was added to the ${label} list. Try “${LIST_COMMAND_NAMES[list]}: milk, eggs, bread”.`;
    }
    return requests;
  }

  #catalogListAdd(memberId: string, list: ListKey, itemText: string): string {
    const label = LIST_LABELS[list];
    const branded = unsupportedBrandedRequest(itemText);
    if (branded) {
      return `I heard “${branded}”, but live product lookup isn’t connected, so I didn’t save a substitute to the ${label} list.`;
    }
    const parsed = this.#parseListRequests(list, itemText);
    if (typeof parsed === "string") return parsed;
    if (parsed.some((request) => isGenericMilkRequest(request.query))) {
      const replaced = this.#replaceOtherPendingSelections(memberId);
      this.#savePendingListSelection(memberId, { listKey: list, requests: parsed, results: null });
      return `${replaced}For the ${label} list: which kind of milk? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond, or “cancel”.`;
    }
    return this.#saveCatalogListRequests(memberId, list, parsed);
  }

  #saveCatalogListRequests(memberId: string, list: ListKey, requests: ListRequest[], milk?: Product): string {
    const label = LIST_LABELS[list];
    const resolved = requests.map((request) => ({
      request,
      product: milk && isGenericMilkRequest(request.query) ? milk : extractCartRequests(request.query)[0]?.product,
    }));
    const unmatched = resolved.filter((entry) => !entry.product).map((entry) => `“${entry.request.query}”`);
    if (unmatched.length) {
      return `I couldn’t match ${unmatched.join(" and ")} to the sample catalog, so nothing was saved to the ${label} list. Try milk, oat milk, eggs, bananas, pasta, tomato sauce, parmesan, bread, apples, or peanut butter.`;
    }
    const overCap = resolved.filter(({ request, product }) => request.maxPriceCents !== undefined
      && !(request.maxPriceInclusive ? product!.priceCents <= request.maxPriceCents : product!.priceCents < request.maxPriceCents));
    if (overCap.length) {
      return `${overCap.map(({ product, request }) => `${product!.name} (${money(product!.priceCents)} sample estimate) isn’t ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents!)}`).join("; ")}. Nothing was saved to the ${label} list.`;
    }
    const lines = resolved.map(({ request, product }) => {
      const outcome = this.#upsertListItem(list, memberId, {
        productId: product!.id,
        name: product!.name,
        quantity: request.quantity,
        unitPriceCents: product!.priceCents,
        priceSource: "sample",
        upc: null,
        size: null,
      });
      return `• ${request.quantity} × ${product!.name} — ${money(product!.priceCents * request.quantity)} sample estimate${outcome === "updated" ? " (updated the existing entry)" : ""}`;
    });
    return this.#listSavedReply(list, lines);
  }

  async #liveListAdd(
    messageId: string,
    memberId: string,
    list: ListKey,
    itemText: string,
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
  ): Promise<string | null> {
    const label = LIST_LABELS[list];
    const parsed = this.#parseListRequests(list, itemText);
    if (typeof parsed === "string") return this.#transactReply(messageId, () => parsed);
    if (parsed.some((request) => isGenericMilkRequest(request.query))) {
      return this.#transactReply(messageId, () => {
        const replaced = this.#replaceOtherPendingSelections(memberId);
        this.#savePendingListSelection(memberId, { listKey: list, requests: parsed, results: null });
        const rest = parsed.length > 1 ? "; then I’ll show Kroger choices for every item" : "";
        return `${replaced}For the ${label} list: which kind of milk? Reply whole, 2%, oat, or almond${rest}. Or say “cancel”.`;
      });
    }
    return this.#searchListRequests(messageId, memberId, list, parsed, searchProducts, locationId);
  }

  async #searchListRequests(
    messageId: string,
    memberId: string,
    list: ListKey,
    requests: ListRequest[],
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
  ): Promise<string | null> {
    const label = LIST_LABELS[list];
    const optionLimit = requests.length === 1 ? 5 : 3;
    let results: BatchProductResult[];
    try {
      results = await Promise.all(requests.map(async (request) => {
        const result = await searchProducts(request.query);
        const matching = result.products.filter((product) => this.#meetsPriceLimit(product, request.maxPriceCents, request.maxPriceInclusive ?? false));
        return { total: matching.length, products: matching.slice(0, optionLimit) };
      }));
    } catch (error) {
      return this.#transactReply(messageId, () => {
        this.#db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
        return `I couldn’t reach Kroger’s product search just now (${error instanceof Error ? error.message : "request failed"}). Nothing was saved to the ${label} list; please try again.`;
      });
    }
    const missing = requests.flatMap((request, index) => results[index]!.products.length ? [] : [
      request.maxPriceCents === undefined
        ? `“${request.query}”`
        : `“${request.query}” ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)}`,
    ]);
    if (missing.length) {
      return this.#transactReply(messageId, () => {
        this.#db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
        return `I couldn’t find Kroger products for ${missing.join(" and ")} at the configured store. Nothing was saved to the ${label} list. Try a more specific description or raise the item budget.`;
      });
    }
    return this.#transactReply(messageId, () => {
      const replaced = this.#replaceOtherPendingSelections(memberId);
      this.#savePendingListSelection(memberId, { listKey: list, requests, results });
      const storeNote = locationId ? ` at the selected Kroger store (${locationId})` : "; choose a store to get local prices";
      const option = (product: KrogerProduct, index: number, indent: string): string => {
        const cents = this.#currentPrice(product);
        return `${indent}${index + 1}) ${product.description}${product.size ? ` · ${product.size}` : ""} — ${cents === null ? "price unavailable" : money(cents)}`;
      };
      if (requests.length === 1) {
        const request = requests[0]!;
        const products = results[0]!.products;
        const cap = request.maxPriceCents === undefined ? "" : ` (showing options ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)} each)`;
        return `${replaced}For the ${label} list, Kroger found ${products.length} matching options${cap} for “${request.query}”${storeNote}:\n${products.map((product, index) => option(product, index, "")).join("\n")}\nReply 1-${products.length} to save your choice to the ${label} list, or “cancel”.`;
      }
      const sections = requests.map((request, index) => {
        const cap = request.maxPriceCents === undefined ? "" : ` · ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)} each`;
        return `${index + 1}. ${request.quantity > 1 ? `${request.quantity} × ` : ""}${request.query}${cap} (${results[index]!.total} options)\n${results[index]!.products.map((product, optionIndex) => option(product, optionIndex, "   ")).join("\n")}`;
      });
      return `${replaced}For the ${label} list, I found options for your ${requests.length} items${storeNote}:\n${sections.join("\n")}\nReply with one choice number per item in order, separated by commas (for example “1, 2, 1”). Nothing is saved until all choices are selected. Reply “cancel” to discard this search.`;
    });
  }

  async #continueLiveListSelection(
    messageId: string,
    memberId: string,
    text: string,
    pending: PendingListSelection,
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
  ): Promise<string | null> {
    const label = LIST_LABELS[pending.listKey];
    if (/^(cancel|never mind|nevermind)$/i.test(text)) {
      return this.#transactReply(messageId, () => {
        this.#db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
        return `Okay, nothing was added to the ${label} list.`;
      });
    }
    if (!pending.results) {
      const milk = this.#milkSearchQuery(text);
      if (!milk) {
        return this.#transactReply(messageId, () => `For the ${label} list: which kind of milk? Reply whole, 2%, oat, or almond, or “cancel”.`);
      }
      const requests = pending.requests.map((request) => isGenericMilkRequest(request.query) ? { ...request, query: milk } : request);
      return this.#searchListRequests(messageId, memberId, pending.listKey, requests, searchProducts, locationId);
    }
    return this.#transactReply(messageId, () => this.#saveListSelections(memberId, pending, text));
  }

  /** Save numbered Kroger choices from a pending selection to its list; caller holds the transaction. */
  #saveListSelections(memberId: string, pending: PendingListSelection, text: string): string {
    const label = LIST_LABELS[pending.listKey];
    const results = pending.results ?? [];
    const numbers = text.match(/^\s*\d+(?:\s*(?:,|\s)\s*\d+)*\s*$/)?.[0].trim().split(/[\s,]+/).map(Number);
    const valid = numbers !== undefined
      && numbers.length === pending.requests.length
      && numbers.every((number, index) => Number.isInteger(number) && number >= 1 && number <= (results[index]?.products.length ?? 0));
    if (!valid) {
      return pending.requests.length === 1
        ? `Please reply with a number from 1 to ${results[0]?.products.length ?? 1}, or “cancel”. I’m still waiting to save your choice to the ${label} list.`
        : `Reply with one result number for each item, in order (for example “1, 2, 1”), or “cancel”. Nothing has been saved to the ${label} list yet.`;
    }
    this.#db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
    const lines = pending.requests.map((request, index) => {
      const product = results[index]!.products[numbers![index]! - 1]!;
      const cents = this.#currentPrice(product);
      const outcome = this.#upsertListItem(pending.listKey, memberId, {
        productId: `kroger:${product.productId}`,
        name: product.description,
        quantity: request.quantity,
        unitPriceCents: cents,
        priceSource: "kroger",
        upc: product.upc,
        size: product.size,
      });
      const price = cents === null ? "no current store price (I’ll re-quote when the list is loaded)" : `${money(cents * request.quantity)} Kroger quote`;
      return `• ${request.quantity} × ${product.description}${product.size ? ` · ${product.size}` : ""} — ${price}${outcome === "updated" ? " (updated the existing entry)" : ""}`;
    });
    return this.#listSavedReply(pending.listKey, lines);
  }

  #upsertListItem(list: ListKey, memberId: string, item: {
    productId: string; name: string; quantity: number; unitPriceCents: number | null;
    priceSource: "sample" | "kroger"; upc: string | null; size: string | null;
  }): "added" | "updated" {
    const now = this.#now().toISOString();
    const existing = this.#db.prepare(
      "SELECT id FROM recurring_list_items WHERE household_id = ? AND list_key = ? AND product_id = ?",
    ).get(this.#householdId, list, item.productId) as { id: string } | undefined;
    if (existing) {
      this.#db.prepare(
        "UPDATE recurring_list_items SET quantity = ?, product_name = ?, unit_price_cents = ?, price_source = ?, upc = ?, size = ?, quoted_at = ? WHERE id = ?",
      ).run(item.quantity, item.name, item.unitPriceCents, item.priceSource, item.upc, item.size, now, existing.id);
    } else {
      this.#db.prepare(
        "INSERT INTO recurring_list_items (id, household_id, list_key, product_id, product_name, quantity, unit_price_cents, price_source, upc, size, added_by, created_at, quoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(randomUUID(), this.#householdId, list, item.productId, item.name, item.quantity, item.unitPriceCents,
        item.priceSource, item.upc, item.size, memberId, now, now);
    }
    this.#db.prepare("UPDATE recurring_lists SET revision = revision + 1 WHERE household_id = ? AND list_key = ?")
      .run(this.#householdId, list);
    return existing ? "updated" : "added";
  }

  /** Mark a list active (reminders start at the next cycle). Returns a note when newly activated. */
  #activateList(list: ListKey): string {
    const row = this.#listRow(list);
    if (row.active_since) return "";
    const now = this.#now();
    const anchorDate = list === "biweekly" && !row.anchor_date
      ? localDateKey(nextWeekdayAfter(now, row.anchor_weekday))
      : row.anchor_date;
    this.#db.prepare("UPDATE recurring_lists SET active_since = ?, anchor_date = ? WHERE household_id = ? AND list_key = ?")
      .run(now.toISOString(), anchorDate, this.#householdId, list);
    const updated = this.#listRow(list);
    const next = this.#listDueInfo(updated, now).nextReminderAt;
    const schedule = describeSchedule(list, this.#listSchedule(updated));
    return next && updated.reminders_enabled === 1
      ? `I’ll check in with the group about the ${LIST_LABELS[list]} list ${schedule}, starting ${friendlyDate(next)}.`
      : "";
  }

  #listSavedReply(list: ListKey, lines: string[]): string {
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const activation = this.#activateList(list);
    const items = this.#listItems(list);
    const estimate = this.#listEstimate(items);
    return [
      `Saved to the household’s ${label} list:`,
      ...lines,
      `The ${label} list now has ${items.length} item${items.length === 1 ? "" : "s"} (about ${money(estimate.cents)}${estimate.unpriced ? `, plus ${estimate.unpriced} unpriced` : ""}).${activation ? ` ${activation}` : ""}`,
      `Text “${command} list” to review it or “load ${command} list” to add it to the cart.`,
    ].join("\n");
  }

  #matchListItems(list: ListKey, itemText: string): { items: ListItemRow[]; matches: ListItemRow[] } {
    const items = this.#listItems(list);
    const trimmed = itemText.trim();
    if (/^#?\d{1,2}$/.test(trimmed)) {
      const item = items[Number(trimmed.replace("#", "")) - 1];
      return { items, matches: item ? [item] : [] };
    }
    const tokens = this.#retailerQuery(trimmed)
      .replace(/\b(?:the|my|our|some|a|an|all|of)\b/gi, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) return { items, matches: [] };
    const contains = (name: string, token: string): boolean => name.includes(token)
      || (token.length > 3 && token.endsWith("s") && name.includes(token.slice(0, -1)));
    const matches = items.filter((item) => {
      const name = this.#listItemName(item).toLocaleLowerCase();
      return tokens.every((token) => contains(name, token.toLocaleLowerCase()));
    });
    return { items, matches };
  }

  #ambiguousListMatch(list: ListKey, itemText: string, matches: ListItemRow[], items: ListItemRow[], verb: string): string {
    const command = LIST_COMMAND_NAMES[list];
    const options = matches.map((item) => `${items.indexOf(item) + 1}) ${item.quantity} × ${this.#listItemName(item)}`).join("\n");
    return `More than one ${LIST_LABELS[list]} list item matches “${itemText}”:\n${options}\nSay which one by number, for example “${verb === "remove" ? `remove ${items.indexOf(matches[0]!) + 1} from ${command} list` : `set ${items.indexOf(matches[0]!) + 1} on ${command} list to 2`}”. Nothing was changed.`;
  }

  #removeFromList(list: ListKey, itemText: string): string {
    const label = LIST_LABELS[list];
    const { items, matches } = this.#matchListItems(list, itemText);
    if (!matches.length) {
      return `I couldn’t find “${itemText}” on the ${label} list, so nothing was removed. Text “${LIST_COMMAND_NAMES[list]} list” to see it.`;
    }
    if (matches.length > 1) return this.#ambiguousListMatch(list, itemText, matches, items, "remove");
    const item = matches[0]!;
    this.#db.prepare("DELETE FROM recurring_list_items WHERE id = ?").run(item.id);
    this.#db.prepare("UPDATE recurring_lists SET revision = revision + 1 WHERE household_id = ? AND list_key = ?")
      .run(this.#householdId, list);
    const remaining = items.length - 1;
    return `Removed ${this.#listItemName(item)} from the ${label} list. It now has ${remaining} item${remaining === 1 ? "" : "s"}. The cart was not changed.`;
  }

  #setListQuantity(list: ListKey, itemText: string, quantity: number): string {
    if (quantity === 0) return this.#removeFromList(list, itemText);
    const label = LIST_LABELS[list];
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return "Quantities must be between 1 and 99.";
    const { items, matches } = this.#matchListItems(list, itemText);
    if (!matches.length) return `I couldn’t find “${itemText}” on the ${label} list, so nothing was changed.`;
    if (matches.length > 1) return this.#ambiguousListMatch(list, itemText, matches, items, "quantity");
    const item = matches[0]!;
    this.#db.prepare("UPDATE recurring_list_items SET quantity = ? WHERE id = ?").run(quantity, item.id);
    this.#db.prepare("UPDATE recurring_lists SET revision = revision + 1 WHERE household_id = ? AND list_key = ?")
      .run(this.#householdId, list);
    return `Set ${this.#listItemName(item)} on the ${label} list to ${quantity}. The cart was not changed.`;
  }

  #requestListClear(memberId: string, list: ListKey): string {
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const items = this.#listItems(list);
    if (!items.length) return `The ${label} list is already empty.`;
    this.#db.prepare(
      "INSERT INTO pending_list_clears (member_id, list_key, list_revision, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET list_key = excluded.list_key, list_revision = excluded.list_revision, created_at = excluded.created_at",
    ).run(memberId, list, this.#listRow(list).revision, new Date().toISOString());
    return `This will remove all ${items.length} item${items.length === 1 ? "" : "s"} from the household’s ${label} list for everyone (the cart is not affected, and this can’t be undone). Reply “confirm clear ${command} list” to proceed, or “cancel clear ${command} list”.`;
  }

  #confirmListClear(memberId: string, list?: ListKey): string {
    const pending = this.#db.prepare("SELECT list_key, list_revision FROM pending_list_clears WHERE member_id = ?")
      .get(memberId) as { list_key: ListKey; list_revision: number } | undefined;
    if (!pending || (list && pending.list_key !== list)) {
      const name = list ? LIST_COMMAND_NAMES[list] : "weekly";
      return `There isn’t a pending request from you to clear ${list ? `the ${LIST_LABELS[list]}` : "a"} list. Text “clear ${name} list” first.`;
    }
    const key = pending.list_key;
    const label = LIST_LABELS[key];
    const command = LIST_COMMAND_NAMES[key];
    const row = this.#listRow(key);
    const items = this.#listItems(key);
    if (row.revision !== pending.list_revision) {
      this.#db.prepare("UPDATE pending_list_clears SET list_revision = ?, created_at = ? WHERE member_id = ?")
        .run(row.revision, new Date().toISOString(), memberId);
      return `The ${label} list changed since you asked. It now has ${items.length} item${items.length === 1 ? "" : "s"}. Reply “confirm clear ${command} list” again to clear it, or “cancel clear ${command} list”.`;
    }
    this.#db.prepare("DELETE FROM pending_list_clears WHERE member_id = ?").run(memberId);
    this.#db.prepare("DELETE FROM recurring_list_items WHERE household_id = ? AND list_key = ?").run(this.#householdId, key);
    this.#db.prepare("UPDATE recurring_lists SET revision = revision + 1 WHERE household_id = ? AND list_key = ?")
      .run(this.#householdId, key);
    return `Cleared the ${label} list (${items.length} item${items.length === 1 ? "" : "s"} removed). The cart was not changed. Add new items with “${command}: …”.`;
  }

  #cancelListClear(memberId: string, list?: ListKey): string {
    const pending = this.#db.prepare("SELECT list_key FROM pending_list_clears WHERE member_id = ?")
      .get(memberId) as { list_key: ListKey } | undefined;
    if (!pending || (list && pending.list_key !== list)) return "There isn’t a pending list clear to cancel.";
    this.#db.prepare("DELETE FROM pending_list_clears WHERE member_id = ?").run(memberId);
    return `Okay, I left the ${LIST_LABELS[pending.list_key]} list unchanged.`;
  }

  /** Why a load can’t proceed (empty list or already loaded this cycle), if anything. */
  #listLoadBlocker(list: ListKey, force: boolean): string | undefined {
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    if (!this.#listItems(list).length) {
      return `The ${label} list is empty, so nothing was added to the cart. Add items with “${command}: milk, eggs”.`;
    }
    if (force) return undefined;
    const row = this.#listRow(list);
    if (row.last_loaded_at && this.#listDueInfo(row, this.#now()).loadedThisCycle) {
      const by = row.last_loaded_by ? this.getMembers().find((member) => member.id === row.last_loaded_by)?.name : undefined;
      return `The ${label} list was already loaded into the cart on ${friendlyDate(new Date(row.last_loaded_at))}${by ? ` by ${by}` : ""}, so I didn’t add it again. Text “load ${command} list again” if you really want another copy.`;
    }
    return undefined;
  }

  /** Called when a cart undo entry is reverted: if it was a list load, restore the previous load state. */
  #revertListLoad(undoId: string): void {
    const load = this.#db.prepare(
      "SELECT list_key, prev_loaded_at, prev_loaded_by FROM recurring_list_loads WHERE household_id = ? AND undo_id = ?",
    ).get(this.#householdId, undoId) as { list_key: ListKey; prev_loaded_at: string | null; prev_loaded_by: string | null } | undefined;
    if (!load) return;
    this.#db.prepare("UPDATE recurring_lists SET last_loaded_at = ?, last_loaded_by = ? WHERE household_id = ? AND list_key = ?")
      .run(load.prev_loaded_at, load.prev_loaded_by, this.#householdId, load.list_key);
    this.#db.prepare("DELETE FROM recurring_list_loads WHERE undo_id = ?").run(undoId);
  }

  async #quoteListItems(list: ListKey, quoteProduct: ProductQuoter): Promise<Map<string, ProductQuote>> {
    const krogerItems = this.#listItems(list).filter((item) => item.price_source === "kroger" && item.product_id.startsWith("kroger:"));
    const entries = await Promise.all(krogerItems.map(async (item): Promise<[string, ProductQuote]> => {
      try {
        return [item.product_id, { product: await quoteProduct(item.product_id.slice("kroger:".length)) }];
      } catch (error) {
        return [item.product_id, { product: null, error: error instanceof Error ? error.message : "Kroger request failed" }];
      }
    }));
    return new Map(entries);
  }

  /**
   * Copy a list into the cart as ordinary cart lines owned by the sender, as one
   * cart revision and one undo step. Kroger items use a fresh store quote when
   * one is available; otherwise the last saved quote is used and flagged.
   * Products already in the cart are skipped unless forced (“again”).
   */
  #loadListIntoCart(memberId: string, list: ListKey, force: boolean, quotes: Map<string, ProductQuote> | undefined, liveQuotes: boolean): string {
    const blocker = this.#listLoadBlocker(list, force);
    if (blocker) return blocker;
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const items = this.#listItems(list);
    const inCart = new Set((this.#db.prepare("SELECT product_id FROM cart_items WHERE household_id = ?")
      .all(this.#householdId) as Array<{ product_id: string }>).map((row) => row.product_id));
    const undoSnapshot = this.#captureCartItems();
    const createdAt = new Date().toISOString();
    const nowIso = this.#now().toISOString();
    const insertSample = this.#db.prepare(
      "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertKroger = this.#db.prepare(
      "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Loaded items follow the sender's sharing session like any other add.
    const participantIds = this.#participantsFor(memberId);
    const participants = JSON.stringify(participantIds);
    const added: string[] = [];
    const flagged: string[] = [];
    const alreadyInCart: string[] = [];
    const unpriced: string[] = [];
    for (const item of items) {
      const name = this.#listItemName(item);
      if (!force && inCart.has(item.product_id)) {
        alreadyInCart.push(name);
        continue;
      }
      const catalogProduct = item.price_source === "sample" ? CATALOG.find((product) => product.id === item.product_id) : undefined;
      if (catalogProduct) {
        insertSample.run(randomUUID(), this.#householdId, item.product_id, item.quantity, memberId, participants, createdAt);
        added.push(`• ${item.quantity} × ${catalogProduct.name} — ${money(catalogProduct.priceCents * item.quantity)} (sample estimate)`);
        continue;
      }
      const quote = quotes?.get(item.product_id);
      const quotedPrice = quote?.product ? this.#currentPrice(quote.product) : null;
      const price = quotedPrice ?? item.unit_price_cents;
      if (price === null) {
        unpriced.push(name);
        continue;
      }
      const finalName = quote?.product && quotedPrice !== null ? quote.product.description : name;
      const upc = quote?.product && quotedPrice !== null ? quote.product.upc ?? item.upc : item.upc;
      insertKroger.run(randomUUID(), this.#householdId, item.product_id, item.quantity, memberId, participants, createdAt,
        finalName, price, "kroger", upc);
      if (quotedPrice !== null) {
        this.#db.prepare("UPDATE recurring_list_items SET product_name = ?, unit_price_cents = ?, upc = ?, quoted_at = ? WHERE id = ?")
          .run(finalName, quotedPrice, upc, nowIso, item.id);
        added.push(`• ${item.quantity} × ${finalName} — ${money(price * item.quantity)} (Kroger quote, re-checked now)`);
      } else {
        const savedOn = item.quoted_at ? ` from ${friendlyDate(new Date(item.quoted_at))}` : "";
        const reason = !liveQuotes
          ? "live re-quote isn’t available here"
          : quote?.error
            ? "Kroger’s price lookup failed"
            : quote?.product
              ? "Kroger returned no current price at this store"
              : "Kroger didn’t return this product for the configured store";
        added.push(`• ${item.quantity} × ${finalName} — ${money(price * item.quantity)} (last saved Kroger quote${savedOn}; not re-quoted)`);
        flagged.push(`${finalName}: ${reason}`);
      }
    }
    const notes: string[] = [];
    if (flagged.length) {
      notes.push(`Price not refreshed for ${flagged.join("; ")}. Kroger’s availability precheck at checkout will catch anything the store no longer carries.`);
    }
    if (alreadyInCart.length) {
      notes.push(`Already in the cart, so not duplicated: ${alreadyInCart.join(", ")}. Text “load ${command} list again” to add copies anyway.`);
    }
    if (unpriced.length) {
      notes.push(`Skipped (no Kroger price available yet): ${unpriced.join(", ")}.`);
    }
    if (!added.length) {
      return [`Nothing from the ${label} list was added to the cart.`, ...notes].join("\n");
    }
    this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
      .run(this.#householdId);
    this.#recordUndo(memberId, `load the ${label} list (${added.length} item${added.length === 1 ? "" : "s"})`, undoSnapshot);
    const undoEntry = this.#db.prepare("SELECT id FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(this.#householdId) as { id: string } | undefined;
    // Remember the previous load state per undo entry so undoing this load also
    // restores the list's “already loaded this cycle” state.
    const previous = this.#listRow(list);
    this.#db.prepare(
      "DELETE FROM recurring_list_loads WHERE household_id = ? AND undo_id NOT IN (SELECT id FROM cart_undo_history WHERE household_id = ?)",
    ).run(this.#householdId, this.#householdId);
    if (undoEntry) {
      this.#db.prepare(
        "INSERT OR REPLACE INTO recurring_list_loads (undo_id, household_id, list_key, prev_loaded_at, prev_loaded_by) VALUES (?, ?, ?, ?, ?)",
      ).run(undoEntry.id, this.#householdId, list, previous.last_loaded_at, previous.last_loaded_by);
    }
    this.#db.prepare("UPDATE recurring_lists SET last_loaded_at = ?, last_loaded_by = ? WHERE household_id = ? AND list_key = ?")
      .run(nowIso, memberId, this.#householdId, list);
    const recipients = participantIds.length > 1
      ? `shared by ${this.#joinNames(this.#memberNames(participantIds))}`
      : `for ${this.getMembers().find((member) => member.id === memberId)?.name ?? "you"}`;
    return [
      `Loaded ${added.length} item${added.length === 1 ? "" : "s"} from the ${label} list into the cart ${recipients} (one change — “undo” reverts it):`,
      ...added,
      ...notes,
      this.formatSummary(memberId),
    ].join("\n");
  }

  #startList(list: ListKey): string {
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const activation = this.#activateList(list);
    const items = this.#listItems(list);
    const ask = items.length
      ? `It already has ${items.length} item${items.length === 1 ? "" : "s"}; text “${command} list” to review. What else should be on it?`
      : "What should be on it?";
    const status = activation || (this.#listRow(list).reminders_enabled === 1
      ? `It’s already active; next check-in ${this.#nextReminderText(list)}.`
      : `Reminders are paused; text “resume ${command} reminders” to turn them back on.`);
    return `The household’s ${label} list is ready. ${ask} Reply like “${command}: milk, eggs, bread” (up to 5 items per message). ${status}`;
  }

  #nextReminderText(list: ListKey): string {
    const next = this.#listDueInfo(this.#listRow(list), this.#now()).nextReminderAt;
    if (!next) return "not scheduled";
    return next <= this.#now() ? "due now" : `${friendlyDate(next)}`;
  }

  #setListWeekday(list: ListKey, weekday: number): string {
    if (list === "monthly") return "The monthly list uses a day of the month, for example “monthly list on the 1st”.";
    if (weekday < 0 || weekday > 6) return "I didn’t recognize that day. Try “weekly list on sundays”.";
    const now = this.#now();
    const anchorDate = list === "biweekly" ? localDateKey(nextWeekdayAfter(now, weekday)) : this.#listRow(list).anchor_date;
    this.#db.prepare("UPDATE recurring_lists SET anchor_weekday = ?, anchor_date = ? WHERE household_id = ? AND list_key = ?")
      .run(weekday, anchorDate, this.#householdId, list);
    return this.#afterScheduleChange(list);
  }

  #setListMonthDay(list: ListKey, dayOfMonth: number): string {
    if (list !== "monthly") {
      return `The ${LIST_LABELS[list]} list uses a weekday, for example “${LIST_COMMAND_NAMES[list]} list on sundays”.`;
    }
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return "Choose a day from 1 to 31, for example “monthly list on the 15th”.";
    this.#db.prepare("UPDATE recurring_lists SET day_of_month = ? WHERE household_id = ? AND list_key = ?")
      .run(dayOfMonth, this.#householdId, list);
    return this.#afterScheduleChange(list);
  }

  /** A new anchor never triggers an immediate reminder for a cycle that has already started. */
  #afterScheduleChange(list: ListKey): string {
    const now = this.#now();
    const row = this.#listRow(list);
    const info = this.#listDueInfo(row, now);
    if (row.active_since && info.cycleStart <= now && row.last_reminded_cycle !== info.cycleKey) {
      this.#db.prepare("UPDATE recurring_lists SET last_reminded_cycle = ? WHERE household_id = ? AND list_key = ?")
        .run(info.cycleKey, this.#householdId, list);
    }
    const schedule = describeSchedule(list, this.#listSchedule(row));
    const status = !row.active_since
      ? ` The list isn’t active yet; it starts when someone adds an item or texts “start ${LIST_COMMAND_NAMES[list]} list”.`
      : row.reminders_enabled !== 1
        ? " Reminders are currently paused."
        : ` Next check-in: ${this.#nextReminderText(list)}.`;
    return `Okay — the ${LIST_LABELS[list]} list is now due ${schedule}. I check in around ${this.#reminderHourText()} that day.${status}`;
  }

  #setListReminders(list: ListKey, enabled: boolean): string {
    this.#db.prepare("UPDATE recurring_lists SET reminders_enabled = ? WHERE household_id = ? AND list_key = ?")
      .run(enabled ? 1 : 0, this.#householdId, list);
    const label = LIST_LABELS[list];
    if (!enabled) {
      return `Paused reminders for the ${label} list. The list is kept; text “resume ${LIST_COMMAND_NAMES[list]} reminders” to turn them back on.`;
    }
    const row = this.#listRow(list);
    return row.active_since
      ? `Reminders for the ${label} list are on. Next check-in: ${this.#nextReminderText(list)}.`
      : `Reminders for the ${label} list are on. They start once someone adds an item or texts “start ${LIST_COMMAND_NAMES[list]} list”.`;
  }

  #reminderHourText(): string {
    const hour = this.#reminderHour % 12 === 0 ? 12 : this.#reminderHour % 12;
    return `${hour}:00 ${this.#reminderHour < 12 ? "AM" : "PM"}`;
  }

  #reminderText(list: ListKey): string {
    const title = LIST_TITLES[list];
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const items = this.#listItems(list);
    if (!items.length) {
      return `${title} groceries are due, but the ${label} list is empty. What should be on it? Add items with “${command}: milk, eggs”.`;
    }
    const estimate = this.#listEstimate(items);
    const names = items.slice(0, 6).map((item) => `${item.quantity > 1 ? `${item.quantity} × ` : ""}${this.#listItemName(item)}`);
    const more = items.length > 6 ? `, and ${items.length - 6} more` : "";
    return `${title} groceries are due. The ${label} list has ${items.length} item${items.length === 1 ? "" : "s"} (about ${money(estimate.cents)} estimated): ${names.join(", ")}${more}. Reply “load ${command} list” to add them to the cart, or add items with “${command}: …”.`;
  }

  #formatListView(list: ListKey): string {
    const row = this.#listRow(list);
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const items = this.#listItems(list);
    const schedule = describeSchedule(list, this.#listSchedule(row));
    const header = `${LIST_TITLES[list]} list (shared by the household · due ${schedule})`;
    const lines = items.map((item, index) => {
      const unit = this.#listItemUnitPrice(item);
      const price = unit === null
        ? "no saved price"
        : item.price_source === "kroger"
          ? `${money(unit * item.quantity)} Kroger quote${item.quoted_at ? ` from ${friendlyDate(new Date(item.quoted_at))}` : ""}`
          : `${money(unit * item.quantity)} sample estimate`;
      return `${index + 1}) ${item.quantity} × ${this.#listItemName(item)}${item.size ? ` · ${item.size}` : ""} — ${price}`;
    });
    const estimate = this.#listEstimate(items);
    const body = items.length
      ? `${lines.join("\n")}\nEstimated total: ${money(estimate.cents)}${estimate.unpriced ? ` (+${estimate.unpriced} unpriced)` : ""}. Kroger prices are re-quoted when the list is loaded.`
      : `The list is empty. Add items with “${command}: milk, eggs, bread”.`;
    const statusParts: string[] = [];
    if (!row.active_since) statusParts.push(`Not started yet — reminders begin once it has items (or text “start ${command} list”).`);
    else if (row.reminders_enabled !== 1) statusParts.push(`Reminders paused (“resume ${command} reminders”).`);
    else statusParts.push(`Next check-in: ${this.#nextReminderText(list)}.`);
    if (row.last_loaded_at) {
      const by = row.last_loaded_by ? this.getMembers().find((member) => member.id === row.last_loaded_by)?.name : undefined;
      statusParts.push(`Last loaded ${friendlyDate(new Date(row.last_loaded_at))}${by ? ` by ${by}` : ""}.`);
    }
    return `${header}\n${body}\n${statusParts.join(" ")}\nLoad into the cart: “load ${command} list”. Remove: “remove eggs from ${command} list”. Change amount: “set eggs on ${command} list to 2”.`;
  }

  #formatListsOverview(): string {
    const lines = LIST_KEYS.map((list) => {
      const row = this.#listRow(list);
      const items = this.#listItems(list);
      const estimate = this.#listEstimate(items);
      const size = items.length ? `${items.length} item${items.length === 1 ? "" : "s"}, about ${money(estimate.cents)}` : "empty";
      const status = !row.active_since
        ? "not started"
        : row.reminders_enabled !== 1
          ? "reminders paused"
          : `next check-in ${this.#nextReminderText(list)}`;
      return `• ${LIST_TITLES[list]} (“${LIST_COMMAND_NAMES[list]} list”) — ${size} · due ${describeSchedule(list, this.#listSchedule(row))} · ${status}`;
    });
    return `Household recurring lists:\n${lines.join("\n")}\nAdd: “weekly: milk, eggs” · View: “monthly list” · Use: “load weekly list” · Timing: “weekly list on saturdays” or “monthly list on the 15th”.`;
  }

  #listSetupPrompt(mode: "catalog" | "live"): string {
    const describe = (list: ListKey): string => describeSchedule(list, this.#listSchedule(this.#listRow(list)));
    const lookup = mode === "live"
      ? "I’ll search Kroger and ask you to pick each product, just like adding to the cart."
      : "In this demo I match items to the sample catalog.";
    return [
      "Let’s set up the household’s recurring grocery lists. What should go on each one?",
      `• Weekly (${describe("weekly")}): reply like “weekly: milk, eggs, bread”`,
      `• Every two weeks (${describe("biweekly")}): “biweekly: paper towels, coffee”`,
      `• Monthly (${describe("monthly")}): “monthly: olive oil, rice”`,
      `${lookup} Each list belongs to the whole group. When a list is due I’ll ask the group whether to load it into the cart; change timing with “weekly list on saturdays” or “monthly list on the 15th”. Text “lists” anytime to review.`,
    ].join("\n");
  }
}
