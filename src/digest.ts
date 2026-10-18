// Sunday digest: one short group message every Sunday at 6pm (server time) with the week ahead: chores and
// who has them, who owes whom, upcoming plans, recurring lists coming due, bills due soon, and one fun stat.
//
// It is sent at most once per week: the week is claimed in digest_sent before sending, so restarts, several
// timers, or a second instance never repeat it. If GroupCart was offline at 6pm it goes out at the next check
// until Monday noon; after that the week is skipped. "digest" in the chat previews it for whoever asks.
//
// buildDigest() is pure (tests feed it data); DigestService owns timing, de-dup, and purchase counts for the
// "most bought" stat. Tables use the digest_ prefix.
import type { DatabaseSync } from "node:sqlite";
import { addDaysIso, localIso } from "./points.js";

export const DIGEST_WEEKDAY = 0; // Sunday
export const DIGEST_HOUR = 18; // 6pm server time
const CATCH_UP_UNTIL_HOUR = 12; // Monday noon
const MAX_PER_LINE = 3;

export type DigestData = {
  chores: Array<{ emoji: string; name: string; who: string | null; late: boolean }>;
  transfers: Array<{ from: string; to: string; cents: number }>;
  events: Array<{ emoji: string; title: string; when: string }>;
  /** Open plan votes ("Movie night"). */
  polls: string[];
  lists: Array<{ title: string; when: string }>;
  bills: Array<{ emoji: string; vendor: string; cents: number; when: string; overdue: boolean }>;
  /** One fun stat line (without the emoji bullet), or null. */
  stat: string | null;
};

export function emptyDigestData(): DigestData {
  return { chores: [], transfers: [], events: [], polls: [], lists: [], bills: [], stat: null };
}

function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function first(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

function more(items: string[], max = MAX_PER_LINE): string {
  return items.length > max ? `${items.slice(0, max).join(" · ")} +${items.length - max}` : items.join(" · ");
}

/** The digest text: a header plus up to seven emoji lines; empty sections are left out. */
export function buildDigest(data: DigestData, options: { now: Date; preview?: boolean }): string {
  // The week it covers starts on the coming Monday (today when it is Monday).
  const weekStart = addDaysIso(localIso(options.now), (8 - options.now.getDay()) % 7);
  const label = new Date(`${weekStart}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const lines = [options.preview ? `📬 Digest preview · week of ${label}` : `📬 Sunday digest · week of ${label}`];
  // Chores come most urgent first, so late ones are always shown.
  if (data.chores.length) lines.push(`🧽 Chores: ${more(data.chores.map((chore) => `${chore.emoji} ${chore.name} (${chore.who ? first(chore.who) : "open"}${chore.late ? ", late" : ""})`))}`);
  if (data.transfers.length) {
    const total = data.transfers.reduce((sum, transfer) => sum + transfer.cents, 0);
    lines.push(`💸 Settle up: ${more(data.transfers.map((transfer) => `${first(transfer.from)} → ${first(transfer.to)} ${dollars(transfer.cents)}`))}${data.transfers.length > 1 ? ` (${dollars(total)} total)` : ""}`);
  } else {
    lines.push("💸 Everyone’s settled up.");
  }
  if (data.events.length || data.polls.length) {
    const polls = data.polls.length ? [`🗳️ ${data.polls.length === 1 ? `${data.polls[0]} vote open` : `${data.polls.length} votes open`}`] : [];
    lines.push(`📅 Coming up: ${more([...polls, ...data.events.map((event) => `${event.emoji} ${event.title} ${event.when}`)])}`);
  }
  if (data.lists.length) lines.push(`🛒 Lists due: ${more(data.lists.map((list) => `${list.title} ${list.when}`))}`);
  if (data.bills.length) lines.push(`🧾 Bills: ${more(data.bills.map((bill) => `${bill.emoji} ${bill.vendor} ${dollars(bill.cents)} ${bill.overdue ? "overdue" : bill.when}`))}`);
  if (data.stat) lines.push(data.stat);
  if (lines.length === 2 && !data.transfers.length) lines.push("🎉 A quiet week: nothing due.");
  return lines.join("\n");
}

/** The Sunday (YYYY-MM-DD) whose digest is due at `now`, or null outside Sunday 6pm – Monday noon. */
export function digestWeekKey(now: Date): string | null {
  const day = now.getDay();
  if (day === DIGEST_WEEKDAY && now.getHours() >= DIGEST_HOUR) return localIso(now);
  if (day === (DIGEST_WEEKDAY + 1) % 7 && now.getHours() < CATCH_UP_UNTIL_HOUR) return addDaysIso(localIso(now), -1);
  return null;
}

/** "Today 6pm" on Sunday before 6pm, else "Sun 6pm". */
export function nextDigestLabel(now: Date): string {
  return now.getDay() === DIGEST_WEEKDAY && now.getHours() < DIGEST_HOUR ? "Today 6pm" : "Sun 6pm";
}

export type DigestServiceOptions = {
  db: DatabaseSync;
  household: string;
  gather: () => DigestData;
  send: (text: string) => Promise<void>;
  /** False while nothing can be delivered yet (live mode before the bot has seen the group): the week stays unclaimed. */
  canSend?: () => boolean;
  now?: () => Date;
};

export type DigestTick = "sent" | "not_due" | "already_sent" | "waiting";

export class DigestService {
  readonly #db: DatabaseSync;
  readonly #household: string;
  readonly #gather: () => DigestData;
  readonly #send: (text: string) => Promise<void>;
  readonly #canSend: () => boolean;
  readonly #now: () => Date;

  constructor(options: DigestServiceOptions) {
    this.#db = options.db;
    this.#household = options.household;
    this.#gather = options.gather;
    this.#send = options.send;
    this.#canSend = options.canSend ?? (() => true);
    this.#now = options.now ?? (() => new Date());
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS digest_sent (
        household_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (household_id, week_key)
      );
      CREATE TABLE IF NOT EXISTS digest_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id TEXT NOT NULL,
        checkout_key TEXT NOT NULL,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        at TEXT NOT NULL,
        UNIQUE (household_id, checkout_key, name)
      );
    `);
  }

  text(preview = false): string {
    return buildDigest(this.#gather(), { now: this.#now(), preview });
  }

  /** Sends this week's digest if it is due and nobody has sent it yet. */
  async tick(): Promise<DigestTick> {
    const now = this.#now();
    const week = digestWeekKey(now);
    if (!week) return "not_due";
    if (this.#db.prepare("SELECT 1 FROM digest_sent WHERE household_id = ? AND week_key = ?").get(this.#household, week)) return "already_sent";
    if (!this.#canSend()) return "waiting";
    const text = this.text(false);
    const claimed = Number(this.#db.prepare("INSERT OR IGNORE INTO digest_sent (household_id, week_key, sent_at, text) VALUES (?, ?, ?, ?)")
      .run(this.#household, week, now.toISOString(), text).changes) > 0;
    if (!claimed) return "already_sent";
    await this.#send(text);
    return "sent";
  }

  lastSent(): { week: string; at: string } | null {
    const row = this.#db.prepare("SELECT week_key, sent_at FROM digest_sent WHERE household_id = ? ORDER BY week_key DESC LIMIT 1").get(this.#household) as { week_key: string; sent_at: string } | undefined;
    return row ? { week: row.week_key, at: row.sent_at } : null;
  }

  /** Counts items from a completed grocery checkout (for "most bought"). Idempotent per checkout. */
  recordPurchases(checkoutKey: string, items: ReadonlyArray<{ name: string; quantity: number }>, at: Date | string = this.#now()): void {
    const stamp = new Date(at).toISOString();
    const insert = this.#db.prepare("INSERT OR IGNORE INTO digest_purchases (household_id, checkout_key, name, quantity, at) VALUES (?, ?, ?, ?, ?)");
    for (const item of items) {
      const name = String(item.name ?? "").trim().slice(0, 60);
      if (name) insert.run(this.#household, checkoutKey, name, Math.max(1, Math.round(item.quantity || 1)), stamp);
    }
  }

  mostBought(days = 60): { name: string; count: number } | null {
    const since = new Date(this.#now().getTime() - days * 86_400_000).toISOString();
    const row = this.#db.prepare("SELECT name, SUM(quantity) AS count FROM digest_purchases WHERE household_id = ? AND at >= ? GROUP BY lower(name) ORDER BY count DESC, MAX(at) DESC LIMIT 1")
      .get(this.#household, since) as { name: string; count: number } | undefined;
    return row && Number(row.count) > 1 ? { name: row.name, count: Number(row.count) } : null;
  }
}
