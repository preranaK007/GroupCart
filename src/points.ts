// Points, levels, streaks, and the monthly MVP.
//
// Feature modules award points with one call when something good happens; every award has a unique source
// key, so retries and replays never double count, and undoing the action revokes it:
//   awardPoints({ kind: "chore", memberId, key: `chore:${logId}`, onTime, covering, day: dueDate, label })
//   revokePoints(`chore:${logId}`)
// Both are no-ops until setupMoneyPoints() installs the service (tests and other tools keep working).
//
// Rules (POINT_RULES): chores 15 on your turn and on time, 10 when covering someone, 5 when late; a bill paid
// to the vendor by its due date 10 (late 4); paying a roommate back 8; doing a grocery checkout 12; hosting a
// social plan 10 or booking a timed household event 5; finishing a one-off list 6. Some kinds are capped per week.
// Levels come from all-time points; the leaderboard and MVP use the current calendar month.
// A streak counts consecutive weeks (Mon–Sun) in which every chore that was your turn got done on time.
//
// Tables use the points_ prefix in the shared SQLite database.
import type { DatabaseSync } from "node:sqlite";

export type PointsKind = "chore" | "bill" | "payback" | "checkout" | "event" | "list";

export type AwardInput = {
  kind: PointsKind;
  memberId: string;
  /** Unique per action, e.g. "chore:42", "bill:<id>", "checkout:<key>". */
  key: string;
  /** Short description for "recent" lists ("Dishes", "Paid Alex back"). */
  label?: string;
  /** Chores and bills: done by the due date. */
  onTime?: boolean;
  /** Chores: done on someone else's turn. */
  covering?: boolean;
  /** Events: a social plan (game night, movie, dinner...) rather than a household event. */
  social?: boolean;
  /** Events: has a start time (all-day reminders earn nothing). */
  timed?: boolean;
  /** Local date (YYYY-MM-DD) the award belongs to; chores use their due date so streaks follow the week it was due. */
  day?: string | null;
  /** When it happened (default now). */
  at?: Date | string;
};

export type AwardResult = { points: number; total: number; level: number; leveledUp: boolean };

export const POINT_RULES = {
  choreOnTime: 15,
  choreCovering: 10,
  choreLate: 5,
  billOnTime: 10,
  billLate: 4,
  payback: 8,
  checkout: 12,
  eventHost: 10,
  eventBook: 5,
  listDone: 6,
} as const;

/** At most this many awards of a kind per member per week (chores are naturally limited by their schedule). */
export const WEEKLY_CAPS: Partial<Record<PointsKind, number>> = { payback: 5, checkout: 3, event: 3, list: 3 };

export const RULES_TEXT = "Chores 15 on time (10 covering, 5 late) · bills paid on time 10 · paybacks 8 · grocery checkouts 12 · hosting a plan 10 · finishing a one-off list 6.";

/** Points for one action (pure). */
export function pointsFor(input: Pick<AwardInput, "kind" | "onTime" | "covering" | "social" | "timed">): number {
  switch (input.kind) {
    case "chore": return input.onTime === false ? POINT_RULES.choreLate : input.covering ? POINT_RULES.choreCovering : POINT_RULES.choreOnTime;
    case "bill": return input.onTime === false ? POINT_RULES.billLate : POINT_RULES.billOnTime;
    case "payback": return POINT_RULES.payback;
    case "checkout": return POINT_RULES.checkout;
    case "event": return input.social ? POINT_RULES.eventHost : input.timed ? POINT_RULES.eventBook : 0;
    case "list": return POINT_RULES.listDone;
  }
}

/** All-time points needed for a level: 0, 50, 125, 225, 350, 500, ... */
export function levelThreshold(level: number): number {
  return level <= 1 ? 0 : (25 * (level - 1) * (level + 2)) / 2;
}

export function levelFor(total: number): { level: number; floor: number; next: number } {
  let level = 1;
  while (levelThreshold(level + 1) <= total) level += 1;
  return { level, floor: levelThreshold(level), next: levelThreshold(level + 1) };
}

// ---------------------------------------------------------------------------
// Dates (server-local calendar days)
// ---------------------------------------------------------------------------

export function localIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isoToNoon(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12);
}

export function addDaysIso(iso: string, days: number): string {
  const date = isoToNoon(iso);
  date.setDate(date.getDate() + days);
  return localIso(date);
}

/** Monday (YYYY-MM-DD) of the week containing `iso`. */
export function weekOf(iso: string): string {
  const date = isoToNoon(iso);
  return addDaysIso(iso, -((date.getDay() + 6) % 7));
}

export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, "0")}`;
}

export function monthName(month: string, style: "long" | "short" = "long"): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y!, m! - 1, 15).toLocaleDateString("en-US", { month: style });
}

// ---------------------------------------------------------------------------
// Streaks and MVP (pure)
// ---------------------------------------------------------------------------

export type WeekStatus = "clean" | "miss";

/**
 * Consecutive clean weeks, newest first. The current week counts once it is clean; a miss this week ends the
 * streak; a week with nothing yet (the current one) is skipped; any other empty week ends it.
 */
export function computeStreak(weeks: ReadonlyMap<string, WeekStatus>, currentWeek: string): number {
  let week = currentWeek;
  const current = weeks.get(week);
  if (current === "miss") return 0;
  if (!current) week = addDaysIso(week, -7);
  let streak = 0;
  for (let guard = 0; guard < 520 && weeks.get(week) === "clean"; guard += 1) {
    streak += 1;
    week = addDaysIso(week, -7);
  }
  return streak;
}

/** Week statuses from a member's chore awards and recorded misses. Covering late never counts against you. */
export function weekStatuses(chores: ReadonlyArray<{ day: string; onTime: boolean; covering: boolean }>, misses: ReadonlyArray<{ day: string }>): Map<string, WeekStatus> {
  const weeks = new Map<string, WeekStatus>();
  for (const chore of chores) {
    const week = weekOf(chore.day);
    if (chore.onTime) { if (!weeks.has(week)) weeks.set(week, "clean"); }
    else if (!chore.covering) weeks.set(week, "miss");
  }
  for (const miss of misses) weeks.set(weekOf(miss.day), "miss");
  return weeks;
}

/** Most points in a month (ties: whoever got there first, then name). Null when nobody scored. */
export function monthlyMvp(rows: ReadonlyArray<{ memberId: string; points: number; at: string }>, month: string): { memberId: string; points: number } | null {
  const totals = new Map<string, { points: number; last: string }>();
  for (const row of rows) {
    if (monthOf(new Date(row.at)) !== month) continue;
    const entry = totals.get(row.memberId) ?? { points: 0, last: "" };
    entry.points += row.points;
    if (row.at > entry.last) entry.last = row.at;
    totals.set(row.memberId, entry);
  }
  const best = [...totals.entries()].filter(([, entry]) => entry.points > 0)
    .sort((a, b) => b[1].points - a[1].points || a[1].last.localeCompare(b[1].last) || a[0].localeCompare(b[0]))[0];
  return best ? { memberId: best[0], points: best[1].points } : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type Member = { id: string; name: string };
type LedgerRow = { id: number; member_id: string; kind: string; source_key: string; points: number; label: string | null; on_time: number | null; covering: number; day: string; at: string };

export type Standing = { memberId: string; name: string; rank: number; month: number; total: number; level: number; streak: number; mvp: boolean };
export type Badge = { emoji: string; label: string };
export type MemberPoints = {
  memberId: string;
  name: string;
  month: number;
  total: number;
  level: number;
  floor: number;
  next: number;
  streak: number;
  rank: number;
  badges: Badge[];
  recent: Array<{ points: number; label: string; kind: PointsKind; at: string }>;
};

export type PointsServiceOptions = {
  db: DatabaseSync;
  household: string;
  members: () => Member[];
  now?: () => Date;
  /** Called once per member per level reached (not during demo backfill). */
  onLevelUp?: (member: Member, level: number, total: number) => void;
};

export class PointsService {
  readonly #db: DatabaseSync;
  readonly #household: string;
  readonly #members: () => Member[];
  readonly #now: () => Date;
  readonly #onLevelUp: PointsServiceOptions["onLevelUp"];

  constructor(options: PointsServiceOptions) {
    this.#db = options.db;
    this.#household = options.household;
    this.#members = options.members;
    this.#now = options.now ?? (() => new Date());
    this.#onLevelUp = options.onLevelUp;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS points_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_key TEXT NOT NULL,
        points INTEGER NOT NULL,
        label TEXT,
        on_time INTEGER,
        covering INTEGER NOT NULL DEFAULT 0,
        day TEXT NOT NULL,
        at TEXT NOT NULL,
        UNIQUE (household_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS points_ledger_member ON points_ledger (household_id, member_id, at);
      CREATE TABLE IF NOT EXISTS points_misses (
        household_id TEXT NOT NULL,
        chore_id TEXT NOT NULL,
        due_date TEXT NOT NULL,
        member_id TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (household_id, chore_id, due_date)
      );
      CREATE TABLE IF NOT EXISTS points_levels (
        household_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        reached_at TEXT NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (household_id, member_id, level)
      );
      CREATE TABLE IF NOT EXISTS points_meta (household_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (household_id, key));
    `);
  }

  now(): Date { return this.#now(); }
  today(): string { return localIso(this.#now()); }
  members(): Member[] { return this.#members().map(({ id, name }) => ({ id, name })); }

  meta(key: string): string | undefined {
    return (this.#db.prepare("SELECT value FROM points_meta WHERE household_id = ? AND key = ?").get(this.#household, key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO points_meta (household_id, key, value) VALUES (?, ?, ?)").run(this.#household, key, value);
  }

  #total(memberId: string): number {
    return Number((this.#db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger WHERE household_id = ? AND member_id = ?").get(this.#household, memberId) as { total: number }).total);
  }

  /** Records an award once per source key. Returns null when nothing was added (duplicate, capped, zero, unknown member). */
  award(input: AwardInput, options: { silent?: boolean } = {}): AwardResult | null {
    const member = this.#members().find((candidate) => candidate.id === input.memberId);
    if (!member || !input.key) return null;
    const points = pointsFor(input);
    if (points <= 0) return null;
    const at = input.at ? new Date(input.at) : this.#now();
    if (Number.isNaN(at.getTime())) return null;
    const day = input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : localIso(at);
    const exists = this.#db.prepare("SELECT 1 FROM points_ledger WHERE household_id = ? AND source_key = ?").get(this.#household, input.key);
    if (exists) return null;
    const cap = WEEKLY_CAPS[input.kind];
    if (cap !== undefined) {
      const week = weekOf(day);
      const count = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM points_ledger WHERE household_id = ? AND member_id = ? AND kind = ? AND day >= ? AND day <= ?")
        .get(this.#household, member.id, input.kind, week, addDaysIso(week, 6)) as { count: number }).count);
      if (count >= cap) return null;
    }
    const before = this.#total(member.id);
    const inserted = this.#db.prepare("INSERT OR IGNORE INTO points_ledger (household_id, member_id, kind, source_key, points, label, on_time, covering, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.#household, member.id, input.kind, input.key, points, input.label?.slice(0, 80) ?? null, input.onTime === undefined ? null : input.onTime ? 1 : 0, input.covering ? 1 : 0, day, at.toISOString());
    if (!Number(inserted.changes)) return null;
    const total = before + points;
    const previous = levelFor(before).level;
    const { level } = levelFor(total);
    let leveledUp = false;
    for (let reached = previous + 1; reached <= level; reached += 1) {
      const fresh = Number(this.#db.prepare("INSERT OR IGNORE INTO points_levels (household_id, member_id, level, reached_at, seen) VALUES (?, ?, ?, ?, ?)")
        .run(this.#household, member.id, reached, at.toISOString(), options.silent ? 1 : 0).changes) > 0;
      if (fresh && reached === level) leveledUp = true;
    }
    if (leveledUp && !options.silent) {
      try { this.#onLevelUp?.(member, level, total); } catch (error) { console.warn("Level-up notice failed:", error instanceof Error ? error.message : error); }
    }
    return { points, total, level, leveledUp };
  }

  /** Removes an award (e.g. a chore completion was undone). */
  revoke(key: string): boolean {
    return Number(this.#db.prepare("DELETE FROM points_ledger WHERE household_id = ? AND source_key = ?").run(this.#household, key).changes) > 0;
  }

  /** A chore went overdue on this member's turn (breaks their streak for the week it was due). */
  recordMiss(choreId: string, dueDate: string, memberId: string): boolean {
    return Number(this.#db.prepare("INSERT OR IGNORE INTO points_misses (household_id, chore_id, due_date, member_id, at) VALUES (?, ?, ?, ?, ?)")
      .run(this.#household, choreId, dueDate, memberId, this.#now().toISOString()).changes) > 0;
  }

  #rows(memberId?: string): LedgerRow[] {
    return (memberId
      ? this.#db.prepare("SELECT * FROM points_ledger WHERE household_id = ? AND member_id = ? ORDER BY at DESC, id DESC").all(this.#household, memberId)
      : this.#db.prepare("SELECT * FROM points_ledger WHERE household_id = ? ORDER BY at DESC, id DESC").all(this.#household)) as LedgerRow[];
  }

  streak(memberId: string, rows = this.#rows(memberId)): number {
    const chores = rows.filter((row) => row.kind === "chore").map((row) => ({ day: row.day, onTime: row.on_time !== 0, covering: row.covering === 1 }));
    const misses = (this.#db.prepare("SELECT due_date AS day FROM points_misses WHERE household_id = ? AND member_id = ?").all(this.#household, memberId) as Array<{ day: string }>);
    return computeStreak(weekStatuses(chores, misses), weekOf(this.today()));
  }

  mvp(month = monthOf(this.#now())): { memberId: string; name: string; points: number } | null {
    const best = monthlyMvp(this.#rows().map((row) => ({ memberId: row.member_id, points: row.points, at: row.at })), month);
    if (!best) return null;
    const member = this.#members().find((candidate) => candidate.id === best.memberId);
    return member ? { ...best, name: member.name } : null;
  }

  /** This month's standings (rank by month points, then all-time). */
  standings(): Standing[] {
    const month = monthOf(this.#now());
    const rows = this.#rows();
    const mvp = monthlyMvp(rows.map((row) => ({ memberId: row.member_id, points: row.points, at: row.at })), month);
    const list = this.#members().map((member) => {
      const mine = rows.filter((row) => row.member_id === member.id);
      const total = mine.reduce((sum, row) => sum + row.points, 0);
      const monthPoints = mine.filter((row) => monthOf(new Date(row.at)) === month).reduce((sum, row) => sum + row.points, 0);
      return { memberId: member.id, name: member.name, rank: 0, month: monthPoints, total, level: levelFor(total).level, streak: this.streak(member.id, mine), mvp: mvp?.memberId === member.id };
    }).sort((a, b) => b.month - a.month || b.total - a.total || a.name.localeCompare(b.name));
    let rank = 0;
    list.forEach((entry, index) => {
      rank = index > 0 && entry.month === list[index - 1]!.month && entry.total === list[index - 1]!.total ? rank : index + 1;
      entry.rank = rank;
    });
    return list;
  }

  summary(memberId: string): MemberPoints | null {
    const standing = this.standings().find((entry) => entry.memberId === memberId);
    if (!standing) return null;
    const rows = this.#rows(memberId);
    const { floor, next } = levelFor(standing.total);
    return {
      memberId,
      name: standing.name,
      month: standing.month,
      total: standing.total,
      level: standing.level,
      floor,
      next,
      streak: standing.streak,
      rank: standing.rank,
      badges: this.#badges(memberId, rows, standing),
      recent: rows.slice(0, 5).map((row) => ({ points: row.points, label: row.label ?? row.kind, kind: row.kind as PointsKind, at: row.at })),
    };
  }

  #badges(memberId: string, rows: LedgerRow[], standing: Standing): Badge[] {
    const badges: Badge[] = [];
    const month = monthOf(this.#now());
    if (standing.mvp && standing.month > 0) badges.push({ emoji: "👑", label: `MVP so far · ${monthName(month, "short")}` });
    let past = previousMonth(month);
    for (let index = 0; index < 3; index += 1, past = previousMonth(past)) {
      if (this.mvp(past)?.memberId === memberId) badges.push({ emoji: "🏆", label: `MVP · ${monthName(past, "short")}` });
    }
    if (standing.streak >= 2) badges.push({ emoji: "🔥", label: `${standing.streak}-week streak` });
    const count = (kind: PointsKind) => rows.filter((row) => row.kind === kind).length;
    if (count("chore") >= 10) badges.push({ emoji: "🧽", label: "Chore champ" });
    if (count("payback") + rows.filter((row) => row.kind === "bill" && row.on_time === 1).length >= 3) badges.push({ emoji: "💸", label: "Pays on time" });
    if (count("checkout") >= 3) badges.push({ emoji: "🛒", label: "Head shopper" });
    if (count("event") >= 3) badges.push({ emoji: "🎉", label: "Host" });
    return badges.slice(0, 5);
  }

  /** Level reached but not yet celebrated in this member's browser. */
  pendingLevelUp(memberId: string): number | null {
    const row = this.#db.prepare("SELECT MAX(level) AS level FROM points_levels WHERE household_id = ? AND member_id = ? AND seen = 0").get(this.#household, memberId) as { level: number | null };
    return row.level ?? null;
  }

  markLevelsSeen(memberId: string): void {
    this.#db.prepare("UPDATE points_levels SET seen = 1 WHERE household_id = ? AND member_id = ?").run(this.#household, memberId);
  }

  // -------------------------------------------------------------------------
  // Chat replies
  // -------------------------------------------------------------------------

  pointsReply(memberId: string): string {
    const me = this.summary(memberId);
    if (!me) return "I couldn’t find you in this household.";
    const first = me.name.split(/\s+/)[0];
    const lines = [`⭐ ${first}: ${me.month} points this month · level ${me.level} (${me.total} all-time)`];
    const extras = [me.streak >= 1 ? `🔥 ${me.streak}-week streak` : "", me.rank === 1 && me.month > 0 ? "👑 MVP so far" : `#${me.rank} this month`].filter(Boolean);
    lines.push(`${extras.join(" · ")} · ${me.next - me.total} to level ${me.level + 1}`);
    if (me.recent.length) lines.push(`Recent: ${me.recent.slice(0, 3).map((entry) => `+${entry.points} ${entry.label}`).join(" · ")}`);
    else lines.push("Earn points for chores, paying back, checkouts, and hosting. “leaderboard” shows the standings.");
    return lines.join("\n");
  }

  leaderboardReply(): string {
    const standings = this.standings();
    const month = monthOf(this.#now());
    if (!standings.some((entry) => entry.total > 0)) return "🏆 No points yet. Chores, paybacks, checkouts, and hosting all count. “points” shows yours.";
    const lines = [`🏆 ${monthName(month)} leaderboard`];
    for (const entry of standings) {
      lines.push(`${entry.rank}. ${entry.name} ${entry.month}${entry.streak >= 2 ? ` 🔥${entry.streak}` : ""}${entry.mvp && entry.month > 0 ? " 👑" : ""}`);
    }
    const last = this.mvp(previousMonth(month));
    if (last) lines.push(`Last month’s MVP: ${last.name} (${last.points}).`);
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Demo
  // -------------------------------------------------------------------------

  /**
   * Demo mode: credits the seeded history (chores, bills, paybacks, events) once, quietly, so the
   * leaderboard, streaks, and last month's MVP have something to show. Keys match the live hooks.
   */
  seedDemo(history: { awards: AwardInput[]; misses?: Array<{ choreId: string; dueDate: string; memberId: string }> }): number {
    let added = 0;
    for (const award of history.awards) if (this.award(award, { silent: true })) added += 1;
    for (const miss of history.misses ?? []) this.recordMiss(miss.choreId, miss.dueDate, miss.memberId);
    return added;
  }
}

// ---------------------------------------------------------------------------
// Module-level hooks for feature modules
// ---------------------------------------------------------------------------

let active: PointsService | null = null;

export function setActivePoints(service: PointsService | null): void {
  active = service;
}

export function activePoints(): PointsService | null {
  return active;
}

/** Awards points for an action (no-op until points are set up). Never throws. */
export function awardPoints(input: AwardInput): AwardResult | null {
  try {
    return active?.award(input) ?? null;
  } catch (error) {
    console.warn("Could not award points:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Revokes an earlier award by its key (no-op until points are set up). Never throws. */
export function revokePoints(key: string): void {
  try {
    active?.revoke(key);
  } catch (error) {
    console.warn("Could not revoke points:", error instanceof Error ? error.message : error);
  }
}
