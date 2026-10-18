// Sample calendars for the /calendar page when Google OAuth is not configured
// (or a member has not connected Google):
//   - demoEvents(): deterministic titled schedules. The same member + week always
//     produces the same events ("Lecture", "Gym", "Work shift", ...).
//   - DemoCalendarFile: GROUP_CART_DEMO_CALENDAR, a local JSON file whose events
//     replace the generated schedule for members with a matching name.
import { readFileSync, statSync } from "node:fs";
import { addDays, dayOfWeek, isDateString, isValidTimeZone, zonedTimeToEpoch, type Interval } from "./availability.js";
import { busyFromItems, cleanLocation, cleanText, MAX_TITLE_LENGTH, overlapsWindow, sortItems, type CalendarItem } from "./calendarItems.js";

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minutes after local midnight, a title, and optional place / "show as available". */
type Entry = { start: number; end: number; title: string; location?: string; free?: boolean };
type Persona = (weekday: number, random: () => number) => Entry[];

const h = (hours: number) => Math.round(hours * 60);
/** Random offset in 15-minute steps between -steps and +steps. */
const jitter = (random: () => number, steps: number) => (Math.floor(random() * (steps * 2 + 1)) - steps) * 15;
const pick = <T>(random: () => number, options: readonly T[]): T => options[Math.floor(random() * options.length)]!;
const entry = (start: number, end: number, title: string, extra: Partial<Entry> = {}): Entry => ({ start, end, title, ...extra });

// weekday: 0 = Sunday ... 6 = Saturday
const personas: Persona[] = [
  // Office job with a lunch gap, an early gym session, evening plans, and a Saturday market.
  (weekday, random) => {
    if (weekday === 0) return random() < 0.5 ? [entry(h(14) + jitter(random, 2), h(16), pick(random, ["Call with family", "Brunch with friends", "Grocery run"]))] : [];
    if (weekday === 6) {
      const blocks: Entry[] = [];
      if (random() < 0.6) blocks.push(entry(h(10), h(11.5) + jitter(random, 2), "Farmers market", { location: "Market square", free: true }));
      if (random() < 0.4) blocks.push(entry(h(18.5), h(20.5), "Dinner with friends"));
      return blocks;
    }
    const blocks: Entry[] = [
      entry(h(9) + jitter(random, 2), h(12), "Work", { location: "Office" }),
      entry(h(13), h(17.5) + jitter(random, 2), weekday === 2 || weekday === 4 ? "Meetings" : "Work", { location: "Office" }),
    ];
    if (random() < 0.4) blocks.push(entry(h(18.5), h(20) + jitter(random, 2), pick(random, ["Dinner with friends", "Climbing", "Book club", "Movie night"])));
    if (random() < 0.3) blocks.push(entry(h(7.5), h(8.25), "Gym", { location: "Rec center" }));
    return blocks;
  },
  // Student: lectures and labs, evening study group, weekend practice and brunch.
  (weekday, random) => {
    if (weekday === 0) return random() < 0.5 ? [entry(h(11), h(12.5), "Brunch")] : [];
    if (weekday === 6) return random() < 0.5 ? [entry(h(13) + jitter(random, 2), h(15), "Practice", { location: "Field 2" })] : [];
    const blocks: Entry[] = [];
    const classes: Array<[number, string, string]> = weekday % 2 === 1
      ? [[8.5, "Lecture", "Hall 120"], [11, "Calculus", "Math 204"], [14, "Lab", "Science 3"]]
      : [[10, "Seminar", "Hall 120"], [13.5, "Lab", "Science 3"]];
    for (const [start, title, location] of classes) {
      if (random() < 0.85) blocks.push(entry(h(start) + jitter(random, 1), h(start + 1.25 + Math.floor(random() * 3) * 0.25), title, { location }));
    }
    if (weekday === 3 && random() < 0.6) blocks.push(entry(h(15.5), h(16.5), "Office hours (optional)", { location: "Math 204", free: true }));
    if (random() < 0.45) blocks.push(entry(h(19), h(21), "Study group", { location: "Library, 3rd floor" }));
    return blocks;
  },
  // Shift worker: alternating early/late shifts, two days off with the gym.
  (weekday, random) => {
    if (weekday === 3 || weekday === 0) {
      const blocks: Entry[] = random() < 0.7 ? [entry(h(9), h(10.5), "Gym", { location: "Rec center" })] : [];
      if (weekday === 0 && random() < 0.4) blocks.push(entry(h(17), h(19), "Dinner with friends"));
      return blocks;
    }
    if (weekday === 1 || weekday === 4) return [entry(h(7), h(15) + jitter(random, 1), "Work shift", { location: "Café" })];
    if (weekday === 6) return [entry(h(11), h(19), "Work shift", { location: "Café" })];
    return [entry(h(14) + jitter(random, 1), h(22), "Closing shift", { location: "Café" })];
  },
  // Hybrid worker: meetings in blocks, focus time, an evening class.
  (weekday, random) => {
    if (weekday === 0 || weekday === 6) return random() < 0.4 ? [entry(h(16), h(18), pick(random, ["Hike", "Soccer game", "Dinner with friends"]))] : [];
    const blocks: Entry[] = [entry(h(8.5), h(10) + jitter(random, 1), "Team meeting"), entry(h(10.5) + jitter(random, 1), h(12), "Focus time")];
    if (random() < 0.7) blocks.push(entry(h(14), h(16) + jitter(random, 2), pick(random, ["Client call", "Design review", "1:1 with manager"])));
    if (random() < 0.3) blocks.push(entry(h(17.5), h(19), "Yoga", { location: "Yoga studio" }));
    return blocks;
  },
];

/** Titled sample events for one member and week (Monday `weekStart`), in `timeZone`. */
export function demoEvents(memberKey: string, memberIndex: number, weekStart: string, timeZone: string): CalendarItem[] {
  const persona = personas[memberIndex % personas.length]!;
  const random = seededRandom(hashSeed(`${weekStart}|${memberKey}|${memberIndex}`));
  const items: CalendarItem[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    for (const block of persona(dayOfWeek(date), random)) {
      if (block.end <= block.start) continue;
      const item: CalendarItem = { start: zonedTimeToEpoch(date, block.start, timeZone), end: zonedTimeToEpoch(date, block.end, timeZone), title: block.title };
      if (block.location) item.location = block.location;
      if (block.free) item.free = true;
      items.push(item);
    }
  }
  return sortItems(items);
}

/** Busy blocks of the sample schedule ("show as available" events excluded). */
export function demoBusyBlocks(memberKey: string, memberIndex: number, weekStart: string, timeZone: string): Interval[] {
  return busyFromItems(demoEvents(memberKey, memberIndex, weekStart, timeZone));
}

// ---------------------------------------------------------------------------
// GROUP_CART_DEMO_CALENDAR: a local showcase file
//   { "timeZone": "America/Los_Angeles",
//     "members": { "<member name>": [ { "title", "start", "end", "location"? }, ... ] } }
// start/end are ISO datetimes (with an offset, or wall-clock time in `timeZone`) or
// YYYY-MM-DD dates for all-day events. "free": true (or "transparency": "transparent")
// marks an event as "show as available". Member names match case-insensitively.

export type DemoCalendar = { timeZone: string; members: Map<string, CalendarItem[]> };

const MAX_FILE_BYTES = 2_000_000;
const MAX_EVENTS_PER_MEMBER = 5_000;

export function memberNameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** "2026-10-12T10:00:00-07:00" (absolute) or "2026-10-12T10:00" (wall clock in `timeZone`) or "2026-10-12" (date). */
function parseFileTime(value: unknown, timeZone: string): { at: number; date: string | null } | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (isDateString(text)) return { at: zonedTimeToEpoch(text, 0, timeZone), date: text };
  const wall = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(text);
  if (wall && isDateString(wall[1]!)) {
    const minutes = Number(wall[2]) * 60 + Number(wall[3]);
    return minutes < 24 * 60 ? { at: zonedTimeToEpoch(wall[1]!, minutes, timeZone) + Number(wall[4] ?? 0) * 1000, date: null } : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? { at, date: null } : null;
}

/** Validates and normalizes a demo calendar document. Throws on a malformed document; skips malformed events. */
export function parseDemoCalendar(document: unknown, fallbackTimeZone: string): DemoCalendar {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("expected a JSON object");
  const raw = document as { timeZone?: unknown; members?: unknown };
  const timeZone = typeof raw.timeZone === "string" && isValidTimeZone(raw.timeZone) ? raw.timeZone : fallbackTimeZone;
  if (!raw.members || typeof raw.members !== "object" || Array.isArray(raw.members)) throw new Error("expected a \"members\" object");
  const members = new Map<string, CalendarItem[]>();
  for (const [name, list] of Object.entries(raw.members as Record<string, unknown>)) {
    const key = memberNameKey(name);
    if (!key || !Array.isArray(list)) continue;
    const items = members.get(key) ?? [];
    for (const value of list.slice(0, MAX_EVENTS_PER_MEMBER)) {
      if (!value || typeof value !== "object") continue;
      const event = value as Record<string, unknown>;
      const start = parseFileTime(event.start, timeZone);
      let end = parseFileTime(event.end ?? (start?.date ? addDays(start.date, 1) : undefined), timeZone);
      if (!start || !end) continue;
      const allDay = Boolean(start.date && end.date);
      if (allDay && end.at <= start.at) end = { at: zonedTimeToEpoch(addDays(start.date!, 1), 0, timeZone), date: addDays(start.date!, 1) };
      if (end.at <= start.at) continue;
      const item: CalendarItem = { start: start.at, end: end.at, title: cleanText(event.title ?? event.summary, MAX_TITLE_LENGTH) || "(No title)" };
      const location = cleanLocation(event.location);
      if (location) item.location = location;
      if (event.free === true || event.transparency === "transparent" || event.showAs === "free") item.free = true;
      if (allDay) item.allDay = true;
      items.push(item);
    }
    members.set(key, sortItems(items));
  }
  return { timeZone, members };
}

/** Entries for `memberName` in `window`, or null when the file has no calendar for that name. */
export function demoCalendarEvents(calendar: DemoCalendar | null, memberName: string, window: Interval): CalendarItem[] | null {
  const items = calendar?.members.get(memberNameKey(memberName));
  return items ? items.filter((item) => overlapsWindow(item, window)) : null;
}

/** Reads GROUP_CART_DEMO_CALENDAR lazily and again whenever the file changes. Never logs its contents. */
export class DemoCalendarFile {
  #cache: { stamp: string; calendar: DemoCalendar | null } | null = null;
  #warned = "";

  constructor(readonly path: string, private readonly fallbackTimeZone: () => string) {}

  get(): DemoCalendar | null {
    let stamp: string;
    try {
      const stats = statSync(this.path);
      if (stats.size > MAX_FILE_BYTES) return this.#fail(`${stats.mtimeMs}:${stats.size}`, "the file is larger than 2 MB");
      stamp = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      return this.#fail("missing", "the file was not found");
    }
    if (this.#cache?.stamp === stamp) return this.#cache.calendar;
    try {
      const calendar = parseDemoCalendar(JSON.parse(readFileSync(this.path, "utf8")), this.fallbackTimeZone());
      this.#cache = { stamp, calendar };
      return calendar;
    } catch (error) {
      return this.#fail(stamp, error instanceof SyntaxError ? "it is not valid JSON" : error instanceof Error ? error.message : "it could not be read");
    }
  }

  #fail(stamp: string, reason: string): null {
    this.#cache = { stamp, calendar: null };
    if (this.#warned !== stamp) {
      this.#warned = stamp;
      console.warn(`GROUP_CART_DEMO_CALENDAR is ignored: ${reason}.`);
    }
    return null;
  }
}
