// Chores: recurring and one-off household chores with a fair rotation, "away" status,
// completion history, group-chat commands, morning/overdue nudges, the /chores page and
// its JSON API, and Claude connector tools. Wired from index.ts with setupChores().
//
// Rotation: the open occurrence of a chore goes to whoever in its pool has gone longest
// without doing it (never = longest), then fewest completions, then pool order. Away
// members are skipped. "skip" passes the current turn on (the skipper still owes the next
// one); "swap" hands the current turn to someone else. Everything lives in chore_* tables.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { addDays, isDateString, localDate, mondayOf, zonedTimeToEpoch } from "./availability.js";
import {
  buildSchedule, capitalize, daysBetween, dueLabel, durationPhrase, fairOrder, firstDueOnOrAfter, guessEmoji, joinNames,
  matchChore, monthDay, nextDueAfterCompletion, occurrencesBetween, overdueNudge, parseAddSpec, parseChoreCommand, parseDay,
  pastLabel, pickAssignee, possessive, previousDue, projectRotation, scheduleLabel, shortDate, shortWeekday, WEEKDAY_NAMES, weekLabel,
  type MemberStats, type Schedule, type ScheduleInput,
} from "./choresLogic.js";
import {
  notifyGroup, registerCommand, registerHelp, registerRoute, registerTools, scheduleEvery,
  type CommandContext, type ToolCaller, type ToolSpec,
} from "./platform.js";
import type { CartStore } from "./store.js";
import { renderChoresPage } from "./ui/choresPage.js";
import { awardPoints, revokePoints } from "./points.js"; // money & points

/** Morning digest goes out from this local hour; overdue nudges only between these hours (live mode). */
const DIGEST_HOUR = 9;
const DIGEST_LAST_HOUR = 11;
const NUDGE_END_HOUR = 21;
const NUDGE_INTERVAL_MS = 15 * 60_000;

type Person = { id: string; name: string };

type Chore = {
  id: string;
  name: string;
  emoji: string;
  schedule: Schedule;
  /** Member ids in the rotation; empty = everyone. */
  pool: string[];
  /** Due date of the open occurrence; null once a one-off is done. */
  nextDue: string | null;
  override: string | null;
  skipped: string[];
  archived: boolean;
};

type ChoreRow = {
  id: string; name: string; emoji: string; kind: string; weekday: number | null; every_weeks: number; day_of_month: number | null;
  anchor_date: string | null; pool_json: string; next_due: string | null; assignee_override: string | null; skipped_json: string;
  archived_at: string | null;
};

type LogRow = { id: number; chore_id: string; kind: string; member_id: string | null; other_id: string | null; due_date: string | null; on_date: string; at: string };

type Context = {
  today: string;
  people: Person[];
  ids: string[];
  /** memberId -> date they are back (away on earlier days). */
  away: Map<string, string>;
  stats: Map<string, Map<string, MemberStats>>;
  lastDone: Map<string, LogRow>;
};

export type OpenChore = {
  id: string;
  name: string;
  emoji: string;
  dueDate: string;
  /** "Today", "2 days late", "Tomorrow", "Sun", "Sat, Oct 24". */
  dueText: string;
  status: "late" | "today" | "upcoming";
  lateDays: number;
  assigneeId: string | null;
  scheduleLabel: string;
  schedule: Schedule;
  everyone: boolean;
  pool: string[];
  /** Pool members free to take this turn (for swaps). */
  available: string[];
  /** False until the cycle starts (the day after the previous due date), e.g. right after doing it early. */
  canComplete: boolean;
  /** First day it can be marked done. */
  opensOn: string;
  lastDone: { memberId: string | null; when: string } | null;
};

export type WeekItem = {
  choreId: string;
  name: string;
  emoji: string;
  status: "done" | "late" | "open" | "planned";
  memberId: string | null;
  note: string;
};

export type ChoresView = {
  demoMode: boolean;
  today: string;
  weekStart: string;
  prevWeek: string;
  nextWeek: string;
  isCurrentWeek: boolean;
  weekLabel: string;
  choreCount: number;
  members: Array<{ id: string; name: string; awayUntil: string | null; awayLabel: string | null; done30: number; open: number }>;
  days: Array<{ date: string; dow: string; day: number; isToday: boolean; isPast: boolean; items: WeekItem[] }>;
  upNext: OpenChore[];
  recent: Array<{ logId: number; choreId: string; name: string; emoji: string; memberId: string | null; when: string }>;
};

type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number };

function fail(error: string, status = 400): { ok: false; error: string; status: number } {
  return { ok: false, error, status };
}

function parseIds(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function toSchedule(row: ChoreRow): Schedule {
  if (row.kind === "monthly") return { kind: "monthly", day: row.day_of_month ?? 31 };
  if (row.kind === "once") return { kind: "once", date: row.anchor_date ?? row.next_due ?? "1970-01-01" };
  return { kind: "weekly", weekday: row.weekday ?? 0, everyWeeks: row.every_weeks || 1, anchor: row.anchor_date ?? "1970-01-04" };
}

function toChore(row: ChoreRow): Chore {
  return {
    id: row.id, name: row.name, emoji: row.emoji, schedule: toSchedule(row), pool: parseIds(row.pool_json), nextDue: row.next_due,
    override: row.assignee_override, skipped: parseIds(row.skipped_json), archived: Boolean(row.archived_at),
  };
}

function localHour(now: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(now))) % 24;
}

/** "A or B", "A, B, or C". */
function joinOr(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

const EXAMPLES = "“add chore vacuum every Sunday”, “add chore trash weekly on Tuesday”, “add chore fridge monthly”, or “add chore fix lamp by Friday”";

export class ChoreService {
  readonly #store: CartStore;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly timeZone: string;
  readonly demoMode: boolean;

  constructor(store: CartStore, options: { demoMode: boolean; timeZone?: string; now?: () => number }) {
    this.#store = store;
    this.#db = store.database;
    this.#now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    this.demoMode = options.demoMode;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS chore_chores (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('weekly', 'monthly', 'once')),
        weekday INTEGER,
        every_weeks INTEGER NOT NULL DEFAULT 1,
        day_of_month INTEGER,
        anchor_date TEXT,
        pool_json TEXT NOT NULL DEFAULT '[]',
        next_due TEXT,
        assignee_override TEXT,
        skipped_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS chore_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chore_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('done', 'skip', 'swap')),
        member_id TEXT,
        other_id TEXT,
        actor_id TEXT,
        due_date TEXT,
        on_date TEXT NOT NULL,
        at TEXT NOT NULL,
        prev_json TEXT
      );
      CREATE INDEX IF NOT EXISTS chore_log_by_chore ON chore_log (chore_id, kind, at);
      CREATE TABLE IF NOT EXISTS chore_away (
        member_id TEXT PRIMARY KEY,
        until_date TEXT NOT NULL,
        set_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chore_nudges (
        key TEXT PRIMARY KEY,
        sent_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chore_messages (
        message_id TEXT PRIMARY KEY,
        reply TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chore_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------------------
  // Reading

  today(): string {
    return localDate(this.#now(), this.timeZone);
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #chores(options: { includeArchived?: boolean } = {}): Chore[] {
    const rows = this.#db.prepare(
      `SELECT * FROM chore_chores WHERE household_id = ? ${options.includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY created_at, name`,
    ).all(this.#store.household) as ChoreRow[];
    return rows.map(toChore);
  }

  #chore(id: string): Chore | null {
    const row = this.#db.prepare("SELECT * FROM chore_chores WHERE id = ? AND household_id = ?").get(id, this.#store.household) as ChoreRow | undefined;
    return row ? toChore(row) : null;
  }

  #context(): Context {
    const today = this.today();
    const people = this.#store.getMembers().map(({ id, name }) => ({ id, name }));
    const away = new Map<string, string>();
    for (const row of this.#db.prepare("SELECT member_id, until_date FROM chore_away WHERE until_date > ?").all(today) as Array<{ member_id: string; until_date: string }>) {
      away.set(row.member_id, row.until_date);
    }
    const stats = new Map<string, Map<string, MemberStats>>();
    const lastDone = new Map<string, LogRow>();
    const logs = this.#db.prepare("SELECT * FROM chore_log WHERE kind = 'done' ORDER BY at, id").all() as LogRow[];
    for (const log of logs) {
      lastDone.set(log.chore_id, log);
      if (!log.member_id) continue;
      const perChore = stats.get(log.chore_id) ?? new Map<string, MemberStats>();
      const previous = perChore.get(log.member_id) ?? { last: null, count: 0 };
      perChore.set(log.member_id, { last: Date.parse(log.at), count: previous.count + 1 });
      stats.set(log.chore_id, perChore);
    }
    return { today, people, ids: people.map((person) => person.id), away, stats, lastDone };
  }

  #name(ctx: Context, id: string | null): string {
    return ctx.people.find((person) => person.id === id)?.name ?? "someone";
  }

  #pool(chore: Chore, ctx: Context): string[] {
    const chosen = chore.pool.filter((id) => ctx.ids.includes(id));
    return chosen.length ? chosen : ctx.ids;
  }

  #awayOn(ctx: Context, date: string): Set<string> {
    return new Set([...ctx.away].filter(([, back]) => date < back).map(([id]) => id));
  }

  #turnDate(chore: Chore, ctx: Context): string {
    return chore.nextDue && chore.nextDue > ctx.today ? chore.nextDue : ctx.today;
  }

  #assignee(chore: Chore, ctx: Context, overrides: { skipped?: string[]; override?: string | null } = {}): string | null {
    if (!chore.nextDue) return null;
    return pickAssignee({
      pool: this.#pool(chore, ctx),
      stats: ctx.stats.get(chore.id) ?? new Map(),
      unavailable: this.#awayOn(ctx, this.#turnDate(chore, ctx)),
      skipped: overrides.skipped ?? chore.skipped,
      override: overrides.override === undefined ? chore.override : overrides.override,
    });
  }

  #available(chore: Chore, ctx: Context): string[] {
    const away = this.#awayOn(ctx, this.#turnDate(chore, ctx));
    return this.#pool(chore, ctx).filter((id) => !away.has(id));
  }

  #open(chore: Chore, ctx: Context): OpenChore | null {
    if (!chore.nextDue || chore.archived) return null;
    const lateDays = Math.max(0, daysBetween(chore.nextDue, ctx.today));
    const status = lateDays > 0 ? "late" : chore.nextDue === ctx.today ? "today" : "upcoming";
    const last = ctx.lastDone.get(chore.id);
    const previous = previousDue(chore.schedule, chore.nextDue);
    const opensOn = previous ? addDays(previous, 1) : ctx.today;
    return {
      id: chore.id,
      name: chore.name,
      emoji: chore.emoji,
      dueDate: chore.nextDue,
      dueText: status === "late" ? `${durationPhrase(lateDays)} late` : capitalize(dueLabel(chore.nextDue, ctx.today)),
      status,
      lateDays,
      assigneeId: this.#assignee(chore, ctx),
      scheduleLabel: chore.schedule.kind === "once" ? `One-off, ${shortDate(chore.schedule.date)}` : scheduleLabel(chore.schedule),
      schedule: chore.schedule,
      everyone: !chore.pool.filter((id) => ctx.ids.includes(id)).length,
      pool: this.#pool(chore, ctx),
      available: this.#available(chore, ctx),
      canComplete: opensOn <= ctx.today,
      opensOn,
      lastDone: last ? { memberId: last.member_id, when: pastLabel(last.on_date, ctx.today) } : null,
    };
  }

  /** Open chores, most urgent first. */
  openChores(): OpenChore[] {
    const ctx = this.#context();
    return this.#openAll(ctx);
  }

  #openAll(ctx: Context): OpenChore[] {
    return this.#chores().map((chore) => this.#open(chore, ctx)).filter((chore): chore is OpenChore => Boolean(chore))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
  }

  view(weekParam?: string | null): ChoresView {
    const ctx = this.#context();
    const { today } = ctx;
    const currentWeek = mondayOf(today);
    const weekStart = weekParam && isDateString(weekParam) ? mondayOf(weekParam) : currentWeek;
    const weekEnd = addDays(weekStart, 6);
    const isCurrentWeek = weekStart === currentWeek;
    const chores = this.#chores({ includeArchived: true });
    const byId = new Map(chores.map((chore) => [chore.id, chore]));
    const days = Array.from({ length: 7 }, (_, offset) => {
      const date = addDays(weekStart, offset);
      return { date, dow: shortWeekday(date), day: Number(date.slice(8)), isToday: date === today, isPast: date < today, items: [] as WeekItem[] };
    });
    const place = (date: string, item: WeekItem) => days.find((day) => day.date === date)?.items.push(item);

    const doneLogs = this.#db.prepare(
      "SELECT * FROM chore_log WHERE kind = 'done' AND due_date >= ? AND due_date <= ? ORDER BY at",
    ).all(weekStart, weekEnd) as LogRow[];
    for (const log of doneLogs) {
      const chore = byId.get(log.chore_id);
      if (!chore || chore.archived || !log.due_date) continue;
      place(log.due_date, { choreId: chore.id, name: chore.name, emoji: chore.emoji, status: "done", memberId: log.member_id, note: pastLabel(log.on_date, today) });
    }

    for (const chore of chores) {
      if (chore.archived || !chore.nextDue) continue;
      const assignee = this.#assignee(chore, ctx);
      const late = chore.nextDue < today;
      const openDate = late && isCurrentWeek ? today : chore.nextDue;
      if (openDate >= weekStart && openDate <= weekEnd) {
        place(openDate, {
          choreId: chore.id, name: chore.name, emoji: chore.emoji, status: late ? "late" : "open", memberId: assignee,
          note: late ? `${durationPhrase(daysBetween(chore.nextDue, today))} late` : "",
        });
      }
      if (chore.schedule.kind === "once" || weekEnd <= chore.nextDue) continue;
      const dates = occurrencesBetween(chore.schedule, chore.nextDue, weekEnd, 80);
      const projected = projectRotation({
        first: assignee,
        dates,
        pool: this.#pool(chore, ctx),
        stats: ctx.stats.get(chore.id) ?? new Map(),
        isUnavailable: (id, date) => this.#awayOn(ctx, date).has(id),
      });
      dates.forEach((date, index) => {
        if (index === 0 || date < weekStart || date < today) return;
        place(date, { choreId: chore.id, name: chore.name, emoji: chore.emoji, status: "planned", memberId: projected[index] ?? null, note: "" });
      });
    }
    const rank = { late: 0, open: 1, planned: 2, done: 3 } as const;
    for (const day of days) day.items.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

    const upNext = this.#openAll(ctx);
    const since = addDays(today, -29);
    const done30 = new Map<string, number>();
    for (const row of this.#db.prepare("SELECT member_id, COUNT(*) AS count FROM chore_log WHERE kind = 'done' AND on_date >= ? GROUP BY member_id").all(since) as Array<{ member_id: string; count: number }>) {
      done30.set(row.member_id, Number(row.count));
    }
    const recentRows = this.#db.prepare(
      "SELECT l.* FROM chore_log l JOIN chore_chores c ON c.id = l.chore_id WHERE l.kind = 'done' AND c.household_id = ? AND c.archived_at IS NULL ORDER BY l.at DESC, l.id DESC LIMIT 6",
    ).all(this.#store.household) as LogRow[];
    return {
      demoMode: this.demoMode,
      today,
      weekStart,
      prevWeek: addDays(weekStart, -7),
      nextWeek: addDays(weekStart, 7),
      isCurrentWeek,
      weekLabel: weekLabel(weekStart, weekEnd),
      choreCount: chores.filter((chore) => !chore.archived).length,
      members: ctx.people.map((person) => {
        const back = ctx.away.get(person.id) ?? null;
        return {
          ...person,
          awayUntil: back,
          awayLabel: back ? monthDay(back) : null,
          done30: done30.get(person.id) ?? 0,
          open: upNext.filter((chore) => chore.assigneeId === person.id).length,
        };
      }),
      days,
      upNext,
      recent: recentRows.map((log) => {
        const chore = byId.get(log.chore_id);
        return { logId: log.id, choreId: log.chore_id, name: chore?.name ?? "Chore", emoji: chore?.emoji ?? "✨", memberId: log.member_id, when: pastLabel(log.on_date, today) };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Changes (shared by the group chat, the page, and connector tools)

  create(input: { name: string; emoji?: string | null; schedule: ScheduleInput; pool?: string[]; actorId?: string | null }): Result<{ chore: OpenChore }> {
    const ctx = this.#context();
    const name = input.name.replace(/\s+/g, " ").trim();
    if (!name) return fail("Give the chore a name.");
    if (name.length > 60) return fail("Keep the name under 60 characters.");
    const duplicate = this.#chores().find((chore) => chore.name.toLowerCase() === name.toLowerCase() && chore.nextDue);
    if (duplicate) return fail(`${duplicate.emoji} ${duplicate.name} is already on the chore list (${lowerFirst(scheduleLabel(duplicate.schedule))}).`, 409);
    const scheduleInput = input.schedule;
    if (scheduleInput.kind === "once") {
      if (!isDateString(scheduleInput.date)) return fail("Pick a due date.");
      if (scheduleInput.date < ctx.today) return fail("That date has passed.");
    } else if (scheduleInput.kind === "weekly") {
      if (!Number.isInteger(scheduleInput.weekday) || scheduleInput.weekday < 0 || scheduleInput.weekday > 6) return fail("Pick a day of the week.");
      const every = scheduleInput.everyWeeks ?? 1;
      if (!Number.isInteger(every) || every < 1 || every > 8) return fail("Repeat every 1 to 8 weeks.");
    } else if (!Number.isInteger(scheduleInput.day) || scheduleInput.day < 1 || scheduleInput.day > 31) {
      return fail("Pick a day of the month.");
    }
    const emoji = (input.emoji ?? "").trim();
    if (emoji.length > 16) return fail("Use a single emoji.");
    const pool = [...new Set((input.pool ?? []).filter((id) => ctx.ids.includes(id)))];
    if (input.pool?.length && !pool.length) return fail("Choose at least one person.");
    const storedPool = pool.length === ctx.ids.length ? [] : ctx.ids.filter((id) => pool.includes(id));
    const schedule = buildSchedule(scheduleInput, ctx.today);
    const id = randomUUID();
    this.#db.prepare(
      `INSERT INTO chore_chores (id, household_id, name, emoji, kind, weekday, every_weeks, day_of_month, anchor_date, pool_json, next_due, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, this.#store.household, name, emoji || guessEmoji(name), schedule.kind,
      schedule.kind === "weekly" ? schedule.weekday : null,
      schedule.kind === "weekly" ? schedule.everyWeeks : 1,
      schedule.kind === "monthly" ? schedule.day : null,
      schedule.kind === "weekly" ? schedule.anchor : schedule.kind === "once" ? schedule.date : null,
      JSON.stringify(storedPool), firstDueOnOrAfter(schedule, ctx.today), input.actorId ?? null, new Date(this.#now()).toISOString(),
    );
    return { ok: true, chore: this.#open(this.#chore(id)!, this.#context())! };
  }

  complete(choreId: string, memberId: string | null, actorId: string | null = null): Result<{ chore: OpenChore; doneBy: string | null; wasTurn: boolean; next: OpenChore | null; logId: number }> {
    const ctx = this.#context();
    const chore = this.#chore(choreId);
    if (!chore || chore.archived) return fail("That chore no longer exists.", 404);
    const open = this.#open(chore, ctx);
    if (!open) return fail(`${chore.emoji} ${chore.name}: already done.`, 409);
    const doer = memberId ?? open.assigneeId;
    if (doer && !ctx.ids.includes(doer)) return fail("That person isn’t in the household.", 404);
    const today = this.#db.prepare("SELECT member_id FROM chore_log WHERE chore_id = ? AND kind = 'done' AND on_date = ? ORDER BY at DESC LIMIT 1").get(chore.id, ctx.today) as { member_id: string | null } | undefined;
    if (today) return fail(`${chore.emoji} ${chore.name}: already done today by ${this.#name(ctx, today.member_id)}.`, 409);
    if (!open.canComplete) return fail(`${chore.emoji} ${chore.name}: all done for now. The next one is ${shortDate(open.dueDate)}.`, 409);
    const nextDue = nextDueAfterCompletion(chore.schedule, open.dueDate, ctx.today);
    const logId = this.#tx(() => {
      const inserted = this.#db.prepare(
        "INSERT INTO chore_log (chore_id, kind, member_id, actor_id, due_date, on_date, at, prev_json) VALUES (?, 'done', ?, ?, ?, ?, ?, ?)",
      ).run(chore.id, doer, actorId, open.dueDate, ctx.today, new Date(this.#now()).toISOString(), JSON.stringify({ nextDue: chore.nextDue, override: chore.override, skipped: chore.skipped }));
      this.#db.prepare("UPDATE chore_chores SET next_due = ?, assignee_override = NULL, skipped_json = '[]' WHERE id = ?").run(nextDue, chore.id);
      return Number(inserted.lastInsertRowid);
    });
    // --- Money & points: on your turn and on time earns the most; covering still counts; late counts less ---
    if (doer) awardPoints({ kind: "chore", memberId: doer, key: `chore:${logId}`, label: chore.name, onTime: open.lateDays === 0, covering: Boolean(open.assigneeId) && doer !== open.assigneeId, day: open.dueDate });
    // --- end money & points ---
    const after = this.#context();
    const updated = this.#chore(chore.id)!;
    return { ok: true, chore: open, doneBy: doer, wasTurn: doer === open.assigneeId, next: this.#open(updated, after), logId };
  }

  /** Reverts a completion if nothing else has happened to that chore since. */
  undo(logId: number): Result<{ name: string }> {
    const log = this.#db.prepare("SELECT * FROM chore_log WHERE id = ?").get(logId) as (LogRow & { prev_json: string | null }) | undefined;
    if (!log || log.kind !== "done" || !log.prev_json) return fail("Nothing to undo.", 404);
    const chore = this.#chore(log.chore_id);
    if (!chore) return fail("That chore no longer exists.", 404);
    const later = this.#db.prepare("SELECT 1 FROM chore_log WHERE chore_id = ? AND id > ? LIMIT 1").get(log.chore_id, logId);
    if (later) return fail("That chore changed since; undo isn’t available.", 409);
    const prev = JSON.parse(log.prev_json) as { nextDue: string | null; override: string | null; skipped: string[] };
    this.#tx(() => {
      this.#db.prepare("UPDATE chore_chores SET next_due = ?, assignee_override = ?, skipped_json = ? WHERE id = ?").run(prev.nextDue, prev.override, JSON.stringify(prev.skipped ?? []), chore.id);
      this.#db.prepare("DELETE FROM chore_log WHERE id = ?").run(logId);
    });
    revokePoints(`chore:${logId}`); // money & points
    return { ok: true, name: chore.name };
  }

  skip(choreId: string, actorId: string | null = null): Result<{ chore: OpenChore; from: string; to: string }> {
    const ctx = this.#context();
    const chore = this.#chore(choreId);
    const open = chore ? this.#open(chore, ctx) : null;
    if (!chore || !open) return fail("That chore isn’t open.", 404);
    const from = open.assigneeId;
    if (!from) return fail(`No one is free to take ${chore.emoji} ${chore.name} right now.`, 409);
    const skipped = [...new Set([...chore.skipped, from])];
    const to = this.#assignee(chore, ctx, { skipped, override: null });
    if (!to || to === from) return fail(`No one else is free to take ${chore.emoji} ${chore.name} right now.`, 409);
    this.#tx(() => {
      this.#db.prepare("UPDATE chore_chores SET skipped_json = ?, assignee_override = NULL WHERE id = ?").run(JSON.stringify(skipped), chore.id);
      this.#db.prepare("INSERT INTO chore_log (chore_id, kind, member_id, other_id, actor_id, due_date, on_date, at) VALUES (?, 'skip', ?, ?, ?, ?, ?, ?)")
        .run(chore.id, from, to, actorId, open.dueDate, ctx.today, new Date(this.#now()).toISOString());
    });
    return { ok: true, chore: { ...open, assigneeId: to }, from, to };
  }

  /** Hands the open turn to `memberId` (a swap). */
  assign(choreId: string, memberId: string, actorId: string | null = null): Result<{ chore: OpenChore; from: string | null; to: string; after: string | null }> {
    const ctx = this.#context();
    const chore = this.#chore(choreId);
    const open = chore ? this.#open(chore, ctx) : null;
    if (!chore || !open) return fail("That chore isn’t open.", 404);
    if (!ctx.ids.includes(memberId)) return fail("That person isn’t in the household.", 404);
    const name = this.#name(ctx, memberId);
    if (!this.#pool(chore, ctx).includes(memberId)) return fail(`${name} isn’t in the ${chore.emoji} ${chore.name} rotation.`);
    const back = ctx.away.get(memberId);
    if (back && this.#turnDate(chore, ctx) < back) return fail(`${name} is away until ${monthDay(back)}.`, 409);
    if (open.assigneeId === memberId) return fail(`It’s already ${possessive(name)} turn.`, 409);
    this.#tx(() => {
      this.#db.prepare("UPDATE chore_chores SET assignee_override = ? WHERE id = ?").run(memberId, chore.id);
      this.#db.prepare("INSERT INTO chore_log (chore_id, kind, member_id, other_id, actor_id, due_date, on_date, at) VALUES (?, 'swap', ?, ?, ?, ?, ?, ?)")
        .run(chore.id, open.assigneeId, memberId, actorId, open.dueDate, ctx.today, new Date(this.#now()).toISOString());
    });
    let after: string | null = null;
    if (chore.schedule.kind !== "once") {
      const dates = occurrencesBetween(chore.schedule, open.dueDate, addDays(open.dueDate, 400), 2);
      after = projectRotation({
        first: memberId, dates, pool: this.#pool(chore, ctx), stats: ctx.stats.get(chore.id) ?? new Map(),
        isUnavailable: (id, date) => this.#awayOn(ctx, date).has(id),
      })[1] ?? null;
    }
    return { ok: true, chore: { ...open, assigneeId: memberId }, from: open.assigneeId, to: memberId, after };
  }

  archive(choreId: string): Result<{ name: string }> {
    const chore = this.#chore(choreId);
    if (!chore || chore.archived) return fail("That chore no longer exists.", 404);
    this.#db.prepare("UPDATE chore_chores SET archived_at = ? WHERE id = ?").run(new Date(this.#now()).toISOString(), chore.id);
    return { ok: true, name: chore.name };
  }

  restore(choreId: string): Result<{ name: string }> {
    const chore = this.#chore(choreId);
    if (!chore || !chore.archived) return fail("Nothing to restore.", 404);
    this.#db.prepare("UPDATE chore_chores SET archived_at = NULL WHERE id = ?").run(chore.id);
    return { ok: true, name: chore.name };
  }

  /** Marks someone away until `until` (the day they're back), or back now when `until` is null. */
  setAway(memberId: string, until: string | null): Result<{ name: string; until: string | null; wasAway: boolean; handoffs: Array<{ chore: string; to: string | null }> }> {
    const before = this.#context();
    if (!before.ids.includes(memberId)) return fail("That person isn’t in the household.", 404);
    const name = this.#name(before, memberId);
    const wasAway = before.away.has(memberId);
    if (until !== null) {
      if (!isDateString(until) || until <= before.today) return fail("Pick a day after today.");
      if (daysBetween(before.today, until) > 366) return fail("Pick a date within a year.");
      this.#db.prepare("INSERT INTO chore_away (member_id, until_date, set_at) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET until_date = excluded.until_date, set_at = excluded.set_at")
        .run(memberId, until, new Date(this.#now()).toISOString());
    } else {
      this.#db.prepare("DELETE FROM chore_away WHERE member_id = ?").run(memberId);
    }
    const after = this.#context();
    const handoffs: Array<{ chore: string; to: string | null }> = [];
    for (const chore of this.#chores()) {
      const was = this.#assignee(chore, before);
      const now = this.#assignee(chore, after);
      if (was === memberId && now !== memberId) handoffs.push({ chore: `${chore.emoji} ${chore.name}`, to: now });
    }
    return { ok: true, name, until, wasAway, handoffs };
  }

  // ---------------------------------------------------------------------------
  // Nudges

  /** Morning digest of today's chores and one overdue nudge per chore per day (persisted). */
  async nudgeTick(): Promise<string | null> {
    const now = this.#now();
    const hour = localHour(now, this.timeZone);
    if (!this.demoMode && (hour < DIGEST_HOUR || hour >= NUDGE_END_HOUR)) return null;
    const ctx = this.#context();
    const open = this.#openAll(ctx);
    const lines: string[] = [];
    const keys: string[] = [];
    const sent = (key: string) => Boolean(this.#db.prepare("SELECT 1 FROM chore_nudges WHERE key = ?").get(key));

    const digestKey = `digest:${ctx.today}`;
    const dueToday = open.filter((chore) => chore.status === "today");
    if (dueToday.length && !sent(digestKey) && (this.demoMode || hour <= DIGEST_LAST_HOUR)) {
      lines.push(`☀️ Today: ${dueToday.map((chore) => `${chore.emoji} ${chore.name} (${chore.assigneeId ? this.#name(ctx, chore.assigneeId) : "no one free"})`).join(", ")}`);
      keys.push(digestKey);
    }
    for (const chore of open) {
      if (chore.status !== "late" || !chore.assigneeId) continue;
      const key = `overdue:${chore.id}:${ctx.today}`;
      if (sent(key)) continue;
      const stat = ctx.stats.get(chore.id)?.get(chore.assigneeId);
      const daysSince = stat?.last ? daysBetween(localDate(stat.last, this.timeZone), ctx.today) : null;
      lines.push(overdueNudge({ name: chore.name, emoji: chore.emoji, assigneeName: this.#name(ctx, chore.assigneeId), daysSinceAssignee: daysSince, lateDays: chore.lateDays }));
      keys.push(key);
    }
    if (!lines.length) return null;
    const at = new Date(now).toISOString();
    this.#tx(() => {
      for (const key of keys) this.#db.prepare("INSERT OR IGNORE INTO chore_nudges (key, sent_at) VALUES (?, ?)").run(key, at);
      this.#db.prepare("DELETE FROM chore_nudges WHERE sent_at < ?").run(new Date(now - 90 * 86_400_000).toISOString());
      this.#db.prepare("DELETE FROM chore_messages WHERE at < ?").run(new Date(now - 30 * 86_400_000).toISOString());
    });
    const text = lines.join("\n");
    await notifyGroup(text);
    return text;
  }

  // ---------------------------------------------------------------------------
  // Group chat

  /** Replies to chore commands; null for anything else. Idempotent by message id. */
  handleCommand(context: CommandContext): string | null {
    const command = parseChoreCommand(context.text);
    if (!command) return null;
    const existing = this.#db.prepare("SELECT reply FROM chore_messages WHERE message_id = ?").get(context.messageId) as { reply: string } | undefined;
    if (existing) return existing.reply;
    const reply = this.#reply(command, context);
    if (reply === null) return null;
    this.#db.prepare("INSERT OR IGNORE INTO chore_messages (message_id, reply, at) VALUES (?, ?, ?)").run(context.messageId, reply, new Date(this.#now()).toISOString());
    return reply;
  }

  #find(query: string, explicit: boolean): { chore: Chore } | { reply: string } | null {
    const open = this.#chores().filter((chore) => chore.nextDue);
    const result = matchChore(query, open);
    if (result && "match" in result) return { chore: result.match };
    if (result) {
      const options = result.ambiguous.slice(0, 3).map((chore) => `${chore.emoji} ${chore.name}`);
      return { reply: `Which one: ${joinOr(options)}? Use more of the name.` };
    }
    // Unmatched phrases are only claimed when they sound like a chore ("done laundry"), so other
    // features' commands ("done milk") and groceries still get them.
    if (!explicit || ["✨", "🛒", "💸"].includes(guessEmoji(query))) return null;
    if (!open.length) return { reply: `No chores yet. Add one, like ${EXAMPLES}.` };
    const names = open.slice(0, 6).map((chore) => `${chore.emoji} ${chore.name}`).join(", ");
    return { reply: `I couldn’t find a chore called “${query.trim()}”. Chores: ${names}.` };
  }

  #reply(command: NonNullable<ReturnType<typeof parseChoreCommand>>, context: CommandContext): string | null {
    const me = context.memberId;
    const ctx = this.#context();
    switch (command.type) {
      case "list": return this.#listReply(ctx);
      case "mine": return this.#mineReply(ctx, me);
      case "add": {
        const spec = parseAddSpec(command.spec, ctx.today, ctx.people.map((person) => person.name));
        if (!spec.ok) {
          if (spec.reason === "daily") return `Daily chores aren’t supported yet. Try “add chore dishes every Sunday” or “add chore trash weekly on Tuesday”.`;
          if (spec.reason === "past_date") return "That date has passed. Try “add chore fix lamp by Friday”.";
          return `Say when it’s due, like ${EXAMPLES}.`;
        }
        const pool = spec.poolNames.map((name) => ctx.people.find((person) => person.name === name)?.id).filter((id): id is string => Boolean(id));
        const result = this.create({ name: spec.name, emoji: spec.emoji, schedule: spec.schedule, pool, actorId: me });
        if (!result.ok) return result.error;
        const chore = result.chore;
        const when = chore.schedule.kind === "once" ? `due ${dueLabel(chore.dueDate, ctx.today)}` : lowerFirst(scheduleLabel(chore.schedule));
        const who = chore.assigneeId ? this.#name(ctx, chore.assigneeId) : null;
        const rotation = chore.everyone ? "" : ` Rotation: ${joinNames(chore.pool.map((id) => this.#name(ctx, id)))}.`;
        const first = !who ? "" : chore.schedule.kind === "once" ? ` ${possessive(who)} on it.` : ` ${possessive(who)} first, ${dueLabel(chore.dueDate, ctx.today)}.`;
        return `➕ Added ${chore.emoji} ${chore.name}, ${when}.${first}${rotation}`;
      }
      case "done": {
        const found = this.#find(command.query, command.explicit);
        if (!found) return null;
        if ("reply" in found) return found.reply;
        const result = this.complete(found.chore.id, me, me);
        if (!result.ok) return result.error;
        const label = `${result.chore.emoji} ${result.chore.name}`;
        const thanks = result.wasTurn || !result.chore.assigneeId ? `✅ Nice, ${context.memberName}!` : `✅ Thanks for covering, ${context.memberName}!`;
        if (!result.next) return `${thanks} ${label} done.`;
        const nextWho = result.next.assigneeId ? `${possessive(this.#name(ctx, result.next.assigneeId))} up next` : "Next one";
        return `${thanks} ${label} done. ${nextWho}, ${dueLabel(result.next.dueDate, ctx.today)}.`;
      }
      case "skip": {
        const found = this.#find(command.query, command.explicit);
        if (!found) return null;
        if ("reply" in found) return found.reply;
        const result = this.skip(found.chore.id, me);
        if (!result.ok) return result.error;
        const label = `${result.chore.emoji} ${result.chore.name}`;
        const lead = result.from === me ? `${this.#name(ctx, result.from)} passed ${label}.` : `Skipped ${possessive(this.#name(ctx, result.from))} turn on ${label}.`;
        return `⏭️ ${lead} ${possessive(this.#name(ctx, result.to))} up, ${result.chore.status === "late" ? `${durationPhrase(result.chore.lateDays)} late` : `due ${dueLabel(result.chore.dueDate, ctx.today)}`}.`;
      }
      case "swap": {
        const found = this.#find(command.query, true);
        if (!found) return null;
        if ("reply" in found) return found.reply;
        const chore = found.chore;
        const label = `${chore.emoji} ${chore.name}`;
        const wanted = command.who.trim().toLowerCase().replace(/^@/, "");
        const other = wanted === "me" ? ctx.people.find((person) => person.id === me)
          : ctx.people.find((person) => person.name.toLowerCase() === wanted || (person.name.split(/\s+/)[0] ?? "").toLowerCase() === wanted);
        if (!other) return `I don’t know “${command.who.trim()}”. Try ${joinNames(ctx.people.filter((person) => person.id !== me).map((person) => person.name))}.`;
        if (other.id === me) return "Pick someone else to swap with.";
        const current = this.#assignee(chore, ctx);
        const target = current === me ? other.id : current === other.id ? me : null;
        if (!target) return `${label} is ${current ? possessive(this.#name(ctx, current)) : "no one’s"} turn right now, so only ${current ? this.#name(ctx, current) : "they"} can swap it.`;
        const result = this.assign(chore.id, target, me);
        if (!result.ok) return result.error;
        const due = result.chore.status === "late" ? `${durationPhrase(result.chore.lateDays)} late` : `due ${dueLabel(result.chore.dueDate, ctx.today)}`;
        const after = result.after ? ` ${possessive(this.#name(ctx, result.after))} up after.` : "";
        return `🔄 Swapped: ${this.#name(ctx, target)} has ${label} this time (${due}).${after}`;
      }
      case "away": {
        if (!command.when) return "Until when? Try “away until Oct 30”.";
        const until = parseDay(command.when, ctx.today, { after: true });
        if (!until || daysBetween(ctx.today, until) > 366) return "I didn’t catch the date. Try “away until Oct 30” or “away until Friday”.";
        const result = this.setAway(me, until);
        if (!result.ok) return result.error;
        const handoffs = result.handoffs.map((handoff) => (handoff.to ? `${this.#name(ctx, handoff.to)} takes ${handoff.chore}` : `no one is free for ${handoff.chore}`));
        return `✈️ Got it, ${context.memberName}. You’re off chores until ${shortDate(until)}.${handoffs.length ? ` ${capitalize(handoffs.join("; "))}.` : ""} Text “I’m back” if plans change.`;
      }
      case "back": {
        const result = this.setAway(me, null);
        if (!result.ok) return result.error;
        return result.wasAway ? `👋 Welcome back, ${context.memberName}! You’re in the chore rotation again.` : `You’re already in the chore rotation, ${context.memberName}.`;
      }
    }
  }

  #listReply(ctx: Context): string {
    const open = this.#openAll(ctx);
    if (!this.#chores().length) return `No chores yet. Add one, like ${EXAMPLES}.`;
    const horizon = addDays(ctx.today, 6);
    const soon = open.filter((chore) => chore.dueDate <= horizon);
    const lines = soon.map((chore) => `${chore.emoji} ${chore.name}: ${chore.assigneeId ? this.#name(ctx, chore.assigneeId) : "no one free"}, ${chore.status === "late" ? chore.dueText : dueLabel(chore.dueDate, ctx.today)}`);
    const monday = mondayOf(ctx.today);
    const done = this.#db.prepare(
      "SELECT l.member_id, c.name, c.emoji FROM chore_log l JOIN chore_chores c ON c.id = l.chore_id WHERE l.kind = 'done' AND l.on_date >= ? AND c.household_id = ? ORDER BY l.at",
    ).all(monday, this.#store.household) as Array<{ member_id: string | null; name: string; emoji: string }>;
    const out = [soon.length ? "🧽 Chores this week" : "Nothing due this week 🎉", ...lines];
    if (!soon.length && open[0]) out.push(`Next: ${open[0].emoji} ${open[0].name}, ${open[0].assigneeId ? `${this.#name(ctx, open[0].assigneeId)}, ` : ""}${dueLabel(open[0].dueDate, ctx.today)}`);
    if (done.length) out.push(`✅ Done: ${done.map((row) => `${row.emoji} ${row.name} (${this.#name(ctx, row.member_id)})`).join(", ")}`);
    const away = [...ctx.away].map(([id, back]) => `${this.#name(ctx, id)} until ${monthDay(back)}`);
    if (away.length) out.push(`✈️ Away: ${away.join(", ")}`);
    return out.join("\n");
  }

  #mineReply(ctx: Context, me: string): string {
    const name = this.#name(ctx, me);
    const back = ctx.away.get(me);
    if (back) return `You’re away until ${shortDate(back)}, ${name}, so you’re off the rotation. Text “I’m back” to rejoin.`;
    const mine = this.#openAll(ctx).filter((chore) => chore.assigneeId === me);
    if (!mine.length) return `Nothing on your plate, ${name} 🎉`;
    return [`${name}, you’re up for:`, ...mine.map((chore) => `${chore.emoji} ${chore.name}, ${chore.status === "late" ? chore.dueText : dueLabel(chore.dueDate, ctx.today)}`)].join("\n");
  }

  // ---------------------------------------------------------------------------
  // Connector tools (run as the calling member)

  resolveChore(query: unknown): { chore: Chore } | { error: string } {
    if (typeof query !== "string" || !query.trim()) return { error: "Name the chore, e.g. \"dishes\"." };
    const byId = this.#chore(query.trim());
    if (byId && !byId.archived) return { chore: byId };
    const found = this.#find(query, true);
    if (!found) return { error: `No chore matches "${query}". Open chores: ${this.#chores().filter((chore) => chore.nextDue).map((chore) => chore.name).join(", ") || "none"}.` };
    return "reply" in found ? { error: found.reply } : { chore: found.chore };
  }

  describe(chore: OpenChore): Record<string, unknown> {
    const ctx = this.#context();
    return {
      id: chore.id,
      name: chore.name,
      emoji: chore.emoji,
      schedule: chore.scheduleLabel,
      due_date: chore.dueDate,
      due: chore.dueText,
      status: chore.status,
      assignee: chore.assigneeId ? this.#name(ctx, chore.assigneeId) : null,
      rotation: chore.everyone ? "everyone" : chore.pool.map((id) => this.#name(ctx, id)),
    };
  }

  tools(): ToolSpec[] {
    const service = this;
    const caller = (who: ToolCaller) => who.memberId;
    const nameOf = (id: string | null) => (id ? this.#name(this.#context(), id) : null);
    return [
      {
        name: "list_chores",
        description: "List the household's open chores due in the next few days (default 7), with who is up, plus chores done this week and who is away. Use it to answer \"what chores are due\" or \"whose turn is it\".",
        inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 31, description: "How many days ahead to include (default 7). Overdue chores are always included." } } },
        handler: (args) => {
          const days = typeof args.days === "number" && args.days >= 1 && args.days <= 31 ? Math.floor(args.days) : 7;
          const view = service.view();
          const horizon = addDays(view.today, days - 1);
          return {
            today: view.today,
            time_zone: service.timeZone,
            chores: view.upNext.filter((chore) => chore.dueDate <= horizon).map((chore) => service.describe(chore)),
            later: view.upNext.filter((chore) => chore.dueDate > horizon).length,
            done_recently: view.recent.map((entry) => ({ chore: entry.name, by: nameOf(entry.memberId), when: entry.when })),
            away: view.members.filter((member) => member.awayUntil).map((member) => ({ name: member.name, back_on: member.awayUntil })),
          };
        },
      },
      {
        name: "my_chores",
        description: "List the chores currently assigned to the calling household member (overdue first), and whether they are marked away.",
        inputSchema: { type: "object", properties: {} },
        handler: (_args, who) => {
          const view = service.view();
          const me = view.members.find((member) => member.id === caller(who));
          return {
            member: who.memberName,
            away_until: me?.awayUntil ?? null,
            chores: view.upNext.filter((chore) => chore.assigneeId === caller(who)).map((chore) => service.describe(chore)),
          };
        },
      },
      {
        name: "complete_chore",
        description: "Mark a chore as done by the calling member (for its current turn) and report who is up next. The chore can be named loosely, e.g. \"dishes\" or \"trash\".",
        inputSchema: { type: "object", properties: { chore: { type: "string", description: "Chore name (fuzzy match) or chore id." } }, required: ["chore"] },
        mutates: true,
        handler: (args, who) => {
          const found = service.resolveChore(args.chore);
          if ("error" in found) return { ok: false, error: found.error };
          const result = service.complete(found.chore.id, caller(who), caller(who));
          if (!result.ok) return { ok: false, error: result.error };
          return {
            ok: true,
            done: service.describe(result.chore),
            done_by: who.memberName,
            next: result.next ? { due_date: result.next.dueDate, assignee: nameOf(result.next.assigneeId) } : null,
          };
        },
      },
      {
        name: "add_chore",
        description: "Add a household chore with a schedule: weekly on a weekday (optionally every N weeks), monthly on a day of the month, or once by a due date. The rotation defaults to everyone; fairness picks who goes first.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short chore name, e.g. \"Take out trash\"." },
            repeat: { type: "string", enum: ["weekly", "monthly", "once"], description: "How often it repeats." },
            weekday: { type: "string", enum: WEEKDAY_NAMES.map((day) => day.toLowerCase()), description: "Weekly: the day it is due (default sunday)." },
            every_weeks: { type: "integer", minimum: 1, maximum: 8, description: "Weekly: repeat every N weeks (default 1)." },
            day_of_month: { type: "integer", minimum: 1, maximum: 31, description: "Monthly: day of the month (default 31 = last day; 29-31 fall on the last day of shorter months)." },
            due_date: { type: "string", description: "Once: due date as YYYY-MM-DD (phrases like \"Friday\" or \"Oct 30\" also work)." },
            emoji: { type: "string", description: "Optional single emoji icon; one is picked from the name otherwise." },
            assignees: { type: "array", items: { type: "string" }, description: "Member names in the rotation. Omit for everyone." },
          },
          required: ["name", "repeat"],
        },
        mutates: true,
        handler: (args, who) => {
          const today = service.today();
          let schedule: ScheduleInput;
          if (args.repeat === "weekly") {
            const weekday = typeof args.weekday === "string" ? WEEKDAY_NAMES.findIndex((day) => day.toLowerCase() === String(args.weekday).toLowerCase()) : 0;
            if (weekday < 0) return { ok: false, error: "weekday must be a day name like \"tuesday\"." };
            schedule = { kind: "weekly", weekday, everyWeeks: typeof args.every_weeks === "number" ? Math.floor(args.every_weeks) : 1 };
          } else if (args.repeat === "monthly") {
            schedule = { kind: "monthly", day: typeof args.day_of_month === "number" ? Math.floor(args.day_of_month) : 31 };
          } else if (args.repeat === "once") {
            const date = typeof args.due_date === "string" ? parseDay(args.due_date, today) : null;
            if (!date) return { ok: false, error: "A one-off chore needs a due_date on or after today (YYYY-MM-DD)." };
            schedule = { kind: "once", date };
          } else {
            return { ok: false, error: "repeat must be weekly, monthly, or once." };
          }
          const people = service.#context().people;
          const pool: string[] = [];
          if (Array.isArray(args.assignees)) {
            for (const entry of args.assignees) {
              const wanted = String(entry).trim().toLowerCase();
              const person = people.find((candidate) => candidate.name.toLowerCase() === wanted || (candidate.name.split(/\s+/)[0] ?? "").toLowerCase() === wanted);
              if (!person) return { ok: false, error: `Unknown member "${String(entry)}". Members: ${people.map((candidate) => candidate.name).join(", ")}.` };
              pool.push(person.id);
            }
          }
          const result = service.create({ name: String(args.name ?? ""), emoji: typeof args.emoji === "string" ? args.emoji : null, schedule, pool, actorId: caller(who) });
          return result.ok ? { ok: true, chore: service.describe(result.chore) } : { ok: false, error: result.error };
        },
      },
      {
        name: "skip_chore",
        description: "Pass the current turn of a chore to the next fair person (the skipper stays first in line for the following turn). Use when the person who is up can't do it this time.",
        inputSchema: { type: "object", properties: { chore: { type: "string", description: "Chore name (fuzzy match) or chore id." } }, required: ["chore"] },
        mutates: true,
        handler: (args, who) => {
          const found = service.resolveChore(args.chore);
          if ("error" in found) return { ok: false, error: found.error };
          const result = service.skip(found.chore.id, caller(who));
          if (!result.ok) return { ok: false, error: result.error };
          return { ok: true, chore: service.describe(result.chore), skipped: nameOf(result.from), now_up: nameOf(result.to) };
        },
      },
      {
        name: "set_away",
        description: "Mark the calling member away from chores until a date (the day they are back), or back now. Away members are skipped in every rotation.",
        inputSchema: {
          type: "object",
          properties: {
            until: { type: "string", description: "The day they are back, as YYYY-MM-DD or a phrase like \"Oct 30\" or \"Friday\"." },
            back: { type: "boolean", description: "True to clear away status now." },
          },
        },
        mutates: true,
        handler: (args, who) => {
          if (args.back === true) {
            const result = service.setAway(caller(who), null);
            return result.ok ? { ok: true, away_until: null, was_away: result.wasAway } : { ok: false, error: result.error };
          }
          const until = typeof args.until === "string" ? parseDay(args.until, service.today(), { after: true }) : null;
          if (!until) return { ok: false, error: "Give until as a date after today (YYYY-MM-DD), or back: true." };
          const result = service.setAway(caller(who), until);
          if (!result.ok) return { ok: false, error: result.error };
          return { ok: true, away_until: until, handoffs: result.handoffs.map((handoff) => ({ chore: handoff.chore, now_up: nameOf(handoff.to) })) };
        },
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Demo data

  /** Seeds a lived-in household once (demo mode only). Dates are relative to today. */
  seedDemo(): boolean {
    if (this.#db.prepare("SELECT 1 FROM chore_meta WHERE key = 'demo_seeded'").get()) return false;
    if (this.#chores({ includeArchived: true }).length) return false;
    const ctx = this.#context();
    if (!ctx.people.length) return false;
    const t = ctx.today;
    const who = (index: number) => ctx.people[index % ctx.people.length]!.id;
    // Cast from the roster in order (any names, any size); with fewer members the roles repeat.
    const [one, two, three, four, five] = [who(0), who(1), who(2), who(3), who(4)];
    const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
    const nextSunday = firstDueOnOrAfter({ kind: "weekly", weekday: 0, everyWeeks: 1, anchor: "1970-01-04" }, t);
    const endOfLastMonth = addDays(`${t.slice(0, 7)}-01`, -1);
    type Seed = { name: string; emoji: string; schedule: ScheduleInput; pool?: string[]; anchor?: string; nextDue: string; history: Array<[string, string, string?]> };
    const seeds: Seed[] = [
      { name: "Dishes", emoji: "🍽️", schedule: { kind: "weekly", weekday: weekdayOf(addDays(t, -2)) }, pool: [one, three], nextDue: addDays(t, -2),
        history: [[addDays(t, -23), one], [addDays(t, -16), three], [addDays(t, -9), one]] },
      { name: "Take out trash", emoji: "🗑️", schedule: { kind: "weekly", weekday: weekdayOf(t) }, nextDue: t,
        history: [[addDays(t, -21), one], [addDays(t, -14), two], [addDays(t, -7), three]] },
      { name: "Water plants", emoji: "🪴", schedule: { kind: "weekly", weekday: weekdayOf(addDays(t, -1)) }, nextDue: addDays(t, 6),
        history: [[addDays(t, -15), three], [addDays(t, -8), one], [addDays(t, -1), two]] },
      { name: "Vacuum", emoji: "🧹", schedule: { kind: "weekly", weekday: 0 }, nextDue: nextSunday,
        history: [[addDays(nextSunday, -14), one], [addDays(nextSunday, -7), three]] },
      { name: "Clean bathroom", emoji: "🛁", schedule: { kind: "weekly", weekday: weekdayOf(addDays(t, 3)), everyWeeks: 2 }, anchor: addDays(t, 3), nextDue: addDays(t, 3),
        history: [[addDays(t, -25), one], [addDays(t, -11), three, addDays(t, -10)]] },
      { name: "Recycling", emoji: "♻️", schedule: { kind: "weekly", weekday: weekdayOf(addDays(t, -3)) }, nextDue: addDays(t, 4),
        history: [[addDays(t, -10), four], [addDays(t, -3), three]] },
      { name: "Deep clean fridge", emoji: "🧊", schedule: { kind: "monthly", day: 31 }, nextDue: firstDueOnOrAfter({ kind: "monthly", day: 31 }, t),
        history: [[endOfLastMonth, five]] },
    ];
    this.#tx(() => {
      const createdAt = new Date(this.#now() - 35 * 86_400_000).toISOString();
      for (const seed of seeds) {
        const schedule = buildSchedule(seed.schedule, t);
        const anchor = schedule.kind === "weekly" ? (seed.anchor ?? seed.nextDue) : null;
        const id = randomUUID();
        this.#db.prepare(
          `INSERT INTO chore_chores (id, household_id, name, emoji, kind, weekday, every_weeks, day_of_month, anchor_date, pool_json, next_due, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, this.#store.household, seed.name, seed.emoji, schedule.kind,
          schedule.kind === "weekly" ? schedule.weekday : null, schedule.kind === "weekly" ? schedule.everyWeeks : 1,
          schedule.kind === "monthly" ? schedule.day : null, anchor, JSON.stringify(seed.pool && seed.pool.length < ctx.ids.length ? seed.pool : []),
          seed.nextDue, createdAt);
        for (const [due, member, doneOn] of seed.history) {
          const on = doneOn ?? due;
          const at = new Date(zonedTimeToEpoch(on, 18 * 60 + 30, this.timeZone)).toISOString();
          this.#db.prepare("INSERT INTO chore_log (chore_id, kind, member_id, due_date, on_date, at) VALUES (?, 'done', ?, ?, ?, ?)").run(id, member, due, on, at);
        }
      }
      this.#db.prepare("INSERT OR REPLACE INTO chore_meta (key, value) VALUES ('demo_seeded', ?)").run(new Date(this.#now()).toISOString());
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// HTTP

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 8_192) { reject(new Error("Request body is too large.")); request.destroy(); }
    });
    request.on("end", () => {
      try {
        const value = raw ? JSON.parse(raw) as unknown : {};
        resolve(value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
      } catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}

/** Rejects cross-site browser POSTs: require JSON (forces a CORS preflight) and a same-host Origin when present. */
function isSameOriginJson(request: IncomingMessage): boolean {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function scheduleFromBody(value: unknown): ScheduleInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.kind === "once" && typeof input.date === "string") return { kind: "once", date: input.date };
  if (input.kind === "weekly" && typeof input.weekday === "number") return { kind: "weekly", weekday: input.weekday, everyWeeks: typeof input.everyWeeks === "number" ? input.everyWeeks : 1 };
  if (input.kind === "monthly" && typeof input.day === "number") return { kind: "monthly", day: input.day };
  return null;
}

export async function handleChoresRequest(service: ChoreService, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url;
  if (request.method === "GET" && (pathname === "/chores" || pathname === "/chores/")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderChoresPage());
    return true;
  }
  if (pathname !== "/api/chores" && !pathname.startsWith("/api/chores/")) return false;
  if (request.method === "GET" && pathname === "/api/chores") {
    sendJson(response, 200, service.view(url.searchParams.get("week")));
    return true;
  }
  if (request.method !== "POST") { sendJson(response, 404, { error: "Not found." }); return true; }
  if (!isSameOriginJson(request)) { sendJson(response, 403, { error: "Change chores from the GroupCart chores page." }); return true; }
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Request failed." });
    return true;
  }
  const respond = (result: Result<Record<string, unknown>>) => sendJson(response, result.ok ? 200 : result.status ?? 400, result);
  const choreId = str(body.choreId);
  switch (pathname) {
    case "/api/chores": {
      const schedule = scheduleFromBody(body.schedule);
      if (!schedule) { sendJson(response, 400, { ok: false, error: "Pick when it repeats." }); return true; }
      const pool = Array.isArray(body.pool) ? body.pool.filter((id): id is string => typeof id === "string") : [];
      respond(service.create({ name: str(body.name), emoji: str(body.emoji) || null, schedule, pool }));
      return true;
    }
    case "/api/chores/done": respond(service.complete(choreId, str(body.memberId) || null)); return true;
    case "/api/chores/undo": respond(service.undo(Number(body.logId))); return true;
    case "/api/chores/skip": respond(service.skip(choreId)); return true;
    case "/api/chores/assign": respond(service.assign(choreId, str(body.memberId))); return true;
    case "/api/chores/delete": respond(service.archive(choreId)); return true;
    case "/api/chores/restore": respond(service.restore(choreId)); return true;
    case "/api/chores/away": {
      const until = body.until === null || body.until === undefined || body.until === "" ? null : str(body.until);
      respond(service.setAway(str(body.memberId), until));
      return true;
    }
    default:
      sendJson(response, 404, { error: "Not found." });
      return true;
  }
}

// ---------------------------------------------------------------------------
// Wiring

// --- Money & points: the running chores service, for streaks and the Sunday digest (src/moneyPoints.ts) ---
let activeChores: ChoreService | null = null;
export function choreService(): ChoreService | null {
  return activeChores;
}
// --- end money & points ---

/** Registers chores with the platform: command, help, routes, connector tools, and the nudge schedule. */
export function setupChores(options: { store: CartStore; demoMode: boolean }): ChoreService {
  const service = new ChoreService(options.store, { demoMode: options.demoMode });
  activeChores = service; // money & points
  if (options.demoMode && service.seedDemo()) console.log("Chores: added sample chores and history for the demo.");
  registerCommand("chores", (context) => (context.text ? service.handleCommand(context) : null));
  registerHelp("Chores: “chores” for this week, “my chores”, “done dishes” when finished, “skip dishes” or “swap dishes with <name>” to trade a turn.");
  registerHelp(`Add a chore: ${EXAMPLES}.`);
  registerHelp("Away: “away until Oct 30” takes you out of chore rotations; “I’m back” puts you back.");
  registerRoute((request, response, url) => handleChoresRequest(service, request, response, url));
  registerTools(service.tools());
  scheduleEvery("chores-nudges", NUDGE_INTERVAL_MS, async () => { await service.nudgeTick(); });
  return service;
}
