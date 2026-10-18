// Household events and plans: one-off and recurring events (weekly/monthly, timed or
// all-day), RSVPs, fair task splits, snack lists, time polls that auto-book on a
// majority, movie ideas, "find a time" suggestions from everyone-free windows, and
// day-before / hour-before reminders that each fire once. Tables use the `event_`
// prefix in the shared SQLite database (store.database).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { addDays, freeWindowsInDays, localDate, mondayOf, zonedTimeToEpoch, type Interval, type MemberBusy } from "./availability.js";
import {
  ACTIVITIES, HOUSE_PLAN, activityByKey, daysBetween, detectActivity, formatClock, formatDay, formatOccurrence, formatSlot, localMinutes,
  occurrencesBetween, pickEmoji, rankSlots, splitEmoji, type Activity, type ActivityKey, type EventRule, type Occurrence, type ParsedVote,
  type Recurrence, type RsvpStatus,
} from "./eventsParse.js";
import type { CalendarService } from "./googleCalendar.js";
import { normalizeName, type ListView, type ListsService } from "./lists.js";
import type { CartStore } from "./store.js";

export type EventKind = ActivityKey | "house";
export type PollMode = "vote" | "pick";
export type PollStatus = "open" | "booked" | "cancelled" | "expired" | "replaced";

export type EventInput = {
  title: string;
  emoji?: string | null;
  kind?: EventKind | null;
  /** YYYY-MM-DD (household time zone). */
  date: string;
  /** All-day multi-day end (inclusive). */
  endDate?: string | null;
  /** Minutes after midnight; null/undefined = all day. */
  startMin?: number | null;
  durationMin?: number | null;
  recurrence?: Recurrence;
  everyone?: boolean;
  attendeeIds?: string[];
  notes?: string | null;
};

export type EventRecord = {
  id: string;
  title: string;
  emoji: string;
  kind: EventKind;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startMin: number | null;
  durationMin: number;
  recurrence: Recurrence;
  everyone: boolean;
  attendeeIds: string[];
  notes: string | null;
  pollId: string | null;
  createdBy: string | null;
  createdAt: string;
  timeZone: string;
};

export type OccurrenceView = {
  key: string;
  eventId: string;
  title: string;
  emoji: string;
  kind: EventKind;
  allDay: boolean;
  start: number;
  end: number;
  date: string;
  endDate: string;
  recurrence: Recurrence;
  label: string;
  attendeeIds: string[];
  rsvps: Record<string, RsvpStatus>;
  listId: string | null;
};

export type TaskView = { id: string; label: string; memberId: string | null; done: boolean };
export type IdeaView = { id: string; title: string; addedBy: string; votes: string[] };
/** A suggested time; `busy` lists members whose calendars are busy then (empty = everyone free). */
export type Slot = Interval & { busy: string[] };
export type PollOption = { index: number; start: number; end: number; label: string; busy: string[]; yes: string[]; no: string[] };
export type PollView = {
  id: string;
  kind: EventKind;
  title: string;
  emoji: string;
  durationMin: number;
  organizerId: string | null;
  mode: PollMode;
  status: PollStatus;
  createdAt: string;
  eventId: string | null;
  attendeeIds: string[];
  responded: string[];
  majority: number;
  options: PollOption[];
};

export type EventDetail = {
  event: EventRecord;
  next: OccurrenceView | null;
  rsvps: Record<string, RsvpStatus>;
  tasks: TaskView[];
  list: ListView | null;
  ideas: IdeaView[];
};

type EventRow = {
  id: string; title: string; emoji: string; kind: string; all_day: number; start_date: string; start_min: number | null; duration_min: number;
  end_date: string; tz: string; recurrence: string; everyone: number; attendee_ids_json: string; notes: string | null; poll_id: string | null;
  created_by: string | null; created_at: string; cancelled_at: string | null;
};
type PollRow = {
  id: string; kind: string; title: string; emoji: string; duration_min: number; organizer_id: string | null; mode: string; options_json: string;
  status: string; event_id: string | null; created_at: string; closed_at: string | null; everyone: number; attendee_ids_json: string;
};

export type PlanShape = { label: string; emoji: string; kind: EventKind; minutes: number; window: [number, number]; preferred: number; preferredDays: number[] };

/** Template for planning an activity (or a plain household event when `kind` is "house"). */
export function planShape(kind: EventKind, overrides: { label?: string; emoji?: string; minutes?: number | null } = {}): PlanShape {
  const activity = activityByKey(kind);
  if (!activity) {
    return { label: overrides.label ?? "House meeting", emoji: overrides.emoji ?? "🏠", kind: "house", minutes: overrides.minutes ?? HOUSE_PLAN.minutes, window: HOUSE_PLAN.window, preferred: HOUSE_PLAN.preferred, preferredDays: HOUSE_PLAN.preferredDays };
  }
  return { label: overrides.label ?? activity.label, emoji: overrides.emoji ?? activity.emoji, kind: activity.key, minutes: overrides.minutes ?? activity.minutes, window: activity.window, preferred: activity.preferred, preferredDays: activity.preferredDays };
}

const SOCIAL = new Set<string>(ACTIVITIES.map((activity) => activity.key));
const DAY_MS = 86_400_000;

export class EventsService {
  readonly #store: CartStore;
  readonly #db: DatabaseSync;
  readonly #calendar: CalendarService | undefined;
  readonly #lists: ListsService;
  readonly #notify: (text: string) => Promise<void>;
  readonly #now: () => number;
  readonly timeZone: string;

  constructor(store: CartStore, options: { calendar?: CalendarService; lists: ListsService; timeZone: string; notify: (text: string) => Promise<void>; now?: () => number }) {
    this.#store = store;
    this.#db = store.database;
    this.#calendar = options.calendar;
    this.#lists = options.lists;
    this.#notify = options.notify;
    this.#now = options.now ?? Date.now;
    this.timeZone = options.timeZone;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS event_events (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        title TEXT NOT NULL,
        emoji TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'house',
        all_day INTEGER NOT NULL,
        start_date TEXT NOT NULL,
        start_min INTEGER,
        duration_min INTEGER NOT NULL,
        end_date TEXT NOT NULL,
        tz TEXT NOT NULL,
        recurrence TEXT NOT NULL DEFAULT 'none',
        everyone INTEGER NOT NULL DEFAULT 1,
        attendee_ids_json TEXT NOT NULL,
        notes TEXT,
        poll_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        cancelled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS event_reminders (
        event_id TEXT NOT NULL,
        occurrence TEXT NOT NULL,
        kind TEXT NOT NULL,
        sent INTEGER NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (event_id, occurrence, kind)
      );
      CREATE TABLE IF NOT EXISTS event_rsvps (
        event_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (event_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS event_tasks (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        label TEXT NOT NULL,
        member_id TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_polls (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        emoji TEXT NOT NULL,
        duration_min INTEGER NOT NULL,
        organizer_id TEXT,
        mode TEXT NOT NULL,
        options_json TEXT NOT NULL,
        status TEXT NOT NULL,
        event_id TEXT,
        everyone INTEGER NOT NULL DEFAULT 1,
        attendee_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS event_votes (
        poll_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        option INTEGER NOT NULL,
        yes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (poll_id, member_id, option)
      );
      CREATE TABLE IF NOT EXISTS event_ideas (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        added_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_idea_votes (
        idea_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (idea_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS event_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  get calendarMode(): "demo" | "google" | "none" {
    return this.#calendar ? this.#calendar.mode : "none";
  }

  get calendar(): CalendarService | undefined {
    return this.#calendar;
  }

  now(): number {
    return this.#now();
  }

  today(): string {
    return localDate(this.#now(), this.timeZone);
  }

  members(): Array<{ id: string; name: string }> {
    return this.#store.getMembers().map(({ id, name }) => ({ id, name }));
  }

  memberName(id: string | null | undefined): string {
    return this.members().find((member) => member.id === id)?.name ?? "Someone";
  }

  meta(key: string): string | undefined {
    return (this.#db.prepare("SELECT value FROM event_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // --- Events --------------------------------------------------------------

  #record(row: EventRow): EventRecord {
    return {
      id: row.id,
      title: row.title,
      emoji: row.emoji,
      kind: (SOCIAL.has(row.kind) ? row.kind : "house") as EventKind,
      allDay: Boolean(row.all_day),
      startDate: row.start_date,
      endDate: row.end_date,
      startMin: row.all_day ? null : row.start_min,
      durationMin: row.duration_min,
      recurrence: (["weekly", "monthly"].includes(row.recurrence) ? row.recurrence : "none") as Recurrence,
      everyone: Boolean(row.everyone),
      attendeeIds: row.everyone ? this.members().map((member) => member.id) : JSON.parse(row.attendee_ids_json) as string[],
      notes: row.notes,
      pollId: row.poll_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      timeZone: row.tz,
    };
  }

  #rule(event: EventRecord): EventRule {
    return { startDate: event.startDate, startMin: event.startMin, durationMin: event.durationMin, endDate: event.endDate, recurrence: event.recurrence, timeZone: event.timeZone };
  }

  activeEvents(): EventRecord[] {
    return (this.#db.prepare("SELECT * FROM event_events WHERE household_id = ? AND cancelled_at IS NULL ORDER BY start_date, start_min").all(this.#store.household) as EventRow[]).map((row) => this.#record(row));
  }

  getEvent(id: string): EventRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM event_events WHERE id = ? AND household_id = ?").get(id, this.#store.household) as EventRow | undefined;
    return row && !row.cancelled_at ? this.#record(row) : undefined;
  }

  /** Validates and stores an event; social activities also get a fair task split and a snack list. */
  create(input: EventInput, actorId: string | null, options: { extras?: boolean; pollId?: string | null; rsvps?: Record<string, RsvpStatus> } = {}): { ok: true; event: EventRecord } | { ok: false; error: string } {
    const split = splitEmoji(input.title ?? "");
    const title = split.title.replace(/\s+/g, " ").trim();
    if (!title) return { ok: false, error: "Give the event a name." };
    if (title.length > 60) return { ok: false, error: "That name is too long (60 characters max)." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "")) return { ok: false, error: "When is it? e.g. “add event house meeting Sunday 7pm”." };
    const startMin = input.startMin ?? null;
    if (startMin !== null && !(startMin >= 0 && startMin < 1440)) return { ok: false, error: "That start time doesn’t look right." };
    const detected = detectActivity(title);
    const kind: EventKind = input.kind && (input.kind === "house" || SOCIAL.has(input.kind)) ? input.kind : detected?.activity.key ?? "house";
    const activity = activityByKey(kind);
    const emoji = (input.emoji && input.emoji.trim().slice(0, 16)) || split.emoji || (detected ? detected.emoji : pickEmoji(title));
    const durationMin = startMin === null ? 0 : Math.max(15, Math.min(24 * 60, Math.round(input.durationMin ?? activity?.minutes ?? 60)));
    let endDate = startMin === null ? input.endDate && /^\d{4}-\d{2}-\d{2}$/.test(input.endDate) ? input.endDate : input.date : input.date;
    if (endDate < input.date) endDate = input.date;
    if (daysBetween(input.date, endDate) > 30) return { ok: false, error: "All-day events can span up to a month." };
    const recurrence: Recurrence = input.recurrence === "weekly" || input.recurrence === "monthly" ? input.recurrence : "none";
    const members = this.members();
    const attendees = (input.attendeeIds ?? []).filter((id) => members.some((member) => member.id === id));
    const everyone = input.everyone !== false || !attendees.length || attendees.length >= members.length;
    const notes = input.notes?.trim().slice(0, 500) || null;
    const id = randomUUID();
    const createdAt = new Date(this.#now()).toISOString();
    this.#db.prepare(`INSERT INTO event_events (id, household_id, title, emoji, kind, all_day, start_date, start_min, duration_min, end_date, tz, recurrence, everyone, attendee_ids_json, notes, poll_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, this.#store.household, title.charAt(0).toUpperCase() + title.slice(1), emoji, kind, startMin === null ? 1 : 0, input.date, startMin, durationMin, endDate,
      this.timeZone, recurrence, everyone ? 1 : 0, JSON.stringify(everyone ? [] : [...attendees].sort()), notes, options.pollId ?? null, actorId, createdAt,
    );
    const event = this.getEvent(id)!;
    const rsvps: Record<string, RsvpStatus> = { ...(options.rsvps ?? {}) };
    if (kind !== "house" && actorId && members.some((member) => member.id === actorId) && !rsvps[actorId]) rsvps[actorId] = "going";
    for (const [memberId, status] of Object.entries(rsvps)) this.setRsvp(id, memberId, status);
    if (activity && options.extras !== false) {
      this.#assignTasks(id, activity.tasks, event.attendeeIds);
      const listName = detected && detected.activity.key === activity.key && detected.label !== activity.label ? `${detected.label} snacks` : activity.listName;
      this.#lists.createList({ name: listName, items: activity.listItems, who: { everyone: true, memberIds: [] }, createdBy: actorId, emoji, eventId: id, nameSuffix: formatDay(input.date, "0000-01-01").replace(/^\w+ /, "") });
    }
    return { ok: true, event };
  }

  /** Cancels an event (the whole series when it repeats) and drops its untouched snack list. */
  cancel(eventId: string): EventRecord | undefined {
    const event = this.getEvent(eventId);
    if (!event) return undefined;
    this.#db.prepare("UPDATE event_events SET cancelled_at = ? WHERE id = ?").run(new Date(this.#now()).toISOString(), eventId);
    const list = this.#lists.listForEvent(eventId);
    if (list && !list.items.some((item) => item.carted || item.checked)) this.#lists.deleteList(list.id);
    return event;
  }

  findEvents(query: string): EventRecord[] {
    const wanted = normalizeName(splitEmoji(query).title);
    if (!wanted) return [];
    const events = this.activeEvents();
    const exact = events.filter((event) => normalizeName(event.title) === wanted);
    if (exact.length) return exact;
    return events.filter((event) => normalizeName(event.title).includes(wanted) || wanted.includes(normalizeName(event.title)));
  }

  #view(event: EventRecord, occurrence: Occurrence, rsvps?: Record<string, RsvpStatus>, listId?: string | null): OccurrenceView {
    return {
      key: `${event.id}:${occurrence.date}`,
      eventId: event.id,
      title: event.title,
      emoji: event.emoji,
      kind: event.kind,
      allDay: event.allDay,
      start: occurrence.start,
      end: occurrence.end,
      date: occurrence.date,
      endDate: occurrence.endDate,
      recurrence: event.recurrence,
      label: formatOccurrence(occurrence, event.allDay, this.timeZone, this.today()),
      attendeeIds: event.attendeeIds,
      rsvps: rsvps ?? this.rsvps(event.id),
      listId: listId === undefined ? this.#lists.listForEvent(event.id)?.id ?? null : listId,
    };
  }

  /** All occurrences overlapping [from, to), in time order. */
  occurrences(from: number, to: number): OccurrenceView[] {
    return this.activeEvents()
      .flatMap((event) => {
        const found = occurrencesBetween(this.#rule(event), from, to, 60);
        if (!found.length) return [];
        const rsvps = this.rsvps(event.id);
        const listId = this.#lists.listForEvent(event.id)?.id ?? null;
        return found.map((occurrence) => this.#view(event, occurrence, rsvps, listId));
      })
      .sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
  }

  /** Next occurrences that have not ended yet. */
  upcoming(limit = 5, days = 30): OccurrenceView[] {
    const now = this.#now();
    return this.occurrences(now, now + days * DAY_MS).filter((occurrence) => occurrence.end > now).slice(0, limit);
  }

  nextOccurrence(event: EventRecord): OccurrenceView | null {
    const now = this.#now();
    const found = occurrencesBetween(this.#rule(event), now, now + 400 * DAY_MS, 1)[0];
    return found ? this.#view(event, found) : null;
  }

  detail(eventId: string): EventDetail | undefined {
    const event = this.getEvent(eventId);
    if (!event) return undefined;
    return {
      event,
      next: this.nextOccurrence(event),
      rsvps: this.rsvps(eventId),
      tasks: this.tasks(eventId),
      list: this.#lists.listForEvent(eventId) ?? null,
      ideas: event.kind === "movie" ? this.ideas("movie").slice(0, 5) : [],
    };
  }

  // --- RSVPs and tasks ------------------------------------------------------

  rsvps(eventId: string): Record<string, RsvpStatus> {
    const rows = this.#db.prepare("SELECT member_id, status FROM event_rsvps WHERE event_id = ?").all(eventId) as Array<{ member_id: string; status: string }>;
    return Object.fromEntries(rows.map((row) => [row.member_id, row.status as RsvpStatus]));
  }

  setRsvp(eventId: string, memberId: string, status: RsvpStatus): void {
    this.#db.prepare("INSERT INTO event_rsvps (event_id, member_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, member_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at")
      .run(eventId, memberId, status, new Date(this.#now()).toISOString());
  }

  /** "🎲 Game night (Thu 7:30pm): ✓ Alex, Maya · ? Jordan" */
  rsvpLine(event: EventRecord): string {
    const rsvps = this.rsvps(event.id);
    const people = this.members().filter((member) => event.attendeeIds.includes(member.id));
    const group = (status: RsvpStatus) => people.filter((member) => rsvps[member.id] === status).map((member) => member.name);
    const waiting = people.filter((member) => !rsvps[member.id]).map((member) => member.name);
    const marks: Array<[string, string[]]> = [["✓", group("going")], ["?", group("maybe")], ["✗", group("no")]];
    const parts = marks.filter(([, names]) => names.length).map(([mark, names]) => `${mark} ${names.join(", ")}`);
    if (waiting.length) parts.push(`waiting on ${waiting.join(", ")}`);
    const next = this.nextOccurrence(event);
    return `${event.emoji} ${event.title}${next ? ` (${next.label})` : ""}: ${parts.join(" · ")}`;
  }

  tasks(eventId: string): TaskView[] {
    return (this.#db.prepare("SELECT id, label, member_id, done FROM event_tasks WHERE event_id = ? ORDER BY position").all(eventId) as Array<{ id: string; label: string; member_id: string | null; done: number }>)
      .map((row) => ({ id: row.id, label: row.label, memberId: row.member_id, done: Boolean(row.done) }));
  }

  setTaskDone(taskId: string, done: boolean): boolean {
    return Number(this.#db.prepare("UPDATE event_tasks SET done = ? WHERE id = ? AND event_id IN (SELECT id FROM event_events WHERE household_id = ?)").run(done ? 1 : 0, taskId, this.#store.household).changes) > 0;
  }

  /**
   * Fair task split: each task goes to the attendee who has done that task the
   * fewest times, then who has the fewest tasks overall, then a rotation that
   * shifts every event, so “pick the movie” and the clean-up both rotate.
   */
  #assignTasks(eventId: string, labels: string[], attendeeIds: string[]): void {
    if (!attendeeIds.length || !labels.length) return;
    const rows = this.#db.prepare("SELECT member_id, label, COUNT(*) AS count FROM event_tasks WHERE member_id IS NOT NULL GROUP BY member_id, label").all() as Array<{ member_id: string; label: string; count: number }>;
    const perLabel = (memberId: string, label: string) => Number(rows.find((row) => row.member_id === memberId && row.label.toLowerCase() === label.toLowerCase())?.count ?? 0);
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.member_id, (totals.get(row.member_id) ?? 0) + Number(row.count));
    const rounds = Number((this.#db.prepare("SELECT COUNT(DISTINCT event_id) AS count FROM event_tasks").get() as { count: number }).count);
    const ordered = [...attendeeIds].sort();
    const rotation = (id: string) => (ordered.indexOf(id) - rounds % ordered.length + ordered.length) % ordered.length;
    const insert = this.#db.prepare("INSERT INTO event_tasks (id, event_id, label, member_id, done, position, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)");
    const stamp = new Date(this.#now()).toISOString();
    const taken = new Map<string, number>();
    labels.forEach((label, index) => {
      const pick = [...ordered].sort((a, b) =>
        (taken.get(a) ?? 0) - (taken.get(b) ?? 0)
        || perLabel(a, label) - perLabel(b, label)
        || (totals.get(a) ?? 0) - (totals.get(b) ?? 0)
        || rotation(a) - rotation(b))[0]!;
      taken.set(pick, (taken.get(pick) ?? 0) + 1);
      totals.set(pick, (totals.get(pick) ?? 0) + 1);
      insert.run(randomUUID(), eventId, label, pick, index, stamp);
    });
  }

  taskLine(eventId: string): string {
    return this.tasks(eventId).map((task) => `${this.memberName(task.memberId)}: ${task.label.toLowerCase()}`).join(" · ");
  }

  /** Group message after an event is booked: time, task split, snack list. */
  announcement(event: EventRecord, verb = "is on"): string {
    const next = this.nextOccurrence(event);
    const when = next ? (event.allDay ? next.label : formatSlot(next.start, next.end, this.timeZone, this.today())) : formatDay(event.startDate, this.today());
    const lines = [`${event.emoji} ${event.title} ${verb}: ${when}${event.recurrence !== "none" ? ` (${event.recurrence})` : ""}`];
    const tasks = this.taskLine(event.id);
    if (tasks) lines.push(`Tasks: ${tasks}`);
    const list = this.#lists.listForEvent(event.id);
    if (list && list.remaining) lines.push(`${list.name}: ${list.items.filter((item) => !item.checked).map((item) => item.name.toLowerCase()).join(", ")}. Text “${list.name.toLowerCase()} to cart” to add them.`);
    if (event.kind === "movie") lines.push("Movie ideas? Text “add movie <title>”.");
    return lines.join("\n");
  }

  // --- Find a time -----------------------------------------------------------

  /**
   * Best everyone-free slots for `shape` over the next `days` (or the given dates),
   * using each member's busy time from the calendar service plus existing
   * household events.
   */
  async suggest(shape: PlanShape, options: { dates?: string[] | null; days?: number; count?: number; durationMin?: number | null } = {}): Promise<{ slots: Slot[]; included: number; total: number; mode: "demo" | "google" | "none" }> {
    const now = this.#now();
    const today = this.today();
    const durationMin = Math.max(15, Math.min(12 * 60, options.durationMin ?? shape.minutes));
    const horizon = Math.max(1, Math.min(14, options.days ?? 7));
    const dates = (options.dates?.length ? options.dates : Array.from({ length: horizon }, (_, offset) => addDays(today, offset)))
      .filter((date) => date >= today && daysBetween(today, date) < 14);
    if (!dates.length) return { slots: [], included: 0, total: this.members().length, mode: this.calendarMode };
    const busy = new Map<string, Interval[]>();
    let included = 0;
    let total = this.members().length;
    if (this.#calendar) {
      for (const week of [...new Set(dates.map(mondayOf))]) {
        const data = await this.#calendar.week({ week, timeZone: this.timeZone, now });
        total = data.members.length;
        const counted = data.members.filter((member) => member.status === "sample" || member.status === "connected");
        included = Math.max(included, counted.length);
        for (const member of counted) busy.set(member.id, [...(busy.get(member.id) ?? []), ...member.busy]);
      }
    }
    const first = zonedTimeToEpoch(dates[0]!, 0, this.timeZone);
    const last = zonedTimeToEpoch(addDays(dates[dates.length - 1]!, 1), 0, this.timeZone);
    const house = this.occurrences(first, last).filter((occurrence) => !occurrence.allDay).map(({ start, end }) => ({ start, end }));
    const members: MemberBusy[] = [...busy.entries()].map(([memberId, blocks]) => ({ memberId, busy: blocks }));
    members.push({ memberId: "__house", busy: house });
    const dayWindows = dates.map((date) => ({ start: zonedTimeToEpoch(date, shape.window[0], this.timeZone), end: zonedTimeToEpoch(date, shape.window[1], this.timeZone) }));
    const windows = freeWindowsInDays(members, dayWindows, durationMin);
    const count = options.count ?? 3;
    const preferences = { durationMin, preferredMin: shape.preferred, preferredDays: shape.preferredDays, now, timeZone: this.timeZone, count };
    const slots: Slot[] = rankSlots(windows, preferences).map(({ start, end }) => ({ start, end, busy: [] }));
    if (slots.length < count && members.length > 2) {
      // Not enough times that suit everyone: fill in with the best times only one person is busy.
      const partial: Array<Slot & { score: number }> = [];
      for (const member of members) {
        if (member.memberId === "__house") continue;
        const others = members.filter((candidate) => candidate !== member);
        for (const slot of rankSlots(freeWindowsInDays(others, dayWindows, durationMin), preferences)) partial.push({ start: slot.start, end: slot.end, score: slot.score + 120, busy: [member.memberId] });
      }
      partial.sort((a, b) => a.score - b.score || a.start - b.start);
      for (const slot of partial) {
        if (slots.length >= count) break;
        if (slots.some((chosen) => slot.start < chosen.end && chosen.start < slot.end)) continue;
        slots.push({ start: slot.start, end: slot.end, busy: slot.busy });
      }
      slots.sort((a, b) => a.start - b.start);
    }
    return { slots, included, total, mode: this.calendarMode };
  }

  // --- Polls -------------------------------------------------------------

  #poll(row: PollRow): PollView {
    const members = this.members();
    const attendeeIds = row.everyone ? members.map((member) => member.id) : JSON.parse(row.attendee_ids_json) as string[];
    const votes = this.#db.prepare("SELECT member_id, option, yes FROM event_votes WHERE poll_id = ?").all(row.id) as Array<{ member_id: string; option: number; yes: number }>;
    const slots = JSON.parse(row.options_json) as Array<Interval & { busy?: string[] }>;
    const today = this.today();
    return {
      id: row.id,
      kind: (SOCIAL.has(row.kind) ? row.kind : "house") as EventKind,
      title: row.title,
      emoji: row.emoji,
      durationMin: row.duration_min,
      organizerId: row.organizer_id,
      mode: row.mode === "pick" ? "pick" : "vote",
      status: row.status as PollStatus,
      createdAt: row.created_at,
      eventId: row.event_id,
      attendeeIds,
      responded: [...new Set(votes.map((vote) => vote.member_id))],
      majority: Math.floor(attendeeIds.length / 2) + 1,
      options: slots.map((slot, index) => ({
        index: index + 1,
        start: slot.start,
        end: slot.end,
        label: formatSlot(slot.start, null, this.timeZone, today),
        busy: slot.busy ?? [],
        yes: votes.filter((vote) => vote.option === index + 1 && vote.yes).map((vote) => vote.member_id),
        no: votes.filter((vote) => vote.option === index + 1 && !vote.yes).map((vote) => vote.member_id),
      })),
    };
  }

  getPoll(id: string): PollView | undefined {
    const row = this.#db.prepare("SELECT * FROM event_polls WHERE id = ? AND household_id = ?").get(id, this.#store.household) as PollRow | undefined;
    return row ? this.#poll(row) : undefined;
  }

  /** Open polls, newest first (expires polls whose every option has started). */
  openPolls(mode?: PollMode): PollView[] {
    const now = this.#now();
    const rows = this.#db.prepare("SELECT * FROM event_polls WHERE household_id = ? AND status = 'open' ORDER BY created_at DESC").all(this.#store.household) as PollRow[];
    const open: PollView[] = [];
    for (const row of rows) {
      const slots = JSON.parse(row.options_json) as Interval[];
      if (slots.every((slot) => slot.start <= now)) {
        this.#db.prepare("UPDATE event_polls SET status = 'expired', closed_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
        continue;
      }
      if (!mode || row.mode === mode) open.push(this.#poll(row));
    }
    return open;
  }

  /** The group vote that was booked most recently within `withinMs` (for late "2" replies). */
  recentlyBooked(withinMs = 6 * 3_600_000): PollView | undefined {
    const since = new Date(this.#now() - withinMs).toISOString();
    const row = this.#db.prepare("SELECT * FROM event_polls WHERE household_id = ? AND status = 'booked' AND mode = 'vote' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 1").get(this.#store.household, since) as PollRow | undefined;
    return row ? this.#poll(row) : undefined;
  }

  /** Creates a time poll (group vote) or a pick list (organizer chooses) from suggested slots. */
  async createPoll(input: { shape: PlanShape; title?: string | null; organizerId: string | null; mode: PollMode; dates?: string[] | null; durationMin?: number | null; days?: number; slots?: Slot[] }): Promise<{ ok: true; poll: PollView; basis: { included: number; total: number; mode: string } } | { ok: false; error: string }> {
    const durationMin = Math.max(15, Math.min(12 * 60, input.durationMin ?? input.shape.minutes));
    let slots: Slot[] = input.slots?.filter((slot) => slot.end > slot.start && slot.start > this.#now()).slice(0, 5) ?? [];
    let basis = { included: 0, total: this.members().length, mode: this.calendarMode as string };
    if (!slots.length) {
      const found = await this.suggest(input.shape, { dates: input.dates, days: input.days, count: 3, durationMin });
      slots = found.slots;
      basis = { included: found.included, total: found.total, mode: found.mode };
    }
    if (!slots.length) return { ok: false, error: `I couldn’t find a ${durationLabel(durationMin)} window that works${input.dates?.length ? " then" : " in the next week"}. Try another day or a shorter time.` };
    const stamp = new Date(this.#now()).toISOString();
    const replaced = input.mode === "pick"
      ? this.#db.prepare("SELECT id FROM event_polls WHERE household_id = ? AND status = 'open' AND mode = 'pick' AND organizer_id IS ?").all(this.#store.household, input.organizerId) as Array<{ id: string }>
      : this.#db.prepare("SELECT id FROM event_polls WHERE household_id = ? AND status = 'open' AND mode = 'vote' AND kind = ?").all(this.#store.household, input.shape.kind) as Array<{ id: string }>;
    for (const row of replaced) this.#db.prepare("UPDATE event_polls SET status = 'replaced', closed_at = ? WHERE id = ?").run(stamp, row.id);
    const id = randomUUID();
    const title = (input.title?.trim() || input.shape.label).replace(/\s+/g, " ").slice(0, 60);
    this.#db.prepare("INSERT INTO event_polls (id, household_id, kind, title, emoji, duration_min, organizer_id, mode, options_json, status, everyone, attendee_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, '[]', ?)")
      .run(id, this.#store.household, input.shape.kind, title.charAt(0).toUpperCase() + title.slice(1), input.shape.emoji, durationMin, input.organizerId, input.mode, JSON.stringify(slots.map(({ start, end, busy }) => ({ start, end, busy: busy ?? [] }))), stamp);
    return { ok: true, poll: this.getPoll(id)!, basis };
  }

  /** Chat text for a new poll. */
  pollText(poll: PollView, basis?: { included: number; total: number; mode: string }): string {
    const options = poll.options.map((option) => `${option.index}) ${option.label}${option.busy.length ? ` (${option.busy.map((id) => this.memberName(id)).join(", ")} busy)` : ""}`);
    const note = basis && basis.mode === "google" && basis.included < basis.total ? `\n(Based on ${basis.included} of ${basis.total} calendars.)` : "";
    if (poll.mode === "pick") {
      return `${poll.emoji} ${poll.title} (${durationLabel(poll.durationMin)}) — everyone’s free:\n${options.join("\n")}\nReply ${poll.options.map((option) => option.index).join(", ").replace(/, (\d)$/, ", or $1")} to book.${note}`;
    }
    return `${poll.emoji} ${poll.title}! Vote: ${options.join(" ")}\nReply with every number that works (e.g. “1 3”).${note}`;
  }

  tallyLine(poll: PollView): string {
    return poll.options.map((option) => `${option.index}) ${option.yes.length}`).join(" · ");
  }

  /** Records a member's yes/no for options; auto-books when an option reaches a majority. */
  vote(pollId: string, memberId: string, vote: ParsedVote): { poll: PollView; booked: EventRecord | null } {
    const stamp = new Date(this.#now()).toISOString();
    const upsert = this.#db.prepare("INSERT INTO event_votes (poll_id, member_id, option, yes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(poll_id, member_id, option) DO UPDATE SET yes = excluded.yes, updated_at = excluded.updated_at");
    for (const option of vote.yes) upsert.run(pollId, memberId, option, 1, stamp);
    for (const option of vote.no) upsert.run(pollId, memberId, option, 0, stamp);
    const poll = this.getPoll(pollId)!;
    const winner = poll.options
      .filter((option) => option.yes.filter((id) => poll.attendeeIds.includes(id)).length >= poll.majority && option.start > this.#now())
      .sort((a, b) => b.yes.length - a.yes.length || a.no.length - b.no.length || a.start - b.start)[0];
    if (!winner || poll.mode !== "vote") return { poll, booked: null };
    const booked = this.book(pollId, winner.index, null);
    return { poll: this.getPoll(pollId)!, booked: booked.ok ? booked.event : null };
  }

  /** Books one option of a poll as an event (RSVPs follow the votes). */
  book(pollId: string, optionIndex: number, actorId: string | null): { ok: true; event: EventRecord } | { ok: false; error: string } {
    const poll = this.getPoll(pollId);
    if (!poll || poll.status !== "open") return { ok: false, error: "That plan is closed." };
    const option = poll.options.find((candidate) => candidate.index === optionIndex);
    if (!option) return { ok: false, error: `Pick a number from 1 to ${poll.options.length}.` };
    if (option.start <= this.#now()) return { ok: false, error: "That time has already started. Pick another." };
    const rsvps: Record<string, RsvpStatus> = {};
    for (const id of option.yes) rsvps[id] = "going";
    for (const id of option.no) rsvps[id] = "no";
    if (actorId && !rsvps[actorId]) rsvps[actorId] = "going";
    if (poll.organizerId && !rsvps[poll.organizerId] && poll.mode === "pick") rsvps[poll.organizerId] = "going";
    const created = this.create({
      title: poll.title,
      emoji: poll.emoji,
      kind: poll.kind,
      date: localDate(option.start, this.timeZone),
      startMin: localMinutes(option.start, this.timeZone),
      durationMin: Math.round((option.end - option.start) / 60_000),
    }, poll.organizerId ?? actorId, { pollId, rsvps });
    if (!created.ok) return created;
    this.#db.prepare("UPDATE event_polls SET status = 'booked', event_id = ?, closed_at = ? WHERE id = ?").run(created.event.id, new Date(this.#now()).toISOString(), pollId);
    return created;
  }

  cancelPoll(pollId: string): boolean {
    return Number(this.#db.prepare("UPDATE event_polls SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'open'").run(new Date(this.#now()).toISOString(), pollId).changes) > 0;
  }

  // --- Movie ideas -----------------------------------------------------------

  ideas(kind = "movie"): IdeaView[] {
    const rows = this.#db.prepare("SELECT id, title, added_by, created_at FROM event_ideas WHERE household_id = ? AND kind = ? ORDER BY created_at").all(this.#store.household, kind) as Array<{ id: string; title: string; added_by: string; created_at: string }>;
    const votes = this.#db.prepare("SELECT idea_id, member_id FROM event_idea_votes WHERE idea_id IN (SELECT id FROM event_ideas WHERE household_id = ? AND kind = ?)").all(this.#store.household, kind) as Array<{ idea_id: string; member_id: string }>;
    return rows.map((row) => ({ id: row.id, title: row.title, addedBy: row.added_by, votes: votes.filter((vote) => vote.idea_id === row.id).map((vote) => vote.member_id) }))
      .sort((a, b) => b.votes.length - a.votes.length);
  }

  addIdea(kind: string, title: string, memberId: string): { ok: true; idea: IdeaView; added: boolean } | { ok: false; error: string } {
    const clean = title.replace(/\s+/g, " ").trim().replace(/^["“']|["”']$/g, "").slice(0, 80);
    if (!clean) return { ok: false, error: "Which movie? e.g. “add movie Paddington 2”." };
    const existing = this.findIdea(kind, clean);
    if (existing && normalizeName(existing.title) === normalizeName(clean)) return { ok: true, idea: existing, added: false };
    const id = randomUUID();
    this.#db.prepare("INSERT INTO event_ideas (id, household_id, kind, title, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, this.#store.household, kind, clean, memberId, new Date(this.#now()).toISOString());
    this.voteIdea(id, memberId);
    return { ok: true, idea: this.ideas(kind).find((idea) => idea.id === id)!, added: true };
  }

  findIdea(kind: string, query: string): IdeaView | undefined {
    const wanted = normalizeName(query);
    if (!wanted) return undefined;
    const ideas = this.ideas(kind);
    return ideas.find((idea) => normalizeName(idea.title) === wanted)
      ?? (ideas.filter((idea) => normalizeName(idea.title).startsWith(wanted)).length === 1 ? ideas.find((idea) => normalizeName(idea.title).startsWith(wanted)) : undefined);
  }

  /** One vote per member per kind: voting for a title moves the member's vote there. */
  voteIdea(ideaId: string, memberId: string): void {
    const kind = (this.#db.prepare("SELECT kind FROM event_ideas WHERE id = ?").get(ideaId) as { kind: string } | undefined)?.kind;
    if (!kind) return;
    this.#db.prepare("DELETE FROM event_idea_votes WHERE member_id = ? AND idea_id IN (SELECT id FROM event_ideas WHERE household_id = ? AND kind = ?)").run(memberId, this.#store.household, kind);
    this.#db.prepare("INSERT OR IGNORE INTO event_idea_votes (idea_id, member_id, created_at) VALUES (?, ?, ?)").run(ideaId, memberId, new Date(this.#now()).toISOString());
  }

  removeIdea(ideaId: string): boolean {
    this.#db.prepare("DELETE FROM event_idea_votes WHERE idea_id = ?").run(ideaId);
    return Number(this.#db.prepare("DELETE FROM event_ideas WHERE id = ? AND household_id = ?").run(ideaId, this.#store.household).changes) > 0;
  }

  ideasLine(kind = "movie"): string {
    const ideas = this.ideas(kind);
    if (!ideas.length) return "No movie ideas yet. Add one with “add movie <title>”.";
    return `🍿 Movie ideas: ${ideas.slice(0, 6).map((idea) => `${idea.title}${idea.votes.length ? ` (${idea.votes.length})` : ""}`).join(" · ")}\nVote with “vote <title>”.`;
  }

  // --- Reminders -------------------------------------------------------------

  /**
   * Sends day-before and hour-before reminders. Each (event, occurrence, kind) is
   * claimed in event_reminders first, so a reminder is sent at most once even
   * across restarts. Reminders that would arrive right after the event was
   * created (or together with a closer reminder) are recorded without sending.
   */
  async runReminders(): Promise<string[]> {
    const now = this.#now();
    this.openPolls();
    const sent: string[] = [];
    const today = this.today();
    for (const occurrence of this.occurrences(now, now + 26 * 3_600_000 + DAY_MS)) {
      if (occurrence.start <= now) continue;
      const event = this.getEvent(occurrence.eventId);
      if (!event) continue;
      const createdAt = Date.parse(event.createdAt);
      const dayAt = occurrence.allDay ? zonedTimeToEpoch(addDays(occurrence.date, -1), 18 * 60, this.timeZone) : occurrence.start - DAY_MS;
      const hourAt = occurrence.allDay ? null : occurrence.start - 3_600_000;
      const hourDue = hourAt !== null && now >= hourAt;
      const dayDue = now >= dayAt;
      if (hourDue) {
        const silent = createdAt > hourAt!;
        if (this.#claim(event.id, occurrence.date, "hour", !silent) && !silent) {
          const text = `⏰ In 1 hour: ${event.emoji} ${event.title} (${formatClock(occurrence.start, this.timeZone)})${this.#goingNote(event)}`;
          await this.#notify(text);
          sent.push(text);
        }
        this.#claim(event.id, occurrence.date, "day", false);
      } else if (dayDue) {
        const silent = createdAt > dayAt;
        if (this.#claim(event.id, occurrence.date, "day", !silent) && !silent) {
          const when = occurrence.allDay ? "" : ` · ${formatClock(occurrence.start, this.timeZone)}`;
          const label = daysBetween(today, occurrence.date) === 0 ? "Today" : "Tomorrow";
          const tasks = this.taskLine(event.id);
          const text = `⏰ ${label}: ${event.emoji} ${event.title}${when}${this.#goingNote(event)}${tasks ? `\n${tasks}` : ""}`;
          await this.#notify(text);
          sent.push(text);
        }
      }
    }
    return sent;
  }

  #goingNote(event: EventRecord): string {
    if (event.kind === "house") return "";
    const going = Object.values(this.rsvps(event.id)).filter((status) => status === "going").length;
    return going ? ` · ${going} going` : "";
  }

  /** Inserts the reminder marker; true only for the first claim. */
  #claim(eventId: string, occurrence: string, kind: "day" | "hour", sent: boolean): boolean {
    return Number(this.#db.prepare("INSERT OR IGNORE INTO event_reminders (event_id, occurrence, kind, sent, at) VALUES (?, ?, ?, ?, ?)")
      .run(eventId, occurrence, kind, sent ? 1 : 0, new Date(this.#now()).toISOString()).changes) > 0;
  }
}

export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
