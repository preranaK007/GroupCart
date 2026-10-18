import { randomUUID } from "node:crypto";
import { CATALOG, money } from "../cart.js";
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
  type ListKey,
  type ListSchedule,
} from "../lists.js";
import type { StoreContext, StoreModules } from "./context.js";
import { retailerQuery } from "./parsing.js";
import { currentPriceCents } from "./pricing.js";
import type {
  ListDueInfo,
  ListItemRow,
  ListReminderClaim,
  ListRow,
  ProductQuote,
  ProductQuoter,
  RecurringListSnapshot,
} from "./types.js";

/**
 * Recurring household lists (weekly, every two weeks, monthly): stored items,
 * cadence and reminders, editing, and loading a list into the cart.
 *
 * The lists belong to the whole household. Items are saved with real Kroger
 * product IDs/UPCs in live mode (via the same numbered-choice search) or with
 * sample-catalog IDs in demo mode. Loading a list copies its items into the
 * cart as one undoable change, split by the sender's sharing session.
 */
export class RecurringLists {
  constructor(private readonly ctx: StoreContext, private readonly m: StoreModules) {}

  /** Read-only view of the three lists for the dashboard. */
  listsSnapshot(): RecurringListSnapshot[] {
    const now = this.ctx.now();
    const memberNames = new Map(this.ctx.getMembers().map((member) => [member.id, member.name]));
    return LIST_KEYS.map((key) => {
      const row = this.listRow(key);
      const info = this.listDueInfo(row, now);
      const items = this.listItems(key);
      return {
        key,
        title: LIST_TITLES[key],
        command: LIST_COMMAND_NAMES[key],
        schedule: describeSchedule(key, this.listSchedule(row)),
        active: Boolean(row.active_since),
        remindersEnabled: row.reminders_enabled === 1,
        dueNow: info.dueNow,
        nextReminderAt: info.nextReminderAt?.toISOString() ?? null,
        lastLoadedAt: row.last_loaded_at,
        lastLoadedByName: row.last_loaded_by ? memberNames.get(row.last_loaded_by) ?? null : null,
        estimatedCents: this.listEstimate(items).cents,
        items: items.map((item) => ({
          id: item.id,
          name: this.listItemName(item),
          quantity: item.quantity,
          unitPriceCents: this.listItemUnitPrice(item),
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
    const now = this.ctx.now();
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      const claims: ListReminderClaim["claims"] = [];
      const parts: string[] = [];
      for (const key of LIST_KEYS) {
        const row = this.listRow(key);
        const info = this.listDueInfo(row, now);
        if (!info.shouldRemind) continue;
        claims.push({ listKey: key, cycleKey: info.cycleKey, previous: row.last_reminded_cycle });
        this.ctx.db.prepare("UPDATE recurring_lists SET last_reminded_cycle = ? WHERE household_id = ? AND list_key = ?")
          .run(info.cycleKey, this.ctx.householdId, key);
        parts.push(this.m.listText.reminderText(key));
      }
      this.ctx.db.exec("COMMIT");
      if (!claims.length) return null;
      const pauseHint = claims.map(({ listKey }) => `“pause ${LIST_COMMAND_NAMES[listKey]} reminders”`).join(" or ");
      return { text: `${parts.join("\n\n")}\n(Text ${pauseHint} to stop these check-ins.)`, claims };
    } catch (error) {
      this.ctx.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Undo a claim whose message was not delivered, so a later attempt can send it. */
  releaseListReminders(claim: ListReminderClaim): void {
    const update = this.ctx.db.prepare(
      "UPDATE recurring_lists SET last_reminded_cycle = ? WHERE household_id = ? AND list_key = ? AND last_reminded_cycle = ?",
    );
    for (const entry of claim.claims) update.run(entry.previous, this.ctx.householdId, entry.listKey, entry.cycleKey);
  }

  /** Persist the household group conversation the bot has received allowlisted messages from. */
  rememberGroupSpace(spaceId: string, phone?: string): void {
    const existing = this.groupSpace();
    if (existing && existing.id === spaceId && existing.phone === phone) return;
    this.ctx.db.prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(`group_space:${this.ctx.householdId}`, JSON.stringify({ id: spaceId, phone: phone ?? null, seenAt: this.ctx.now().toISOString() }));
  }

  groupSpace(): { id: string; phone?: string } | undefined {
    const row = this.ctx.db.prepare("SELECT value FROM app_state WHERE key = ?")
      .get(`group_space:${this.ctx.householdId}`) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value) as { id?: unknown; phone?: unknown };
      if (typeof parsed.id !== "string" || !parsed.id) return undefined;
      return typeof parsed.phone === "string" && parsed.phone ? { id: parsed.id, phone: parsed.phone } : { id: parsed.id };
    } catch {
      return undefined;
    }
  }

  listRow(list: ListKey): ListRow {
    return this.ctx.db.prepare(
      "SELECT list_key, anchor_weekday, anchor_date, day_of_month, active_since, last_loaded_at, last_loaded_by, last_reminded_cycle, reminders_enabled, revision FROM recurring_lists WHERE household_id = ? AND list_key = ?",
    ).get(this.ctx.householdId, list) as ListRow;
  }

  listItems(list: ListKey): ListItemRow[] {
    return this.ctx.db.prepare(
      "SELECT id, list_key, product_id, product_name, quantity, unit_price_cents, price_source, upc, size, added_by, created_at, quoted_at FROM recurring_list_items WHERE household_id = ? AND list_key = ? ORDER BY created_at, rowid",
    ).all(this.ctx.householdId, list) as ListItemRow[];
  }

  listSchedule(row: ListRow): ListSchedule {
    return { anchorWeekday: row.anchor_weekday, anchorDate: row.anchor_date, dayOfMonth: row.day_of_month };
  }

  listItemName(item: ListItemRow): string {
    return item.product_name ?? CATALOG.find((product) => product.id === item.product_id)?.name ?? "item";
  }

  listItemUnitPrice(item: ListItemRow): number | null {
    if (item.price_source === "sample") {
      return CATALOG.find((product) => product.id === item.product_id)?.priceCents ?? item.unit_price_cents;
    }
    return item.unit_price_cents;
  }

  listEstimate(items: ListItemRow[]): { cents: number; unpriced: number } {
    let cents = 0;
    let unpriced = 0;
    for (const item of items) {
      const price = this.listItemUnitPrice(item);
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
  listDueInfo(row: ListRow, now: Date): ListDueInfo {
    const schedule = this.listSchedule(row);
    const cycleStart = currentCycleStart(row.list_key, schedule, now);
    const cycleKey = `${row.list_key}:${localDateKey(cycleStart)}`;
    const loadedAt = row.last_loaded_at ? new Date(row.last_loaded_at) : null;
    const loadedThisCycle = loadedAt !== null && loadedAt >= addLocalDays(cycleStart, -2);
    const activeSince = row.active_since ? new Date(row.active_since) : null;
    const remindAt = (start: Date): Date => new Date(start.getFullYear(), start.getMonth(), start.getDate(), this.ctx.reminderHour);
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

  /** Mark a list active (reminders start at the next cycle). Returns a note when newly activated. */
  activateList(list: ListKey): string {
    const row = this.listRow(list);
    if (row.active_since) return "";
    const now = this.ctx.now();
    const anchorDate = list === "biweekly" && !row.anchor_date
      ? localDateKey(nextWeekdayAfter(now, row.anchor_weekday))
      : row.anchor_date;
    this.ctx.db.prepare("UPDATE recurring_lists SET active_since = ?, anchor_date = ? WHERE household_id = ? AND list_key = ?")
      .run(now.toISOString(), anchorDate, this.ctx.householdId, list);
    const updated = this.listRow(list);
    const next = this.listDueInfo(updated, now).nextReminderAt;
    const schedule = describeSchedule(list, this.listSchedule(updated));
    return next && updated.reminders_enabled === 1
      ? `I’ll check in with the group about the ${LIST_LABELS[list]} list ${schedule}, starting ${friendlyDate(next)}.`
      : "";
  }

  upsertListItem(list: ListKey, memberId: string, item: {
    productId: string; name: string; quantity: number; unitPriceCents: number | null;
    priceSource: "sample" | "kroger"; upc: string | null; size: string | null;
  }): "added" | "updated" {
    const now = this.ctx.now().toISOString();
    const existing = this.ctx.db.prepare(
      "SELECT id FROM recurring_list_items WHERE household_id = ? AND list_key = ? AND product_id = ?",
    ).get(this.ctx.householdId, list, item.productId) as { id: string } | undefined;
    if (existing) {
      this.ctx.db.prepare(
        "UPDATE recurring_list_items SET quantity = ?, product_name = ?, unit_price_cents = ?, price_source = ?, upc = ?, size = ?, quoted_at = ? WHERE id = ?",
      ).run(item.quantity, item.name, item.unitPriceCents, item.priceSource, item.upc, item.size, now, existing.id);
    } else {
      this.ctx.db.prepare(
        "INSERT INTO recurring_list_items (id, household_id, list_key, product_id, product_name, quantity, unit_price_cents, price_source, upc, size, added_by, created_at, quoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(randomUUID(), this.ctx.householdId, list, item.productId, item.name, item.quantity, item.unitPriceCents,
        item.priceSource, item.upc, item.size, memberId, now, now);
    }
    this.ctx.db.prepare("UPDATE recurring_lists SET revision = revision + 1 WHERE household_id = ? AND list_key = ?")
      .run(this.ctx.householdId, list);
    return existing ? "updated" : "added";
  }

  matchListItems(list: ListKey, itemText: string): { items: ListItemRow[]; matches: ListItemRow[] } {
    const items = this.listItems(list);
    const trimmed = itemText.trim();
    if (/^#?\d{1,2}$/.test(trimmed)) {
      const item = items[Number(trimmed.replace("#", "")) - 1];
      return { items, matches: item ? [item] : [] };
    }
    const tokens = retailerQuery(this.ctx.getMembers(), trimmed)
      .replace(/\b(?:the|my|our|some|a|an|all|of)\b/gi, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) return { items, matches: [] };
    const contains = (name: string, token: string): boolean => name.includes(token)
      || (token.length > 3 && token.endsWith("s") && name.includes(token.slice(0, -1)));
    const matches = items.filter((item) => {
      const name = this.listItemName(item).toLocaleLowerCase();
      return tokens.every((token) => contains(name, token.toLocaleLowerCase()));
    });
    return { items, matches };
  }

  ambiguousListMatch(list: ListKey, itemText: string, matches: ListItemRow[], items: ListItemRow[], verb: string): string {
    const command = LIST_COMMAND_NAMES[list];
    const options = matches.map((item) => `${items.indexOf(item) + 1}) ${item.quantity} × ${this.listItemName(item)}`).join("\n");
    return `More than one ${LIST_LABELS[list]} list item matches “${itemText}”:\n${options}\nSay which one by number, for example “${verb === "remove" ? `remove ${items.indexOf(matches[0]!) + 1} from ${command} list` : `set ${items.indexOf(matches[0]!) + 1} on ${command} list to 2`}”. Nothing was changed.`;
  }

  removeFromList(list: ListKey, itemText: string): string {
    const label = LIST_LABELS[list];
    const { items, matches } = this.matchListItems(list, itemText);
    if (!matches.length) {
      return `I couldn’t find “${itemText}” on the ${label} list, so nothing was removed. Text “${LIST_COMMAND_NAMES[list]} list” to see it.`;
    }
    if (matches.length > 1) return this.ambiguousListMatch(list, itemText, matches, items, "remove");
    const item = matches[0]!;
    this.ctx.db.prepare("DELETE FROM recurring_list_items WHERE id = ?").run(item.id);
    this.ctx.db.prepare("UPDATE recurring_lists SET revision = revision + 1 WHERE household_id = ? AND list_key = ?")
      .run(this.ctx.householdId, list);
    const remaining = items.length - 1;
    return `Removed ${this.listItemName(item)} from the ${label} list. It now has ${remaining} item${remaining === 1 ? "" : "s"}. The cart was not changed.`;
  }

  setListQuantity(list: ListKey, itemText: string, quantity: number): string {
    if (quantity === 0) return this.removeFromList(list, itemText);
    const label = LIST_LABELS[list];
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return "Quantities must be between 1 and 99.";
    const { items, matches } = this.matchListItems(list, itemText);
    if (!matches.length) return `I couldn’t find “${itemText}” on the ${label} list, so nothing was changed.`;
    if (matches.length > 1) return this.ambiguousListMatch(list, itemText, matches, items, "quantity");
    const item = matches[0]!;
    this.ctx.db.prepare("UPDATE recurring_list_items SET quantity = ? WHERE id = ?").run(quantity, item.id);
    this.ctx.db.prepare("UPDATE recurring_lists SET revision = revision + 1 WHERE household_id = ? AND list_key = ?")
      .run(this.ctx.householdId, list);
    return `Set ${this.listItemName(item)} on the ${label} list to ${quantity}. The cart was not changed.`;
  }

  requestListClear(memberId: string, list: ListKey): string {
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const items = this.listItems(list);
    if (!items.length) return `The ${label} list is already empty.`;
    this.ctx.db.prepare(
      "INSERT INTO pending_list_clears (member_id, list_key, list_revision, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET list_key = excluded.list_key, list_revision = excluded.list_revision, created_at = excluded.created_at",
    ).run(memberId, list, this.listRow(list).revision, new Date().toISOString());
    return `This will remove all ${items.length} item${items.length === 1 ? "" : "s"} from the household’s ${label} list for everyone (the cart is not affected, and this can’t be undone). Reply “confirm clear ${command} list” to proceed, or “cancel clear ${command} list”.`;
  }

  confirmListClear(memberId: string, list?: ListKey): string {
    const pending = this.ctx.db.prepare("SELECT list_key, list_revision FROM pending_list_clears WHERE member_id = ?")
      .get(memberId) as { list_key: ListKey; list_revision: number } | undefined;
    if (!pending || (list && pending.list_key !== list)) {
      const name = list ? LIST_COMMAND_NAMES[list] : "weekly";
      return `There isn’t a pending request from you to clear ${list ? `the ${LIST_LABELS[list]}` : "a"} list. Text “clear ${name} list” first.`;
    }
    const key = pending.list_key;
    const label = LIST_LABELS[key];
    const command = LIST_COMMAND_NAMES[key];
    const row = this.listRow(key);
    const items = this.listItems(key);
    if (row.revision !== pending.list_revision) {
      this.ctx.db.prepare("UPDATE pending_list_clears SET list_revision = ?, created_at = ? WHERE member_id = ?")
        .run(row.revision, new Date().toISOString(), memberId);
      return `The ${label} list changed since you asked. It now has ${items.length} item${items.length === 1 ? "" : "s"}. Reply “confirm clear ${command} list” again to clear it, or “cancel clear ${command} list”.`;
    }
    this.ctx.db.prepare("DELETE FROM pending_list_clears WHERE member_id = ?").run(memberId);
    this.ctx.db.prepare("DELETE FROM recurring_list_items WHERE household_id = ? AND list_key = ?").run(this.ctx.householdId, key);
    this.ctx.db.prepare("UPDATE recurring_lists SET revision = revision + 1 WHERE household_id = ? AND list_key = ?")
      .run(this.ctx.householdId, key);
    return `Cleared the ${label} list (${items.length} item${items.length === 1 ? "" : "s"} removed). The cart was not changed. Add new items with “${command}: …”.`;
  }

  cancelListClear(memberId: string, list?: ListKey): string {
    const pending = this.ctx.db.prepare("SELECT list_key FROM pending_list_clears WHERE member_id = ?")
      .get(memberId) as { list_key: ListKey } | undefined;
    if (!pending || (list && pending.list_key !== list)) return "There isn’t a pending list clear to cancel.";
    this.ctx.db.prepare("DELETE FROM pending_list_clears WHERE member_id = ?").run(memberId);
    return `Okay, I left the ${LIST_LABELS[pending.list_key]} list unchanged.`;
  }

  /** Why a load can’t proceed (empty list or already loaded this cycle), if anything. */
  listLoadBlocker(list: ListKey, force: boolean): string | undefined {
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    if (!this.listItems(list).length) {
      return `The ${label} list is empty, so nothing was added to the cart. Add items with “${command}: milk, eggs”.`;
    }
    if (force) return undefined;
    const row = this.listRow(list);
    if (row.last_loaded_at && this.listDueInfo(row, this.ctx.now()).loadedThisCycle) {
      const by = row.last_loaded_by ? this.ctx.getMembers().find((member) => member.id === row.last_loaded_by)?.name : undefined;
      return `The ${label} list was already loaded into the cart on ${friendlyDate(new Date(row.last_loaded_at))}${by ? ` by ${by}` : ""}, so I didn’t add it again. Text “load ${command} list again” if you really want another copy.`;
    }
    return undefined;
  }

  /** Called when a cart undo entry is reverted: if it was a list load, restore the previous load state. */
  revertListLoad(undoId: string): void {
    const load = this.ctx.db.prepare(
      "SELECT list_key, prev_loaded_at, prev_loaded_by FROM recurring_list_loads WHERE household_id = ? AND undo_id = ?",
    ).get(this.ctx.householdId, undoId) as { list_key: ListKey; prev_loaded_at: string | null; prev_loaded_by: string | null } | undefined;
    if (!load) return;
    this.ctx.db.prepare("UPDATE recurring_lists SET last_loaded_at = ?, last_loaded_by = ? WHERE household_id = ? AND list_key = ?")
      .run(load.prev_loaded_at, load.prev_loaded_by, this.ctx.householdId, load.list_key);
    this.ctx.db.prepare("DELETE FROM recurring_list_loads WHERE undo_id = ?").run(undoId);
  }

  async quoteListItems(list: ListKey, quoteProduct: ProductQuoter): Promise<Map<string, ProductQuote>> {
    const krogerItems = this.listItems(list).filter((item) => item.price_source === "kroger" && item.product_id.startsWith("kroger:"));
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
  loadListIntoCart(memberId: string, list: ListKey, force: boolean, quotes: Map<string, ProductQuote> | undefined, liveQuotes: boolean): string {
    const blocker = this.listLoadBlocker(list, force);
    if (blocker) return blocker;
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const items = this.listItems(list);
    const inCart = new Set((this.ctx.db.prepare("SELECT product_id FROM cart_items WHERE household_id = ?")
      .all(this.ctx.householdId) as Array<{ product_id: string }>).map((row) => row.product_id));
    const undoSnapshot = this.m.cart.captureCartItems();
    const createdAt = new Date().toISOString();
    const nowIso = this.ctx.now().toISOString();
    const insertSample = this.ctx.db.prepare(
      "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertKroger = this.ctx.db.prepare(
      "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Loaded items follow the sender's sharing session like any other add.
    const participantIds = this.m.sharing.participantsFor(memberId);
    const participants = JSON.stringify(participantIds);
    const added: string[] = [];
    const flagged: string[] = [];
    const alreadyInCart: string[] = [];
    const unpriced: string[] = [];
    for (const item of items) {
      const name = this.listItemName(item);
      if (!force && inCart.has(item.product_id)) {
        alreadyInCart.push(name);
        continue;
      }
      const catalogProduct = item.price_source === "sample" ? CATALOG.find((product) => product.id === item.product_id) : undefined;
      if (catalogProduct) {
        insertSample.run(randomUUID(), this.ctx.householdId, item.product_id, item.quantity, memberId, participants, createdAt);
        added.push(`• ${item.quantity} × ${catalogProduct.name} — ${money(catalogProduct.priceCents * item.quantity)} (sample estimate)`);
        continue;
      }
      const quote = quotes?.get(item.product_id);
      const quotedPrice = quote?.product ? currentPriceCents(quote.product) : null;
      const price = quotedPrice ?? item.unit_price_cents;
      if (price === null) {
        unpriced.push(name);
        continue;
      }
      const finalName = quote?.product && quotedPrice !== null ? quote.product.description : name;
      const upc = quote?.product && quotedPrice !== null ? quote.product.upc ?? item.upc : item.upc;
      insertKroger.run(randomUUID(), this.ctx.householdId, item.product_id, item.quantity, memberId, participants, createdAt,
        finalName, price, "kroger", upc);
      if (quotedPrice !== null) {
        this.ctx.db.prepare("UPDATE recurring_list_items SET product_name = ?, unit_price_cents = ?, upc = ?, quoted_at = ? WHERE id = ?")
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
    this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
      .run(this.ctx.householdId);
    this.m.cart.recordUndo(memberId, `load the ${label} list (${added.length} item${added.length === 1 ? "" : "s"})`, undoSnapshot);
    const undoEntry = this.ctx.db.prepare("SELECT id FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(this.ctx.householdId) as { id: string } | undefined;
    // Remember the previous load state per undo entry so undoing this load also
    // restores the list's “already loaded this cycle” state.
    const previous = this.listRow(list);
    this.ctx.db.prepare(
      "DELETE FROM recurring_list_loads WHERE household_id = ? AND undo_id NOT IN (SELECT id FROM cart_undo_history WHERE household_id = ?)",
    ).run(this.ctx.householdId, this.ctx.householdId);
    if (undoEntry) {
      this.ctx.db.prepare(
        "INSERT OR REPLACE INTO recurring_list_loads (undo_id, household_id, list_key, prev_loaded_at, prev_loaded_by) VALUES (?, ?, ?, ?, ?)",
      ).run(undoEntry.id, this.ctx.householdId, list, previous.last_loaded_at, previous.last_loaded_by);
    }
    this.ctx.db.prepare("UPDATE recurring_lists SET last_loaded_at = ?, last_loaded_by = ? WHERE household_id = ? AND list_key = ?")
      .run(nowIso, memberId, this.ctx.householdId, list);
    const recipients = participantIds.length > 1
      ? `shared by ${this.ctx.joinNames(this.ctx.memberNames(participantIds))}`
      : `for ${this.ctx.getMembers().find((member) => member.id === memberId)?.name ?? "you"}`;
    return [
      `Loaded ${added.length} item${added.length === 1 ? "" : "s"} from the ${label} list into the cart ${recipients} (one change — “undo” reverts it):`,
      ...added,
      ...notes,
      this.m.cart.formatSummary(memberId),
    ].join("\n");
  }

  startList(list: ListKey): string {
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const activation = this.activateList(list);
    const items = this.listItems(list);
    const ask = items.length
      ? `It already has ${items.length} item${items.length === 1 ? "" : "s"}; text “${command} list” to review. What else should be on it?`
      : "What should be on it?";
    const status = activation || (this.listRow(list).reminders_enabled === 1
      ? `It’s already active; next check-in ${this.m.listText.nextReminderText(list)}.`
      : `Reminders are paused; text “resume ${command} reminders” to turn them back on.`);
    return `The household’s ${label} list is ready. ${ask} Reply like “${command}: milk, eggs, bread” (up to 5 items per message). ${status}`;
  }

  setListWeekday(list: ListKey, weekday: number): string {
    if (list === "monthly") return "The monthly list uses a day of the month, for example “monthly list on the 1st”.";
    if (weekday < 0 || weekday > 6) return "I didn’t recognize that day. Try “weekly list on sundays”.";
    const now = this.ctx.now();
    const anchorDate = list === "biweekly" ? localDateKey(nextWeekdayAfter(now, weekday)) : this.listRow(list).anchor_date;
    this.ctx.db.prepare("UPDATE recurring_lists SET anchor_weekday = ?, anchor_date = ? WHERE household_id = ? AND list_key = ?")
      .run(weekday, anchorDate, this.ctx.householdId, list);
    return this.afterScheduleChange(list);
  }

  setListMonthDay(list: ListKey, dayOfMonth: number): string {
    if (list !== "monthly") {
      return `The ${LIST_LABELS[list]} list uses a weekday, for example “${LIST_COMMAND_NAMES[list]} list on sundays”.`;
    }
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return "Choose a day from 1 to 31, for example “monthly list on the 15th”.";
    this.ctx.db.prepare("UPDATE recurring_lists SET day_of_month = ? WHERE household_id = ? AND list_key = ?")
      .run(dayOfMonth, this.ctx.householdId, list);
    return this.afterScheduleChange(list);
  }

  /** A new anchor never triggers an immediate reminder for a cycle that has already started. */
  afterScheduleChange(list: ListKey): string {
    const now = this.ctx.now();
    const row = this.listRow(list);
    const info = this.listDueInfo(row, now);
    if (row.active_since && info.cycleStart <= now && row.last_reminded_cycle !== info.cycleKey) {
      this.ctx.db.prepare("UPDATE recurring_lists SET last_reminded_cycle = ? WHERE household_id = ? AND list_key = ?")
        .run(info.cycleKey, this.ctx.householdId, list);
    }
    const schedule = describeSchedule(list, this.listSchedule(row));
    const status = !row.active_since
      ? ` The list isn’t active yet; it starts when someone adds an item or texts “start ${LIST_COMMAND_NAMES[list]} list”.`
      : row.reminders_enabled !== 1
        ? " Reminders are currently paused."
        : ` Next check-in: ${this.m.listText.nextReminderText(list)}.`;
    return `Okay — the ${LIST_LABELS[list]} list is now due ${schedule}. I check in around ${this.m.listText.reminderHourText()} that day.${status}`;
  }

  setListReminders(list: ListKey, enabled: boolean): string {
    this.ctx.db.prepare("UPDATE recurring_lists SET reminders_enabled = ? WHERE household_id = ? AND list_key = ?")
      .run(enabled ? 1 : 0, this.ctx.householdId, list);
    const label = LIST_LABELS[list];
    if (!enabled) {
      return `Paused reminders for the ${label} list. The list is kept; text “resume ${LIST_COMMAND_NAMES[list]} reminders” to turn them back on.`;
    }
    const row = this.listRow(list);
    return row.active_since
      ? `Reminders for the ${label} list are on. Next check-in: ${this.m.listText.nextReminderText(list)}.`
      : `Reminders for the ${label} list are on. They start once someone adds an item or texts “start ${LIST_COMMAND_NAMES[list]} list”.`;
  }
}
