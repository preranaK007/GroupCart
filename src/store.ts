import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CATALOG,
  extractCartRequests,
  isGenericMilkRequest,
  isSharedRequest,
  money,
  resolveMilkChoice,
  unsupportedBrandedRequest,
  type Product,
} from "./cart.js";
import { maskHandle, normalizeHandle } from "./config.js";
import type { KrogerCartAvailabilityIssue, KrogerProduct } from "./kroger.js";

/** `handle` is the member's primary (id-defining) handle; `aliases` are extra handles for the same person. */
export type MemberConfig = { handle: string; name: string; aliases?: string[] };
export type Member = { id: string; handle: string; name: string };
export type GoogleCalendarAccount = { memberId: string; refreshToken: string; scope: string; status: "connected" | "needs_reconnect"; lastError: string | null; connectedAt: string };
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

type SplitwiseExpenseRow = {
  checkout_key: string; revision: number; source: string; payer_member_id: string | null; payer_name: string | null;
  total_cents: number; currency: string; description: string; shares_json: string; request_json: string | null;
  status: string; mode: string; note: string | null; expense_id: string | null; expense_url: string | null;
  error: string | null; attempts: number; created_at: string; updated_at: string;
};

type PendingRetailerChoice = {
  query: string;
  quantity: number;
  participantIds: string[];
  products: KrogerProduct[];
};

type BatchRequest = {
  query: string;
  quantity: number;
  participantIds: string[];
  maxPriceCents?: number;
  maxPriceInclusive?: boolean;
};
type BatchProductResult = { total: number; products: KrogerProduct[] };

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
  checkedOutRevision: number | null;
};

// --- Splitwise expense log (types) ---------------------------------------
// A completed checkout handed to the checkout hooks (src/splitwise.ts). Shares
// come from the same deterministic split as snapshot(), so they sum to totalCents.
export type CompletedCheckout = {
  checkoutKey: string;
  householdId: string;
  revision: number;
  source: "mock" | "kroger";
  payer: { id: string; name: string } | null;
  totalCents: number;
  items: Array<{ name: string; quantity: number; totalCents: number }>;
  shares: Array<{ memberId: string; name: string; shareCents: number }>;
  completedAt: string;
};

export type SplitwiseExpenseStatus = "pending" | "sending" | "logged" | "simulated" | "failed";

export type SplitwiseExpenseRecord = {
  checkoutKey: string;
  revision: number;
  source: "mock" | "kroger";
  payerMemberId: string | null;
  payerName: string | null;
  totalCents: number;
  currency: string;
  description: string;
  shares: Array<{ memberId: string; name: string; paidCents: number; owedCents: number; splitwiseUser: string | null }>;
  request: Record<string, string> | null;
  status: SplitwiseExpenseStatus;
  mode: "live" | "simulated";
  note: string | null;
  expenseId: string | null;
  expenseUrl: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

// Implemented by SplitwiseService. record() runs inside the checkout transaction
// (isolated by a savepoint so it can never roll the checkout back); finish()
// runs after commit and may call the network; neither may break checkout.
export type CheckoutHooks = {
  record(checkout: CompletedCheckout): void;
  summary(checkoutKey: string): string | undefined;
  finish(checkoutKey: string): Promise<string | undefined>;
  status(): string;
  retry(): Promise<string>;
};
// --- end Splitwise expense log (types) -----------------------------------

export class CartStore {
  readonly #db: DatabaseSync;
  readonly #householdId: string;
  readonly #dashboardUrl: string;
  readonly #krogerCartEnabled: boolean;
  #checkoutHooks: CheckoutHooks | undefined;

  constructor(databasePath: string, householdId: string, budgetCents: number, dashboardUrl = "http://127.0.0.1:3000", krogerCartEnabled = false) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.#db = new DatabaseSync(absolutePath);
    this.#householdId = householdId;
    this.#dashboardUrl = dashboardUrl;
    this.#krogerCartEnabled = krogerCartEnabled;
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
    `);
    this.#ensureSplitwiseTable();
    this.#ensureGoogleCalendarTables();
  }

  registerMembers(configuredMembers: MemberConfig[]): Member[] {
    const insert = this.#db.prepare(
      "INSERT INTO members (id, household_id, handle, name) VALUES (?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET name = excluded.name",
    );
    const update = this.#db.prepare("UPDATE members SET handle = ?, name = ? WHERE id = ?");
    // Rows were keyed by the raw configured handle. Reuse any existing row whose handle normalizes to one of the
    // member's handles so member ids (and their cart items, shares, and approvals) survive normalization or reordering.
    const existing = this.getMembers();
    const claimed = new Set<string>();
    for (const member of configuredMembers) {
      const handle = normalizeHandle(member.handle);
      const handles = new Set([handle, ...(member.aliases ?? []).map(normalizeHandle)]);
      const matches = existing.filter((row) => !claimed.has(row.id) && handles.has(normalizeHandle(row.handle)));
      const row = matches.find((candidate) => candidate.handle === handle) ?? matches[0];
      if (!row) {
        insert.run(this.memberId(handle), this.#householdId, handle, member.name);
        continue;
      }
      claimed.add(row.id);
      if (row.handle !== handle || row.name !== member.name) update.run(handle, member.name, row.id);
      for (const duplicate of matches.filter((candidate) => candidate !== row)) {
        console.warn(`GroupCart database has a separate member row for ${maskHandle(duplicate.handle)}, now listed under ${member.name}; it is kept so existing cart history stays valid.`);
      }
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
    ).get(this.#householdId, normalizeHandle(handle)) as Member | undefined;
  }

  /** Records a handled message id (e.g. a group membership event); returns false if it was already processed. */
  markMessageProcessed(messageId: string, reply: string | null): boolean {
    return Number(this.#db.prepare(
      "INSERT OR IGNORE INTO processed_messages (message_id, reply_text, processed_at) VALUES (?, ?, ?)",
    ).run(messageId, reply, new Date().toISOString()).changes) > 0;
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

      if (/^(dashboard|open dashboard|cart page)$/i.test(normalized)) {
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
        reply = this.#completeMockCheckout(memberId);
      } else if (CartStore.#splitwiseCommand.test(normalized)) {
        // Splitwise status (retry needs the network, so only the async live path runs it).
        reply = this.#checkoutHooks?.status() ?? "Splitwise logging isn’t set up in this GroupCart.";
      } else {
        const pending = this.#db.prepare(
          "SELECT kind, original_text FROM pending_clarifications WHERE member_id = ?",
        ).get(memberId) as { kind: string; original_text: string } | undefined;
        if (pending?.kind === "milk" || pending?.kind === "milk-shared") {
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
              const shared = pending.kind === "milk-shared" || isSharedRequest(normalized);
              const companionRequests = extractCartRequests(pending.original_text);
              const requests = [{ product, quantity: 1 }, ...companionRequests];
              this.#addRequests(memberId, requests, shared);
              reply = this.formatSummary(memberId, requests.map(({ product: added }) => added.name), shared);
            }
          }
        } else if (unsupportedBrandedRequest(normalized)) {
          const productName = unsupportedBrandedRequest(normalized)!;
          reply = `I heard “${productName}”, but live product lookup isn’t connected yet. I didn’t substitute generic eggs or a made-up live price. Reply “generic eggs” to add the sample catalog item, or leave it for now.`;
        } else if (isGenericMilkRequest(normalized)) {
          this.#db.prepare(
            "INSERT INTO pending_clarifications (member_id, kind, original_text, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET kind = excluded.kind, original_text = excluded.original_text, created_at = excluded.created_at",
          ).run(memberId, isSharedRequest(normalized) ? "milk-shared" : "milk", normalized, new Date().toISOString());
          reply = "What kind of milk? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond. You can also type the kind you want, and I’ll look up matching store products.";
        } else {
          const requests = extractCartRequests(normalized);
          if (requests.length === 0) {
            reply = `I couldn’t match that to our sample catalog. Try milk, oat milk, eggs, bananas, pasta, tomato sauce, parmesan, bread, apples, or peanut butter. Text “help” to see examples and commands, or “cart” to review your basket.`;
          } else if (isSharedRequest(normalized)) {
            const participants = this.#shareParticipants(normalized, memberId);
            const details = this.#shareRequests(memberId, requests, participants);
            reply = `${details}\n${this.formatSummary(memberId)}`;
          } else {
            this.#addRequests(memberId, requests, false);
            reply = this.formatSummary(memberId, requests.map(({ product }) => product.name), false);
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
  ): Promise<string | null> {
    const existing = this.#existingReply(messageId);
    if (existing !== undefined) return existing;

    const normalized = text.trim();
    const isCommand = /^(cart|show cart|review cart|dashboard|open dashboard|cart page|approve|approve cart|confirm cart|checkout|finish checkout|cancel checkout|clear mine|clear my items|clear my stuff|clear my groceries|clear everything for me|clear all|clear everything|clear cart|clear entire cart|empty cart|clear shared list|clear entire shared list|confirm clear all|cancel clear all|yes clear all|undo|undo last|revert|revert last change)$/i.test(normalized)
      || this.#isHelpRequest(normalized)
      || CartStore.#splitwiseCommand.test(normalized)
      || (/^yes$/i.test(normalized) && this.#hasPendingClearAll(memberId));
    if (/^splitwise retry$/i.test(normalized) && this.#checkoutHooks) {
      let reply: string;
      try { reply = await this.#checkoutHooks.retry(); } catch (error) {
        reply = `Splitwise retry failed (${error instanceof Error ? error.message : "unknown error"}). The checkout itself is unaffected.`;
      }
      return this.#saveAndReturnReply(messageId, reply);
    }
    if (/^(checkout|finish checkout)$/i.test(normalized)) {
      if (!allowKrogerCartCheckout) return this.processIncomingText(messageId, memberId, normalized);
      return this.#startKrogerCheckout(messageId, memberId, locationId, checkCartAvailability);
    }
    if (/^cancel checkout$/i.test(normalized)) {
      return this.#cancelKrogerCheckout(messageId, memberId);
    }
    const pendingKrogerCheckout = this.#getPendingKrogerCheckout();
    if (pendingKrogerCheckout?.status === "adding") {
      if (!/^(cart|show cart|review cart|help|commands|hi|hello|hey|dashboard|open dashboard|cart page)$/i.test(normalized)) {
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
      if (!/^(cart|show cart|review cart|help|commands|hi|hello|hey|dashboard|open dashboard|cart page)$/i.test(normalized)) {
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
      const batchRequests = this.#multiItemRequests(normalized, memberId);
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
        return this.#searchBatchAndPrompt(messageId, memberId, batchRequests, searchProducts, locationId);
      }
    }

    const pendingChoiceRow = this.#db.prepare(
      "SELECT query, quantity, participant_ids_json, products_json FROM pending_product_choices WHERE member_id = ?",
    ).get(memberId) as {
      query: string;
      quantity: number;
      participant_ids_json: string;
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
        participantIds: JSON.parse(pendingChoiceRow.participant_ids_json) as string[],
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
        const participantIds = [...new Set(pending.participantIds)].sort();
        const shared = participantIds.length > 1;
        const existingItem = shared ? this.#db.prepare(
          "SELECT id, participants_json FROM cart_items WHERE household_id = ? AND product_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        ).get(this.#householdId, itemId) as { id: string; participants_json: string } | undefined : undefined;
        if (existingItem) {
          this.#db.prepare("UPDATE cart_items SET participants_json = ? WHERE id = ?")
            .run(JSON.stringify(participantIds), existingItem.id);
        } else {
          this.#db.prepare(
            "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            randomUUID(), this.#householdId, itemId, pending.quantity, memberId,
            JSON.stringify(participantIds), new Date().toISOString(), chosen.description,
            priceCents, "kroger", chosen.upc,
          );
        }
        this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
          .run(this.#householdId);
        this.#recordUndo(memberId, `add ${chosen.description}`, undoSnapshot);
        const participantNames = this.getMembers().filter((member) => participantIds.includes(member.id)).map((member) => member.name);
        const reply = `${existingItem ? `Updated the existing ${chosen.description} line to share` : `Added ${chosen.description}`} ${shared ? `for ${participantNames.join(" and ")}` : `for ${this.getMembers().find((member) => member.id === memberId)?.name ?? "you"}`} at ${money(priceCents)}${chosen.size ? ` (${chosen.size})` : ""}.\n${this.formatSummary(memberId, [], false)}`;
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

    if (pendingMilk && (pendingMilk.kind === "milk" || pendingMilk.kind === "milk-shared")) {
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

    if (!query || query.length < 2) return this.processIncomingText(messageId, memberId, normalized);

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

      const participantIds = isSharedRequest(contextText) || pendingMilk?.kind === "milk-shared"
        ? this.#shareParticipants(contextText, memberId)
        : [memberId];
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
      const reply = `Kroger found ${products.length} matching options${cap} for “${query}”${storeNote}:\n${lines.join("\n")}\nReply 1-${products.length} to add your choice to GroupCart, or “cancel”.${participantIds.length > 1 ? ` The chosen item will be shared by ${this.getMembers().filter((member) => participantIds.includes(member.id)).map((member) => member.name).join(" and ")}.` : ""}`;
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

  completeMockCheckout(payerMemberId?: string): { ok: boolean; message: string } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#completeMockCheckout(payerMemberId);
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
      // Splitwise: Kroger confirmed, so log the checkout (savepoint-isolated).
      const checkoutKey = this.#recordCheckout(snapshot, memberId, "kroger");
      this.#db.exec("COMMIT");
      const splitwiseNote = await this.#finishCheckoutLog(checkoutKey);
      return { ok: true, message: splitwiseNote ? `${message}\n\n${splitwiseNote}` : message };
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
        participantNames: participantIds.map((id) => memberNames.get(id) ?? "Member"),
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

  // ---------------------------------------------------------------------------
  // Google Calendar (per-member free/busy connection). Refresh tokens stay in this
  // local SQLite file and are never returned by any dashboard API.

  #ensureGoogleCalendarTables(): void {
    this.#db.exec(`
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

  googleCalendarAccount(memberId: string): GoogleCalendarAccount | undefined {
    const row = this.#db.prepare(
      "SELECT member_id, refresh_token, scope, status, last_error, connected_at FROM google_calendar_accounts WHERE member_id = ?",
    ).get(memberId) as { member_id: string; refresh_token: string; scope: string; status: string; last_error: string | null; connected_at: string } | undefined;
    return row ? {
      memberId: row.member_id,
      refreshToken: row.refresh_token,
      scope: row.scope,
      status: row.status === "needs_reconnect" ? "needs_reconnect" : "connected",
      lastError: row.last_error,
      connectedAt: row.connected_at,
    } : undefined;
  }

  saveGoogleCalendarAccount(memberId: string, refreshToken: string, scope: string): void {
    const now = new Date().toISOString();
    this.#db.prepare(
      "INSERT INTO google_calendar_accounts (member_id, refresh_token, scope, status, last_error, connected_at, updated_at) VALUES (?, ?, ?, 'connected', NULL, ?, ?) ON CONFLICT(member_id) DO UPDATE SET refresh_token = excluded.refresh_token, scope = excluded.scope, status = 'connected', last_error = NULL, connected_at = excluded.connected_at, updated_at = excluded.updated_at",
    ).run(memberId, refreshToken, scope, now, now);
  }

  markGoogleCalendarNeedsReconnect(memberId: string, reason: string): void {
    this.#db.prepare(
      "UPDATE google_calendar_accounts SET status = 'needs_reconnect', last_error = ?, updated_at = ? WHERE member_id = ?",
    ).run(reason.slice(0, 240), new Date().toISOString(), memberId);
  }

  deleteGoogleCalendarAccount(memberId: string): void {
    this.#db.prepare("DELETE FROM google_calendar_accounts WHERE member_id = ?").run(memberId);
  }

  /** Previously recorded reply for an idempotent command (undefined when the message is new). */
  recordedReply(messageId: string): string | null | undefined {
    return this.#existingReply(messageId);
  }

  /** Records a reply produced outside the cart flow (e.g. the "calendar" command) for idempotency. */
  recordCommandReply(messageId: string, reply: string): void {
    this.#saveMessageReply(messageId, reply);
  }
  // --- end Google Calendar ----------------------------------------------------

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
    query = query.replace(/\b(?:for everyone|for all of us|for us|for me|shared|share|please|thanks|thx)\b/gi, " ");
    query = query.replace(/\bwith\s+(?:(?:and|me)\s+)?[\p{L}'-]+(?:\s+(?:and|&)\s+[\p{L}'-]+)*\s*$/iu, " ");
    for (const member of this.getMembers()) {
      const names = new Set([member.name, member.name.split(/\s+/)[0] ?? member.name]);
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        query = query.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "giu"), " ");
      }
    }
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
      "Share: add sharing to the specific item, like “eggs shared with Anu and Prerana.” In a list, sharing applies only to the item next to that phrase.",
      "Review: “cart” shows items, total, budget, and each person’s share.",
      this.#dashboardMessage(),
      `Calendar: “calendar” links the household calendar (${this.#dashboardUrl.replace(/\/$/, "")}/calendar) and lists the next times everyone is free for a pickup or delivery.`,
      "Remove: say “remove bread” or “I don’t want bread anymore.” For all your items, say “clear mine.”",
      "Clear everyone’s cart: “clear all,” then “confirm clear all” (or “cancel clear all”).",
      "Undo: “undo” reverts the latest cart change; repeat to step back through recent changes.",
      this.#krogerCartEnabled
        ? "Approve/Kroger cart: everyone texts “approve,” then “checkout” checks availability at the configured store before asking whose Kroger account to use. If something appears unavailable, GroupCart suggests alternatives but never substitutes automatically; choose one with “replace 1 with 2.” Any changed list needs everyone’s approval again. After sign-in, available UPC items are added to Kroger; you finish ordering there. No order or payment is placed by GroupCart."
        : "Approve/checkout: in the local demo, checkout is simulated. Live Kroger cart transfer requires configured Kroger app credentials and Cart API access. GroupCart never places an order or charges anyone.",
      "Splitwise: after checkout, GroupCart logs the total as one Splitwise expense paid by the shopper, with each person owing their share. Text “splitwise” (or “settle”) for the latest status, or “splitwise retry” if logging failed.",
      "Not sure what to say? Text “help” or “commands” anytime.",
    ].join("\n\n");
  }

  #dashboardMessage(): string {
    return `Dashboard: ${this.#dashboardUrl} (open this on the computer running GroupCart; it is local-only and not reachable from other devices).`;
  }

  #multiItemRequests(text: string, memberId: string): BatchRequest[] {
    let body = text.trim().replace(/^[\s,;]*(?:hi|hello|hey)[,:\s]+/i, "");
    body = body.replace(/^\s*(?:(?:can|could|may)\s+i\s+(?:please\s+)?(?:get|have|add)|(?:i|we)\s+(?:would\s+like|want|need)|please\s+(?:add|get)|add)\s+/i, "");
    const segments = body.split(/\s*(?:,|;|\n)\s*|\s+and\s+/i)
      .map((segment) => segment.trim().replace(/^[,;\s]+|[.!?]+$/g, ""))
      .filter(Boolean);
    if (segments.length < 2) return [];
    const requests = segments.map((segment) => {
      const explicitlyShared = /\b(?:shared|share)\s+with\b/i.test(segment);
      const allShared = /\b(?:for everyone|for all of us|for us|family size)\b/i.test(text);
      const priceLimit = this.#priceLimit(segment);
      const itemText = segment
        .replace(/\s+\b(?:shared|share)\s+with\s+.+$/i, "")
        .replace(/\s+for\s+(?:everyone|all\s+of\s+us|us)\s*$/i, "")
        .replace(/\b(?:under|below|less than|at most|no more than|up to)\s+\$?\s*\d+(?:\.\d{1,2})?\s*(?:dollars?)?\b/gi, " ")
        .trim();
      const extracted = extractCartRequests(itemText);
      const mentionedOtherMember = this.getMembers().some((member) => member.id !== memberId && [member.name, member.name.split(/\s+/)[0] ?? member.name].some((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(segment);
      }));
      const itemIsShared = explicitlyShared || isSharedRequest(itemText) || mentionedOtherMember;
      return {
        query: this.#retailerQuery(itemText),
        quantity: extracted.length === 1 ? extracted[0]!.quantity : this.#quantityFromText(itemText),
        maxPriceCents: priceLimit?.cents,
        maxPriceInclusive: priceLimit?.inclusive,
        participantIds: itemIsShared
          ? this.#shareParticipants(segment, memberId)
          : allShared ? this.#shareParticipants(text, memberId) : [memberId],
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
        const sharedNames = this.getMembers().filter((member) => request.participantIds.includes(member.id)).map((member) => member.name);
        const sharing = sharedNames.length > 1 ? ` · shared: ${sharedNames.join(", ")}` : "";
        const priceLimit = request.maxPriceCents === undefined
          ? ""
          : ` · ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)} each`;
        return `${index + 1}. ${request.quantity > 1 ? `${request.quantity} × ` : ""}${request.query}${priceLimit}${sharing} (${result.total} options)\n${options.join("\n")}`;
      });
      const storeNote = locationId ? ` at selected store ${locationId}` : " at the configured Kroger-family store";
      const reply = `I found options for your ${requests.length} items${storeNote}:\n${sections.join("\n")}\nReply with one choice number per item in order, separated by commas (for example “1, 2, 1”). Nothing is added until all choices are selected. Reply “cancel” to discard this search.`;
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
      for (let index = 0; index < chosen.length; index += 1) {
        const product = chosen[index]!;
        const request = requests[index]!;
        const price = this.#currentPrice(product)!;
        const productId = `kroger:${product.productId}`;
        const participantIds = [...new Set(request.participantIds)].sort();
        const shared = participantIds.length > 1;
        const existingItem = shared ? this.#db.prepare(
          "SELECT id FROM cart_items WHERE household_id = ? AND product_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        ).get(this.#householdId, productId) as { id: string } | undefined : undefined;
        if (existingItem) {
          this.#db.prepare("UPDATE cart_items SET participants_json = ? WHERE id = ?")
            .run(JSON.stringify(participantIds), existingItem.id);
        } else {
          this.#db.prepare(
            "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(randomUUID(), this.#householdId, productId, request.quantity, memberId,
            JSON.stringify(participantIds), new Date().toISOString(), product.description,
            price, "kroger", product.upc);
        }
        chosenLines.push(product.description);
      }
      this.#db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
        .run(this.#householdId);
      this.#recordUndo(memberId, `add ${chosenLines.join(", ")}`, undoSnapshot);
      const reply = `Added all ${chosenLines.length} selected items to GroupCart.\n${this.formatSummary(memberId)}`;
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

  #addRequests(memberId: string, requests: Array<{ product: Product; quantity: number }>, shared: boolean): void {
    const member = this.#db.prepare(
      "SELECT id FROM members WHERE household_id = ? AND id = ?",
    ).get(this.#householdId, memberId);
    if (!member) throw new Error("Sender is not a configured household member.");

    const undoSnapshot = this.#captureCartItems();
    const participantIds = shared
      ? this.getMembers().map((candidate) => candidate.id)
      : [memberId];
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
  }

  #shareParticipants(text: string, memberId: string): string[] {
    const members = this.getMembers();
    const normalizedText = text.toLocaleLowerCase();
    const mentioned = members.filter((member) => {
      const firstName = member.name.split(/\s+/)[0] ?? member.name;
      return [member.name, firstName].some((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(normalizedText);
      });
    });
    const participants = new Set(mentioned.map((member) => member.id));
    participants.add(memberId);
    if (participants.size < 2) return members.map((member) => member.id);
    return [...participants];
  }

  #shareRequests(
    memberId: string,
    requests: Array<{ product: Product; quantity: number }>,
    participantIds: string[],
  ): string {
    const now = new Date().toISOString();
    const undoSnapshot = this.#captureCartItems();
    const participantJson = JSON.stringify([...new Set(participantIds)].sort());
    let changed = false;
    const sharedNames: string[] = [];

    for (const request of requests) {
      const existing = this.#db.prepare(
        "SELECT id, participants_json FROM cart_items WHERE household_id = ? AND product_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get(this.#householdId, request.product.id) as { id: string; participants_json: string } | undefined;
      if (existing) {
        this.#db.prepare("UPDATE cart_items SET participants_json = ? WHERE id = ?").run(participantJson, existing.id);
        sharedNames.push(request.product.name);
        changed ||= existing.participants_json !== participantJson;
      } else {
        this.#db.prepare(
          "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(randomUUID(), this.#householdId, request.product.id, request.quantity, memberId, participantJson, now);
        sharedNames.push(request.product.name);
        changed = true;
      }
    }

    if (changed) {
      this.#db.prepare(
        "UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?",
      ).run(this.#householdId);
      this.#recordUndo(memberId, `share ${sharedNames.join(", ")}`, undoSnapshot);
    }
    const names = this.getMembers().filter((member) => participantIds.includes(member.id)).map((member) => member.name);
    return changed
      ? `Updated ${sharedNames.join(" and ")} to share between ${names.join(" and ")}.`
      : `${sharedNames.join(" and ")} is already shared between ${names.join(" and ")}.`;
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

  #completeMockCheckout(payerMemberId?: string): string {
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
    const reply = `Mock checkout complete for ${money(snapshot.totalCents)}. No payment was charged. The cart is cleared for your next list.`;
    // Splitwise: demo checkouts are always simulated (no network), so the summary is ready now.
    const checkoutKey = this.#recordCheckout(snapshot, payerMemberId, "mock");
    const splitwiseNote = checkoutKey ? this.#checkoutHooks?.summary(checkoutKey) : undefined;
    return splitwiseNote ? `${reply}\n\n${splitwiseNote}` : reply;
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

  // --- Splitwise expense log (persistence + checkout hooks) ---------------
  static readonly #splitwiseCommand = /^(splitwise|settle|settle up|splitwise status|splitwise retry)$/i;

  setCheckoutHooks(hooks: CheckoutHooks | undefined): void {
    this.#checkoutHooks = hooks;
  }

  /** Inserts the log row for a checkout; returns false if one already exists (idempotent). */
  insertSplitwiseExpense(record: SplitwiseExpenseRecord): boolean {
    const result = this.#db.prepare(
      "INSERT OR IGNORE INTO splitwise_expenses (checkout_key, household_id, revision, source, payer_member_id, payer_name, total_cents, currency, description, shares_json, request_json, status, mode, note, expense_id, expense_url, error, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.checkoutKey, this.#householdId, record.revision, record.source, record.payerMemberId, record.payerName,
      record.totalCents, record.currency, record.description, JSON.stringify(record.shares),
      record.request ? JSON.stringify(record.request) : null, record.status, record.mode, record.note,
      record.expenseId, record.expenseUrl, record.error, record.attempts, record.createdAt, record.updatedAt,
    );
    return Number(result.changes) > 0;
  }

  getSplitwiseExpense(checkoutKey: string): SplitwiseExpenseRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM splitwise_expenses WHERE checkout_key = ? AND household_id = ?")
      .get(checkoutKey, this.#householdId) as SplitwiseExpenseRow | undefined;
    return row ? CartStore.#splitwiseRecord(row) : undefined;
  }

  latestSplitwiseExpense(): SplitwiseExpenseRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM splitwise_expenses WHERE household_id = ? ORDER BY revision DESC LIMIT 1")
      .get(this.#householdId) as SplitwiseExpenseRow | undefined;
    return row ? CartStore.#splitwiseRecord(row) : undefined;
  }

  /** Atomically moves a row from one of `from` to 'sending'; only one caller can win. */
  claimSplitwiseExpense(checkoutKey: string, from: SplitwiseExpenseStatus[]): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const result = this.#db.prepare(
      `UPDATE splitwise_expenses SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE checkout_key = ? AND household_id = ? AND status IN (${placeholders})`,
    ).run(new Date().toISOString(), checkoutKey, this.#householdId, ...from);
    return Number(result.changes) > 0;
  }

  updateSplitwiseExpense(
    checkoutKey: string,
    patch: { status: SplitwiseExpenseStatus; expenseId?: string | null; expenseUrl?: string | null; error?: string | null },
  ): void {
    this.#db.prepare(
      "UPDATE splitwise_expenses SET status = ?, expense_id = COALESCE(?, expense_id), expense_url = COALESCE(?, expense_url), error = ?, updated_at = ? WHERE checkout_key = ? AND household_id = ?",
    ).run(patch.status, patch.expenseId ?? null, patch.expenseUrl ?? null, patch.error ?? null, new Date().toISOString(), checkoutKey, this.#householdId);
  }

  #ensureSplitwiseTable(): void {
    this.#db.exec(`
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

  static #splitwiseRecord(row: SplitwiseExpenseRow): SplitwiseExpenseRecord {
    return {
      checkoutKey: row.checkout_key,
      revision: row.revision,
      source: row.source === "kroger" ? "kroger" : "mock",
      payerMemberId: row.payer_member_id,
      payerName: row.payer_name,
      totalCents: row.total_cents,
      currency: row.currency,
      description: row.description,
      shares: JSON.parse(row.shares_json) as SplitwiseExpenseRecord["shares"],
      request: row.request_json ? JSON.parse(row.request_json) as Record<string, string> : null,
      status: row.status as SplitwiseExpenseStatus,
      mode: row.mode === "live" ? "live" : "simulated",
      note: row.note,
      expenseId: row.expense_id,
      expenseUrl: row.expense_url,
      error: row.error,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Hands a completed checkout to the hooks inside the open transaction. Never throws. */
  #recordCheckout(snapshot: CartSnapshot, payerMemberId: string | undefined, source: "mock" | "kroger"): string | undefined {
    if (!this.#checkoutHooks) return undefined;
    const checkoutKey = `${this.#householdId}:r${snapshot.revision}`;
    const payer = snapshot.members.find((member) => member.id === payerMemberId);
    this.#db.exec("SAVEPOINT splitwise_log");
    try {
      this.#checkoutHooks.record({
        checkoutKey,
        householdId: this.#householdId,
        revision: snapshot.revision,
        source,
        payer: payer ? { id: payer.id, name: payer.name } : null,
        totalCents: snapshot.totalCents,
        items: snapshot.items.map((item) => ({ name: item.name, quantity: item.quantity, totalCents: item.totalCents })),
        shares: snapshot.members.map((member) => ({ memberId: member.id, name: member.name, shareCents: member.shareCents })),
        completedAt: new Date().toISOString(),
      });
      this.#db.exec("RELEASE splitwise_log");
      return checkoutKey;
    } catch (error) {
      this.#db.exec("ROLLBACK TO splitwise_log");
      this.#db.exec("RELEASE splitwise_log");
      console.warn(`Splitwise log for checkout ${checkoutKey} was not recorded: ${error instanceof Error ? error.message : "unknown error"}`);
      return undefined;
    }
  }

  async #finishCheckoutLog(checkoutKey: string | undefined): Promise<string | undefined> {
    if (!checkoutKey || !this.#checkoutHooks) return undefined;
    try {
      return await this.#checkoutHooks.finish(checkoutKey);
    } catch (error) {
      return `Splitwise: couldn’t log this checkout (${error instanceof Error ? error.message : "unknown error"}). The checkout itself is complete.`;
    }
  }
  // --- end Splitwise expense log ------------------------------------------

  private formatSummary(memberId: string, addedNames: string[] = [], shared = false): string {
    const snapshot = this.snapshot();
    const mine = snapshot.members.find((member) => member.id === memberId);
    const lines = snapshot.items.slice(-8).map((item) =>
      `• ${item.quantity} × ${item.name} — ${money(item.totalCents)} (${item.priceSource === "kroger" ? "Kroger" : "sample"}; ${item.participantNames.length > 1 ? `shared: ${item.participantNames.join(", ")}` : `for ${item.ownerName}`})`,
    );
    const shares = snapshot.members.map((member) => `${member.name}: ${money(member.shareCents)}`).join(" · ");
    const prefix = addedNames.length
      ? `Added ${addedNames.join(", ")} for ${shared ? "the household" : mine?.name ?? "you"}.\n`
      : "";
    const budgetNote = snapshot.totalCents > snapshot.budgetCents
      ? `\nOver the ${money(snapshot.budgetCents)} sample budget by ${money(snapshot.totalCents - snapshot.budgetCents)}.`
      : `\nWithin the ${money(snapshot.budgetCents)} sample budget.`;
    const priceNote = snapshot.items.some((item) => item.priceSource === "kroger")
      ? "Kroger prices are store-specific when a location is configured; sample items are marked."
      : "sample catalog prices";
    return `${prefix}Cart revision ${snapshot.revision} · ${priceNote}\n${lines.join("\n")}\nTotal: ${money(snapshot.totalCents)}\n${shares}${budgetNote}\nText “cart”, “approve”, or “checkout”.`;
  }
}
