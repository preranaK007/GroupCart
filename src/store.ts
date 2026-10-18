import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { maskHandle, normalizeHandle } from "./config.js";
import type { KrogerCartAvailabilityIssue } from "./kroger.js";
import { parseListCommand } from "./lists.js";
import { registerPendingQuestion } from "./platform.js";
import { CartLedger } from "./store/cartLedger.js";
import { StoreContext, type StoreModules } from "./store/context.js";
import { GoogleCalendarAccounts } from "./store/googleCalendarAccounts.js";
import { KrogerCheckout } from "./store/krogerCheckout.js";
import { ListCommands } from "./store/listCommands.js";
import { ListText } from "./store/listText.js";
import { dashboardMessage, helpMessage } from "./store/messages.js";
import { CANCEL_REPLY_PATTERN, CART_COMMAND_PATTERN, cancellationQuery, isBanter, isHelpRequest, normalizeCancelReply, parseReviewCommand, parseSharingCommand } from "./store/parsing.js";
import { ProductSearch } from "./store/productSearch.js";
import { RecurringLists } from "./store/recurringLists.js";
import { initializeSchema } from "./store/schema.js";
import { SharingSessions } from "./store/sharing.js";
import { SPLITWISE_COMMAND_PATTERN, SPLITWISE_RETRY_PATTERN, SplitwiseLog } from "./store/splitwiseLog.js";
import type {
  CartSnapshot,
  CartStoreOptions,
  CheckoutHooks,
  GoogleCalendarAccount,
  ListReminderClaim,
  Member,
  MemberConfig,
  PendingKrogerCheckout,
  ProductQuoter,
  ProductSearchFn,
  RecurringListSnapshot,
  SplitwiseExpenseRecord,
  SplitwiseExpenseStatus,
} from "./store/types.js";

export type {
  CartSnapshot,
  CartStoreOptions,
  CheckoutHooks,
  CompletedCheckout,
  GoogleCalendarAccount,
  ListReminderClaim,
  Member,
  MemberConfig,
  ProductQuoter,
  RecurringListSnapshot,
  SplitwiseExpenseRecord,
  SplitwiseExpenseStatus,
} from "./store/types.js";

/**
 * Phrases the store owns outright: cart commands, sharing sessions, and recurring-list commands. index.ts sends
 * these straight to the store so no feature command handler (src/platform.ts runCommands) can intercept them.
 */
export function isStoreCommand(text: string): boolean {
  const normalized = text.trim();
  return CART_COMMAND_PATTERN.test(normalized) || Boolean(parseSharingCommand(normalized)) || Boolean(parseListCommand(normalized));
}

const CANCEL_CHECKOUT_PATTERN = /^(?:please\s+)?cancel\s+(?:the\s+)?(?:kroger\s+)?checkout(?:\s+please)?[.!]*$/i;
const APPROVE_PATTERN = /^(approve|approve cart|confirm cart)$/i;
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
    m.splitwise = new SplitwiseLog(this.#ctx);
    m.calendarAccounts = new GoogleCalendarAccounts(this.#ctx);
    this.#m = m;
    // Product picks, milk kind, list selections, and confirmations take bare numbers and "yes"/"ok" alike.
    registerPendingQuestion("cart", (memberId) => this.pendingQuestionAt(memberId));
  }

  registerMembers(configuredMembers: MemberConfig[]): Member[] {
    const { db, householdId } = this.#ctx;
    const insert = db.prepare(
      "INSERT INTO members (id, household_id, handle, name) VALUES (?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET name = excluded.name",
    );
    const update = db.prepare("UPDATE members SET handle = ?, name = ? WHERE id = ?");
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
        insert.run(this.#memberId(handle), householdId, handle, member.name);
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

  /** Shared SQLite handle for feature modules outside src/store/ (they create their own tables). */
  get database(): DatabaseSync {
    return this.#ctx.db;
  }

  get household(): string {
    return this.#ctx.householdId;
  }

  getMembers(): Member[] {
    return this.#ctx.getMembers();
  }

  /**
   * Whether this message belongs to the store before any feature command sees it: the store's own phrases
   * (`isStoreCommand`), “cancel checkout”, and checkout-review choices (“remove 2”, “replace 1 with 2”) while a
   * review is open or just finished, so chores' “skip …” or a bill draft's “remove …” can't take them.
   */
  ownsMessage(text: string, memberId?: string): boolean {
    const normalized = text.trim();
    if (isStoreCommand(normalized) || CANCEL_CHECKOUT_PATTERN.test(normalized)) return true;
    // A feature draft must not take a cancel meant for this member's grocery question.
    if (memberId && CANCEL_REPLY_PATTERN.test(normalized) && this.hasPendingChoice(memberId)) return true;
    return parseReviewCommand(normalized) !== undefined
      && (this.#m.checkout.hasOpenReview() || this.#m.checkout.reviewRecentlyEnded());
  }

  memberForHandle(handle: string): Member | undefined {
    return this.#ctx.db.prepare(
      "SELECT id, handle, name FROM members WHERE household_id = ? AND handle = ?",
    ).get(this.#ctx.householdId, normalizeHandle(handle)) as Member | undefined;
  }

  /** Records a handled message id (e.g. a group membership event); returns false if it was already processed. */
  markMessageProcessed(messageId: string, reply: string | null): boolean {
    return Number(this.#ctx.db.prepare(
      "INSERT OR IGNORE INTO processed_messages (message_id, reply_text, processed_at) VALUES (?, ?, ?)",
    ).run(messageId, reply, new Date().toISOString()).changes) > 0;
  }

  /**
   * When GroupCart last asked this member something they still have to answer (a numbered product or list pick,
   * milk kind, which item to remove, a clear confirmation, or whose Kroger account to use), as an ISO time; null
   * when nothing is pending. Feature modules use it to leave bare numbers and “cancel” to the store.
   */
  pendingQuestionAt(memberId: string): string | null {
    const queries = [
      "SELECT created_at AS at FROM pending_product_choices WHERE member_id = ?",
      "SELECT created_at AS at FROM pending_product_batches WHERE member_id = ?",
      "SELECT created_at AS at FROM pending_clarifications WHERE member_id = ?",
      "SELECT created_at AS at FROM pending_item_cancellations WHERE member_id = ?",
      "SELECT created_at AS at FROM pending_cart_clears WHERE member_id = ?",
      "SELECT created_at AS at FROM pending_list_selections WHERE member_id = ?",
      "SELECT created_at AS at FROM pending_list_clears WHERE member_id = ?",
      "SELECT created_at AS at FROM pending_kroger_checkouts WHERE requester_id = ? AND status = 'choosing_account'",
    ];
    let latest: string | null = null;
    for (const sql of queries) {
      const row = this.#ctx.db.prepare(sql).get(memberId) as { at: string } | undefined;
      if (row?.at && (!latest || row.at > latest)) latest = row.at;
    }
    return latest;
  }

  /**
   * Group banter (“lol”, “👍”, “thanks”) while the store has nothing to ask this member: stay quiet instead of
   * answering “I couldn’t match that” (or running a live product search). With a question open, or a checkout
   * paused for the group, it goes through as usual so the checkout nudge still reaches them.
   */
  #isIdleBanter(memberId: string, text: string): boolean {
    return isBanter(text) && this.pendingQuestionAt(memberId) === null && this.pendingKrogerCheckout() === undefined;
  }

  hasPendingChoice(memberId: string): boolean {
    return this.pendingQuestionAt(memberId) !== null;
  }

  /** Previously recorded reply for an idempotent command (undefined when the message is new). */
  recordedReply(messageId: string): string | null | undefined {
    return this.#ctx.existingReply(messageId);
  }

  /** Records a reply produced outside the cart flow (e.g. the "calendar" command) for idempotency. */
  recordCommandReply(messageId: string, reply: string): void {
    this.#ctx.saveMessageReply(messageId, reply);
  }

  /** Demo / sample-catalog conversation (also the fallback for live-mode commands). */
  processIncomingText(messageId: string, memberId: string, text: string): string | null {
    const existing = this.#ctx.existingReply(messageId);
    if (existing !== undefined) return existing;
    if (this.#isIdleBanter(memberId, text)) return null;

    const { db } = this.#ctx;
    const { cart, sharing, listCommands } = this.#m;
    db.exec("BEGIN IMMEDIATE");
    try {
      const normalized = normalizeCancelReply(text);
      let reply: string | null;
      const sharingCommand = parseSharingCommand(normalized);
      // Splitwise status is a plain command: it never feeds a pending list selection.
      const splitwiseCommand = SPLITWISE_COMMAND_PATTERN.test(normalized);
      const listReply = sharingCommand || splitwiseCommand ? undefined : listCommands.catalogListTurn(memberId, normalized);

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
        reply = cart.completeMockCheckout(memberId);
      } else if (splitwiseCommand) {
        // Splitwise status (retry needs the network, so only the async live path runs it).
        reply = this.#m.splitwise.statusReply();
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
   * sharing commands, recurring-list commands, Kroger checkout, item removal, multi-item
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
    if (this.#isIdleBanter(memberId, text)) return null;

    const { db } = this.#ctx;
    const { cart, checkout, search, listCommands } = this.#m;
    const normalized = normalizeCancelReply(text);
    // Sharing-session commands never touch the cart or Kroger, so they are
    // handled before any pending checkout, choice, list, or clarification state.
    if (parseSharingCommand(normalized)) return this.processIncomingText(messageId, memberId, normalized);
    const listCommand = listCommands.listCommandFor(memberId, normalized);
    const isCommand = CART_COMMAND_PATTERN.test(normalized)
      || isHelpRequest(normalized)
      || SPLITWISE_COMMAND_PATTERN.test(normalized)
      || (/^yes$/i.test(normalized) && cart.hasPendingClearAll(memberId))
      || listCommand !== undefined;

    // Splitwise retry needs the network, so it only runs here (status is answered by processIncomingText).
    if (SPLITWISE_RETRY_PATTERN.test(normalized)) {
      const retryReply = await this.#m.splitwise.retryReply();
      if (retryReply !== undefined) return this.#ctx.saveAndReturnReply(messageId, retryReply);
    }

    // Kroger checkout.
    if (/^(checkout|finish checkout)$/i.test(normalized)) {
      if (!allowKrogerCartCheckout) return this.processIncomingText(messageId, memberId, normalized);
      return checkout.startKrogerCheckout(messageId, memberId, locationId, checkCartAvailability);
    }
    if (CANCEL_CHECKOUT_PATTERN.test(normalized)) {
      return checkout.cancelKrogerCheckout(messageId, memberId);
    }
    // List maintenance never changes the cart and must win over review parsing, even if its item text says
    // “drop” or “remove”. Loading a list is a cart change and still goes through the checkout lock below.
    const listOnlyCommand = listCommand !== undefined && listCommand.kind !== "load";
    if (listOnlyCommand) {
      return listCommands.handleLiveListCommand(messageId, memberId, listCommand, searchProducts, locationId, quoteProduct);
    }
    const pendingKrogerCheckout = checkout.getPendingKrogerCheckout();
    // “remove 2” / “replace 1 with 2” right after the review ended (someone else finished it) must not turn into a
    // Kroger product search for “remove 2”.
    const reviewCommand = pendingKrogerCheckout?.status === "replacement_review" ? undefined : parseReviewCommand(normalized);
    if (reviewCommand && this.pendingQuestionAt(memberId) === null) {
      return checkout.handleReviewCommand(messageId, memberId, reviewCommand);
    }
    if (pendingKrogerCheckout) {
      const reply = this.#pendingCheckoutTurn(messageId, memberId, normalized, pendingKrogerCheckout, isCommand);
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
    if (isCommand || CANCEL_REPLY_PATTERN.test(normalized)) {
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

  completeMockCheckout(payerMemberId?: string): { ok: boolean; message: string } {
    this.#ctx.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#m.cart.completeMockCheckout(payerMemberId);
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

  // --- Splitwise expense log (src/store/splitwiseLog.ts; hooks implemented by src/splitwise.ts) ---
  setCheckoutHooks(hooks: CheckoutHooks | undefined): void {
    this.#m.splitwise.setHooks(hooks);
  }

  /** Inserts the log row for a checkout; returns false if one already exists (idempotent). */
  insertSplitwiseExpense(record: SplitwiseExpenseRecord): boolean {
    return this.#m.splitwise.insert(record);
  }

  getSplitwiseExpense(checkoutKey: string): SplitwiseExpenseRecord | undefined {
    return this.#m.splitwise.get(checkoutKey);
  }

  latestSplitwiseExpense(): SplitwiseExpenseRecord | undefined {
    return this.#m.splitwise.latest();
  }

  /** Atomically moves a row from one of `from` to 'sending'; only one caller can win. */
  claimSplitwiseExpense(checkoutKey: string, from: SplitwiseExpenseStatus[]): boolean {
    return this.#m.splitwise.claim(checkoutKey, from);
  }

  updateSplitwiseExpense(
    checkoutKey: string,
    patch: { status: SplitwiseExpenseStatus; expenseId?: string | null; expenseUrl?: string | null; error?: string | null },
  ): void {
    this.#m.splitwise.update(checkoutKey, patch);
  }

  // --- Google Calendar (src/store/googleCalendarAccounts.ts; used by src/googleCalendar.ts) ---
  googleCalendarAccount(memberId: string): GoogleCalendarAccount | undefined {
    return this.#m.calendarAccounts.account(memberId);
  }

  saveGoogleCalendarAccount(memberId: string, refreshToken: string, scope: string): void {
    this.#m.calendarAccounts.save(memberId, refreshToken, scope);
  }

  markGoogleCalendarNeedsReconnect(memberId: string, reason: string): void {
    this.#m.calendarAccounts.markNeedsReconnect(memberId, reason);
  }

  deleteGoogleCalendarAccount(memberId: string): void {
    this.#m.calendarAccounts.delete(memberId);
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
  ): string | undefined {
    const { checkout } = this.#m;
    if (pending.status === "adding") {
      if (!READ_ONLY_COMMAND_PATTERN.test(normalized)) {
        return this.#ctx.saveAndReturnReply(messageId, "GroupCart is sending the approved list to Kroger right now. Please wait for the result before changing the cart.");
      }
    }
    if (pending.requesterId === memberId
      && (pending.status === "choosing_account" || pending.status === "awaiting_oauth")
      && !isCommand) {
      return checkout.handleKrogerAccountChoice(messageId, memberId, normalized, pending);
    }
    if (pending.status === "replacement_review") {
      // The group's review of unavailable items. Items are only ever chosen by number.
      const command = parseReviewCommand(normalized);
      if (command) return checkout.handleReviewCommand(messageId, memberId, command) ?? "";
      // List maintenance was already handled; read-only commands and approvals also keep working.
      if (READ_ONLY_COMMAND_PATTERN.test(normalized) || APPROVE_PATTERN.test(normalized)) return undefined;
      // A member answering their own question (“cancel” to a product pick, a number for a list pick) isn't
      // talking to the review; let their own flow take it. Cart-changing answers wait until the review ends.
      const removalQuery = cancellationQuery(this.#ctx.getMembers(), normalized);
      const answersListPick = !isCommand && !removalQuery && this.#m.listCommands.pendingListSelection(memberId) !== undefined;
      if (answersListPick || (CANCEL_REPLY_PATTERN.test(normalized) && this.pendingQuestionAt(memberId) !== null)) return undefined;
      if (CANCEL_REPLY_PATTERN.test(normalized)) return checkout.cancelKrogerCheckout(messageId, memberId);
      if (removalQuery) {
        const hint = checkout.reviewNameHint(messageId, removalQuery);
        if (hint !== undefined) return hint;
      }
      return checkout.reviewNudge(messageId);
    }
    if (pending.requesterId !== memberId && /^(\d+|cancel)$/i.test(normalized) && this.pendingQuestionAt(memberId) === null) {
      const requester = this.#ctx.getMembers().find((member) => member.id === pending.requesterId)?.name ?? "the member who requested checkout";
      return this.#ctx.saveAndReturnReply(messageId, `Please have ${requester} finish the Kroger account selection, or ask them to text “cancel checkout”.`);
    }
    return undefined;
  }

  #memberId(handle: string): string {
    return createHash("sha256").update(`${this.#ctx.householdId}:${handle}`).digest("hex").slice(0, 20);
  }
}
