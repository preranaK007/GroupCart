import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KrogerCartAvailabilityIssue } from "./kroger.js";
import { CartLedger } from "./store/cartLedger.js";
import { StoreContext, type StoreModules } from "./store/context.js";
import { KrogerCheckout } from "./store/krogerCheckout.js";
import { ListCommands } from "./store/listCommands.js";
import { ListText } from "./store/listText.js";
import { dashboardMessage, helpMessage } from "./store/messages.js";
import { CART_COMMAND_PATTERN, cancellationQuery, isHelpRequest, parseSharingCommand } from "./store/parsing.js";
import { ProductSearch } from "./store/productSearch.js";
import { RecurringLists } from "./store/recurringLists.js";
import { initializeSchema } from "./store/schema.js";
import { SharingSessions } from "./store/sharing.js";
import type {
  CartSnapshot,
  CartStoreOptions,
  ListReminderClaim,
  Member,
  MemberConfig,
  PendingKrogerCheckout,
  ProductQuoter,
  ProductSearchFn,
  RecurringListSnapshot,
} from "./store/types.js";

export type {
  CartSnapshot,
  CartStoreOptions,
  ListReminderClaim,
  Member,
  MemberConfig,
  ProductQuoter,
  RecurringListSnapshot,
} from "./store/types.js";

const CANCEL_PATTERN = /^(cancel|never mind|nevermind)$/i;
/** Commands that stay available while a Kroger checkout is mid-flight. */
const READ_ONLY_COMMAND_PATTERN = /^(cart|show cart|review cart|help|commands|hi|hello|hey|dashboard|open dashboard|cart page)$/i;

/**
 * GroupCart's household state and conversation router. Each inbound message is
 * routed here to the feature module that owns it (see `src/store/`); this class
 * owns idempotency by message ID and the order in which pending states win.
 */
export class CartStore {
  readonly #ctx: StoreContext;
  readonly #m: StoreModules;

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
    const db = new DatabaseSync(absolutePath);
    const reminderHour = Number.isInteger(options.reminderHour) && options.reminderHour! >= 0 && options.reminderHour! <= 23
      ? options.reminderHour!
      : 9;
    this.#ctx = new StoreContext(db, householdId, dashboardUrl, krogerCartEnabled, options.now ?? (() => new Date()), reminderHour);
    initializeSchema(db, householdId, budgetCents);
    const m = {} as StoreModules;
    m.cart = new CartLedger(this.#ctx, m);
    m.sharing = new SharingSessions(this.#ctx);
    m.checkout = new KrogerCheckout(this.#ctx, m);
    m.search = new ProductSearch(this.#ctx, m);
    m.lists = new RecurringLists(this.#ctx, m);
    m.listCommands = new ListCommands(this.#ctx, m);
    m.listText = new ListText(this.#ctx, m);
    this.#m = m;
  }

  registerMembers(configuredMembers: MemberConfig[]): Member[] {
    const insert = this.#ctx.db.prepare(
      "INSERT INTO members (id, household_id, handle, name) VALUES (?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET name = excluded.name",
    );
    for (const member of configuredMembers) {
      insert.run(this.#memberId(member.handle), this.#ctx.householdId, member.handle, member.name);
    }
    return this.getMembers();
  }

  getMembers(): Member[] {
    return this.#ctx.getMembers();
  }

  memberForHandle(handle: string): Member | undefined {
    return this.#ctx.db.prepare(
      "SELECT id, handle, name FROM members WHERE household_id = ? AND handle = ?",
    ).get(this.#ctx.householdId, handle) as Member | undefined;
  }

  /** Demo / sample-catalog conversation (also the fallback for live-mode commands). */
  processIncomingText(messageId: string, memberId: string, text: string): string | null {
    const existing = this.#ctx.existingReply(messageId);
    if (existing !== undefined) return existing;

    const { db } = this.#ctx;
    const { cart, sharing, listCommands } = this.#m;
    db.exec("BEGIN IMMEDIATE");
    try {
      const normalized = text.trim();
      let reply: string | null;
      const sharingCommand = parseSharingCommand(normalized);
      const listReply = sharingCommand ? undefined : listCommands.catalogListTurn(memberId, normalized);

      if (sharingCommand) {
        reply = sharingCommand.action === "start"
          ? sharing.startSharing(memberId, sharingCommand.names)
          : sharing.stopSharing(memberId, sharingCommand.names);
      } else if (listReply !== undefined) {
        reply = listReply;
      } else if (/^(dashboard|open dashboard|cart page)$/i.test(normalized)) {
        reply = dashboardMessage(this.#ctx);
      } else if (isHelpRequest(normalized)) {
        reply = helpMessage(this.#ctx);
      } else if (/^(cart|show cart|review cart)$/i.test(normalized)) {
        reply = cart.formatSummary(memberId);
      } else if (/^(clear mine|clear my items|clear my stuff|clear my groceries|clear everything for me)$/i.test(normalized)) {
        reply = cart.clearMemberItems(memberId);
      } else if (/^(clear all|clear everything|clear cart|clear entire cart|empty cart|clear shared list|clear entire shared list)$/i.test(normalized)) {
        reply = cart.requestClearAll(memberId);
      } else if (/^(confirm clear all|yes,? clear all)$/i.test(normalized) || (/^yes$/i.test(normalized) && cart.hasPendingClearAll(memberId))) {
        reply = cart.confirmClearAll(memberId);
      } else if (/^(cancel clear all|cancel)$/i.test(normalized) && cart.hasPendingClearAll(memberId)) {
        db.prepare("DELETE FROM pending_cart_clears WHERE member_id = ?").run(memberId);
        reply = "Okay, I left the shared cart unchanged.";
      } else if (/^(undo|undo last|revert|revert last change)$/i.test(normalized)) {
        reply = cart.undoLastCartChange(memberId);
      } else if (/^(approve|approve cart|confirm cart)$/i.test(normalized)) {
        reply = cart.approveCurrentRevision(memberId);
      } else if (/^(checkout|finish checkout)$/i.test(normalized)) {
        reply = cart.completeMockCheckout();
      } else {
        reply = cart.catalogItemText(memberId, normalized);
      }

      db.prepare(
        "INSERT INTO processed_messages (message_id, reply_text, processed_at) VALUES (?, ?, ?)",
      ).run(messageId, reply, new Date().toISOString());
      db.exec("COMMIT");
      return reply;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Live Kroger conversation. Pending states are checked in priority order:
   * sharing commands, Kroger checkout, recurring lists, item removal, multi-item
   * search, single product choice, then a new search. Plain commands and
   * anything that isn't a live search fall back to `processIncomingText`.
   */
  async processLiveIncomingText(
    messageId: string,
    memberId: string,
    text: string,
    searchProducts: ProductSearchFn,
    locationId?: string,
    allowKrogerCartCheckout = false,
    checkCartAvailability?: (items: Array<{ id: string; name: string; upc: string; quantity: number }>) => Promise<KrogerCartAvailabilityIssue[]>,
    quoteProduct?: ProductQuoter,
  ): Promise<string | null> {
    const existing = this.#ctx.existingReply(messageId);
    if (existing !== undefined) return existing;

    const { db } = this.#ctx;
    const { cart, checkout, search, listCommands } = this.#m;
    const normalized = text.trim();
    // Sharing-session commands never touch the cart or Kroger, so they are
    // handled before any pending checkout, choice, list, or clarification state.
    if (parseSharingCommand(normalized)) return this.processIncomingText(messageId, memberId, normalized);
    const listCommand = listCommands.listCommandFor(memberId, normalized);
    const isCommand = CART_COMMAND_PATTERN.test(normalized)
      || isHelpRequest(normalized)
      || (/^yes$/i.test(normalized) && cart.hasPendingClearAll(memberId))
      || listCommand !== undefined;

    // Kroger checkout.
    if (/^(checkout|finish checkout)$/i.test(normalized)) {
      if (!allowKrogerCartCheckout) return this.processIncomingText(messageId, memberId, normalized);
      return checkout.startKrogerCheckout(messageId, memberId, locationId, checkCartAvailability);
    }
    if (/^cancel checkout$/i.test(normalized)) {
      return checkout.cancelKrogerCheckout(messageId, memberId);
    }
    const pendingKrogerCheckout = checkout.getPendingKrogerCheckout();
    // Recurring-list commands that do not touch the cart stay available while a
    // Kroger checkout is in progress; loading a list into the cart does not.
    const listOnlyCommand = listCommand !== undefined && listCommand.kind !== "load";
    if (pendingKrogerCheckout) {
      const reply = this.#pendingCheckoutTurn(messageId, memberId, normalized, pendingKrogerCheckout, isCommand, listOnlyCommand);
      if (reply !== undefined) return reply;
    }

    // Recurring household lists (weekly / biweekly / monthly).
    if (listCommand) {
      return listCommands.handleLiveListCommand(messageId, memberId, listCommand, searchProducts, locationId, quoteProduct);
    }
    const pendingListSelection = listCommands.pendingListSelection(memberId);
    if (pendingListSelection && !isCommand) {
      if (cancellationQuery(this.#ctx.getMembers(), normalized)) {
        // A cart removal request supersedes an unfinished list selection, the
        // same way it supersedes an unfinished cart product choice.
        db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
      } else {
        return listCommands.continueLiveListSelection(messageId, memberId, normalized, pendingListSelection, searchProducts, locationId);
      }
    }

    // Item removal. A sentence like “I don't want bread anymore” is a cart
    // change, not a query, so it wins over pending product choices and search.
    const pendingCancellation = db.prepare(
      "SELECT item_ids_json, query FROM pending_item_cancellations WHERE member_id = ?",
    ).get(memberId) as { item_ids_json: string; query: string } | undefined;
    const removalQuery = cancellationQuery(this.#ctx.getMembers(), normalized);
    if (removalQuery) {
      return cart.startItemCancellation(messageId, memberId, removalQuery);
    }
    if (pendingCancellation && !isCommand) {
      return cart.continueItemCancellation(messageId, memberId, normalized, pendingCancellation);
    }

    // Multi-item search.
    const pendingBatchRow = db.prepare(
      "SELECT requests_json, results_json FROM pending_product_batches WHERE member_id = ?",
    ).get(memberId) as { requests_json: string; results_json: string | null } | undefined;
    if (pendingBatchRow && !isCommand) {
      return search.continueBatch(messageId, memberId, normalized, pendingBatchRow, searchProducts, locationId);
    }
    if (!isCommand) {
      const batchReply = await search.startBatch(messageId, memberId, normalized, searchProducts, locationId);
      if (batchReply !== undefined) return batchReply;
    }

    // Single product choice, then a new single-item search.
    const pendingChoiceRow = db.prepare(
      "SELECT query, quantity, products_json FROM pending_product_choices WHERE member_id = ?",
    ).get(memberId) as { query: string; quantity: number; products_json: string } | undefined;
    if (pendingChoiceRow && !isCommand) {
      return search.choosePending(messageId, memberId, normalized, pendingChoiceRow);
    }
    if (isCommand || CANCEL_PATTERN.test(normalized)) {
      return this.processIncomingText(messageId, memberId, normalized);
    }
    return await search.searchSingle(messageId, memberId, normalized, searchProducts, locationId)
      ?? this.processIncomingText(messageId, memberId, normalized);
  }

  approveForMember(memberId: string): { ok: boolean; message: string } {
    this.#ctx.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#m.cart.approveCurrentRevision(memberId);
      const ok = !result.startsWith("There isn’t a cart") && !result.startsWith("That member");
      this.#ctx.db.exec("COMMIT");
      return { ok, message: result };
    } catch (error) {
      this.#ctx.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeMockCheckout(): { ok: boolean; message: string } {
    this.#ctx.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#m.cart.completeMockCheckout();
      const ok = result.startsWith("Mock checkout complete");
      this.#ctx.db.exec("COMMIT");
      return { ok, message: result };
    } catch (error) {
      this.#ctx.db.exec("ROLLBACK");
      throw error;
    }
  }

  pendingKrogerCheckout(): PendingKrogerCheckout | undefined {
    return this.#m.checkout.getPendingKrogerCheckout();
  }

  completeKrogerCartCheckout(
    memberId: string,
    addItemsToCart: (items: Array<{ upc: string; quantity: number }>) => Promise<void>,
  ): Promise<{ ok: boolean; message: string }> {
    return this.#m.checkout.completeKrogerCartCheckout(memberId, addItemsToCart);
  }

  snapshot(): CartSnapshot {
    return this.#m.cart.snapshot();
  }

  listsSnapshot(): RecurringListSnapshot[] {
    return this.#m.lists.listsSnapshot();
  }

  claimDueListReminders(): ListReminderClaim | null {
    return this.#m.lists.claimDueListReminders();
  }

  releaseListReminders(claim: ListReminderClaim): void {
    this.#m.lists.releaseListReminders(claim);
  }

  rememberGroupSpace(spaceId: string, phone?: string): void {
    this.#m.lists.rememberGroupSpace(spaceId, phone);
  }

  groupSpace(): { id: string; phone?: string } | undefined {
    return this.#m.lists.groupSpace();
  }

  getCursor(): number {
    const row = this.#ctx.db.prepare("SELECT value FROM app_state WHERE key = 'photon_cursor'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  saveCursor(cursor: number): void {
    this.#ctx.db.prepare(
      "INSERT INTO app_state (key, value) VALUES ('photon_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(cursor));
  }

  close(): void {
    this.#ctx.db.close();
  }

  /** Replies while a Kroger checkout is pending; `undefined` lets the message continue. */
  #pendingCheckoutTurn(
    messageId: string,
    memberId: string,
    normalized: string,
    pending: PendingKrogerCheckout,
    isCommand: boolean,
    listOnlyCommand: boolean,
  ): string | undefined {
    const { checkout } = this.#m;
    if (pending.status === "adding") {
      if (!READ_ONLY_COMMAND_PATTERN.test(normalized) && !listOnlyCommand) {
        return this.#ctx.saveAndReturnReply(messageId, "GroupCart is sending the approved list to Kroger right now. Please wait for the result before changing the cart.");
      }
    }
    if (pending.requesterId === memberId
      && (pending.status === "choosing_account" || pending.status === "awaiting_oauth")
      && !isCommand) {
      return checkout.handleKrogerAccountChoice(messageId, memberId, normalized, pending);
    }
    if (pending.status === "replacement_review") {
      const selection = normalized.match(/^replace\s+(\d{1,2})\s+with\s+(\d{1,2})$/i);
      if (selection) return checkout.handleKrogerReplacementChoice(messageId, memberId, Number(selection[1]), Number(selection[2]));
      if (!READ_ONLY_COMMAND_PATTERN.test(normalized) && !listOnlyCommand) {
        return this.#ctx.saveAndReturnReply(messageId, "Kroger’s precheck found unavailable items. Choose a suggested option with “replace 1 with 2”, or text “cancel checkout” to leave GroupCart unchanged and manage the item yourself. No replacement is made unless you choose one.");
      }
    }
    if (pending.requesterId !== memberId && /^(\d+|cancel)$/i.test(normalized)) {
      const requester = this.#ctx.getMembers().find((member) => member.id === pending.requesterId)?.name ?? "the member who requested checkout";
      return this.#ctx.saveAndReturnReply(messageId, `Please have ${requester} finish the Kroger account selection, or ask them to text “cancel checkout”.`);
    }
    return undefined;
  }

  #memberId(handle: string): string {
    return createHash("sha256").update(`${this.#ctx.householdId}:${handle}`).digest("hex").slice(0, 20);
  }
}
