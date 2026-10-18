// Grocery lists: recurring staples ("milk every week") and one-off named lists
// ("Party run": chips, soda, cups). Staples are added to the shared cart on schedule
// through the store's normal request path, as if the member had texted the item, so
// splits, undo, and approvals behave exactly like a typed request. Tables use the
// `list_` prefix in the shared SQLite database (store.database).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { addDays, localDate, zonedTimeToEpoch } from "./availability.js";
import { extractCartRequests, isGenericMilkRequest } from "./cart.js";
import { addMonthsClamped } from "./eventsParse.js";
import type { KrogerClient } from "./kroger.js";
import type { CartStore } from "./store.js";

export type CadenceUnit = "day" | "week" | "month";
export type Cadence = { every: number; unit: CadenceUnit };
export type Who = { everyone: boolean; memberIds: string[] };
export type StapleStatus = "added" | "in_cart" | "needs_pick" | "not_found" | "reminded" | "skipped" | "retry";

/** Local time of day (minutes) when due staples are added. */
export const STAPLE_ADD_MINUTES = 9 * 60;
const RETRY_MS = 15 * 60_000;
const BUSY_GRACE_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// Pure helpers

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, other: 2 };

/** Pulls "every 2 weeks" / "monthly" / "biweekly" out of a phrase (default: weekly). */
export function parseCadence(text: string): { cadence: Cadence; rest: string; found: boolean } {
  let rest = ` ${text} `;
  let cadence: Cadence | null = null;
  const take = (pattern: RegExp, make: (match: RegExpMatchArray) => Cadence | null) => {
    if (cadence) return;
    const match = rest.match(pattern);
    if (!match || match.index === undefined) return;
    const value = make(match);
    if (!value) return;
    cadence = value;
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`;
  };
  take(/\b(?:every|each)\s+(\d{1,2}|one|two|three|four|five|six|other)\s+(day|week|month)s?\b/i, (m) => {
    const every = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!.toLowerCase()] ?? 0;
    return every >= 1 && every <= 52 ? { every, unit: m[2]!.toLowerCase() as CadenceUnit } : null;
  });
  take(/\b(?:every|each)\s+(day|week|month)\b/i, (m) => ({ every: 1, unit: m[1]!.toLowerCase() as CadenceUnit }));
  take(/\b(?:once\s+a|a|per)\s+(week|month)\b/i, (m) => ({ every: 1, unit: m[1]!.toLowerCase() as CadenceUnit }));
  take(/\btwice\s+a\s+month\b/i, () => ({ every: 2, unit: "week" }));
  take(/\b(daily|weekly|monthly|biweekly|bi-weekly|fortnightly)\b/i, (m) => {
    const word = m[1]!.toLowerCase();
    if (word === "daily") return { every: 1, unit: "day" };
    if (word === "weekly") return { every: 1, unit: "week" };
    if (word === "monthly") return { every: 1, unit: "month" };
    return { every: 2, unit: "week" };
  });
  const found = cadence !== null;
  return { cadence: cadence ?? { every: 1, unit: "week" }, rest: rest.replace(/\s+/g, " ").trim(), found };
}

export function cadenceLabel(cadence: Cadence): string {
  if (cadence.every === 1) return cadence.unit === "day" ? "Daily" : cadence.unit === "week" ? "Weekly" : "Monthly";
  return `Every ${cadence.every} ${cadence.unit}s`;
}

/** "weekly", "monthly", "every-2-weeks" style word for chat ("Added Maya’s weekly staples"). */
export function cadenceWord(cadence: Cadence): string {
  return cadenceLabel(cadence).toLowerCase();
}

/** The date after `date` for this cadence; monthly keeps `anchorDay` (31st → Feb 28 → Mar 31). */
export function nextStapleDate(date: string, cadence: Cadence, anchorDay: number): string {
  if (cadence.unit === "day") return addDays(date, cadence.every);
  if (cadence.unit === "week") return addDays(date, 7 * cadence.every);
  return addMonthsClamped(date, cadence.every, anchorDay);
}

/** First scheduled date strictly after `today`, stepping from `date` (missed periods are not replayed). */
export function advanceAfter(date: string, today: string, cadence: Cadence, anchorDay: number): string {
  let next = nextStapleDate(date, cadence, anchorDay);
  for (let guard = 0; next <= today && guard < 2000; guard += 1) next = nextStapleDate(next, cadence, anchorDay);
  return next;
}

type MemberLite = { id: string; name: string };

function nameAlternation(members: MemberLite[]): string {
  const names = new Set<string>();
  for (const member of members) {
    names.add(member.name.toLowerCase());
    names.add((member.name.split(/\s+/)[0] ?? member.name).toLowerCase());
  }
  return [...names].filter(Boolean).sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

export function resolveMemberNames(text: string, members: MemberLite[], senderId: string): string[] {
  const ids = new Set<string>();
  for (const raw of text.split(/\s*(?:,|&|\+|\band\b)\s*/i)) {
    const word = raw.trim().toLowerCase();
    if (!word) continue;
    if (word === "me" || word === "myself") { ids.add(senderId); continue; }
    const member = members.find((candidate) => candidate.name.toLowerCase() === word)
      ?? members.find((candidate) => (candidate.name.split(/\s+/)[0] ?? "").toLowerCase() === word);
    if (member) ids.add(member.id);
  }
  return [...ids];
}

/**
 * Who a staple or list is for: "shared" / "for everyone" → everyone; "shared with
 * Maya" → sender + Maya; "for Maya and Jordan" → exactly those; default → sender.
 */
export function parseWho(text: string, members: MemberLite[], senderId: string): { who: Who; rest: string; found: boolean } {
  let rest = ` ${text} `;
  const cut = (match: RegExpMatchArray) => { rest = `${rest.slice(0, match.index)} ${rest.slice(match.index! + match[0].length)}`; };
  const all = members.map((member) => member.id);
  const finish = (ids: string[]): Who => {
    const unique = [...new Set(ids)].filter((id) => all.includes(id)).sort();
    return unique.length >= all.length && all.length > 1 ? { everyone: true, memberIds: [] } : { everyone: false, memberIds: unique.length ? unique : [senderId] };
  };
  const names = nameAlternation(members);
  const nameList = names ? `(?:me|myself|${names})(?:\\s*(?:,|&|\\+|and)\\s*(?:me|myself|${names}))*` : "(?:me|myself)";
  let match = rest.match(new RegExp(`\\b(?:shared|share|split)\\s+with\\s+(${nameList})\\b`, "i"));
  if (match) { cut(match); return { who: finish([senderId, ...resolveMemberNames(match[1]!, members, senderId)]), rest: rest.replace(/\s+/g, " ").trim(), found: true }; }
  match = rest.match(/\b(?:for|with)\s+(?:everyone|everybody|all(?:\s+of\s+us)?|us|the\s+house(?:hold)?|the\s+apartment|the\s+group)\b/i);
  if (match) { cut(match); return { who: { everyone: true, memberIds: [] }, rest: rest.replace(/\s+/g, " ").trim(), found: true }; }
  match = rest.match(/\b(?:shared|share|household|everyone)\b/i);
  if (match) { cut(match); return { who: { everyone: true, memberIds: [] }, rest: rest.replace(/\s+/g, " ").trim(), found: true }; }
  match = rest.match(new RegExp(`\\bfor\\s+(${nameList})\\b`, "i"));
  if (match) { cut(match); return { who: finish(resolveMemberNames(match[1]!, members, senderId)), rest: rest.replace(/\s+/g, " ").trim(), found: true }; }
  return { who: { everyone: false, memberIds: [senderId] }, rest: rest.replace(/\s+/g, " ").trim(), found: false };
}

/** Comparable list/staple name ("The Party Run list" → "party run"). */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\b(?:the|our|my|list)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Turns an item into a safe cart request ("mac and cheese" must not split into two items). */
export function cartRequestText(name: string, who: Who, requesterId: string, members: MemberLite[]): string {
  const clean = name.replace(/\s+and\s+/gi, " & ").replace(/[,;\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (who.everyone) return `add ${clean} for everyone`;
  const others = who.memberIds.filter((id) => id !== requesterId);
  if (!others.length) return `add ${clean}`;
  const names = members.filter((member) => others.includes(member.id)).map((member) => member.name.split(/\s+/)[0] ?? member.name);
  return `add ${clean} shared with ${names.join(" & ")}`;
}

/** Latest time (ISO) the store asked this member something they still have to answer, or null. */
export function cartPromptAt(db: DatabaseSync, memberId: string): string | null {
  let latest: string | null = null;
  const queries = [
    "SELECT created_at AS at FROM pending_product_choices WHERE member_id = ?",
    "SELECT created_at AS at FROM pending_product_batches WHERE member_id = ?",
    "SELECT created_at AS at FROM pending_clarifications WHERE member_id = ?",
    "SELECT created_at AS at FROM pending_item_cancellations WHERE member_id = ?",
    "SELECT created_at AS at FROM pending_cart_clears WHERE member_id = ?",
    "SELECT created_at AS at FROM pending_kroger_checkouts WHERE requester_id = ? AND status IN ('choosing_account')",
  ];
  for (const sql of queries) {
    try {
      const row = db.prepare(sql).get(memberId) as { at: string } | undefined;
      if (row?.at && (!latest || row.at > latest)) latest = row.at;
    } catch {
      // Table not present in this build; nothing pending there.
    }
  }
  return latest;
}

function cartLocked(db: DatabaseSync): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM pending_kroger_checkouts LIMIT 1").get());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Service

export type StapleView = {
  id: string;
  name: string;
  every: number;
  unit: CadenceUnit;
  cadence: string;
  nextDate: string;
  nextAt: number;
  everyone: boolean;
  memberIds: string[];
  requesterId: string;
  lastDate: string | null;
  lastStatus: StapleStatus | null;
  createdAt: string;
};

export type ListItemView = { id: string; name: string; checked: boolean; carted: boolean };
export type ListView = {
  id: string;
  name: string;
  emoji: string | null;
  everyone: boolean;
  memberIds: string[];
  eventId: string | null;
  createdBy: string | null;
  createdAt: string;
  items: ListItemView[];
  remaining: number;
};

type StapleRow = {
  id: string; name: string; every: number; unit: string; anchor_day: number; next_date: string; requester_id: string;
  everyone: number; member_ids_json: string; created_by: string | null; created_at: string; last_date: string | null;
  last_status: string | null; retry_at: number | null;
};
type ListRow = { id: string; name: string; emoji: string | null; everyone: number; member_ids_json: string; event_id: string | null; created_by: string | null; created_at: string };
type ItemRow = { id: string; list_id: string; name: string; checked: number; carted_at: string | null; position: number };

export type CartResult = { status: "added" | "needs_pick" | "not_found" | "retry"; reply: string };
export type MoveResult = { ok: boolean; message: string; added: string[]; missing: string[]; pending: string[] };

export class ListsService {
  readonly #store: CartStore;
  readonly #db: DatabaseSync;
  readonly #kroger: KrogerClient | undefined;
  readonly #notify: (text: string) => Promise<void>;
  readonly #now: () => number;
  readonly timeZone: string;
  #running = false;

  constructor(store: CartStore, options: { timeZone: string; kroger?: KrogerClient; notify: (text: string) => Promise<void>; now?: () => number }) {
    this.#store = store;
    this.#db = store.database;
    this.#kroger = options.kroger;
    this.#notify = options.notify;
    this.#now = options.now ?? Date.now;
    this.timeZone = options.timeZone;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS list_staples (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        name TEXT NOT NULL,
        every INTEGER NOT NULL,
        unit TEXT NOT NULL,
        anchor_day INTEGER NOT NULL,
        next_date TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        everyone INTEGER NOT NULL DEFAULT 0,
        member_ids_json TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        last_date TEXT,
        last_status TEXT,
        retry_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS list_lists (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT,
        everyone INTEGER NOT NULL DEFAULT 1,
        member_ids_json TEXT NOT NULL,
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

  memberName(id: string): string {
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

  whoLabel(who: Who): string {
    if (who.everyone) return "everyone";
    return this.members().filter((member) => who.memberIds.includes(member.id)).map((member) => member.name).join(" & ") || "someone";
  }

  // --- Staples -------------------------------------------------------------

  #stapleView(row: StapleRow): StapleView {
    const cadence = { every: row.every, unit: row.unit as CadenceUnit };
    return {
      id: row.id,
      name: row.name,
      every: row.every,
      unit: cadence.unit,
      cadence: cadenceLabel(cadence),
      nextDate: row.next_date,
      nextAt: zonedTimeToEpoch(row.next_date, STAPLE_ADD_MINUTES, this.timeZone),
      everyone: Boolean(row.everyone),
      memberIds: JSON.parse(row.member_ids_json) as string[],
      requesterId: row.requester_id,
      lastDate: row.last_date,
      lastStatus: (row.last_status as StapleStatus | null) ?? null,
      createdAt: row.created_at,
    };
  }

  listStaples(): StapleView[] {
    const rows = this.#db.prepare("SELECT * FROM list_staples WHERE household_id = ? ORDER BY next_date, name COLLATE NOCASE").all(this.#store.household) as StapleRow[];
    return rows.map((row) => this.#stapleView(row));
  }

  getStaple(id: string): StapleView | undefined {
    const row = this.#db.prepare("SELECT * FROM list_staples WHERE id = ? AND household_id = ?").get(id, this.#store.household) as StapleRow | undefined;
    return row ? this.#stapleView(row) : undefined;
  }

  findStaples(query: string): StapleView[] {
    const wanted = normalizeName(query);
    if (!wanted) return [];
    const staples = this.listStaples();
    const exact = staples.filter((staple) => normalizeName(staple.name) === wanted);
    if (exact.length) return exact;
    return staples.filter((staple) => normalizeName(staple.name).includes(wanted) || wanted.includes(normalizeName(staple.name)));
  }

  addStaple(input: { name: string; cadence: Cadence; who: Who; createdBy: string | null; startDate?: string | null }): { ok: true; staple: StapleView } | { ok: false; error: string } {
    const trimmed = input.name.replace(/\s+/g, " ").trim().replace(/^[\s,:;-]+|[\s,:;.-]+$/g, "");
    const name = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    if (!name) return { ok: false, error: "Which item? e.g. “add staple milk every week”." };
    if (name.length > 60) return { ok: false, error: "That staple name is too long (60 characters max)." };
    if (!(input.cadence.every >= 1 && input.cadence.every <= 52)) return { ok: false, error: "Pick a repeat between 1 and 52." };
    const members = this.members();
    const memberIds = input.who.everyone ? [] : input.who.memberIds.filter((id) => members.some((member) => member.id === id));
    if (!input.who.everyone && !memberIds.length) return { ok: false, error: "Choose who it’s for." };
    const today = this.today();
    const start = input.startDate && /^\d{4}-\d{2}-\d{2}$/.test(input.startDate) && input.startDate >= today ? input.startDate : today;
    const requesterId = input.who.everyone
      ? (input.createdBy && members.some((member) => member.id === input.createdBy) ? input.createdBy : members[0]?.id)
      : input.createdBy && memberIds.includes(input.createdBy) ? input.createdBy : memberIds[0];
    if (!requesterId) return { ok: false, error: "Add household members first." };
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO list_staples (id, household_id, name, every, unit, anchor_day, next_date, requester_id, everyone, member_ids_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, this.#store.household, name, input.cadence.every, input.cadence.unit, Number(start.slice(8, 10)), start, requesterId,
      input.who.everyone ? 1 : 0, JSON.stringify([...memberIds].sort()), input.createdBy, new Date(this.#now()).toISOString(),
    );
    return { ok: true, staple: this.getStaple(id)! };
  }

  removeStaple(id: string): boolean {
    return Number(this.#db.prepare("DELETE FROM list_staples WHERE id = ? AND household_id = ?").run(id, this.#store.household).changes) > 0;
  }

  /** Skips the next add (moves the date one period forward). */
  skipStaple(id: string): StapleView | undefined {
    const row = this.#db.prepare("SELECT * FROM list_staples WHERE id = ? AND household_id = ?").get(id, this.#store.household) as StapleRow | undefined;
    if (!row) return undefined;
    const cadence = { every: row.every, unit: row.unit as CadenceUnit };
    const next = nextStapleDate(row.next_date, cadence, row.anchor_day);
    this.#db.prepare("UPDATE list_staples SET next_date = ?, last_status = 'skipped', retry_at = NULL WHERE id = ?").run(next < this.today() ? advanceAfter(next, this.today(), cadence, row.anchor_day) : next, id);
    return this.getStaple(id);
  }

  /** True when the staple is due now (its add time has passed). */
  isDue(staple: StapleView, now = this.#now()): boolean {
    return now >= staple.nextAt;
  }

  /**
   * Adds every due staple to the cart (once per scheduled date) and announces the
   * result in the group. Safe to call often; overlapping runs are skipped.
   */
  async runDueStaples(): Promise<string | null> {
    if (this.#running) return null;
    this.#running = true;
    try {
      const now = this.#now();
      const rows = (this.#db.prepare("SELECT * FROM list_staples WHERE household_id = ? AND next_date <= ? ORDER BY next_date, created_at").all(this.#store.household, this.today()) as StapleRow[])
        .filter((row) => now >= zonedTimeToEpoch(row.next_date, STAPLE_ADD_MINUTES, this.timeZone) && (!row.retry_at || now >= row.retry_at));
      if (!rows.length || cartLocked(this.#db)) return null;
      const lines: string[] = [];
      const added: Array<{ staple: StapleView }> = [];
      for (const row of rows) {
        const result = await this.processStaple(this.#stapleView(row), now);
        if (result.kind === "added") added.push({ staple: result.staple });
        if (result.line) lines.push(result.line);
      }
      const message = [...this.#addedLines(added.map(({ staple }) => staple)), ...lines].join("\n");
      if (message) await this.#notify(message);
      return message || null;
    } finally {
      this.#running = false;
    }
  }

  #addedLines(staples: StapleView[]): string[] {
    const groups = new Map<string, StapleView[]>();
    for (const staple of staples) {
      const key = staple.everyone ? "*" : staple.memberIds.join(",");
      groups.set(key, [...(groups.get(key) ?? []), staple]);
    }
    return [...groups.entries()].map(([key, group]) => {
      const cadences = new Set(group.map((staple) => staple.cadence));
      const word = cadences.size === 1 && group[0]!.every === 1 ? `${group[0]!.cadence.toLowerCase()} ` : "";
      const names = group.map((staple) => `${staple.name.toLowerCase()}${word || staple.every === 1 ? "" : ` (${staple.cadence.toLowerCase()})`}`).join(", ");
      if (key === "*") return `🛒 Added shared ${word}staples: ${names}`;
      const ids = key.split(",");
      if (ids.length === 1) return `🛒 Added ${this.memberName(ids[0]!)}’s ${word}staples: ${names}`;
      return `🛒 Added ${word}staples for ${this.whoLabel({ everyone: false, memberIds: ids })}: ${names}`;
    });
  }

  /** Processes one due staple. Returns what happened plus an optional group line. */
  async processStaple(staple: StapleView, now = this.#now()): Promise<{ kind: StapleStatus | "deferred"; staple: StapleView; line: string | null; reply?: string }> {
    const members = this.members();
    const who: Who = { everyone: staple.everyone, memberIds: staple.memberIds };
    const participants = staple.everyone ? members.map((member) => member.id) : staple.memberIds;
    const requesterName = this.memberName(staple.requesterId);
    const label = `${staple.name.toLowerCase()} (${staple.cadence.toLowerCase()}${staple.everyone ? ", shared" : ""})`;
    if (this.#inCart(staple.name, participants)) return { kind: "in_cart", staple: this.#finish(staple, "in_cart"), line: null };
    if (cartPromptAt(this.#db, staple.requesterId)) {
      if (now - staple.nextAt < BUSY_GRACE_MS) return { kind: "deferred", staple, line: null };
      return { kind: "reminded", staple: this.#finish(staple, "reminded"), line: `🛒 ${requesterName}, ${label} is due. Text it when you’re ready.` };
    }
    if (this.mode === "sample" && !extractCartRequests(staple.name).length && !isGenericMilkRequest(staple.name)) {
      return { kind: "not_found", staple: this.#finish(staple, "not_found"), line: `🛒 ${label.charAt(0).toUpperCase()}${label.slice(1)} is due, but it isn’t in the sample catalog.` };
    }
    const result = await this.addToCart(`staple:${staple.id}:${staple.nextDate}:${randomUUID().slice(0, 8)}`, staple.requesterId, cartRequestText(staple.name, who, staple.requesterId, members));
    if (result.status === "retry") {
      this.#db.prepare("UPDATE list_staples SET last_status = 'retry', retry_at = ? WHERE id = ?").run(now + RETRY_MS, staple.id);
      return { kind: "retry", staple, line: null };
    }
    if (result.status === "added") return { kind: "added", staple: this.#finish(staple, "added"), line: null, reply: result.reply };
    if (result.status === "needs_pick") {
      return { kind: "needs_pick", staple: this.#finish(staple, "needs_pick"), line: `🛒 ${requesterName}, your ${staple.cadence.toLowerCase()} staple “${staple.name}” is due.\n${result.reply}`, reply: result.reply };
    }
    return { kind: "not_found", staple: this.#finish(staple, "not_found"), line: `🛒 ${label.charAt(0).toUpperCase()}${label.slice(1)} is due, but I couldn’t find it. Text it when you’re ready.`, reply: result.reply };
  }

  #finish(staple: StapleView, status: StapleStatus): StapleView {
    const row = this.#db.prepare("SELECT * FROM list_staples WHERE id = ?").get(staple.id) as StapleRow | undefined;
    if (!row) return staple;
    const cadence = { every: row.every, unit: row.unit as CadenceUnit };
    const next = advanceAfter(row.next_date, this.today(), cadence, row.anchor_day);
    this.#db.prepare("UPDATE list_staples SET next_date = ?, last_date = ?, last_status = ?, retry_at = NULL WHERE id = ?").run(next, row.next_date, status, row.id);
    return this.getStaple(row.id) ?? staple;
  }

  #inCart(name: string, participantIds: string[]): boolean {
    const snapshot = this.#store.snapshot();
    const productIds = extractCartRequests(name).map((request) => request.product.id);
    const wanted = normalizeName(name);
    return snapshot.items.some((item) => {
      const sameItem = productIds.length ? productIds.includes(item.productId) : normalizeName(item.name).includes(wanted);
      return sameItem && participantIds.every((id) => item.participantIds.includes(id));
    });
  }

  /** Sends one request through the store as if `memberId` had texted it. */
  async addToCart(messageId: string, memberId: string, text: string): Promise<CartResult> {
    const before = this.#store.snapshot().revision;
    const kroger = this.#kroger;
    const reply = kroger
      ? await this.#store.processLiveIncomingText(messageId, memberId, text, (query) => kroger.searchProducts(query), kroger.selectedLocationId)
      : this.#store.processIncomingText(messageId, memberId, text);
    const text2 = reply ?? "";
    if (this.#store.snapshot().revision !== before) return { status: "added", reply: text2 };
    if (/couldn’t reach|couldn't reach|couldn’t search/i.test(text2)) return { status: "retry", reply: text2 };
    if (/Reply 1-|Reply 1 for whole|reply 1 for whole|Which kind|What kind|Reply with one choice|which kind of milk/i.test(text2)) return { status: "needs_pick", reply: text2 };
    return { status: "not_found", reply: text2 };
  }

  // --- One-off lists ------------------------------------------------------

  #listView(row: ListRow): ListView {
    const items = (this.#db.prepare("SELECT id, list_id, name, checked, carted_at, position FROM list_items WHERE list_id = ? ORDER BY position, created_at").all(row.id) as ItemRow[])
      .map((item) => ({ id: item.id, name: item.name, checked: Boolean(item.checked) || Boolean(item.carted_at), carted: Boolean(item.carted_at) }));
    return {
      id: row.id,
      name: row.name,
      emoji: row.emoji,
      everyone: Boolean(row.everyone),
      memberIds: JSON.parse(row.member_ids_json) as string[],
      eventId: row.event_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      items,
      remaining: items.filter((item) => !item.checked).length,
    };
  }

  allLists(): ListView[] {
    const rows = this.#db.prepare("SELECT * FROM list_lists WHERE household_id = ? ORDER BY created_at DESC").all(this.#store.household) as ListRow[];
    return rows.map((row) => this.#listView(row));
  }

  getList(id: string): ListView | undefined {
    const row = this.#db.prepare("SELECT * FROM list_lists WHERE id = ? AND household_id = ?").get(id, this.#store.household) as ListRow | undefined;
    return row ? this.#listView(row) : undefined;
  }

  listForEvent(eventId: string): ListView | undefined {
    const row = this.#db.prepare("SELECT * FROM list_lists WHERE event_id = ? AND household_id = ? ORDER BY created_at DESC LIMIT 1").get(eventId, this.#store.household) as ListRow | undefined;
    return row ? this.#listView(row) : undefined;
  }

  /** Finds a list by name: exact, then a unique prefix or substring match. */
  findList(query: string): ListView | undefined {
    const wanted = normalizeName(query);
    if (!wanted) return undefined;
    const rows = this.#db.prepare("SELECT * FROM list_lists WHERE household_id = ? ORDER BY created_at DESC").all(this.#store.household) as ListRow[];
    const exact = rows.find((row) => normalizeName(row.name) === wanted);
    if (exact) return this.#listView(exact);
    const prefix = rows.filter((row) => normalizeName(row.name).startsWith(wanted));
    if (prefix.length === 1) return this.#listView(prefix[0]!);
    const partial = rows.filter((row) => normalizeName(row.name).includes(wanted));
    return partial.length === 1 ? this.#listView(partial[0]!) : undefined;
  }

  createList(input: { name: string; items?: string[]; who?: Who; createdBy: string | null; emoji?: string | null; eventId?: string | null; nameSuffix?: string }): { ok: true; list: ListView } | { ok: false; error: string } {
    let name = input.name.replace(/\s+/g, " ").trim().replace(/^[\s,:;-]+|[\s,:;.-]+$/g, "");
    if (!name) return { ok: false, error: "Name the list, e.g. “new list party run: chips, soda”." };
    if (name.length > 48) return { ok: false, error: "That list name is too long (48 characters max)." };
    name = name.charAt(0).toUpperCase() + name.slice(1);
    if (this.findList(name) && normalizeName(this.findList(name)!.name) === normalizeName(name)) {
      if (!input.eventId) return { ok: false, error: `There’s already a list called ${name}.` };
      const suffix = input.nameSuffix ?? new Intl.DateTimeFormat("en-US", { timeZone: this.timeZone, month: "short", day: "numeric" }).format(this.#now());
      name = `${name} ${suffix}`;
      if (this.findList(name) && normalizeName(this.findList(name)!.name) === normalizeName(name)) name = `${name} ${randomUUID().slice(0, 4)}`;
    }
    const who = input.who ?? { everyone: true, memberIds: [] };
    const id = randomUUID();
    this.#db.prepare("INSERT INTO list_lists (id, household_id, name, emoji, everyone, member_ids_json, event_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, this.#store.household, name, input.emoji ?? null, who.everyone ? 1 : 0, JSON.stringify(who.everyone ? [] : [...who.memberIds].sort()), input.eventId ?? null, input.createdBy, new Date(this.#now()).toISOString());
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

  setItemChecked(itemId: string, checked: boolean): boolean {
    const result = this.#db.prepare("UPDATE list_items SET checked = ?, carted_at = CASE WHEN ? = 0 THEN NULL ELSE carted_at END WHERE id = ? AND list_id IN (SELECT id FROM list_lists WHERE household_id = ?)")
      .run(checked ? 1 : 0, checked ? 1 : 0, itemId, this.#store.household);
    return Number(result.changes) > 0;
  }

  deleteList(listId: string): boolean {
    return Number(this.#db.prepare("DELETE FROM list_lists WHERE id = ? AND household_id = ?").run(listId, this.#store.household).changes) > 0;
  }

  /**
   * Adds every unchecked item to the shared cart as `memberId` (sample catalog in
   * demo mode; Kroger product choices in live mode, which the member then picks).
   */
  async moveToCart(listId: string, memberId: string): Promise<MoveResult> {
    const list = this.getList(listId);
    if (!list) return { ok: false, message: "That list no longer exists.", added: [], missing: [], pending: [] };
    const open = list.items.filter((item) => !item.checked);
    if (!open.length) return { ok: false, message: `Nothing left on ${list.name}.`, added: [], missing: [], pending: [] };
    if (cartLocked(this.#db)) return { ok: false, message: "The cart is locked while a Kroger checkout is in progress. Try again after it finishes.", added: [], missing: [], pending: [] };
    const members = this.members();
    const participants = list.everyone ? members.map((member) => member.id) : list.memberIds;
    const requesterId = list.everyone || participants.includes(memberId) ? memberId : participants[0] ?? memberId;
    if (cartPromptAt(this.#db, requesterId)) {
      return { ok: false, message: `${this.memberName(requesterId)} has an open grocery question. Answer it (or text “cancel”), then try again.`, added: [], missing: [], pending: [] };
    }
    const who: Who = { everyone: list.everyone, memberIds: list.memberIds };
    const markCarted = (ids: string[]) => {
      const stamp = new Date(this.#now()).toISOString();
      for (const id of ids) this.#db.prepare("UPDATE list_items SET checked = 1, carted_at = ? WHERE id = ?").run(stamp, id);
    };

    if (this.#kroger) {
      const batch = open.slice(0, 5);
      const clean = (name: string) => name.replace(/\s+and\s+/gi, " & ").replace(/[,;\n]+/g, " ").trim();
      let text: string;
      if (batch.length === 1) text = cartRequestText(batch[0]!.name, who, requesterId, members);
      else if (who.everyone) text = `add ${batch.map((item) => clean(item.name)).join(", ")} for everyone`;
      else text = `add ${batch.map((item) => cartRequestText(item.name, who, requesterId, members).replace(/^add /, "")).join(", ")}`;
      const result = await this.addToCart(`list:${list.id}:${randomUUID().slice(0, 8)}`, requesterId, text);
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
      if (this.#inCart(item.name, participants)) { added.push(item.name); markCarted([item.id]); continue; }
      const result = await this.addToCart(`list:${item.id}:${randomUUID().slice(0, 8)}`, requesterId, cartRequestText(item.name, who, requesterId, members));
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
