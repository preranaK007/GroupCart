// Pantry: a simple household inventory where each item is In stock, Low, or Out.
//
// "we're out of olive oil" / "low on rice" / "restocked eggs" update an item (creating it when new) and log an
// event; the run-out cadence of each item is learned from those events (median days between "out" events, or
// between restocks/purchases when there aren't enough). When an item runs out regularly, GroupCart suggests the
// store command that adds it to the matching recurring list ("biweekly: olive oil"); it never writes to the store's
// recurring lists itself. Checkout marks purchased items In stock (src/kitchen.ts watches checkouts).
//
// Item identity is shared with meal planning (src/meals.ts): `itemKey()` maps "Extra virgin olive oil", "olive oil"
// and the cart's "Olive oil" to one key, using the sample catalog when the name is one catalog product.
// Tables use the `pantry_` prefix in the shared SQLite database (store.database).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CATALOG, extractCartRequests, type Product } from "./cart.js";
import { LIST_LABELS, type ListKey } from "./lists.js";
import type { CartStore } from "./store.js";

export type PantryStatus = "stock" | "low" | "out";
export const PANTRY_STATUSES: readonly PantryStatus[] = ["stock", "low", "out"];
export const STATUS_LABEL: Record<PantryStatus, string> = { stock: "In stock", low: "Low", out: "Out" };

// ---------------------------------------------------------------------------
// Item names and identity (pure)

const LEADING_WORDS = /^(?:(?:the|our|my|some|more|any|a|an|all|all the|of|fresh|new)\s+)+/i;
const TRAILING_WORDS = /(?:\s+(?:please|pls|now|again|too|already|anymore|any more|left|at home|in the house|in the pantry|for (?:the )?(?:week|dinner|dinners)|lol|haha|ugh))+$/i;

/** Lowercase, trims filler ("the", "some", "please", "again"), punctuation, and emoji. */
export function normalizeItemText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}%'&\- ]+/gu, " ").replace(/\s+/g, " ").trim()
    .replace(LEADING_WORDS, "").replace(TRAILING_WORDS, "").trim();
}

/** Simple singular form for comparing names ("tomatoes" → "tomato", "berries" → "berry", "rice" stays). */
export function singularize(word: string): string {
  if (word.length <= 3 || /(?:ss|us|is|ous)$/.test(word)) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:oes|ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** The one catalog product a name refers to, when the whole name is about one product. */
export function catalogProduct(name: string): Product | undefined {
  const requests = extractCartRequests(name);
  return requests.length === 1 ? requests[0]!.product : undefined;
}

/** Stable identity for pantry items and recipe ingredients: "p:<catalog id>" or the singular words. */
export function itemKey(name: string): string {
  const product = catalogProduct(name);
  if (product) return `p:${product.id}`;
  return normalizeItemText(name).split(" ").filter(Boolean).map(singularize).join(" ");
}

/** Display name: the catalog name when there is one, else the cleaned text with a capital first letter. */
export function displayItemName(name: string): string {
  const product = catalogProduct(name);
  if (product) return product.name;
  const cleaned = normalizeItemText(name);
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : name.trim();
}

const UNIT = String.raw`(?:cups?|c\.|tbsps?|tablespoons?|tsps?|teaspoons?|lbs?|pounds?|oz|ounces?|g|grams?|kg|kilos?|ml|l|liters?|litres?|cans?|jars?|packs?|packages?|bags?|boxes?|bottles?|bunch(?:es)?|heads?|cloves?|pinch(?:es)?|handfuls?|dozen|slices?|pieces?|sticks?|blocks?|fillets?)`;

/** Recipe ingredient without amounts: "2 cups rice" → "rice", "1 can (15 oz) black beans" → "black beans". */
export function cleanIngredient(raw: string): string {
  let text = raw.normalize("NFKC").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(new RegExp(String.raw`^(?:about\s+|approx\.?\s+)?(?:\d+(?:[.,/]\d+)?|[½¼¾⅓⅔]|a|an|one|two|three|four|half(?:\s+a)?)(?:\s*-\s*\d+)?\s*(?:${UNIT}\b\.?)?(?:\s+of)?\s+`, "i"), "");
  text = text.replace(new RegExp(String.raw`^${UNIT}\s+of\s+`, "i"), "");
  text = text.replace(/,?\s*(?:to taste|optional|for serving|chopped|diced|minced|sliced|divided)\s*$/i, "");
  return text.replace(/^[\s,;:-]+|[\s,;:.-]+$/g, "").toLowerCase().slice(0, 40);
}

/** "eggs, rice and olive oil" → three names; a phrase that is one known item ("mac and cheese") stays whole. */
export function splitItemNames(text: string, knownKeys: ReadonlySet<string> = new Set()): string[] {
  const whole = normalizeItemText(text);
  if (!whole) return [];
  if (knownKeys.has(itemKey(whole))) return [whole];
  const parts = text.split(/\s*(?:,|;|\+|&|\band\b|\bplus\b)\s*/i).map((part) => normalizeItemText(part)).filter((part) => part.length >= 2 && part.length <= 40);
  return [...new Set(parts)];
}

// ---------------------------------------------------------------------------
// Group-chat parsing (pure)

export type PantryCommand =
  | { kind: "show" }
  | { kind: "status"; status: PantryStatus; text: string; explicit: boolean };

/** Things people are "out of" that are not groceries. */
const NOT_ITEMS = /^(?:town|here|there|office|the office|time|luck|it|this|that|these|those|you|him|her|them|ideas|money|cash|options|patience|sync|my mind|control|order|stock|gas|breath|state|the country|country|bed|line|place|touch|reach|range|school|work|commission|service|battery|space|practice|shape|the loop|loop|character|context|steam|juice|energy|budget|spoons|home|the house|the way|my way|bounds|sight|it lol)$/i;
const TRAVEL = /\b(?:until|till|til|thru|through|this week|next week|for the (?:week|weekend)|tonight|tomorrow|today)\b/i;

/**
 * Pantry commands: "pantry", "out of eggs", "we're out of olive oil", "low on rice", "running low on coffee",
 * "restocked eggs", "got eggs". `explicit` is false for "got X"/"bought X", which only count for known items.
 */
export function parsePantryCommand(raw: string): PantryCommand | null {
  const text = raw.normalize("NFKC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
  if (!text || text.length > 120) return null;
  if (/^(?:pantry|the pantry|our pantry|show (?:the |our )?pantry|pantry list|what'?s in (?:the |our )?pantry|whats in the pantry|what are we (?:out of|low on)|what'?s low|whats low|what are we low on)\??$/i.test(text)) return { kind: "show" };

  const item = (value: string | undefined): string | null => {
    if (!value) return null;
    const cleaned = value.replace(/^(?:the|our|my|some)\s+/i, "").trim();
    if (!cleaned || cleaned.length > 60 || NOT_ITEMS.test(cleaned) || TRAVEL.test(cleaned)) return null;
    if (/\b(?:on|from|off)\s+(?:the |our |my )?\S/i.test(cleaned) && !/\blow on\b/i.test(cleaned)) return null; // "got salsa on party run" (one-off lists)
    return cleaned;
  };
  const subject = String.raw`(?:(?:uh oh,?\s+|ugh,?\s+|heads up,?\s+|fyi,?\s+)?(?:we|i)(?:'re|'ve| are| have)?\s+|looks like we(?:'re| are)?\s+)?`;
  let match = new RegExp(String.raw`^${subject}(?:just\s+|almost\s+|nearly\s+|kinda\s+|pretty\s+|a bit\s+|getting\s+)?(?:running|getting)\s+(?:low on|out of)\s+(.+)$`, "i").exec(text)
    ?? new RegExp(String.raw`^${subject}(?:getting\s+|running\s+|pretty\s+|kinda\s+|a bit\s+|almost\s+|very\s+|super\s+)?low on\s+(.+)$`, "i").exec(text);
  if (match) {
    const name = item(match[1]);
    return name ? { kind: "status", status: "low", text: name, explicit: true } : null;
  }
  match = new RegExp(String.raw`^${subject}(?:just\s+|all\s+|completely\s+|totally\s+|fully\s+|officially\s+)?(?:out of|ran out of|run out of|outta)\s+(.+)$`, "i").exec(text)
    ?? /^no more\s+(.+?)\s+(?:left|in the house|at home)$/i.exec(text);
  if (match) {
    const name = item(match[1]);
    return name ? { kind: "status", status: "out", text: name, explicit: true } : null;
  }
  match = /^(?:(?:we|i)\s+(?:just\s+)?)?(?:restocked|re-stocked|stocked up on|refilled|replenished|bought more|got more)\s+(.+)$/i.exec(text)
    ?? /^(.+?)\s+(?:is|are)\s+(?:back\s+)?in stock$/i.exec(text)
    ?? /^(?:we have|we've got|got) (.+?) (?:again|now)$/i.exec(text);
  if (match) {
    const name = item(match[1]);
    return name ? { kind: "status", status: "stock", text: name, explicit: true } : null;
  }
  match = /^(?:(?:we|i)\s+(?:just\s+)?)?(?:got|bought|picked up)\s+(.+)$/i.exec(text);
  if (match) {
    const name = item(match[1]);
    return name ? { kind: "status", status: "stock", text: name, explicit: false } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cadence learning (pure)

export type PantryEventKind = "out" | "low" | "stock" | "purchase";
export type PantryEvent = { kind: PantryEventKind; at: string };
export type Cadence = { days: number; basis: "out" | "restock"; samples: number };

const DAY_MS = 86_400_000;

function intervals(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const kept: number[] = [];
  for (const time of sorted) {
    // Two reports within two days are the same run-out ("out of eggs" from two roommates).
    if (!kept.length || time - kept[kept.length - 1]! >= 2 * DAY_MS) kept.push(time);
  }
  return kept.slice(1).map((time, index) => (time - kept[index]!) / DAY_MS);
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * How often an item runs out: the median days between "out" events (at least two intervals), else between
 * restocks/purchases. Null unless it looks regular: 2–60 days, and no interval more than 3x another.
 */
export function learnCadence(events: readonly PantryEvent[]): Cadence | null {
  const at = (kinds: PantryEventKind[]) => events.filter((event) => kinds.includes(event.kind)).map((event) => Date.parse(event.at)).filter(Number.isFinite);
  for (const [basis, kinds] of [["out", ["out"]], ["restock", ["stock", "purchase"]]] as const) {
    const gaps = intervals(at([...kinds]));
    if (gaps.length < 2) continue;
    const days = median(gaps);
    if (days < 2 || days > 60) return null;
    if (Math.max(...gaps) > 3 * Math.min(...gaps)) return null;
    return { days: Math.round(days * 10) / 10, basis, samples: gaps.length };
  }
  return null;
}

/** The recurring list that matches a cadence: weekly (≤10 days), every two weeks (≤21), monthly (≤45). */
export function recurringListFor(days: number): ListKey | null {
  if (days <= 10) return "weekly";
  if (days <= 21) return "biweekly";
  if (days <= 45) return "monthly";
  return null;
}

export function cadenceLabel(days: number): string {
  if (days >= 6 && days <= 8) return "every week";
  if (days >= 12 && days <= 16) return "every 2 weeks";
  if (days >= 19 && days <= 23) return "every 3 weeks";
  if (days >= 26 && days <= 35) return "every month";
  return `every ${Math.round(days)} days`;
}

/** The exact store command that adds an item to a recurring list, e.g. “biweekly: olive oil”. */
export function recurringListCommand(list: ListKey, name: string): string {
  return `${list}: ${name.toLowerCase()}`;
}

export function suggestionText(name: string, cadence: Cadence, list: ListKey): string {
  return `↻ ${name} runs out about ${cadenceLabel(cadence.days)}. Text “${recurringListCommand(list, name)}” to add it to the ${LIST_LABELS[list]} list.`;
}

// ---------------------------------------------------------------------------
// Persistence

export type PantryItem = {
  id: string;
  key: string;
  name: string;
  status: PantryStatus;
  updatedAt: string;
  updatedBy: string | null;
};
export type PantryItemView = PantryItem & {
  inCart: boolean;
  cadenceDays: number | null;
  /** Set when the item runs out regularly and isn't on a recurring list yet. */
  suggestion: { list: ListKey; command: string; label: string } | null;
};

type ItemRow = { id: string; key: string; name: string; status: string; updated_at: string; updated_by: string | null; suggested_at: string | null };

/** How long a "Add it to the cart? Reply yes" offer stays answerable. */
export const OFFER_WINDOW_MS = 30 * 60_000;
const SUGGEST_AGAIN_MS = 21 * DAY_MS;

export class PantryService {
  readonly #store: CartStore;
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(store: CartStore, options: { now?: () => number } = {}) {
    this.#store = store;
    this.#db = store.database;
    this.#now = options.now ?? Date.now;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS pantry_items (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        suggested_at TEXT,
        UNIQUE (household_id, key)
      );
      CREATE TABLE IF NOT EXISTS pantry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        member_id TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pantry_events_by_item ON pantry_events (household_id, item_key, at);
      CREATE TABLE IF NOT EXISTS pantry_offers (
        household_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        keys_json TEXT NOT NULL,
        message_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (household_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS pantry_meta (
        household_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (household_id, key)
      );
    `);
  }

  get #household(): string {
    return this.#store.household;
  }

  #iso(offsetMs = 0): string {
    return new Date(this.#now() + offsetMs).toISOString();
  }

  meta(key: string): string | undefined {
    return (this.#db.prepare("SELECT value FROM pantry_meta WHERE household_id = ? AND key = ?").get(this.#household, key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO pantry_meta (household_id, key, value) VALUES (?, ?, ?) ON CONFLICT (household_id, key) DO UPDATE SET value = excluded.value").run(this.#household, key, value);
  }

  #toItem(row: ItemRow): PantryItem {
    const status = PANTRY_STATUSES.includes(row.status as PantryStatus) ? row.status as PantryStatus : "stock";
    return { id: row.id, key: row.key, name: row.name, status, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  #rows(): ItemRow[] {
    return this.#db.prepare("SELECT id, key, name, status, updated_at, updated_by, suggested_at FROM pantry_items WHERE household_id = ? ORDER BY name COLLATE NOCASE").all(this.#household) as ItemRow[];
  }

  items(): PantryItem[] {
    return this.#rows().map((row) => this.#toItem(row));
  }

  get(id: string): PantryItem | undefined {
    const row = this.#db.prepare("SELECT id, key, name, status, updated_at, updated_by, suggested_at FROM pantry_items WHERE household_id = ? AND id = ?").get(this.#household, id) as ItemRow | undefined;
    return row ? this.#toItem(row) : undefined;
  }

  byKey(key: string): PantryItem | undefined {
    const row = this.#db.prepare("SELECT id, key, name, status, updated_at, updated_by, suggested_at FROM pantry_items WHERE household_id = ? AND key = ?").get(this.#household, key) as ItemRow | undefined;
    return row ? this.#toItem(row) : undefined;
  }

  /** A pantry item by name: same key, else a unique item whose name contains it ("oil" → "Olive oil"). */
  find(name: string): PantryItem | undefined {
    const exact = this.byKey(itemKey(name));
    if (exact) return exact;
    const wanted = normalizeItemText(name);
    if (wanted.length < 3) return undefined;
    const partial = this.items().filter((item) => normalizeItemText(item.name).split(" ").map(singularize).join(" ").includes(wanted.split(" ").map(singularize).join(" ")));
    return partial.length === 1 ? partial[0] : undefined;
  }

  knownKeys(): Set<string> {
    return new Set(this.items().map((item) => item.key));
  }

  inStockKeys(): Set<string> {
    return new Set(this.items().filter((item) => item.status === "stock").map((item) => item.key));
  }

  statusByKey(): Map<string, PantryStatus> {
    return new Map(this.items().map((item) => [item.key, item.status]));
  }

  /** Keys of everything in the shared cart (catalog products and Kroger names mapped to pantry keys). */
  cartKeys(): Set<string> {
    return new Set(this.#store.snapshot().items.flatMap((item) => [`p:${item.productId}`, itemKey(item.name)]));
  }

  #log(key: string, kind: PantryEventKind, memberId: string | null, at = this.#iso()): void {
    this.#db.prepare("INSERT INTO pantry_events (household_id, item_key, kind, member_id, at) VALUES (?, ?, ?, ?, ?)").run(this.#household, key, kind, memberId, at);
  }

  /** Test/demo helper: a past event for cadence learning. */
  logEvent(key: string, kind: PantryEventKind, at: string, memberId: string | null = null): void {
    this.#log(key, kind, memberId, at);
  }

  events(key: string): PantryEvent[] {
    return this.#db.prepare("SELECT kind, at FROM pantry_events WHERE household_id = ? AND item_key = ? ORDER BY at").all(this.#household, key) as PantryEvent[];
  }

  /** Sets an item's status (adding it when new) and logs the change. Returns the item and its previous status. */
  set(name: string, status: PantryStatus, memberId: string | null, options: { event?: PantryEventKind } = {}): { item: PantryItem; previous: PantryStatus | null } {
    const existing = this.find(name);
    const now = this.#iso();
    if (existing) {
      if (existing.status !== status) {
        this.#db.prepare("UPDATE pantry_items SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(status, memberId, now, existing.id);
      }
      if (existing.status !== status || options.event === "purchase") this.#log(existing.key, options.event ?? status, memberId);
      return { item: this.get(existing.id)!, previous: existing.status };
    }
    const key = itemKey(name);
    const id = randomUUID();
    this.#db.prepare("INSERT INTO pantry_items (id, household_id, key, name, status, updated_by, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, this.#household, key, displayItemName(name).slice(0, 40), status, memberId, now, now);
    this.#log(key, options.event ?? status, memberId);
    return { item: this.get(id)!, previous: null };
  }

  setStatusById(id: string, status: PantryStatus, memberId: string | null): PantryItem | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    return this.set(item.name, status, memberId).item;
  }

  remove(id: string): boolean {
    const item = this.get(id);
    if (!item) return false;
    this.#db.prepare("DELETE FROM pantry_items WHERE id = ?").run(id);
    return true;
  }

  /** Checkout: purchased items that are in the pantry (or are sample-catalog products) become In stock. */
  purchased(names: readonly string[], memberId: string | null = null): string[] {
    const updated: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const key = itemKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = this.find(name);
      if (!existing && !key.startsWith("p:")) continue; // long Kroger names that match nothing stay out of the pantry
      updated.push(this.set(existing?.name ?? name, "stock", memberId, { event: "purchase" }).item.name);
    }
    return updated;
  }

  cadence(key: string): Cadence | null {
    return learnCadence(this.events(key));
  }

  /** Items already on one of the store's recurring lists (by pantry key). */
  #recurringKeys(): Set<string> {
    try {
      return new Set(this.#store.listsSnapshot().flatMap((list) => list.items.map((item) => itemKey(item.name))));
    } catch {
      return new Set();
    }
  }

  #suggestion(item: PantryItem, recurring: ReadonlySet<string>): PantryItemView["suggestion"] {
    const cadence = this.cadence(item.key);
    if (!cadence || recurring.has(item.key)) return null;
    const list = recurringListFor(cadence.days);
    return list ? { list, command: recurringListCommand(list, item.name), label: cadenceLabel(cadence.days) } : null;
  }

  /** Everything, with cart state, cadence, and recurring-list suggestions. */
  list(): PantryItemView[] {
    const inCart = this.cartKeys();
    const recurring = this.#recurringKeys();
    const order: Record<PantryStatus, number> = { out: 0, low: 1, stock: 2 };
    return this.items()
      .map((item) => ({ ...item, inCart: inCart.has(item.key), cadenceDays: this.cadence(item.key)?.days ?? null, suggestion: this.#suggestion(item, recurring) }))
      .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  }

  /** The chat suggestion for an item that runs out regularly (at most once every three weeks per item). */
  chatSuggestion(item: PantryItem): string | null {
    const row = this.#db.prepare("SELECT suggested_at FROM pantry_items WHERE id = ?").get(item.id) as { suggested_at: string | null } | undefined;
    if (row?.suggested_at && this.#now() - Date.parse(row.suggested_at) < SUGGEST_AGAIN_MS) return null;
    const cadence = this.cadence(item.key);
    if (!cadence || this.#recurringKeys().has(item.key)) return null;
    const list = recurringListFor(cadence.days);
    if (!list) return null;
    this.#db.prepare("UPDATE pantry_items SET suggested_at = ? WHERE id = ?").run(this.#iso(), item.id);
    return suggestionText(item.name, cadence, list);
  }

  // --- "Add it to the cart? Reply yes" offers, one per member --------------------

  offer(memberId: string, keys: readonly string[], messageId: string | null): void {
    this.#db.prepare("INSERT INTO pantry_offers (household_id, member_id, keys_json, message_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (household_id, member_id) DO UPDATE SET keys_json = excluded.keys_json, message_id = excluded.message_id, created_at = excluded.created_at")
      .run(this.#household, memberId, JSON.stringify([...new Set(keys)]), messageId, this.#iso());
  }

  /** The member's open offer, if it's recent enough to answer. */
  pendingOffer(memberId: string): { keys: string[]; createdAt: string } | null {
    const row = this.#db.prepare("SELECT keys_json, created_at FROM pantry_offers WHERE household_id = ? AND member_id = ?").get(this.#household, memberId) as { keys_json: string; created_at: string } | undefined;
    if (!row) return null;
    if (this.#now() - Date.parse(row.created_at) > OFFER_WINDOW_MS) {
      this.clearOffer(memberId);
      return null;
    }
    const keys = JSON.parse(row.keys_json) as string[];
    return keys.length ? { keys, createdAt: row.created_at } : null;
  }

  clearOffer(memberId: string, keys?: readonly string[]): void {
    if (!keys) {
      this.#db.prepare("DELETE FROM pantry_offers WHERE household_id = ? AND member_id = ?").run(this.#household, memberId);
      return;
    }
    const pending = this.pendingOffer(memberId);
    if (!pending) return;
    const rest = pending.keys.filter((key) => !keys.includes(key));
    if (rest.length) this.#db.prepare("UPDATE pantry_offers SET keys_json = ? WHERE household_id = ? AND member_id = ?").run(JSON.stringify(rest), this.#household, memberId);
    else this.clearOffer(memberId);
  }

  /** Display names for keys (pantry names when known, else catalog names). */
  namesFor(keys: readonly string[]): string[] {
    return keys.map((key) => this.byKey(key)?.name ?? CATALOG.find((product) => `p:${product.id}` === key)?.name ?? key);
  }
}
