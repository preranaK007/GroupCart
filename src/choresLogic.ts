// Pure chore logic: schedules, fair rotation, command parsing, and reply phrasing.
// No I/O and no clocks: every function takes explicit dates ("YYYY-MM-DD" in the
// household's time zone) so it can be checked with hand-made cases.
import { addDays, dayOfWeek, isDateString } from "./availability.js";

// ---------------------------------------------------------------------------
// Schedules

/**
 * weekly: on `weekday` (0 = Sunday) every `everyWeeks` weeks, aligned to `anchor` (a date on that weekday).
 * monthly: on `day` of each month; days past the month's end (e.g. 31 in November) fall on its last day.
 * once: a single due date.
 */
export type Schedule =
  | { kind: "weekly"; weekday: number; everyWeeks: number; anchor: string }
  | { kind: "monthly"; day: number }
  | { kind: "once"; date: string };

/** A schedule as people describe it (no anchor yet). */
export type ScheduleInput =
  | { kind: "weekly"; weekday: number; everyWeeks?: number }
  | { kind: "monthly"; day: number }
  | { kind: "once"; date: string };

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function parts(date: string): [number, number, number] {
  return date.split("-").map(Number) as [number, number, number];
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Turns a described schedule into a stored one, starting from `today`. */
export function buildSchedule(input: ScheduleInput, today: string): Schedule {
  if (input.kind === "once") return { kind: "once", date: input.date };
  if (input.kind === "monthly") return { kind: "monthly", day: Math.min(31, Math.max(1, Math.round(input.day))) };
  const weekday = ((Math.round(input.weekday) % 7) + 7) % 7;
  const everyWeeks = Math.min(8, Math.max(1, Math.round(input.everyWeeks ?? 1)));
  const anchor = addDays(today, (weekday - dayOfWeek(today) + 7) % 7);
  return { kind: "weekly", weekday, everyWeeks, anchor };
}

/** The first due date on or after `date` (a one-off always returns its date). */
export function firstDueOnOrAfter(schedule: Schedule, date: string): string {
  if (schedule.kind === "once") return schedule.date;
  if (schedule.kind === "monthly") {
    const [year, month] = parts(date);
    const inMonth = ymd(year, month, Math.min(schedule.day, daysInMonth(year, month)));
    if (inMonth >= date) return inMonth;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return ymd(nextYear, nextMonth, Math.min(schedule.day, daysInMonth(nextYear, nextMonth)));
  }
  let candidate = addDays(date, (schedule.weekday - dayOfWeek(date) + 7) % 7);
  const every = Math.max(1, Math.round(schedule.everyWeeks));
  if (every > 1) {
    const weeks = Math.round(daysBetween(schedule.anchor, candidate) / 7);
    const offset = ((weeks % every) + every) % every;
    if (offset) candidate = addDays(candidate, (every - offset) * 7);
  }
  return candidate;
}

/**
 * Next due date once the occurrence due on `due` is done on `doneOn`. Doing it early
 * still counts for that occurrence; doing it late skips the occurrences that passed.
 * One-offs have no next date.
 */
export function nextDueAfterCompletion(schedule: Schedule, due: string, doneOn: string): string | null {
  if (schedule.kind === "once") return null;
  return firstDueOnOrAfter(schedule, addDays(due > doneOn ? due : doneOn, 1));
}

/**
 * The due date of the occurrence before `due` (null for one-offs). An occurrence can be
 * completed only after this date, so doing a chore twice never eats into the next cycle.
 */
export function previousDue(schedule: Schedule, due: string): string | null {
  if (schedule.kind === "once") return null;
  if (schedule.kind === "weekly") return addDays(due, -7 * Math.max(1, Math.round(schedule.everyWeeks)));
  const [year, month] = parts(due);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return ymd(prevYear, prevMonth, Math.min(schedule.day, daysInMonth(prevYear, prevMonth)));
}

/** Due dates in [from, to], at most `limit`. */
export function occurrencesBetween(schedule: Schedule, from: string, to: string, limit = 64): string[] {
  const dates: string[] = [];
  let date = firstDueOnOrAfter(schedule, from);
  while (date >= from && date <= to && dates.length < limit) {
    dates.push(date);
    if (schedule.kind === "once") break;
    date = firstDueOnOrAfter(schedule, addDays(date, 1));
  }
  return dates;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`;
}

/** "Every Sunday", "Every other Wednesday", "Monthly on the 15th", "Monthly, last day", "One-off". */
export function scheduleLabel(schedule: Schedule): string {
  if (schedule.kind === "once") return "One-off";
  if (schedule.kind === "monthly") return schedule.day >= 31 ? "Monthly, last day" : `Monthly on the ${ordinal(schedule.day)}`;
  const day = WEEKDAY_NAMES[schedule.weekday] ?? "Sunday";
  if (schedule.everyWeeks <= 1) return `Every ${day}`;
  if (schedule.everyWeeks === 2) return `Every other ${day}`;
  return `Every ${schedule.everyWeeks} weeks on ${day}`;
}

/** "Sat, Oct 24". */
export function shortDate(date: string): string {
  const [, month, day] = parts(date);
  return `${SHORT_WEEKDAYS[dayOfWeek(date)]}, ${SHORT_MONTHS[month - 1]} ${day}`;
}

/** "Oct 24". */
export function monthDay(date: string): string {
  const [, month, day] = parts(date);
  return `${SHORT_MONTHS[month - 1]} ${day}`;
}

/** Relative due label: "today", "tomorrow", "yesterday", "Sun" (within a week), or "Sat, Oct 24". */
export function dueLabel(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff > 1 && diff < 7) return SHORT_WEEKDAYS[dayOfWeek(date)]!;
  return shortDate(date);
}

/** "1 day", "5 days", "2 weeks", "3 months". */
export function durationPhrase(days: number): string {
  const value = Math.max(1, Math.floor(days));
  if (value >= 60) { const months = Math.floor(value / 30); return `${months} month${months === 1 ? "" : "s"}`; }
  if (value >= 7) { const weeks = Math.floor(value / 7); return `${weeks} week${weeks === 1 ? "" : "s"}`; }
  return `${value} day${value === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Fair rotation

/** Per-member history for one chore: when they last did it (epoch ms) and how many times. */
export type MemberStats = { last: number | null; count: number };

/**
 * Orders candidates by fairness: whoever has gone longest without doing the chore first
 * (never done = longest), then fewest completions, then the candidates' own order.
 */
export function fairOrder(candidates: readonly string[], stats: ReadonlyMap<string, MemberStats>): string[] {
  return candidates
    .map((id, index) => ({ id, index, stat: stats.get(id) ?? { last: null, count: 0 } }))
    .sort((a, b) => {
      if (a.stat.last !== b.stat.last) {
        if (a.stat.last === null) return -1;
        if (b.stat.last === null) return 1;
        return a.stat.last - b.stat.last;
      }
      return a.stat.count - b.stat.count || a.index - b.index;
    })
    .map((entry) => entry.id);
}

/**
 * Who is responsible for the open occurrence. Unavailable (away) members are never
 * chosen. A skip/swap override wins while that person is available; otherwise the
 * fairest available member who has not skipped this occurrence.
 */
export function pickAssignee(options: {
  pool: readonly string[];
  stats: ReadonlyMap<string, MemberStats>;
  unavailable: ReadonlySet<string>;
  skipped?: readonly string[];
  override?: string | null;
}): string | null {
  const available = options.pool.filter((id) => !options.unavailable.has(id));
  if (options.override && available.includes(options.override)) return options.override;
  const skipped = new Set(options.skipped ?? []);
  const fresh = available.filter((id) => !skipped.has(id));
  return fairOrder(fresh.length ? fresh : available, options.stats)[0] ?? null;
}

/**
 * Projects who does each upcoming occurrence: `first` takes dates[0], then each later
 * date goes to the fairest member available that day, as if everyone did their turn.
 */
export function projectRotation(options: {
  first: string | null;
  dates: readonly string[];
  pool: readonly string[];
  stats: ReadonlyMap<string, MemberStats>;
  isUnavailable: (memberId: string, date: string) => boolean;
}): Array<string | null> {
  const stats = new Map(options.stats);
  return options.dates.map((date, index) => {
    const who = index === 0
      ? options.first
      : fairOrder(options.pool.filter((id) => !options.isUnavailable(id, date)), stats)[0] ?? null;
    if (who) {
      const previous = stats.get(who) ?? { last: null, count: 0 };
      stats.set(who, { last: Date.parse(`${date}T12:00:00Z`), count: previous.count + 1 });
    }
    return who;
  });
}

// ---------------------------------------------------------------------------
// Matching chore names ("done dishes", "I took out the trash")

const STOP_WORDS = new Set([
  "the", "a", "an", "my", "our", "your", "to", "out", "up", "of", "for", "with", "and", "it", "i", "im", "just",
  "all", "done", "did", "do", "finished", "finish", "complete", "completed", "this", "that", "week", "today",
  "again", "already", "mark", "marked", "as", "turn", "chore", "chores", "is", "are", "was", "have", "has", "ive",
]);

const IRREGULAR: Record<string, string> = {
  took: "take", taken: "take", swept: "sweep", threw: "throw", thrown: "throw", fed: "feed", made: "make",
  emptied: "empty", tidied: "tidy", dishes: "dish", ran: "run", bought: "buy", paid: "pay", hung: "hang",
};

export function stem(word: string): string {
  let w = word.toLowerCase();
  if (IRREGULAR[w]) w = IRREGULAR[w]!;
  else if (w.length > 4 && /ie[sd]$/.test(w)) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && /(sh|ch|x|ss|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|ff|zz)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const EMOJI_SEQUENCE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;

export function stripEmoji(text: string): string {
  return text.replace(EMOJI_SEQUENCE, " ").replace(/️/g, "").replace(/\s+/g, " ").trim();
}

export function firstEmoji(text: string): string | null {
  return text.match(EMOJI_SEQUENCE)?.[0] ?? null;
}

function contentTokens(text: string): string[] {
  return stripEmoji(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((token) => token && !STOP_WORDS.has(token)).map(stem);
}

/** Optimal-string-alignment edit distance (adjacent swaps count as one edit). */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (shorter >= 4) return editDistance(a, b) <= (shorter >= 7 ? 2 : 1);
  return false;
}

/** Finds the chore a phrase refers to: exact name, emoji, or best token overlap (stemmed, typo-tolerant). */
export function matchChore<T extends { name: string; emoji: string }>(query: string, chores: readonly T[]): { match: T } | { ambiguous: T[] } | null {
  if (!chores.length) return null;
  const plain = stripEmoji(query).toLowerCase().replace(/^the\s+/, "").trim();
  const exact = chores.filter((chore) => chore.name.toLowerCase() === plain);
  if (exact.length === 1) return { match: exact[0]! };
  const emoji = firstEmoji(query);
  if (emoji) {
    const byEmoji = chores.filter((chore) => chore.emoji.replace(/️/g, "") === emoji.replace(/️/g, ""));
    if (byEmoji.length === 1) return { match: byEmoji[0]! };
  }
  const queryTokens = contentTokens(query);
  if (!queryTokens.length) return null;
  const scored = chores.map((chore) => {
    const nameTokens = contentTokens(chore.name);
    const hits = nameTokens.filter((token) => queryTokens.some((candidate) => tokensMatch(candidate, token))).length;
    return { chore, hits, score: nameTokens.length ? (2 * hits) / (nameTokens.length + queryTokens.length) : 0 };
  }).filter((entry) => entry.hits > 0 && entry.score >= 0.4).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const top = scored.filter((entry) => Math.abs(entry.score - scored[0]!.score) < 1e-9);
  return top.length === 1 ? { match: top[0]!.chore } : { ambiguous: top.map((entry) => entry.chore) };
}

/** Keyword → emoji rules (also sent to the browser for the live preview in the Add dialog). */
export const EMOJI_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/dish|plate|dishwasher/, "🍽️"], [/recycl/, "♻️"], [/trash|garbage|bins?\b|rubbish|compost/, "🗑️"],
  [/vacuum|sweep|broom|hoover/, "🧹"], [/mop|floor|scrub|wipe|counter/, "🧽"],
  [/bath|toilet|shower|tub|sink/, "🛁"], [/plant|garden|water/, "🪴"], [/laundry|clothes|towel|wash/, "🧺"],
  [/fridge|freezer/, "🧊"], [/kitchen|stove|oven|cook|dinner|meal/, "🍳"], [/grocer|shop/, "🛒"],
  [/lamp|bulb|light/, "💡"], [/fix|repair/, "🔧"], [/dog|cat|pet|litter|feed/, "🐾"], [/window|glass/, "🪟"],
  [/sheet|bed\b|bedding|linen/, "🛏️"], [/dust/, "🪶"], [/rent|bill|pay/, "💸"], [/car\b/, "🚗"], [/mail|package/, "📬"], [/kettle|coffee/, "☕"], [/towels?\b|iron/, "👕"],
];

/** Picks a fitting emoji for a chore name. */
export function guessEmoji(name: string): string {
  const text = name.toLowerCase();
  return EMOJI_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? "✨";
}

// ---------------------------------------------------------------------------
// Dates people type ("Friday", "Oct 30", "10/30", "tomorrow", "in 2 weeks")

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAY_BASE = "(sun|mon|tue|tues|wed|wednes|weds|thu|thur|thurs|fri|sat|satur)";
/** One weekday ("sun", "Tues", "wednesday"); always use with word boundaries ("fri" must not match "fridge"). */
const WEEKDAY_PATTERN = `${WEEKDAY_BASE}(?:s?day)?`;
/** Plural weekday ("Tuesdays") means a weekly chore. */
const WEEKDAY_PLURAL = `${WEEKDAY_BASE}s?days`;
const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, wednes: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6, satur: 6 };
const NUMBER_WORDS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function weekdayIndex(word: string): number | null {
  const match = new RegExp(`^${WEEKDAY_PATTERN}$`, "i").exec(word.trim().replace(/s$/i, ""));
  return match ? WEEKDAY_INDEX[match[1]!.toLowerCase()] ?? null : null;
}

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return ymd(year, month, day);
}

/**
 * Parses a day phrase relative to `today`. Month/day without a year means the next such
 * date. With `after: true` the result must be later than today (e.g. "away until Friday"
 * on a Friday means next Friday); otherwise today counts.
 */
export function parseDay(raw: string, today: string, options: { after?: boolean } = {}): string | null {
  const text = raw.toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(?:on|by|until|till|til|thru|through|due|before|the)\s+/, "").replace(/^the\s+/, "").trim();
  if (!text) return null;
  const [ty, tm] = parts(today);
  const minimum = options.after ? addDays(today, 1) : today;
  const upcoming = (date: string | null) => (date && date >= minimum ? date : null);
  if (text === "today" || text === "tonight") return upcoming(today);
  if (/^(?:tomorrow|tmrw|tmr|tomorow)$/.test(text)) return addDays(today, 1);
  if (text === "day after tomorrow") return addDays(today, 2);
  let match = /^in\s+(\d+|[a-z]+)\s+(day|week)s?$/.exec(text);
  if (match) {
    const count = /^\d+$/.test(match[1]!) ? Number(match[1]) : NUMBER_WORDS[match[1]!];
    if (!count || count > 400) return null;
    return upcoming(addDays(today, count * (match[2] === "week" ? 7 : 1)));
  }
  if (text === "next week") return addDays(today, 7 - ((dayOfWeek(today) + 6) % 7));
  if (/^(?:the\s+)?(?:end of (?:the )?week|this weekend|weekend)$/.test(text)) {
    const target = /weekend/.test(text) ? 6 : 0;
    return upcoming(addDays(today, (target - dayOfWeek(today) + 7) % 7));
  }
  if (/^(?:the\s+)?end of (?:the )?month$/.test(text)) return upcoming(ymd(ty, tm, daysInMonth(ty, tm)));
  match = new RegExp(`^(?:(?:this|next|coming)\\s+)?${WEEKDAY_PATTERN}$`).exec(text);
  if (match) {
    const target = WEEKDAY_INDEX[match[1]!]!;
    let date = addDays(today, (target - dayOfWeek(today) + 7) % 7);
    if (date < minimum) date = addDays(date, 7);
    return date;
  }
  if (isDateString(text)) return upcoming(text);
  match = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(text);
  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  if (match) {
    month = Number(match[1]); day = Number(match[2]);
    if (match[3]) year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  } else {
    match = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/.exec(text) ?? null;
    if (match && MONTH_INDEX[match[1]!]) {
      month = MONTH_INDEX[match[1]!]; day = Number(match[2]); if (match[3]) year = Number(match[3]);
    } else {
      match = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)(?:\s+(\d{4}))?$/.exec(text);
      if (match && MONTH_INDEX[match[2]!]) { month = MONTH_INDEX[match[2]!]; day = Number(match[1]); if (match[3]) year = Number(match[3]); }
    }
  }
  if (month === undefined || day === undefined) return null;
  if (year !== undefined) return upcoming(validDate(year, month, day));
  const thisYear = validDate(ty, month, day);
  if (thisYear && thisYear >= minimum) return thisYear;
  return validDate(ty + 1, month, day);
}

// ---------------------------------------------------------------------------
// Group-chat commands

export type ChoreCommand =
  | { type: "list" }
  | { type: "mine" }
  | { type: "add"; spec: string }
  | { type: "done"; query: string; explicit: boolean }
  | { type: "skip"; query: string; explicit: boolean }
  | { type: "swap"; query: string; who: string }
  | { type: "away"; when: string | null }
  | { type: "back" };

export function normalizeMessage(raw: string): string {
  return raw.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
}

/**
 * Recognizes chore commands. `explicit` commands ("done dishes", "I did the dishes",
 * "skip dishes") always get a reply. Implicit ones ("dishes done", "finished the dishes",
 * "I vacuumed", "pass on dishes") only count when they name an existing chore, so grocery
 * messages such as "finished the milk" fall through to the cart.
 */
export function parseChoreCommand(raw: string): ChoreCommand | null {
  const text = normalizeMessage(raw);
  if (!text) return null;
  let match = /^(?:please\s+)?(?:add|new|create)\s+(?:a\s+)?chores?\b\s*[:\-–]?\s*(.*)$/i.exec(text);
  if (match) return { type: "add", spec: match[1]!.trim() };
  if (/^(?:chores|chore|chore list|list chores|the chores|show chores|chores this week|this week'?s chores|what chores|what are the chores|whose turn(?: is it)?|who'?s up)$/i.test(text)) return { type: "list" };
  if (/^(?:my chores?|my turns?|what are my chores|what'?s my chore|what do i have to do)$/i.test(text)) return { type: "mine" };
  match = /^(?:swap|switch|trade)\s+(?:the\s+)?(.+?)\s+with\s+(.+)$/i.exec(text);
  if (match) return { type: "swap", query: match[1]!, who: match[2]! };
  match = /^(skip|pass(?:\s+on)?)\s+(?:my\s+turn\s+(?:on|for)\s+)?(?:the\s+)?(.+?)(?:\s+(?:this\s+(?:week|time)|today|for now))?$/i.exec(text);
  if (match) return { type: "skip", query: match[2]!, explicit: match[1]!.toLowerCase() === "skip" };
  match = /^(?:i'?m\s+|i\s+am\s+|i'?ll\s+be\s+|i\s+will\s+be\s+)?(?:away|out(?:\s+of\s+town)?|gone|traveling|travelling|on\s+vacation|on\s+a\s+trip)\s+(?:until|till|til|thru|through)\s+(.+)$/i.exec(text);
  if (match) return { type: "away", when: match[1]! };
  if (/^(?:i'?m\s+|i\s+am\s+)?away$/i.test(text)) return { type: "away", when: null };
  if (/^(?:(?:i'?m|i\s+am)\s+(?:back|home)|back)(?:\s+(?:now|again|early|home))?$/i.test(text)) return { type: "back" };
  match = /^(?:i'?m\s+|i\s+am\s+|i\s+)?(?:just\s+)?(?:done\s+(?:with\s+)?|completed\s+)(.+)$/i.exec(text)
    ?? /^i\s+(?:just\s+|already\s+)?did\s+(.+)$/i.exec(text)
    ?? /^mark(?:ed)?\s+(.+?)\s+(?:as\s+)?(?:done|complete)$/i.exec(text);
  if (match) return { type: "done", query: match[1]!, explicit: true };
  match = /^(?:did|finished)\s+(.+)$/i.exec(text)
    ?? /^(?:the\s+)?(.+?)\s+(?:is\s+|are\s+)?(?:all\s+)?(?:done|finished|completed?)$/i.exec(text)
    ?? /^i\s+(?:just\s+|already\s+)?((?:[a-z]+ed|took|swept|threw|fed|emptied|tidied)\b.*)$/i.exec(text);
  if (match) return { type: "done", query: match[1]!, explicit: false };
  return null;
}

export type AddSpec =
  | { ok: true; name: string; emoji: string | null; schedule: ScheduleInput; poolNames: string[] }
  | { ok: false; reason: "empty" | "no_name" | "no_schedule" | "daily" | "past_date" };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses the part after "add chore": a name plus a schedule, and optionally who is in the
 * rotation ("for Maya and Jordan"). Examples: "vacuum every Sunday", "take out trash weekly
 * on Tuesday", "deep clean fridge monthly", "fix lamp by Friday", "plants every 2 weeks on Wed".
 * Weekly without a day means Sunday; monthly without a day means the last day of the month.
 */
export function parseAddSpec(spec: string, today: string, memberNames: readonly string[] = []): AddSpec {
  let text = ` ${normalizeMessage(spec)} `;
  if (!text.trim()) return { ok: false, reason: "empty" };
  const emoji = firstEmoji(text);
  text = ` ${stripEmoji(text)} `;

  const poolNames: string[] = [];
  const names = [...new Set(memberNames.flatMap((name) => [name, name.split(/\s+/)[0] ?? name]))].filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length) {
    const one = `(?:${names.map(escapeRegExp).join("|")})`;
    const pool = new RegExp(`\\s(?:for|between|among|just|only)\\s+(${one}(?:\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)${one})*)(?=[\\s,]|$)`, "i");
    text = text.replace(pool, (_, list: string) => {
      for (const part of list.split(/\s*(?:,|\band\b|&)\s*/i)) {
        const wanted = part.trim().toLowerCase();
        const found = memberNames.find((name) => name.toLowerCase() === wanted || (name.split(/\s+/)[0] ?? "").toLowerCase() === wanted);
        if (found && !poolNames.includes(found)) poolNames.push(found);
      }
      return " ";
    });
  }
  text = text.replace(/\s(?:for|between)\s+(?:everyone|everybody|all of us|all)(?=\s|$)/i, " ");

  if (/\b(?:every\s*day|daily|each\s+day|every\s+night|nightly|every\s+morning)\b/i.test(text)) return { ok: false, reason: "daily" };

  const found: { everyWeeks: number | null; weekly: boolean; monthly: boolean; weekday: number | null; day: number | null; date: string | null; pastDate: boolean } = {
    everyWeeks: null, weekly: false, monthly: false, weekday: null, day: null, date: null, pastDate: false,
  };
  const take = (pattern: RegExp, onMatch: (match: RegExpExecArray) => boolean | void): void => {
    const match = pattern.exec(text);
    if (!match || onMatch(match) === false) return;
    text = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
  };
  const weekdayOf = (word: string) => WEEKDAY_INDEX[word.toLowerCase()] ?? null;

  take(/\bevery\s+(\d+|two|three|four|five|six|seven|eight|other)\s+weeks?\b/i, (m) => {
    const value = m[1]!.toLowerCase();
    found.everyWeeks = value === "other" ? 2 : /^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value] ?? 1;
  });
  take(/\b(?:bi-?weekly|fortnightly|every\s+fortnight|every\s+couple\s+(?:of\s+)?weeks)\b/i, () => { found.everyWeeks = 2; });
  take(new RegExp(`\\b(?:every|each)\\s+(other\\s+)?${WEEKDAY_PATTERN}s?\\b`, "i"), (m) => {
    found.weekday = weekdayOf(m[2]!);
    if (m[1]) found.everyWeeks = 2;
    found.weekly = true;
  });
  take(/\b(?:weekly|every\s+week|each\s+week|once\s+a\s+week|per\s+week)\b/i, () => { found.weekly = true; });
  take(/\b(?:monthly|every\s+month|each\s+month|once\s+a\s+month|per\s+month)\b/i, () => { found.monthly = true; });
  take(/\b(?:on\s+)?(?:the\s+)?(?:last\s+day|end)\s+of\s+(?:the|each|every)\s+month\b/i, () => { found.monthly = true; found.day = 31; });
  take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:the|each|every)\s+month\b/i, (m) => { found.monthly = true; found.day = Number(m[1]); });
  if (found.monthly && found.day === null) {
    take(/\b(?:on\s+)?(?:the\s+)?(?:last\s+day|end\s+of\s+(?:the\s+)?month)\b/i, () => { found.day = 31; });
    if (found.day === null) take(/\b(?:on\s+)?the\s+first\b/i, () => { found.day = 1; });
    if (found.day === null) {
      take(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i, (m) => {
        const day = Number(m[1]);
        if (day < 1 || day > 31) return false;
        found.day = day;
      });
    }
  }
  if (!found.monthly) {
    take(new RegExp(`\\b(?:on\\s+)?${WEEKDAY_PLURAL}\\b`, "i"), (m) => {
      if (found.weekday !== null) return false;
      found.weekday = weekdayOf(m[1]!);
      found.weekly = true;
    });
    if ((found.weekly || found.everyWeeks !== null) && found.weekday === null) {
      take(new RegExp(`\\b(?:on\\s+)?${WEEKDAY_PATTERN}\\b`, "i"), (m) => { found.weekday = weekdayOf(m[1]!); });
    }
  }
  if (!found.weekly && !found.monthly && found.everyWeeks === null) {
    // One-off: "by Friday", "on Oct 30", "due 10/30", "tomorrow", "next Friday", "this weekend".
    const words = text.trim().split(/\s+/);
    for (let start = 0; start < words.length && !found.date && !found.pastDate; start += 1) {
      const keyword = /^(?:by|on|due|before|until|till)$/i.test(words[start]!);
      const bare = /^(?:today|tonight|tomorrow|tmrw|this|next|in)$/i.test(words[start]!);
      if (!keyword && !bare) continue;
      for (let end = Math.min(words.length, start + 5); end > start + (keyword ? 1 : 0); end -= 1) {
        const phrase = words.slice(keyword ? start + 1 : start, end).join(" ");
        const date = parseDay(phrase, today);
        if (!date && !parseDay(phrase, "1970-01-01")) continue;
        if (date) found.date = date; else found.pastDate = true;
        words.splice(start, end - start);
        text = ` ${words.join(" ")} `;
        break;
      }
    }
  }

  const cleaned = text.replace(/\s+/g, " ").trim()
    .replace(/^(?:to|a|an)\s+/i, "")
    .replace(/^[\s,:;\-–]+|[\s,:;\-–]+$/g, "")
    .replace(/\s+(?:on|by|every|each|due|at|the|and|in)$/i, "")
    .replace(/^(?:on|by|every|each)\s+/i, "")
    .trim();
  const name = cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "";
  let schedule: ScheduleInput | null = null;
  if (found.monthly) schedule = { kind: "monthly", day: found.day ?? 31 };
  else if (found.weekly || found.everyWeeks !== null) schedule = { kind: "weekly", weekday: found.weekday ?? 0, everyWeeks: found.everyWeeks ?? 1 };
  else if (found.date) schedule = { kind: "once", date: found.date };
  if (found.pastDate && !schedule) return { ok: false, reason: "past_date" };
  if (!name || name.length > 60) return { ok: false, reason: "no_name" };
  if (!schedule) return { ok: false, reason: "no_schedule" };
  return { ok: true, name, emoji, schedule, poolNames };
}

// ---------------------------------------------------------------------------
// Reply phrasing (names only, never pronouns)

const PARTICIPLES: Record<string, string> = {
  take: "taken", clean: "cleaned", vacuum: "vacuumed", water: "watered", wash: "washed", mop: "mopped", sweep: "swept",
  do: "done", empty: "emptied", fix: "fixed", wipe: "wiped", change: "changed", scrub: "scrubbed", dust: "dusted",
  feed: "fed", walk: "walked", tidy: "tidied", organize: "organized", cook: "cooked", buy: "bought", pay: "paid",
  replace: "replaced", refill: "refilled", restock: "restocked", load: "loaded", unload: "unloaded", fold: "folded",
  sort: "sorted", descale: "descaled", defrost: "defrosted", hoover: "hoovered", polish: "polished", bring: "brought",
  put: "put", make: "made", strip: "stripped", throw: "thrown", run: "run",
};
const PARTICLES = new Set(["out", "up", "down", "off", "away", "in"]);
const DETERMINERS = new Set(["the", "a", "an", "our", "my", "all", "every", "each", "some", "this", "that"]);

/** The chore as an action in present perfect: "taken out the trash", "watered the plants", "done the dishes". */
export function choreDonePhrase(name: string): string {
  const words = stripEmoji(name).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return "done it";
  let verbWords: string[] = [];
  let rest = words;
  if (words[0] === "deep" && words[1] && PARTICIPLES[words[1]]) {
    verbWords = ["deep", PARTICIPLES[words[1]]!];
    rest = words.slice(2);
  } else if (PARTICIPLES[words[0]!]) {
    verbWords = [PARTICIPLES[words[0]!]!];
    rest = words.slice(1);
  }
  if (!verbWords.length) return `done ${DETERMINERS.has(words[0]!) ? "" : "the "}${words.join(" ")}`;
  if (rest[0] && PARTICLES.has(rest[0])) { verbWords.push(rest[0]); rest = rest.slice(1); }
  if (!rest.length) return verbWords.join(" ");
  return `${verbWords.join(" ")} ${DETERMINERS.has(rest[0]!) ? "" : "the "}${rest.join(" ")}`;
}

export function possessive(name: string): string {
  return `${name}’s`;
}

/**
 * Overdue nudge, e.g. "🍽️ Maya hasn’t done the dishes in 3 weeks. Maya’s up next."
 * Falls back to "🗑️ Take out trash: 2 days overdue. Alex’s up next." when the person
 * did it recently (or never).
 */
export function overdueNudge(options: { name: string; emoji: string; assigneeName: string; daysSinceAssignee: number | null; lateDays: number }): string {
  const who = options.assigneeName;
  if (options.daysSinceAssignee !== null && options.daysSinceAssignee >= 7) {
    return `${options.emoji} ${who} hasn’t ${choreDonePhrase(options.name)} in ${durationPhrase(options.daysSinceAssignee)}. ${possessive(who)} up next.`;
  }
  return `${options.emoji} ${options.name}: ${durationPhrase(options.lateDays)} overdue. ${possessive(who)} up next.`;
}

/** "Alex", "Alex and Maya", "Alex, Maya, and Jordan". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Labels for the page

/** "Oct 12 – 18, 2026", "Sep 28 – Oct 4, 2026", "Dec 28, 2026 – Jan 3, 2027". */
export function weekLabel(start: string, end: string): string {
  const [sy, sm, sd] = parts(start);
  const [ey, em, ed] = parts(end);
  if (sy !== ey) return `${monthDay(start)}, ${sy} – ${monthDay(end)}, ${ey}`;
  if (sm !== em) return `${monthDay(start)} – ${monthDay(end)}, ${ey}`;
  return `${SHORT_MONTHS[sm - 1]} ${sd} – ${ed}, ${ey}`;
}

/** Past dates: "Today", "Yesterday", "Thu" (this past week), or "Oct 3". */
export function pastLabel(date: string, today: string): string {
  const diff = daysBetween(date, today);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return SHORT_WEEKDAYS[dayOfWeek(date)]!;
  return monthDay(date);
}

export function shortWeekday(date: string): string {
  return SHORT_WEEKDAYS[dayOfWeek(date)]!;
}

export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
