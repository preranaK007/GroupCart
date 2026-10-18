/**
 * Recurring household grocery lists (weekly, every two weeks, monthly):
 * command parsing and cadence math. Pure functions only — persistence lives in
 * `store.ts`. All dates use the server's local time zone.
 */

export type ListKey = "weekly" | "biweekly" | "monthly";
export const LIST_KEYS: ListKey[] = ["weekly", "biweekly", "monthly"];
export const LIST_LABELS: Record<ListKey, string> = {
  weekly: "weekly",
  biweekly: "every-two-weeks",
  monthly: "monthly",
};
export const LIST_TITLES: Record<ListKey, string> = {
  weekly: "Weekly",
  biweekly: "Every-two-weeks",
  monthly: "Monthly",
};
/** The short name members type in commands, e.g. “load biweekly list”. */
export const LIST_COMMAND_NAMES: Record<ListKey, string> = {
  weekly: "weekly",
  biweekly: "biweekly",
  monthly: "monthly",
};

export type ListSchedule = {
  /** 0 = Sunday … 6 = Saturday; used by weekly and biweekly lists. */
  anchorWeekday: number;
  /** YYYY-MM-DD local date of one biweekly cycle start; null until activated. */
  anchorDate: string | null;
  /** 1–31, clamped to the month length; used by monthly lists. */
  dayOfMonth: number;
};

export type ListCommand =
  | { kind: "overview" }
  | { kind: "setup" }
  | { kind: "view"; list: ListKey }
  | { kind: "add"; list: ListKey; itemText: string }
  | { kind: "remove"; list: ListKey; itemText: string }
  | { kind: "quantity"; list: ListKey; itemText: string; quantity: number }
  | { kind: "clear"; list: ListKey }
  | { kind: "confirmClear"; list?: ListKey }
  | { kind: "cancelClear"; list?: ListKey }
  | { kind: "load"; list: ListKey; force: boolean }
  | { kind: "start"; list: ListKey }
  | { kind: "scheduleWeekday"; list: ListKey; weekday: number }
  | { kind: "scheduleMonthDay"; list: ListKey; dayOfMonth: number }
  | { kind: "reminders"; list: ListKey; enabled: boolean };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const NAME = String.raw`(weekly|bi-?weekly|every[-\s]+(?:two|2|other)[-\s]+weeks?|fortnightly|two[-\s]?weeks?(?:ly)?|monthly)`;
const THE = String.raw`(?:the\s+|our\s+|my\s+)?`;
const LIST_WORD = String.raw`(?:\s+(?:grocery\s+)?list)`;

function listKey(name: string): ListKey {
  const value = name.toLocaleLowerCase();
  if (value.includes("month")) return "monthly";
  if (/bi|two|2|other|fortnight/.test(value)) return "biweekly";
  return "weekly";
}

function rx(source: string): RegExp {
  return new RegExp(`^${source}$`, "i");
}

const patterns = {
  overview: rx(String.raw`(?:(?:show|view|see|review)\s+)?(?:(?:all|our|the|my)\s+)?(?:recurring\s+|grocery\s+|shopping\s+)?lists|lists?\s+schedule|list\s+reminders`),
  setup: rx(String.raw`(?:set\s*up|start|create|begin)\s+(?:the\s+|our\s+)?(?:recurring\s+|grocery\s+|shopping\s+)?lists`),
  view: rx(String.raw`(?:(?:show|view|see|review|what'?s\s+on|what\s+is\s+on)\s+)?${THE}${NAME}${LIST_WORD}`),
  load: rx(String.raw`(?:load|use|add|copy|put|move|(?:bulk\s+)?order)\s+${THE}${NAME}${LIST_WORD}?(?:\s+items)?(?:\s+(?:to|into|in|onto)\s+(?:the\s+|our\s+)?cart)?(\s+again)?`),
  addTo: rx(String.raw`(?:please\s+)?add\s+(.+?)\s+(?:to|on|onto|in|into)\s+${THE}${NAME}${LIST_WORD}?`),
  addToColon: rx(String.raw`add\s+to\s+${THE}${NAME}${LIST_WORD}?\s*:?\s+(.+)`),
  colon: rx(String.raw`${NAME}${LIST_WORD}?\s*:\s*(.+)`),
  remove: rx(String.raw`(?:please\s+)?(?:remove|delete|drop|take)\s+(.+?)\s+(?:from|off|off\s+of)\s+${THE}${NAME}${LIST_WORD}?`),
  quantity: rx(String.raw`(?:set|change|make|update)\s+(.+?)\s+(?:on|in)\s+${THE}${NAME}${LIST_WORD}?\s+to\s+(\d{1,2})`),
  quantityAlt: rx(String.raw`(?:set|change|update)\s+${THE}${NAME}${LIST_WORD}\s+(.+?)\s+to\s+(\d{1,2})`),
  clear: rx(String.raw`(?:clear|empty|reset)\s+${THE}${NAME}${LIST_WORD}`),
  confirmClear: rx(String.raw`(?:confirm|yes,?)\s+clear\s+${THE}${NAME}${LIST_WORD}`),
  cancelClear: rx(String.raw`cancel\s+clear\s+${THE}${NAME}${LIST_WORD}`),
  start: rx(String.raw`(?:start|begin|set\s*up|create|make)\s+(?:a\s+|the\s+|our\s+)?${NAME}${LIST_WORD}`),
  scheduleWeekday: rx(String.raw`${THE}${NAME}${LIST_WORD}?\s+(?:on|every|due\s+on|due)\s+(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?`),
  scheduleMonthDay: rx(String.raw`${THE}${NAME}${LIST_WORD}?\s+(?:on|every|due\s+on|due)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+(?:the|each|every)\s+month)?`),
  remindersOff: rx(String.raw`(?:(?:pause|stop|mute|disable|turn\s+off)\s+${THE}${NAME}${LIST_WORD}?\s+reminders?|${NAME}${LIST_WORD}?\s+reminders?\s+off)`),
  remindersOn: rx(String.raw`(?:(?:resume|unmute|enable|turn\s+on|start)\s+${THE}${NAME}${LIST_WORD}?\s+reminders?|${NAME}${LIST_WORD}?\s+reminders?\s+on)`),
};

export function normalizeListText(text: string): string {
  return text.normalize("NFKC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
}

/**
 * Parse a recurring-list command. Returns undefined for anything else so the
 * caller can fall through to the cart flows. Bare “yes”/“cancel” replies to a
 * pending list clear are resolved by the store, which knows the pending state.
 */
export function parseListCommand(rawText: string): ListCommand | undefined {
  const text = normalizeListText(rawText);
  if (!text) return undefined;
  let match: RegExpMatchArray | null;
  if (patterns.overview.test(text)) return { kind: "overview" };
  if (patterns.setup.test(text)) return { kind: "setup" };
  if ((match = text.match(patterns.confirmClear))) return { kind: "confirmClear", list: listKey(match[1]!) };
  if ((match = text.match(patterns.cancelClear))) return { kind: "cancelClear", list: listKey(match[1]!) };
  if ((match = text.match(patterns.clear))) return { kind: "clear", list: listKey(match[1]!) };
  if ((match = text.match(patterns.remindersOff))) return { kind: "reminders", list: listKey(match[1] ?? match[2]!), enabled: false };
  if ((match = text.match(patterns.remindersOn))) return { kind: "reminders", list: listKey(match[1] ?? match[2]!), enabled: true };
  if ((match = text.match(patterns.start))) return { kind: "start", list: listKey(match[1]!) };
  if ((match = text.match(patterns.scheduleWeekday))) {
    const prefix = match[2]!.toLocaleLowerCase().slice(0, 3);
    return { kind: "scheduleWeekday", list: listKey(match[1]!), weekday: WEEKDAYS.findIndex((day) => day.startsWith(prefix)) };
  }
  if ((match = text.match(patterns.scheduleMonthDay))) {
    return { kind: "scheduleMonthDay", list: listKey(match[1]!), dayOfMonth: Number(match[2]) };
  }
  if ((match = text.match(patterns.view))) return { kind: "view", list: listKey(match[1]!) };
  if ((match = text.match(patterns.load))) return { kind: "load", list: listKey(match[1]!), force: Boolean(match[2]) };
  if ((match = text.match(patterns.quantity))) {
    return { kind: "quantity", list: listKey(match[2]!), itemText: match[1]!.trim(), quantity: Number(match[3]) };
  }
  if ((match = text.match(patterns.quantityAlt))) {
    return { kind: "quantity", list: listKey(match[1]!), itemText: match[2]!.trim(), quantity: Number(match[3]) };
  }
  if ((match = text.match(patterns.remove))) return { kind: "remove", list: listKey(match[2]!), itemText: match[1]!.trim() };
  if ((match = text.match(patterns.addToColon))) return { kind: "add", list: listKey(match[1]!), itemText: match[2]!.trim() };
  if ((match = text.match(patterns.addTo))) return { kind: "add", list: listKey(match[2]!), itemText: match[1]!.trim() };
  if ((match = text.match(patterns.colon))) return { kind: "add", list: listKey(match[1]!), itemText: match[2]!.trim() };
  return undefined;
}

// ---------------------------------------------------------------------------
// Cadence math (local calendar days)

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function dayNumber(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseLocalDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

function clampedMonthDay(year: number, month: number, dayOfMonth: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(Math.max(dayOfMonth, 1), lastDay));
}

/** The next local date (strictly after `date`'s day) that falls on `weekday`. */
export function nextWeekdayAfter(date: Date, weekday: number): Date {
  const today = startOfLocalDay(date);
  const diff = ((weekday - today.getDay() + 7) % 7) || 7;
  return addLocalDays(today, diff);
}

/** The next local date on or after `date`'s day that falls on `weekday`. */
export function nextWeekdayOnOrAfter(date: Date, weekday: number): Date {
  const today = startOfLocalDay(date);
  return addLocalDays(today, (weekday - today.getDay() + 7) % 7);
}

/** Start (local midnight) of the cycle containing `now`. */
export function currentCycleStart(list: ListKey, schedule: ListSchedule, now: Date): Date {
  const today = startOfLocalDay(now);
  if (list === "weekly") {
    return addLocalDays(today, -((today.getDay() - schedule.anchorWeekday + 7) % 7));
  }
  if (list === "biweekly") {
    const anchor = schedule.anchorDate
      ? parseLocalDateKey(schedule.anchorDate)
      : nextWeekdayOnOrAfter(today, schedule.anchorWeekday);
    const cycles = Math.floor((dayNumber(today) - dayNumber(anchor)) / 14);
    return addLocalDays(anchor, cycles * 14);
  }
  const thisMonth = clampedMonthDay(today.getFullYear(), today.getMonth(), schedule.dayOfMonth);
  return today >= thisMonth
    ? thisMonth
    : clampedMonthDay(today.getFullYear(), today.getMonth() - 1, schedule.dayOfMonth);
}

export function nextCycleStart(list: ListKey, schedule: ListSchedule, cycleStart: Date): Date {
  if (list === "weekly") return addLocalDays(cycleStart, 7);
  if (list === "biweekly") return addLocalDays(cycleStart, 14);
  return clampedMonthDay(cycleStart.getFullYear(), cycleStart.getMonth() + 1, schedule.dayOfMonth);
}

/** First cycle start strictly after `date` — used when a list is first activated. */
export function firstCycleStartAfter(list: ListKey, schedule: ListSchedule, date: Date): Date {
  const current = currentCycleStart(list, schedule, date);
  return nextCycleStart(list, schedule, current);
}

export function ordinal(day: number): string {
  const suffixes: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : suffixes[day % 10] ?? "th";
  return `${day}${suffix}`;
}

export function describeSchedule(list: ListKey, schedule: ListSchedule): string {
  if (list === "weekly") return `every ${WEEKDAY_NAMES[schedule.anchorWeekday]}`;
  if (list === "biweekly") {
    return `every other ${WEEKDAY_NAMES[schedule.anchorWeekday]}`;
  }
  return `on the ${ordinal(schedule.dayOfMonth)} of each month${schedule.dayOfMonth > 28 ? " (or the month’s last day)" : ""}`;
}

export function friendlyDate(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
