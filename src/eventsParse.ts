// Pure helpers for household events and plans: activity templates, natural-language
// parsing (dates, times, durations, planning intents, votes, RSVPs), recurrence
// expansion, slot ranking, and short chat formatting. No I/O and no clocks: callers
// pass "now" and "today" explicitly so everything can be checked offline.
import { addDays, dayOfWeek, localDate, zonedTimeToEpoch, type Interval } from "./availability.js";

export type Recurrence = "none" | "weekly" | "monthly";
export type ActivityKey = "movie" | "game" | "dinner" | "outing" | "party" | "hangout";

export type Activity = {
  key: ActivityKey;
  label: string;
  emoji: string;
  /** Default length in minutes. */
  minutes: number;
  /** Local hours a plan may use: [start, end] in minutes after midnight (end may be 1440). */
  window: [number, number];
  /** Preferred local start time (minutes after midnight). */
  preferred: number;
  /** Weekdays (0 = Sunday) without a ranking penalty. */
  preferredDays: number[];
  tasks: string[];
  listName: string;
  listItems: string[];
};

export const ACTIVITIES: readonly Activity[] = [
  { key: "movie", label: "Movie night", emoji: "🎬", minutes: 150, window: [18 * 60, 23 * 60 + 30], preferred: 20 * 60, preferredDays: [5, 6, 0], tasks: ["Pick the movie", "Snacks", "Set up"], listName: "Movie night snacks", listItems: ["Popcorn", "Candy", "Soda"] },
  { key: "game", label: "Game night", emoji: "🎲", minutes: 150, window: [18 * 60, 23 * 60 + 30], preferred: 19 * 60 + 30, preferredDays: [4, 5, 6], tasks: ["Pick the games", "Snacks", "Clean up"], listName: "Game night snacks", listItems: ["Chips", "Salsa", "Soda"] },
  { key: "dinner", label: "House dinner", emoji: "🍝", minutes: 90, window: [17 * 60 + 30, 21 * 60 + 30], preferred: 19 * 60, preferredDays: [0, 1, 2, 3, 4, 5, 6], tasks: ["Cook", "Groceries", "Dishes"], listName: "Dinner groceries", listItems: ["Pasta", "Tomato sauce", "Parmesan", "Bread"] },
  { key: "outing", label: "Outing", emoji: "🌳", minutes: 180, window: [8 * 60, 18 * 60], preferred: 10 * 60, preferredDays: [6, 0], tasks: ["Pick the spot", "Drive", "Snacks"], listName: "Outing snacks", listItems: ["Trail mix", "Granola bars", "Water"] },
  { key: "party", label: "House party", emoji: "🎉", minutes: 240, window: [18 * 60, 24 * 60], preferred: 20 * 60, preferredDays: [5, 6], tasks: ["Playlist", "Snacks", "Clean up"], listName: "Party supplies", listItems: ["Chips", "Soda", "Cups"] },
  { key: "hangout", label: "Hangout", emoji: "🛋️", minutes: 120, window: [16 * 60, 22 * 60], preferred: 19 * 60, preferredDays: [0, 1, 2, 3, 4, 5, 6], tasks: ["Snacks", "Set up"], listName: "Hangout snacks", listItems: ["Chips", "Soda"] },
];

/** Window and preferences for a plain household event ("plan house meeting 1h"). */
export const HOUSE_PLAN = { window: [8 * 60, 21 * 60] as [number, number], preferred: 19 * 60, preferredDays: [0, 1, 2, 3, 4, 5, 6], minutes: 60 };

export function activityByKey(key: string | null | undefined): Activity | undefined {
  return ACTIVITIES.find((activity) => activity.key === key);
}

export type ActivityMatch = { activity: Activity; label: string; emoji: string };

/** Finds the activity a phrase talks about ("watch a movie" → movie night). */
export function detectActivity(text: string): ActivityMatch | null {
  const t = text.toLowerCase();
  const pick = (key: ActivityKey, label?: string, emoji?: string): ActivityMatch => {
    const activity = activityByKey(key)!;
    return { activity, label: label ?? activity.label, emoji: emoji ?? activity.emoji };
  };
  if (/\b(?:movies?|films?|cinema|netflix)\b/.test(t)) return pick("movie");
  if (/\bgame ?nights?\b|\bboard ?games?\b|\b(?:play|playing)\s+(?:some\s+)?(?:games|cards|poker|catan)\b|\bgames\b|\bpoker\b|\btrivia\b/.test(t)) return pick("game");
  if (/\b(?:dinner|potluck|bbq|barbecue|cookout)\b/.test(t)) return pick("dinner", /\bpotluck\b/.test(t) ? "Potluck" : /\b(?:bbq|barbecue|cookout)\b/.test(t) ? "BBQ" : undefined);
  if (/\b(?:hike|hiking)\b/.test(t)) return pick("outing", "Hike", "🥾");
  if (/\bbeach\b/.test(t)) return pick("outing", "Beach day", "🏖️");
  if (/\b(?:picnic|park day)\b/.test(t)) return pick("outing", "Picnic", "🧺");
  if (/\b(?:outing|day trip|road trip)\b/.test(t)) return pick("outing");
  if (/\bbirthday\b/.test(t)) return pick("party", "Birthday party", "🎂");
  if (/\b(?:party|parties|celebrate|celebration)\b/.test(t)) return pick("party");
  if (/\b(?:hang ?out|hang|chill|get[- ]together|do something)\b/.test(t)) return pick("hangout");
  return null;
}

// ---------------------------------------------------------------------------
// Weekdays and dates

const WEEKDAY_SOURCE = "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const MONTH_SOURCE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export function weekdayIndex(word: string): number {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(word.toLowerCase().slice(0, 3));
}

function monthIndex(word: string): number {
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(word.toLowerCase().slice(0, 3));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function daysBetween(from: string, to: string): number {
  const [ay, am, ad] = from.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = to.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Adds whole months to a date, clamping to the month's last day; `anchorDay` keeps the 31st sticky (Jan 31 → Feb 28 → Mar 31). */
export function addMonthsClamped(date: string, months: number, anchorDay?: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12 + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Next date with this weekday. Today counts unless `strict`, or the given time has already passed. */
export function nextWeekdayDate(today: string, weekday: number, options: { strict?: boolean; timeMin?: number | null; nowMin?: number } = {}): string {
  let delta = (weekday - dayOfWeek(today) + 7) % 7;
  if (delta === 0 && (options.strict || (options.timeMin != null && options.nowMin != null && options.timeMin <= options.nowMin))) delta = 7;
  return addDays(today, delta);
}

/** Next date (today or later) falling on day-of-month `day`, clamped in short months. */
export function nextMonthDay(today: string, day: number): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const thisMonth = Math.min(day, daysInMonth(y, m));
  if (thisMonth >= d) return `${y}-${String(m).padStart(2, "0")}-${String(thisMonth).padStart(2, "0")}`;
  return addMonthsClamped(`${y}-${String(m).padStart(2, "0")}-01`, 1, day);
}

/** Local minutes after midnight for an instant. */
export function localMinutes(instant: number, timeZone: string): number {
  const parts = clockFormatter(timeZone, "parts").formatToParts(new Date(instant));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

// ---------------------------------------------------------------------------
// Durations and times

/** "1h", "90 min", "1.5 hours", "an hour", "half an hour", "1h30" → minutes (null when none). */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase();
  if (/\bhalf an hour\b/.test(t)) return 30;
  if (/\ban? hour and a half\b|\bhour and a half\b/.test(t)) return 90;
  if (/\ban? hour\b/.test(t) && !/\d/.test(t)) return 60;
  const hm = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)(?![a-z])\s*(?:(\d{1,2})\s*(?:m|mins?|minutes?)?\b)?/);
  if (hm) {
    const minutes = Math.round(Number(hm[1]) * 60) + (hm[2] ? Number(hm[2]) : 0);
    return minutes > 0 && minutes <= 24 * 60 ? minutes : null;
  }
  const m = t.match(/(\d+)\s*(?:m|mins?|minutes?)\b/);
  if (m) {
    const minutes = Number(m[1]);
    return minutes > 0 && minutes <= 24 * 60 ? minutes : null;
  }
  return null;
}

function to24(hour: number, minute: number, meridiem: string | undefined): number | null {
  if (minute > 59) return null;
  const mer = meridiem?.replace(/\./g, "").toLowerCase();
  if (mer === "am" || mer === "a") {
    if (hour < 1 || hour > 12) return null;
    return (hour % 12) * 60 + minute;
  }
  if (mer === "pm" || mer === "p") {
    if (hour < 1 || hour > 12) return null;
    return ((hour % 12) + 12) * 60 + minute;
  }
  if (hour > 23) return null;
  return hour * 60 + minute;
}

/** Bare "at 7" → 7 PM; "at 9" → 9 AM (household events lean evening for 1–7). */
function bareHour(hour: number): number | null {
  if (hour < 0 || hour > 23) return null;
  if (hour >= 1 && hour <= 7) return (hour + 12) * 60;
  return hour * 60;
}

// ---------------------------------------------------------------------------
// "add event house meeting Sunday 7pm"

export type ParsedWhen = {
  title: string;
  /** First date (YYYY-MM-DD) or null when the text names no day or time. */
  date: string | null;
  /** All-day multi-day end (inclusive), e.g. "Fri–Sun". */
  endDate: string | null;
  /** Start in minutes after midnight; null for all-day. */
  startMin: number | null;
  endMin: number | null;
  durationMin: number | null;
  recurrence: Recurrence;
};

/**
 * Pulls the date, time, duration, and repeat rule out of a short phrase and leaves
 * the rest as the title. `today` is YYYY-MM-DD and `nowMin` the local minutes now.
 */
export function parseWhen(input: string, today: string, nowMin: number): ParsedWhen {
  let s = ` ${input.replace(/[’‘]/g, "'")} `;
  const take = (pattern: RegExp, use: (match: RegExpMatchArray) => boolean | void): boolean => {
    const match = s.match(pattern);
    if (!match || match.index === undefined) return false;
    if (use(match) === false) return false;
    s = `${s.slice(0, match.index)} ${s.slice(match.index + match[0].length)}`;
    return true;
  };
  const w = {
    date: null as string | null,
    endDate: null as string | null,
    startMin: null as number | null,
    endMin: null as number | null,
    durationMin: null as number | null,
    recurrence: "none" as Recurrence,
    weekday: null as number | null,
    weekdayStrict: false,
    monthDay: null as number | null,
    defaultTime: null as number | null,
    allDay: false,
  };

  take(/\bfor\s+(an?\s+hour(?:\s+and\s+a\s+half)?|half\s+an\s+hour|\d+(?:\.\d+)?\s*(?:h|hrs?|hours?)(?:\s*\d+\s*(?:m|mins?|minutes?))?|\d+\s*(?:m|mins?|minutes?))\b/i, (m) => { w.durationMin = parseDuration(m[1]!); });
  if (w.durationMin === null) take(/(?:^|\s)\(?(\d+(?:\.\d+)?\s*(?:h|hrs?|hours?)(?:\s*\d+\s*(?:m|mins?|minutes?))?|\d+\s*(?:mins?|minutes?)|\d+m)\)?(?=\s|$)/i, (m) => { w.durationMin = parseDuration(m[1]!); return w.durationMin !== null; });
  take(/\ball[\s-]?day\b/i, () => { w.allDay = true; });

  take(new RegExp(`\\b(?:every|each)\\s+${WEEKDAY_SOURCE}\\b`, "i"), (m) => { w.recurrence = "weekly"; w.weekday = weekdayIndex(m[1]!); });
  if (w.recurrence === "none") take(/\b(?:every|each)\s+week\b|\bweekly\b/i, () => { w.recurrence = "weekly"; });
  take(/\b(?:of\s+)?(?:every|each|the)\s+month\b|\bmonthly\b/i, () => { w.recurrence = "monthly"; });

  // Day ranges ("Fri–Sun") become all-day spans.
  take(new RegExp(`\\b(?:from\\s+)?${WEEKDAY_SOURCE}\\.?\\s*(?:-|–|—|to|through|thru|until|till)\\s*${WEEKDAY_SOURCE}\\b`, "i"), (m) => {
    const first = weekdayIndex(m[1]!);
    const last = weekdayIndex(m[2]!);
    w.date = nextWeekdayDate(today, first);
    w.endDate = addDays(w.date, (last - first + 7) % 7);
    w.allDay = true;
  });

  take(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => { w.date = `${m[1]}-${m[2]}-${m[3]}`; });
  if (!w.date) take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    w.date = explicitDate(today, month, day, m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined);
  });
  if (!w.date) take(new RegExp(`\\b${MONTH_SOURCE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"), (m) => {
    const day = Number(m[2]);
    if (day < 1 || day > 31) return false;
    w.date = explicitDate(today, monthIndex(m[1]!) + 1, day);
  });
  if (!w.date) take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_SOURCE}\\b`, "i"), (m) => {
    const day = Number(m[1]);
    if (day < 1 || day > 31) return false;
    w.date = explicitDate(today, monthIndex(m[2]!) + 1, day);
  });
  if (!w.date) take(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b(?:\s+of\s+(?:the|each|every)\s+month)?/i, (m) => {
    const day = Number(m[1]);
    if (day < 1 || day > 31) return false;
    w.monthDay = day;
    if (/month/i.test(m[0])) w.recurrence = "monthly";
  });

  // Times: ranges first, then single times.
  take(/\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i, (m) => {
    const endMer = m[6]!;
    const end = to24(Number(m[4]), Number(m[5] ?? 0), endMer);
    let start = to24(Number(m[1]), Number(m[2] ?? 0), m[3] ?? endMer);
    if (end === null || start === null) return false;
    if (!m[3] && start > end) start = to24(Number(m[1]), Number(m[2] ?? 0), /p/i.test(endMer) ? "am" : "pm");
    if (start === null) return false;
    w.startMin = start;
    w.endMin = end;
  });
  if (w.startMin === null) take(/\b(?:from\s+)?([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|to|until)\s*([01]?\d|2[0-3]):([0-5]\d)\b/, (m) => {
    w.startMin = Number(m[1]) * 60 + Number(m[2]);
    w.endMin = Number(m[3]) * 60 + Number(m[4]);
  });
  if (w.startMin === null) take(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=\s|$|[,.!?])/i, (m) => {
    const value = to24(Number(m[1]), Number(m[2] ?? 0), m[3]);
    if (value === null) return false;
    w.startMin = value;
  });
  if (w.startMin === null) take(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/, (m) => { w.startMin = Number(m[1]) * 60 + Number(m[2]); });
  if (w.startMin === null) take(/\bat\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th|\/|%))/i, (m) => {
    const value = bareHour(Number(m[1]));
    if (value === null) return false;
    w.startMin = value;
  });
  if (w.startMin === null) take(/\b(?:at\s+)?noon\b/i, () => { w.startMin = 12 * 60; });
  if (w.startMin === null) take(/\b(?:in\s+the\s+)?morning\b/i, () => { w.startMin = 10 * 60; });
  if (w.startMin === null) take(/\b(?:in\s+the\s+)?afternoon\b/i, () => { w.startMin = 14 * 60; });
  if (w.startMin === null) take(/\b(?:in\s+the\s+)?evening\b/i, () => { w.startMin = 19 * 60; });

  if (!w.date) take(/\btonight\b/i, () => { w.date = today; w.defaultTime = 19 * 60; });
  if (!w.date) take(/\btoday\b/i, () => { w.date = today; });
  if (!w.date) take(/\btomorrow\b/i, () => { w.date = addDays(today, 1); });
  if (!w.date && w.weekday === null) take(new RegExp(`\\b(?:(this|next|on|coming)\\s+)?${WEEKDAY_SOURCE}\\b`, "i"), (m) => {
    w.weekday = weekdayIndex(m[2]!);
    w.weekdayStrict = /next/i.test(m[1] ?? "");
  });

  if (w.startMin === null && w.defaultTime !== null && !w.allDay) w.startMin = w.defaultTime;
  if (w.allDay) { w.startMin = null; w.endMin = null; }
  if (!w.date && w.weekday !== null) w.date = nextWeekdayDate(today, w.weekday, { strict: w.weekdayStrict, timeMin: w.startMin, nowMin });
  if (!w.date && w.monthDay !== null) w.date = nextMonthDay(today, w.monthDay);
  if (!w.date && w.startMin !== null) w.date = w.startMin > nowMin ? today : addDays(today, 1);
  if (w.recurrence === "monthly" && !w.date) w.date = today;
  if (w.recurrence === "weekly" && !w.date) w.date = today;
  if (w.endMin !== null && w.startMin !== null) {
    let length = w.endMin - w.startMin;
    if (length <= 0) length += 24 * 60;
    w.durationMin = length;
  }

  return { title: cleanTitle(s), date: w.date, endDate: w.endDate, startMin: w.startMin, endMin: w.endMin, durationMin: w.durationMin, recurrence: w.recurrence };
}

function explicitDate(today: string, month: number, day: number, year?: number): string | null {
  const [ty] = today.split("-").map(Number) as [number];
  let y = year ?? ty;
  if (day > daysInMonth(y, month)) return null;
  let candidate = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!year && candidate < today) {
    y += 1;
    if (day > daysInMonth(y, month)) return null;
    candidate = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return candidate;
}

const CONNECTOR = /^(?:on|at|from|this|next|every|each|the|for|starting|and|with|to|in|-|–|—|,|:|;)$/i;

export function cleanTitle(text: string): string {
  const words = text.replace(/[!?.]+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  while (words.length && CONNECTOR.test(words[0]!)) words.shift();
  while (words.length && CONNECTOR.test(words[words.length - 1]!)) words.pop();
  const title = words.join(" ").replace(/\s*[,;:]\s*$/, "");
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

// ---------------------------------------------------------------------------
// Emoji

const LEADING_EMOJI = /^\s*(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u;

/** Splits a leading emoji off a title ("🧹 Cleaning day" → ["🧹", "Cleaning day"]). */
export function splitEmoji(title: string): { emoji: string | null; title: string } {
  const match = title.match(LEADING_EMOJI);
  if (!match) return { emoji: null, title: title.trim() };
  return { emoji: match[1]!, title: title.slice(match[0].length).trim() };
}

/** Picks an emoji for a household event from its title. */
export function pickEmoji(title: string): string {
  const t = title.toLowerCase();
  const activity = detectActivity(t);
  if (activity) return activity.emoji;
  const table: Array<[RegExp, string]> = [
    [/\b(?:repair|plumber|electrician|maintenance|fix|landlord|inspection|handyman)\b/, "🔧"],
    [/\b(?:clean|cleaning|tidy|chores?)\b/, "🧹"],
    [/\b(?:rent|bills?|utilities|pay)\b/, "💸"],
    [/\b(?:meeting|check-?in|house talk)\b/, "🏠"],
    [/\b(?:guests?|visiting|visitors?|parents|family|staying)\b/, "🧳"],
    [/\b(?:trash|recycling|garbage|bins?)\b/, "🗑️"],
    [/\b(?:laundry|wash)\b/, "🧺"],
    [/\b(?:grocer(?:y|ies)|shopping|costco)\b/, "🛒"],
    [/\b(?:workout|gym|run|yoga)\b/, "🏃"],
    [/\b(?:move|moving)\b/, "📦"],
  ];
  for (const [pattern, emoji] of table) if (pattern.test(t)) return emoji;
  return "📅";
}

// ---------------------------------------------------------------------------
// Planning intents ("hey we all want to watch a movie")

export type PlanningIntent = {
  match: ActivityMatch;
  /** Allowed dates (YYYY-MM-DD) or null for the next 7 days. */
  dates: string[] | null;
  durationMin: number | null;
};

const PLANNING_CUE = /\b(?:let'?s|lets|we (?:all )?(?:should|want to|wanna|could|gotta|need to)|we all want|should we|shall we|can we|could we|any(?:one|body) (?:up|down|want|wanna|free|interested|in)|who'?s (?:in|up|down|free)|who wants?|wanna|want to (?:do|have|grab|watch|see|play|go|throw|host)|how about|what about|plan (?:a|an|our|some)|down for|up for|time for|feel like)\b/i;
const ACTIVITY_QUESTION = /^(?:hey,?\s+|so,?\s+)?(?:(?:a|an|the|some)\s+)?(?:movie night|movies?|game night|board games|games|house dinner|dinner|potluck|bbq|hike|beach day|picnic|party|hang ?out)(?:\s+(?:night|tonight|tomorrow|this\s+week(?:end)?|next\s+week|this\s+\w+day|on\s+\w+day|\w+day|sometime|soon|later|anyone|someone|guys|y'?all|folks|again))*\s*\?+$/i;
const SUPPLIES_FOR = /\b(?:get|buy|grab|pick up|need|needs|order|bring|add|more|some)\b[^?]*\bfor\s+(?:the\s+|our\s+|a\s+|tonight'?s\s+|this\s+)?(?:movie|movies|game|games|dinner|party|hike|hangout|potluck)\b/i;
const SUPPLY_WORDS = /\b(?:popcorn|snacks?|candy|chips|soda|drinks|beer|wine|supplies|ingredients|groceries|tickets?|rolls|theater|theatre)\b/i;
const SOCIAL_VERBS = /\b(?:watch|play|have|do|go|throw|host|see|catch|grab dinner|hang)\b/i;

/**
 * Recognizes a conservative set of "let's do something together" messages. Grocery
 * requests ("movie theater popcorn", "snacks for game night") are left alone.
 */
export function matchPlanningIntent(text: string, today: string): PlanningIntent | null {
  const raw = text.trim().replace(/[’‘]/g, "'");
  if (!raw || raw.length > 160) return null;
  const t = raw.toLowerCase();
  if (/^(?:add|remove|delete|cancel|clear|approve|checkout|book|vote|plan|poll|new|create|undo|help)\b/.test(t)) return null;
  if (/[,;]\s*\w+\s*,/.test(t)) return null; // comma lists are grocery lists
  const match = detectActivity(t);
  if (!match) return null;
  if (!PLANNING_CUE.test(t) && !ACTIVITY_QUESTION.test(t)) return null;
  if (SUPPLIES_FOR.test(t)) return null;
  if (SUPPLY_WORDS.test(t) && !SOCIAL_VERBS.test(t)) return null;
  return { match, dates: parseDayHint(t, today), durationMin: parseDuration(t.replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/g, " ")) };
}

/** Day hints in a planning message → allowed dates, or null for "the next 7 days". */
export function parseDayHint(text: string, today: string): string[] | null {
  const t = text.toLowerCase();
  if (/\b(?:tonight|today)\b/.test(t)) return [today];
  if (/\btomorrow\b/.test(t)) return [addDays(today, 1)];
  if (/\bweekend\b/.test(t)) {
    const dow = dayOfWeek(today);
    if (dow === 0) return [today];
    const saturday = addDays(today, 6 - dow);
    return dow === 6 ? [today, addDays(today, 1)] : [saturday, addDays(saturday, 1)];
  }
  if (/\bnext week\b/.test(t)) {
    const monday = nextWeekdayDate(today, 1, { strict: true });
    return Array.from({ length: 7 }, (_, offset) => addDays(monday, offset));
  }
  const weekdays = [...t.matchAll(new RegExp(`\\b${WEEKDAY_SOURCE}\\b`, "gi"))].map((m) => weekdayIndex(m[1]!));
  if (weekdays.length) return [...new Set(weekdays.map((weekday) => nextWeekdayDate(today, weekday)))].sort();
  return null;
}

// ---------------------------------------------------------------------------
// Votes and RSVPs

export type ParsedVote = { yes: number[]; no: number[] };

const VOTE_FILLER = new Set(["works", "work", "working", "for", "me", "i", "can", "do", "either", "or", "and", "&", "+", "vote", "votes", "voting", "both", "good", "fine", "ok", "okay", "is", "are", "great", "perfect", "yes", "yeah", "yep", "yup", "sure", "option", "options", "#", "but", "not", "no", "nope", "cant", "can't", "cannot", "won't", "wont", "the", "👍", "✅", "would", "be", "best", "prefer", "pick", "id", "i'd", "probably", "free", "on", "only", "just", "make", "it"]);

/**
 * "2", "1 3", "2 works", "1 and 3 work for me", "can't do 3", "2 works but not 3",
 * "any", "none" → which options a member can or cannot do. Null when the text is
 * not a vote (e.g. "2 bananas").
 */
export function parseVote(text: string, optionCount: number): ParsedVote | null {
  const t = text.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/[!?]+$/g, "").trim();
  if (!t || t.length > 80) return null;
  const all = Array.from({ length: optionCount }, (_, index) => index + 1);
  if (/^(?:none|neither|none of (?:them|those|these)(?: work)?|none work(?:s)?|can'?t do any(?: of them)?|no(?:ne)? good|nothing works)$/.test(t)) return { yes: [], no: all };
  if (/^(?:any|all|any of them|all of them|any(?:thing|one)? works?|all (?:work|good)|i'?m (?:free|good) (?:for )?(?:any|all)(?: of them)?|all work for me|any works for me)$/.test(t)) return { yes: all, no: [] };
  const yes = new Set<number>();
  const no = new Set<number>();
  let found = false;
  for (const clause of t.split(/[,;.]|\bbut\b/)) {
    const words = clause.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const negative = words.some((word) => /^(?:can'?t|cannot|not|no|nope|won'?t)$/.test(word));
    for (const word of words) {
      const numbers = word.match(/^#?(\d)(?:[,&+](\d))*$/);
      if (numbers) {
        for (const digit of word.replace("#", "").split(/[,&+]/)) {
          const value = Number(digit);
          if (value < 1 || value > optionCount) return null;
          (negative ? no : yes).add(value);
          found = true;
        }
        continue;
      }
      if (!VOTE_FILLER.has(word)) return null;
    }
  }
  if (!found) return null;
  for (const value of no) yes.delete(value);
  return { yes: [...yes].sort(), no: [...no].sort() };
}

export type RsvpStatus = "going" | "maybe" | "no";

/** "I'm in", "count me out", "can't make it", "I'm a maybe for game night" → status plus an optional event hint. */
export function parseRsvp(text: string): { status: RsvpStatus; hint: string | null } | null {
  const t = text.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/[!.]+$/g, "").trim();
  let match = t.match(/^(?:i'?m|im|i am|count me) (in|out|down|a maybe|maybe|going|not going|coming|not coming)(?: for (?:the )?(.+))?$/);
  if (match) {
    const word = match[1]!;
    const status: RsvpStatus = /maybe/.test(word) ? "maybe" : /out|not/.test(word) ? "no" : "going";
    return { status, hint: match[2] ?? null };
  }
  match = t.match(/^(?:i )?(?:can'?t|cannot|won'?t be able to) make (?:it|that)(?: (?:to|for) (?:the )?(.+))?$/);
  if (match) return { status: "no", hint: match[1] ?? null };
  match = t.match(/^(?:i'?ll be there|see you there|i'?ll come|i'?m there)(?: for (?:the )?(.+))?$/);
  if (match) return { status: "going", hint: match[1] ?? null };
  match = t.match(/^maybe for (?:the )?(.+)$/);
  if (match) return { status: "maybe", hint: match[1]! };
  return null;
}

// ---------------------------------------------------------------------------
// Recurrence

export type EventRule = {
  startDate: string;
  /** Null for all-day events. */
  startMin: number | null;
  durationMin: number;
  /** Inclusive last day for all-day events (same as startDate for one day). */
  endDate: string;
  recurrence: Recurrence;
  timeZone: string;
};

export type Occurrence = { date: string; endDate: string; start: number; end: number };

function occurrenceAt(rule: EventRule, index: number): Occurrence {
  const date = rule.recurrence === "weekly" ? addDays(rule.startDate, index * 7)
    : rule.recurrence === "monthly" ? addMonthsClamped(rule.startDate, index, Number(rule.startDate.slice(8, 10)))
      : rule.startDate;
  if (rule.startMin === null) {
    const span = Math.max(0, daysBetween(rule.startDate, rule.endDate));
    const endDate = addDays(date, span);
    return { date, endDate, start: zonedTimeToEpoch(date, 0, rule.timeZone), end: zonedTimeToEpoch(addDays(endDate, 1), 0, rule.timeZone) };
  }
  const start = zonedTimeToEpoch(date, rule.startMin, rule.timeZone);
  const end = start + rule.durationMin * 60_000;
  return { date, endDate: localDate(end - 1, rule.timeZone), start, end };
}

/** Occurrences that overlap [from, to), in time order. */
export function occurrencesBetween(rule: EventRule, from: number, to: number, limit = 400): Occurrence[] {
  if (rule.recurrence === "none") {
    const only = occurrenceAt(rule, 0);
    return only.end > from && only.start < to ? [only] : [];
  }
  const fromDate = localDate(from, rule.timeZone);
  const elapsed = daysBetween(rule.startDate, fromDate);
  let index = elapsed <= 0 ? 0 : Math.max(0, rule.recurrence === "weekly" ? Math.floor(elapsed / 7) - 1 : Math.floor(elapsed / 31) - 1);
  const result: Occurrence[] = [];
  for (let guard = 0; guard < 2000 && result.length < limit; guard += 1, index += 1) {
    const occurrence = occurrenceAt(rule, index);
    if (occurrence.start >= to) break;
    if (occurrence.end > from) result.push(occurrence);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Slot ranking

export type SlotPreferences = {
  durationMin: number;
  preferredMin: number;
  preferredDays: number[];
  now: number;
  timeZone: string;
  count: number;
  /** Minimum minutes between now and a suggested start (default 60). */
  leadMin?: number;
};

const HALF_HOUR = 30 * 60_000;

/**
 * Picks the best starts inside everyone-free windows: close to the preferred time,
 * on preferred weekdays, sooner rather than later, one per day when possible.
 * Returned in time order.
 */
export function rankSlots(windows: Interval[], preferences: SlotPreferences): Array<Interval & { score: number }> {
  const duration = preferences.durationMin * 60_000;
  const earliest = Math.ceil((preferences.now + (preferences.leadMin ?? 60) * 60_000) / HALF_HOUR) * HALF_HOUR;
  const today = localDate(preferences.now, preferences.timeZone);
  const candidates: Array<{ start: number; end: number; date: string; score: number }> = [];
  for (const window of windows) {
    const first = Math.ceil(Math.max(window.start, earliest) / HALF_HOUR) * HALF_HOUR;
    const latest = window.end - duration;
    for (let start = first, steps = 0; start <= latest && steps < 48; start += HALF_HOUR, steps += 1) {
      const date = localDate(start, preferences.timeZone);
      const distance = Math.abs(localMinutes(start, preferences.timeZone) - preferences.preferredMin);
      const dayPenalty = preferences.preferredDays.includes(dayOfWeek(date)) ? 0 : 45;
      const score = distance + dayPenalty + daysBetween(today, date) * 15;
      candidates.push({ start, end: start + duration, date, score });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.start - b.start);
  const chosen: typeof candidates = [];
  for (const candidate of candidates) {
    if (chosen.length >= preferences.count) break;
    if (!chosen.some((pick) => pick.date === candidate.date)) chosen.push(candidate);
  }
  for (const candidate of candidates) {
    if (chosen.length >= preferences.count) break;
    if (chosen.includes(candidate)) continue;
    if (chosen.every((pick) => Math.abs(pick.start - candidate.start) >= 90 * 60_000)) chosen.push(candidate);
  }
  return chosen.map(({ start, end, score }) => ({ start, end, score })).sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Chat formatting ("Fri 8pm", "Sat 7:30–10pm")

const formatters = new Map<string, Intl.DateTimeFormat>();
function clockFormatter(timeZone: string, kind: "parts" | "clock" | "weekday" | "monthDay"): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const options: Intl.DateTimeFormatOptions = kind === "parts" ? { hour: "numeric", minute: "numeric", hourCycle: "h23" }
      : kind === "clock" ? { hour: "numeric", minute: "2-digit", hour12: true }
        : kind === "weekday" ? { weekday: "short" }
          : { month: "short", day: "numeric" };
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** "8pm", "7:30pm". */
export function formatClock(instant: number, timeZone: string, withPeriod = true): string {
  const parts = clockFormatter(timeZone, "clock").formatToParts(new Date(instant));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const period = (parts.find((part) => part.type === "dayPeriod")?.value ?? "").toLowerCase();
  return `${hour}${minute === "00" ? "" : `:${minute}`}${withPeriod ? period : ""}`;
}

function periodOf(instant: number, timeZone: string): string {
  return (clockFormatter(timeZone, "clock").formatToParts(new Date(instant)).find((part) => part.type === "dayPeriod")?.value ?? "").toLowerCase();
}

/** "Today", "Tomorrow", "Fri" (within 6 days), otherwise "Fri Oct 30". */
export function formatDay(date: string, today: string): string {
  const delta = daysBetween(today, date);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const instant = Date.UTC(y, m - 1, d, 12);
  const weekday = clockFormatter("UTC", "weekday").format(instant);
  if (delta > 1 && delta < 7) return weekday;
  return `${weekday} ${clockFormatter("UTC", "monthDay").format(instant)}`;
}

/** "Fri 8pm" or, with an end, "Fri 8–10:30pm". */
export function formatSlot(start: number, end: number | null, timeZone: string, today: string): string {
  const day = formatDay(localDate(start, timeZone), today);
  if (end === null) return `${day} ${formatClock(start, timeZone)}`;
  const samePeriod = periodOf(start, timeZone) === periodOf(end, timeZone);
  return `${day} ${formatClock(start, timeZone, !samePeriod)}–${formatClock(end, timeZone)}`;
}

/** Chat label for an occurrence: "Sat 10am", "Fri–Sun", "Nov 1 (all day)". */
export function formatOccurrence(occurrence: Occurrence, allDay: boolean, timeZone: string, today: string, withEnd = false): string {
  if (!allDay) return formatSlot(occurrence.start, withEnd ? occurrence.end : null, timeZone, today);
  const first = formatDay(occurrence.date, today);
  if (occurrence.endDate === occurrence.date) return first;
  return `${first}–${formatDay(occurrence.endDate, today)}`;
}
