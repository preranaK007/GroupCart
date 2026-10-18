// One-off named grocery lists ("Party run": chips, soda, cups; "Movie night snacks").
// Items are checked off or moved into the shared cart through the store's normal
// request path, as if the member had texted each item, so splits (sharing
// sessions), undo, and approvals behave exactly like a typed request. Recurring
// weekly/biweekly/monthly lists are a separate feature (the store's recurring
// lists); nothing here uses those phrases. Tables use the `list_` prefix in the
// shared SQLite database (store.database).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { localDate } from "./availability.js";
import { extractCartRequests, isGenericMilkRequest } from "./cart.js";
import type { KrogerClient } from "./kroger.js";
import { awardPoints } from "./points.js"; // money & points
import type { CartStore } from "./store.js";

// ---------------------------------------------------------------------------
// Pure helpers

/** Comparable list/item name ("The Party Run list" → "party run"). */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\b(?:the|our|my|list)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Words that belong to the store's recurring lists; one-off lists never claim them. */
export const RECURRING_LIST_WORDS = /\b(?:weekly|bi-?weekly|monthly|fortnightly|every\s+(?:two|2|other)\s+weeks?|two[-\s]?weeks?(?:ly)?)\b/i;

/** Turns an item into a safe cart request ("mac and cheese" must not split into two items). */
export function cartRequestText(name: string): string {
  return `add ${name.replace(/\s+and\s+/gi, " & ").replace(/[,;\n]+/g, " ").replace(/\s+/g, " ").trim()}`;
}

/**
 * Latest time (ISO) the store asked this member something they still have to
 * answer (product pick, milk type, list selection, …), or null. The store owns
 * those pending-question tables, so this asks it (CartStore.pendingQuestionAt).
 */
export function cartPromptAt(store: CartStore, memberId: string): string | null {
  return store.pendingQuestionAt(memberId);
}

// ---------------------------------------------------------------------------
// Service

type MemberLite = { id: string; name: string };
export type ListItemView = { id: string; name: string; checked: boolean; carted: boolean };
export type ListView = {
  id: string;
  name: string;
  emoji: string | null;
  eventId: string | null;
  createdBy: string | null;
  createdAt: string;
  items: ListItemView[];
  remaining: number;
};

type ListRow = { id: string; name: string; emoji: string | null; event_id: string | null; created_by: string | null; created_at: string };
type ItemRow = { id: string; list_id: string; name: string; checked: number; carted_at: string | null; position: number };

export type CartResult = { status: "added" | "needs_pick" | "not_found" | "retry"; reply: string };
export type MoveResult = { ok: boolean; message: string; added: string[]; missing: string[]; pending: string[] };

export class NamedListsService {
  readonly #store: CartStore;
  readonly #db: DatabaseSync;
  readonly #kroger: KrogerClient | undefined;
  readonly #now: () => number;
  readonly timeZone: string;

  constructor(store: CartStore, options: { timeZone: string; kroger?: KrogerClient; now?: () => number }) {
    this.#store = store;
    this.#db = store.database;
    this.#kroger = options.kroger;
    this.#now = options.now ?? Date.now;
    this.timeZone = options.timeZone;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS list_lists (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT,
        event_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS list_items (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL REFERENCES list_lists(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        checked INTEGER NOT NULL DEFAULT 0,
        carted_at TEXT,
        added_by TEXT,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS list_items_by_list ON list_items(list_id, position);
      CREATE TABLE IF NOT EXISTS list_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  get mode(): "sample" | "kroger" {
    return this.#kroger ? "kroger" : "sample";
  }

  get database(): DatabaseSync {
    return this.#db;
  }

  members(): MemberLite[] {
    return this.#store.getMembers().map(({ id, name }) => ({ id, name }));
  }

  memberName(id: string | null | undefined): string {
    return this.members().find((member) => member.id === id)?.name ?? "Someone";
  }

  today(): string {
    return localDate(this.#now(), this.timeZone);
  }

  meta(key: string): string | undefined {
    return (this.#db.prepare("SELECT value FROM list_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO list_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  #view(row: ListRow): ListView {
    const items = (this.#db.prepare("SELECT id, list_id, name, checked, carted_at, position FROM list_items WHERE list_id = ? ORDER BY position, created_at").all(row.id) as ItemRow[])
      .map((item) => ({ id: item.id, name: item.name, checked: Boolean(item.checked) || Boolean(item.carted_at), carted: Boolean(item.carted_at) }));
    return {
      id: row.id,
      name: row.name,
      emoji: row.emoji,
      eventId: row.event_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      items,
      remaining: items.filter((item) => !item.checked).length,
    };
  }

  allLists(): ListView[] {
    const rows = this.#db.prepare("SELECT * FROM list_lists WHERE household_id = ? ORDER BY created_at DESC").all(this.#store.household) as ListRow[];
    return rows.map((row) => this.#view(row));
  }

  getList(id: string): ListView | undefined {
    const row = this.#db.prepare("SELECT * FROM list_lists WHERE id = ? AND household_id = ?").get(id, this.#store.household) as ListRow | undefined;
    return row ? this.#view(row) : undefined;
  }

  listForEvent(eventId: string): ListView | undefined {
    const row = this.#db.prepare("SELECT * FROM list_lists WHERE event_id = ? AND household_id = ? ORDER BY created_at DESC LIMIT 1").get(eventId, this.#store.household) as ListRow | undefined;
    return row ? this.#view(row) : undefined;
  }

  /** Finds a list by name: exact, then a unique prefix or substring match. Never matches recurring-list words. */
  findList(query: string): ListView | undefined {
    if (RECURRING_LIST_WORDS.test(query)) return undefined;
    const wanted = normalizeName(query);
    if (!wanted) return undefined;
    const rows = this.#db.prepare("SELECT * FROM list_lists WHERE household_id = ? ORDER BY created_at DESC").all(this.#store.household) as ListRow[];
    const exact = rows.find((row) => normalizeName(row.name) === wanted);
    if (exact) return this.#view(exact);
    const prefix = rows.filter((row) => normalizeName(row.name).startsWith(wanted));
    if (prefix.length === 1) return this.#view(prefix[0]!);
    const partial = rows.filter((row) => normalizeName(row.name).includes(wanted));
    return partial.length === 1 ? this.#view(partial[0]!) : undefined;
  }

  #exists(name: string): boolean {
    const found = this.findList(name);
    return Boolean(found && normalizeName(found.name) === normalizeName(name));
  }

  createList(input: { name: string; items?: string[]; createdBy: string | null; emoji?: string | null; eventId?: string | null; nameSuffix?: string }): { ok: true; list: ListView } | { ok: false; error: string } {
    let name = input.name.replace(/\s+/g, " ").trim().replace(/^[\s,:;-]+|[\s,:;.-]+$/g, "");
    if (!name) return { ok: false, error: "Name the list, e.g. “new list party run: chips, soda”." };
    if (name.length > 48) return { ok: false, error: "That list name is too long (48 characters max)." };
    if (RECURRING_LIST_WORDS.test(name)) return { ok: false, error: "Weekly, biweekly, and monthly lists are the recurring lists. Pick another name for a one-off list." };
    name = name.charAt(0).toUpperCase() + name.slice(1);
    if (this.#exists(name)) {
      if (!input.eventId) return { ok: false, error: `There’s already a list called ${name}.` };
      name = `${name} ${input.nameSuffix ?? new Intl.DateTimeFormat("en-US", { timeZone: this.timeZone, month: "short", day: "numeric" }).format(this.#now())}`;
      if (this.#exists(name)) name = `${name} ${randomUUID().slice(0, 4)}`;
    }
    const id = randomUUID();
    this.#db.prepare("INSERT INTO list_lists (id, household_id, name, emoji, event_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, this.#store.household, name, input.emoji ?? null, input.eventId ?? null, input.createdBy, new Date(this.#now()).toISOString());
    if (input.items?.length) this.addItems(id, input.items, input.createdBy);
    return { ok: true, list: this.getList(id)! };
  }

  /** Adds items (skips blanks and duplicates already unchecked on the list). Returns the names added. */
  addItems(listId: string, names: string[], addedBy: string | null): string[] {
    const list = this.getList(listId);
    if (!list) return [];
    const existing = new Set(list.items.filter((item) => !item.checked).map((item) => normalizeName(item.name)));
    let position = (this.#db.prepare("SELECT COALESCE(MAX(position), 0) AS max FROM list_items WHERE list_id = ?").get(listId) as { max: number }).max;
    const added: string[] = [];
    const insert = this.#db.prepare("INSERT INTO list_items (id, list_id, name, checked, carted_at, added_by, position, created_at) VALUES (?, ?, ?, 0, NULL, ?, ?, ?)");
    for (const raw of names) {
      const name = raw.replace(/\s+/g, " ").trim().replace(/^[\s,:;-]+|[\s,:;.-]+$/g, "").slice(0, 60);
      if (!name || existing.has(normalizeName(name))) continue;
      existing.add(normalizeName(name));
      position += 1;
      const display = name.charAt(0).toUpperCase() + name.slice(1);
      insert.run(randomUUID(), listId, display, addedBy, position, new Date(this.#now()).toISOString());
      added.push(display);
    }
    return added;
  }

  /** Removes items by name; returns the names removed. */
  removeItems(listId: string, names: string[]): string[] {
    const list = this.getList(listId);
    if (!list) return [];
    const removed: string[] = [];
    for (const raw of names) {
      const wanted = normalizeName(raw);
      const item = list.items.find((candidate) => normalizeName(candidate.name) === wanted) ?? list.items.find((candidate) => normalizeName(candidate.name).includes(wanted));
      if (!item || removed.includes(item.name)) continue;
      this.#db.prepare("DELETE FROM list_items WHERE id = ?").run(item.id);
      removed.push(item.name);
    }
    return removed;
  }

  deleteItem(itemId: string): boolean {
    return Number(this.#db.prepare("DELETE FROM list_items WHERE id = ? AND list_id IN (SELECT id FROM list_lists WHERE household_id = ?)").run(itemId, this.#store.household).changes) > 0;
  }

  setItemChecked(itemId: string, checked: boolean, actorId: string | null = null): boolean {
    const result = this.#db.prepare("UPDATE list_items SET checked = ?, carted_at = CASE WHEN ? = 0 THEN NULL ELSE carted_at END WHERE id = ? AND list_id IN (SELECT id FROM list_lists WHERE household_id = ?)")
      .run(checked ? 1 : 0, checked ? 1 : 0, itemId, this.#store.household);
    // --- Money & points: checking off the last item finishes the list ---
    if (checked && actorId && Number(result.changes) > 0) {
      const row = this.#db.prepare("SELECT list_id FROM list_items WHERE id = ?").get(itemId) as { list_id: string } | undefined;
      if (row) this.#creditIfFinished(row.list_id, actorId);
    }
    // --- end money & points ---
    return Number(result.changes) > 0;
  }

  // --- Money & points: finishing a one-off list (every item checked off or moved to the cart) earns points once ---
  #creditIfFinished(listId: string, memberId: string): void {
    const list = this.getList(listId);
    if (list && list.items.length && list.remaining === 0) awardPoints({ kind: "list", memberId, key: `list:${listId}`, label: `Finished ${list.name}` });
  }
  // --- end money & points ---

  deleteList(listId: string): boolean {
    return Number(this.#db.prepare("DELETE FROM list_lists WHERE id = ? AND household_id = ?").run(listId, this.#store.household).changes) > 0;
  }

  #inCart(name: string, memberId: string): boolean {
    const productIds = extractCartRequests(name).map((request) => request.product.id);
    const wanted = normalizeName(name);
    return this.#store.snapshot().items.some((item) => {
      const sameItem = productIds.length ? productIds.includes(item.productId) : normalizeName(item.name).includes(wanted);
      return sameItem && (item.ownerId === memberId || item.participantIds.includes(memberId));
    });
  }

  /** Sends one request through the store as if `memberId` had texted it. */
  async addToCart(messageId: string, memberId: string, text: string): Promise<CartResult> {
    const before = this.#store.snapshot().revision;
    const kroger = this.#kroger;
    const reply = kroger
      ? await this.#store.processLiveIncomingText(messageId, memberId, text, (query) => kroger.searchProducts(query), kroger.selectedLocationId)
      : this.#store.processIncomingText(messageId, memberId, text);
    const replyText = reply ?? "";
    if (this.#store.snapshot().revision !== before) return { status: "added", reply: replyText };
    if (/couldn’t reach|couldn't reach|couldn’t search/i.test(replyText)) return { status: "retry", reply: replyText };
    if (/Reply 1-|Reply 1 for whole|reply 1 for whole|Which kind|What kind|Reply with one choice|which kind of milk/i.test(replyText)) return { status: "needs_pick", reply: replyText };
    return { status: "not_found", reply: replyText };
  }

  /**
   * Adds every unchecked item to the shared cart as `memberId` (sample catalog in
   * demo mode; Kroger product choices in live mode, which the member then picks).
   * Items belong to the member, or are split by their sharing session.
   */
  async moveToCart(listId: string, memberId: string): Promise<MoveResult> {
    const list = this.getList(listId);
    if (!list) return { ok: false, message: "That list no longer exists.", added: [], missing: [], pending: [] };
    const open = list.items.filter((item) => !item.checked);
    if (!open.length) return { ok: false, message: `Nothing left on ${list.name}.`, added: [], missing: [], pending: [] };
    if (this.#store.pendingKrogerCheckout()) return { ok: false, message: "The cart is locked while a Kroger checkout is in progress. Try again after it finishes.", added: [], missing: [], pending: [] };
    if (cartPromptAt(this.#store, memberId)) {
      return { ok: false, message: `${this.memberName(memberId)}, you have an open grocery question. Answer it (or text “cancel”), then try again.`, added: [], missing: [], pending: [] };
    }
    const markCarted = (ids: string[]) => {
      const stamp = new Date(this.#now()).toISOString();
      for (const id of ids) this.#db.prepare("UPDATE list_items SET checked = 1, carted_at = ? WHERE id = ?").run(stamp, id);
      this.#creditIfFinished(list.id, memberId); // money & points
    };

    if (this.#kroger) {
      const batch = open.slice(0, 5);
      const text = `add ${batch.map((item) => cartRequestText(item.name).replace(/^add /, "")).join(", ")}`;
      const result = await this.addToCart(`list:${list.id}:${randomUUID().slice(0, 8)}`, memberId, text);
      if (result.status === "retry" || result.status === "not_found") return { ok: false, message: result.reply, added: [], missing: batch.map((item) => item.name), pending: [] };
      markCarted(batch.map((item) => item.id));
      const rest = open.length - batch.length;
      const more = rest > 0 ? `\n${rest} more on ${list.name}. Send “${list.name.toLowerCase()} to cart” again after choosing.` : "";
      return { ok: true, message: `${result.reply}${more}`, added: result.status === "added" ? batch.map((item) => item.name) : [], missing: [], pending: result.status === "needs_pick" ? batch.map((item) => item.name) : [] };
    }

    const ordered = [...open].sort((a, b) => Number(isGenericMilkRequest(a.name)) - Number(isGenericMilkRequest(b.name)));
    const added: string[] = [];
    const missing: string[] = [];
    const pending: string[] = [];
    let question = "";
    for (const item of ordered) {
      if (!extractCartRequests(item.name).length && !isGenericMilkRequest(item.name)) { missing.push(item.name); continue; }
      if (this.#inCart(item.name, memberId)) { added.push(item.name); markCarted([item.id]); continue; }
      const result = await this.addToCart(`list:${item.id}:${randomUUID().slice(0, 8)}`, memberId, cartRequestText(item.name));
      if (result.status === "added") { added.push(item.name); markCarted([item.id]); }
      else if (result.status === "needs_pick") { pending.push(item.name); markCarted([item.id]); question = result.reply; break; }
      else missing.push(item.name);
    }
    const lines: string[] = [];
    if (added.length) lines.push(`🛒 Moved ${added.length} from ${list.name} to the cart: ${added.map((name) => name.toLowerCase()).join(", ")}.`);
    if (missing.length) lines.push(`Not in the sample catalog: ${missing.map((name) => name.toLowerCase()).join(", ")}.`);
    if (question) lines.push(question);
    if (!lines.length) lines.push(`Nothing from ${list.name} could be added.`);
    return { ok: added.length > 0 || pending.length > 0, message: lines.join("\n"), added, missing, pending };
  }
}
