// Pure helpers for the House section (src/house.ts): the info-card kinds and secret masking, and the group-chat
// phrases for house info, repairs, guests, quiet hours, quick polls, votes, and guest reactions. No I/O and no
// clocks: callers pass "today" (YYYY-MM-DD) and the local minutes now, so everything is testable offline.
import { addDays, dayOfWeek } from "./availability.js";
import { nextWeekdayDate, parseWhen, weekdayIndex } from "./eventsParse.js";

// ---------------------------------------------------------------------------
// Info cards

export type CardKind = "wifi" | "door" | "rules" | "landlord" | "trash" | "emergency" | "note";
export type FieldSpec = { key: string; label: string; secret?: boolean; multiline?: boolean; type?: "text" | "tel" | "email"; placeholder?: string };
export type KindSpec = { label: string; emoji: string; fields: FieldSpec[] };

export const CARD_KINDS: Record<CardKind, KindSpec> = {
  wifi: { label: "Wi-Fi", emoji: "📶", fields: [{ key: "network", label: "Network", placeholder: "Network name" }, { key: "password", label: "Password", secret: true }] },
  door: { label: "Door code", emoji: "🔑", fields: [{ key: "code", label: "Code", secret: true }, { key: "note", label: "Note", placeholder: "e.g. press # after" }] },
  trash: { label: "Trash day", emoji: "🗑️", fields: [{ key: "trash", label: "Trash", placeholder: "e.g. Tuesday night" }, { key: "recycling", label: "Recycling", placeholder: "e.g. Every other Thursday" }] },
  landlord: { label: "Landlord", emoji: "🏢", fields: [{ key: "name", label: "Name" }, { key: "phone", label: "Phone", type: "tel" }, { key: "email", label: "Email", type: "email" }, { key: "note", label: "Note", multiline: true }] },
  rules: { label: "House rules", emoji: "📜", fields: [{ key: "text", label: "Rules", multiline: true, placeholder: "One rule per line" }] },
  emergency: { label: "Emergency", emoji: "🚨", fields: [{ key: "text", label: "Info", multiline: true, placeholder: "Shutoffs, breaker panel, emergency numbers" }] },
  note: { label: "Note", emoji: "📝", fields: [{ key: "text", label: "Note", multiline: true }] },
};

export const CARD_KIND_ORDER: readonly CardKind[] = ["wifi", "door", "trash", "landlord", "rules", "emergency", "note"];

export function isCardKind(value: unknown): value is CardKind {
  return typeof value === "string" && Object.hasOwn(CARD_KINDS, value);
}

export const SECRET_MASK = "••••••••";

/** Masks a secret without revealing its length; empty stays empty. */
export function maskSecret(value: string | null | undefined): string {
  return value ? SECRET_MASK : "";
}

export function secretKeys(kind: CardKind): string[] {
  return CARD_KINDS[kind].fields.filter((field) => field.secret).map((field) => field.key);
}

/** A card's fields with every secret replaced by the mask (what pages, GET JSON, and tools see by default). */
export function maskFields(kind: CardKind, fields: Record<string, string>): Record<string, string> {
  const secrets = new Set(secretKeys(kind));
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, secrets.has(key) ? maskSecret(value) : value]));
}

/** "Tonight" / "Tomorrow" / "Today" when a trash-day text names this weekday or the next one. */
export function trashHint(text: string, today: string, nowMin: number): string | null {
  const match = text.toLowerCase().match(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?\b/);
  if (!match) return null;
  const weekday = weekdayIndex(match[1]!);
  if (weekday < 0) return null;
  const delta = (weekday - dayOfWeek(today) + 7) % 7;
  const night = /\bnight|evening|eve\b/.test(text.toLowerCase());
  if (delta === 0) return night || nowMin >= 17 * 60 ? "Tonight" : "Today";
  if (delta === 1) return "Tomorrow";
  return null;
}

// ---------------------------------------------------------------------------
// Small text helpers

export function normalizeText(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim();
}

export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const STOP = new Set(["the", "a", "an", "our", "my", "is", "are", "in", "on", "of", "to", "and", "it", "its", "this", "that", "again", "still", "please", "now", "just", "finally"]);

/** Lowercase content words with a light plural/verb stem, for matching "fixed faucet" to "Kitchen faucet leaking". */
export function keywords(text: string): string[] {
  return normalizeText(text).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/)
    .map((word) => word.replace(/'s$/, "").replace(/(?<=\w{3})(?:ing|ed|es|s)$/, ""))
    .filter((word) => word.length > 1 && !STOP.has(word));
}

/** Words of `query` found in `title` (prefix matches of 4+ letters count). */
export function matchScore(query: string, title: string): number {
  const words = keywords(title);
  return keywords(query).filter((word) => words.some((candidate) => candidate === word || (word.length >= 4 && (candidate.startsWith(word) || word.startsWith(candidate)) && candidate.length >= 4))).length;
}

const FIXTURES = /\b(faucet|tap|sink|toilet|shower|tub|bath(?:tub)?|drain|dishwasher|washer|washing machine|dryer|fridge|refrigerator|freezer|ice maker|oven|stove|range|microwave|disposal|garbage disposal|heater|heat|heating|radiator|a\/?c|air ?conditioning|aircon|furnace|thermostat|lights?|bulb|lamp|outlet|switch|breaker|door|lock|window|blinds|garage|smoke detector|detector|alarm|wi-?fi|router|internet|pipes?|leak|ceiling|floor|wall|fan|vent|hot water|water heater|doorbell|buzzer|intercom|elevator|mailbox|cabinet|drawer|closet|tiles?|hood|hinge|screen|gutter|roof|sprinkler|bathroom|kitchen)\b/i;

/** Short word to refer to a repair in hints ("fixed faucet"); a fixture beats a room ("kitchen"). */
export function repairKey(title: string): string {
  const found = [...title.matchAll(new RegExp(FIXTURES.source, "gi"))].map((match) => match[1]!.toLowerCase());
  const fixture = found.find((word) => word !== "kitchen" && word !== "bathroom") ?? found[0];
  if (fixture) return fixture;
  return keywords(title).find((word) => word.length > 3) ?? title.toLowerCase().split(" ")[0] ?? "it";
}

// ---------------------------------------------------------------------------
// Group-chat commands (stateless shape; src/house.ts decides with state)

export type InfoTopic = "wifi" | "door" | "rules" | "landlord" | "trash" | "emergency" | "overview";

export type HouseCommand =
  | { kind: "info"; topic: InfoTopic; hint?: string }
  | { kind: "repair.list" }
  | { kind: "repair.new"; title: string }
  | { kind: "repair.fixed"; query: string }
  | { kind: "repair.reported"; query: string }
  | { kind: "repair.assign"; query: string; who: string }
  | { kind: "poll.new"; question: string; options: string[] }
  | { kind: "poll.invalid"; error: string }
  | { kind: "poll.list" }
  | { kind: "poll.close"; hint: string | null };

/** House info, repair, and poll phrases. Guests, quiet hours, votes, and reactions need context (see below). */
export function parseHouseCommand(raw: string): HouseCommand | null {
  const text = normalizeText(raw);
  if (!text || text.length > 300) return null;
  const t = text.toLowerCase();
  let match: RegExpMatchArray | null;

  // House info
  if (/^(?:what(?:'s| is)\s+)?(?:the\s+|our\s+)?(?:wi-?fi|wireless)(?:\s+(?:password|pw|pass|info|network|name|details|code|login))?(?:\s+again)?(?:\s+please)?\s*[?!.]*$/.test(t)) return { kind: "info", topic: "wifi" };
  if ((match = t.match(/^(?:what(?:'s| is)\s+)?(?:the\s+|our\s+)?((?:front|back|side|main|building|apartment|garage)\s+)?(door|gate|lockbox|lock box|garage|building|entry|keypad|alarm)\s+code(?:\s+again)?(?:\s+please)?\s*[?!.]*$/))) {
    return { kind: "info", topic: "door", hint: `${match[1] ?? ""}${match[2]}`.trim() };
  }
  if (/^(?:what are\s+)?(?:the\s+|our\s+)?house\s+rules[?!.]*$/.test(t)) return { kind: "info", topic: "rules" };
  if (/^(?:who(?:'s| is)\s+)?(?:the\s+|our\s+)?(?:landlord|property manager|building manager|super|management)(?:'s)?(?:\s+(?:contact|info|number|phone|phone number|email|details))?\s*[?!.]*$/.test(t)) return { kind: "info", topic: "landlord" };
  if (/^(?:when(?:'s| is)\s+)?(?:the\s+)?(?:trash|garbage|recycling|bins?|rubbish)(?:\s+(?:and|&)\s+recycling)?\s+(?:day|night|pickup|pick-up|collection)s?\s*[?!.]*$/.test(t)) return { kind: "info", topic: "trash" };
  if (/^(?:emergency|emergency info|emergency contacts?|in case of emergency|ice)[?!.]*$/.test(t)) return { kind: "info", topic: "emergency" };
  if (/^(?:house|house info|house board|house stuff)[?!.]*$/.test(t)) return { kind: "info", topic: "overview" };

  // Quick polls
  if ((match = text.match(/^(?:quick\s+)?poll\s*[:\-–—]\s*(.+)$/i)) || (match = text.match(/^(?:quick\s+poll|(?:new|start|create)\s+(?:a\s+)?(?:quick\s+)?poll\s*[:\-–—]?)\s+(.+)$/i))) {
    const built = buildPoll(match[1]!);
    return "error" in built ? { kind: "poll.invalid", error: built.error } : { kind: "poll.new", question: built.question, options: built.options };
  }
  if (/^(?:polls|open polls|show polls|any polls|active polls|house polls|quick polls)[?!.]*$/.test(t)) return { kind: "poll.list" };
  if ((match = t.match(/^(?:close|end|stop|finish)\s+(?:the\s+)?(?:(.+?)\s+)?poll[.!]*$/))) return { kind: "poll.close", hint: match[1] ?? null };

  // Repairs
  if (/^(?:repairs|maintenance|maintenance requests|repair requests|open repairs|what'?s broken|broken stuff|fix(?:-|\s)?it list|repair list)[?!.]*$/.test(t)) return { kind: "repair.list" };
  const created = parseRepairNew(text);
  if (created) return { kind: "repair.new", title: created };
  if ((match = t.match(/^(?:i\s+|we\s+)?(?:just\s+|finally\s+)?(?:fixed|repaired)\s+(?:the\s+|our\s+|my\s+)?(.+?)[.!]*$/))
    || (match = t.match(/^(?:the\s+|our\s+|my\s+)?(.+?)\s+(?:is|are|was|were|got|has been|have been|'s)\s+(?:finally\s+|all\s+)?(?:fixed|repaired|working again)[.!]*$/))
    || (match = t.match(/^(?:the\s+|our\s+)?(.+?)\s+(?:fixed|repaired)[.!]*$/))
    || (match = t.match(/^(?:close|resolve)\s+(?:repair|request|ticket)\s*(#?\d+)[.!]*$/))) {
    return { kind: "repair.fixed", query: match[1]!.trim() };
  }
  if ((match = t.match(/^(?:i\s+)?(?:told|texted|emailed|called|messaged)\s+(?:the\s+)?(?:landlord|property manager|management|super)\s+about\s+(?:the\s+)?(.+?)[.!]*$/))
    || (match = t.match(/^(?:i\s+|we\s+)?(?:reported|flagged)\s+(?:the\s+|our\s+)?(.+?)(?:\s+to\s+(?:the\s+)?(?:landlord|property manager|management|super|building))?[.!]*$/))) {
    return { kind: "repair.reported", query: match[1]!.trim() };
  }
  if ((match = t.match(/^(?:i'?ll|i will|i can|i'?m going to|let me)\s+(?:handle|fix|take care of|deal with|look at|call about|sort out)\s+(?:the\s+)?(.+?)[.!]*$/))) return { kind: "repair.assign", query: match[1]!, who: "me" };
  if ((match = t.match(/^assign\s+(?:the\s+)?(.+?)\s+to\s+([\p{L}' -]+?)[.!]*$/u))) return { kind: "repair.assign", query: match[1]!, who: match[2]! };
  return null;
}

/** "broken: kitchen faucet leaking", "leaky faucet", "the dishwasher won't drain" → a repair title. */
export function parseRepairNew(raw: string): string | null {
  const text = normalizeText(raw);
  let match: RegExpMatchArray | null;
  const title = (value: string) => {
    const clean = value.replace(/\s*[.!]+$/, "").replace(/\s+/g, " ").trim().slice(0, 80);
    return clean.length >= 2 ? capitalize(clean) : null;
  };
  if ((match = text.match(/^(?:broken|repair|fix|maintenance|issue|problem|fix needed)\s*[:\-–—]\s*(.+)$/i))) return title(match[1]!);
  if ((match = text.match(/^((?:broken|leaking|leaky|clogged|busted|jammed)\s+.+)$/i))) return title(match[1]!);
  const natural = text.match(/^(?:the|our|my)\s+(.{2,40}?)\s+(?:is|are|'s|seems(?: to be)?|keeps|kept)\s+(?:(?:still|totally|completely|kinda|kind of|so|really)\s+)?(broken|leaking|clogged|not working|busted|jammed|flickering|dripping|stuck|making (?:a )?(?:weird |loud |strange )?noises?)\b(.*)$/i)
    ?? text.match(/^(?:the|our|my)\s+(.{2,40}?)\s+(won'?t|doesn'?t|isn'?t|can'?t|stopped|keeps)\s+(\w.*)$/i);
  if (natural && FIXTURES.test(natural[1]!)) return title(`${natural[1]} ${natural[2]}${natural[3] ? ` ${natural[3].trim()}` : ""}`.replace(/\s+/g, " "));
  return null;
}

// ---------------------------------------------------------------------------
// Quick polls

const LEADING_FILLER = /^(?:to|the|a|an|at|for|with|go|get|have|order|do|on|in|from)\s+/i;

function cleanOption(value: string): string {
  return capitalize(value.replace(/^\s*(?:or|and)\s+/i, "").replace(/[?.!]+$/, "").replace(/\s+/g, " ").trim()).slice(0, 40);
}

/** "takeout tonight? thai, pizza, sushi" / "thermostat 68 or 70?" / "get a cleaner?" → question + 2–6 options. */
export function buildPoll(raw: string): { question: string; options: string[] } | { error: string } {
  const body = normalizeText(raw);
  let question = body;
  let rest = "";
  const asked = body.match(/^(.*?\?)\s*(\S.*)$/);
  const titled = asked ? null : body.match(/^(.+?)\s*(?::\s+|\s[-–—]\s+)(\S.+)$/);
  if (asked) { question = asked[1]!; rest = asked[2]!; } else if (titled) { question = titled[1]!; rest = titled[2]!; }
  let options: string[];
  if (rest) {
    options = rest.split(/\s*(?:,|\/|;|\||\bor\b)\s*/i);
  } else {
    const inline = question.replace(/\?+$/, "");
    if (/\bor\b|,|\//i.test(inline)) {
      const parts = inline.split(/\s*(?:,|\/|\bor\b)\s*/i).filter(Boolean);
      const others = parts.slice(1);
      const longest = Math.max(1, ...others.map((part) => part.split(" ").length));
      const firstWords = (parts[0] ?? "").split(" ");
      let first = firstWords.length > longest ? firstWords.slice(-longest).join(" ") : parts[0] ?? "";
      while (LEADING_FILLER.test(first) && first.replace(LEADING_FILLER, "")) first = first.replace(LEADING_FILLER, "");
      options = [first, ...others];
    } else {
      options = ["Yes", "No"];
    }
  }
  const seen = new Set<string>();
  options = options.map(cleanOption).filter((option) => option && !seen.has(option.toLowerCase()) && seen.add(option.toLowerCase()));
  question = capitalize(question.replace(/\s+/g, " ").trim()).slice(0, 120);
  if (!question) return { error: "What’s the question? e.g. “poll: takeout tonight? thai, pizza, sushi”." };
  if (!/[?.!]$/.test(question)) question += "?";
  if (options.length < 2) return { error: "Give at least two options, e.g. “poll: takeout tonight? thai, pizza, sushi”." };
  if (options.length > 6) return { error: "Keep it to 6 options or fewer." };
  return { question, options };
}

export type VoteText = { kind: "number"; option: number } | { kind: "multi" } | { kind: "text"; text: string };

/** "2", "#2", "option 2", "I vote 2", "vote pizza" → a vote; "1 3" is several numbers (one pick per person here). */
export function parseVoteText(raw: string): VoteText | null {
  const text = normalizeText(raw).toLowerCase();
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^(?:(?:i\s+)?(?:vote|pick|choose|go with|want)\s+(?:for\s+)?)?(?:option\s+|number\s+|#)?(\d{1,2})(?:\s+(?:please|pls|for me))?\s*[.!]*$/))) return { kind: "number", option: Number(match[1]) };
  if (/^#?\d{1,2}(?:\s*(?:,|&|\+|\band\b|\s)\s*#?\d{1,2})+\s*[.!]*$/.test(text)) return { kind: "multi" };
  if ((match = text.match(/^(?:i\s+)?(?:vote|pick|choose|go with)\s+(?:for\s+)?(.+?)[.!]*$/)) && !/^\d/.test(match[1]!)) return { kind: "text", text: match[1]! };
  return null;
}

// ---------------------------------------------------------------------------
// Guest reactions ("ok" / "concern" after a heads-up)

export function parseReaction(raw: string): { reaction: "ok" | "concern"; note: string | null } | null {
  const text = normalizeText(raw);
  if (/^(?:ok|okay|👍(?:[\u{1F3FB}-\u{1F3FF}])?|sounds good|all good|fine by me|no problem|np|works for me|totally fine|ok with me|okay with me)[!.]*$/iu.test(text)) return { reaction: "ok", note: null };
  const concern = text.match(/^(?:concern|concerned|i have a concern|not ok|not okay|👎(?:[\u{1F3FB}-\u{1F3FF}])?|hmm,? concern|that'?s a problem)(?:\s*[:,\-–—]\s*(.+?))?[.!]*$/iu);
  if (concern) return { reaction: "concern", note: concern[1] ? concern[1].slice(0, 200) : null };
  return null;
}

// ---------------------------------------------------------------------------
// Guests ("having friends over Fri 8pm", "my sister is staying Sat–Sun")

export type GuestRequest = {
  who: string;
  title: string;
  date: string;
  endDate: string | null;
  /** Minutes after midnight; null = all day. */
  startMin: number | null;
  durationMin: number | null;
};

const PEOPLE = /^(?:(?:some|a few|a couple(?: of)?|a bunch of|two|three|four|a)\s+)?(?:friends?|people|guests?|family|relatives|visitors?|folks|coworkers|classmates)$/i;
const NAME = /^\p{Lu}[\p{L}'-]+(?:\s+(?:and|&)\s+\p{Lu}[\p{L}'-]+)?$/u;

const NOT_GUESTS = /^(?:it|this|that|he|she|they|we|i|you|everyone|everybody|nobody|no one|there|here|who|what|which|the\s.+)$/i;

function guestWho(who: string, senderName: string): string | null {
  const clean = who.replace(/\s+/g, " ").trim();
  if (NOT_GUESTS.test(clean)) return null;
  if (/^(?:my|our)\s+[\p{L}' -]{2,30}$/iu.test(clean)) {
    const rest = clean.replace(/^(?:my|our)\s+/i, "");
    return /^our\s/i.test(clean) ? `Our ${rest}` : `${senderName}’s ${rest}`;
  }
  if (PEOPLE.test(clean)) {
    const noun = /people|folks|guests?|visitors?/i.test(clean) ? "guests" : /family|relatives/i.test(clean) ? "family" : clean.replace(/^(?:some|a few|a couple(?: of)?|a bunch of|two|three|four|a)\s+/i, "").toLowerCase();
    return `${senderName}’s ${noun === "friend" ? "friend" : noun}`;
  }
  if (NAME.test(clean)) return clean;
  return null;
}

/**
 * Guest heads-ups → who, title, and when. Null when the text isn't one (or names a household member);
 * `date` is "" when no day or time was given (the caller asks when).
 */
export function parseGuest(raw: string, today: string, nowMin: number, senderName: string, memberNames: string[] = []): GuestRequest | null {
  let text = normalizeText(raw).replace(/^(?:heads[- ]?up|fyi|just so you know|jsyk|so)\s*[:,!.\-–—]*\s*/i, "");
  if (!text || text.length > 200) return null;
  let match: RegExpMatchArray | null;
  let who = "";
  let verb = "over";
  let rest = "";
  if ((match = text.match(/^(?:i'?m|we'?re|i am|we are|i'?ll be|we'?ll be|i'?m going to be|gonna be)?\s*having\s+(.+?)\s+over\b(.*)$/i))) {
    who = match[1]!; rest = match[2]!;
  } else if ((match = text.match(/^(?:guests?|visitors?)\s*[:\-–—]\s*(.+)$/i))) {
    const when = parseWhen(match[1]!, today, nowMin);
    who = when.title && guestWho(when.title, senderName) ? when.title : "guests";
    rest = match[1]!;
  } else if ((match = text.match(/^(.+?)\s+(?:is|are|'s|'re|will be)\s+(staying(?:\s+over)?|sleeping\s+over|crashing(?:\s+(?:here|over))?|visiting|coming\s+(?:over|to\s+visit|to\s+stay|by)|in\s+town|stopping\s+by)\b(.*)$/i))) {
    who = match[1]!; rest = match[3]!;
    const raw = match[2]!.toLowerCase();
    verb = /stay|sleep|crash/.test(raw) ? "staying" : /visit|in town/.test(raw) ? "visiting" : /by/.test(raw) ? "stopping by" : "coming over";
  } else if ((match = text.match(/^((?:(?:some|a few|a couple(?: of)?)\s+)?(?:friends?|people|guests?|family|visitors?))\s+(?:are\s+|is\s+)?(?:coming\s+)?over\b(.*)$/i))) {
    who = match[1]!; rest = match[2]!;
  } else {
    return null;
  }
  if (memberNames.some((name) => name.toLowerCase() === who.trim().toLowerCase() || name.split(/\s+/)[0]!.toLowerCase() === who.trim().toLowerCase())) return null;
  const label = guestWho(who, senderName);
  if (!label) return null;
  const title = `${label} ${verb}`.slice(0, 60);

  let date: string | null = null;
  let endDate: string | null = null;
  let startMin: number | null = null;
  let durationMin: number | null = null;
  const lower = rest.toLowerCase();
  if (/\b(?:this|the|next)?\s*weekend\b/.test(lower)) {
    const dow = dayOfWeek(today);
    const saturday = dow === 6 ? today : dow === 0 ? addDays(today, -1) : addDays(today, 6 - dow);
    const start = /\bnext weekend\b/.test(lower) ? addDays(saturday, 7) : saturday;
    date = dow === 0 && !/\bnext\b/.test(lower) ? today : start;
    endDate = dow === 0 && !/\bnext\b/.test(lower) ? today : addDays(start, 1);
  } else {
    const when = parseWhen(rest, today, nowMin);
    date = when.date;
    endDate = when.endDate;
    startMin = when.startMin;
    durationMin = when.durationMin;
  }
  if (!date) return { who: label, title, date: "", endDate: null, startMin: null, durationMin: null };
  if (verb === "staying") { startMin = null; durationMin = null; }
  if (startMin === null) endDate = endDate && endDate >= date ? endDate : date;
  else endDate = null;
  return { who: label, title, date, endDate, startMin, durationMin: startMin === null ? null : durationMin ?? 180 };
}

// ---------------------------------------------------------------------------
// Quiet hours

export type QuietDefault = { enabled: boolean; startMin: number; endMin: number; nights: number[] };
export const DEFAULT_QUIET: QuietDefault = { enabled: true, startMin: 23 * 60, endMin: 8 * 60, nights: [0, 1, 2, 3, 4] };

export type QuietCommand =
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "default"; startMin: number; endMin: number; nights: number[] | null }
  | { kind: "default.invalid" }
  /** startMin/endMin count from midnight of `date` (they may pass 1440 for after midnight); null = household default. */
  | { kind: "adhoc"; date: string; startMin: number | null; endMin: number | null; reason: string | null };

/** "11pm", "10:30pm", "midnight". */
export function clockLabel(minutes: number): string {
  const total = ((minutes % 1440) + 1440) % 1440;
  if (total === 0) return "midnight";
  if (total === 720) return "noon";
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${hour < 12 ? "am" : "pm"}`;
}

const NIGHT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function nightsLabel(nights: readonly number[]): string {
  const set = [...new Set(nights)].filter((n) => n >= 0 && n <= 6).sort();
  if (set.length === 7) return "Every night";
  if (set.join() === "0,1,2,3,4") return "Weeknights";
  if (set.join() === "5,6") return "Fri & Sat nights";
  if (!set.length) return "No nights";
  return `${set.map((n) => NIGHT_NAMES[n]).join(", ")} nights`;
}

type Clock = { hour: number; minute: number; meridiem: string | null };

function clock(hour: string, minute: string | undefined, meridiem: string | undefined): Clock | null {
  const h = Number(hour);
  const m = Number(minute ?? 0);
  if (!Number.isInteger(h) || h > 23 || m > 59) return null;
  const mer = meridiem ? meridiem.replace(/\./g, "").toLowerCase() : null;
  if (mer && (h < 1 || h > 12)) return null;
  return { hour: h, minute: m, meridiem: mer };
}

/** A quiet-hours start, in minutes from midnight of the evening it belongs to (after midnight → 1440+). */
function startMinutes(value: Clock): number {
  const { hour, minute, meridiem } = value;
  if (meridiem === "pm") return ((hour % 12) + 12) * 60 + minute;
  if (meridiem === "am") return hour === 12 || hour <= 5 ? 1440 + (hour % 12) * 60 + minute : hour * 60 + minute;
  if (hour >= 13) return hour * 60 + minute;
  if (hour === 0 || hour === 12) return 1440 + minute;
  if (hour <= 5) return 1440 + hour * 60 + minute;
  return (hour + 12) * 60 + minute;
}

/** A quiet-hours end after `start` (bare hours are morning). */
function endMinutes(value: Clock, start: number): number {
  const { hour, minute, meridiem } = value;
  let minutes = meridiem === "pm" ? ((hour % 12) + 12) * 60 + minute : meridiem === "am" ? (hour % 12) * 60 + minute : hour >= 13 ? hour * 60 + minute : (hour % 12) * 60 + minute;
  while (minutes <= start) minutes += 1440;
  return minutes;
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
const RANGE = new RegExp(String.raw`\b(?:from\s+)?${TIME}\s*(?:-|–|—|to|until|till|til|through)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?!\d)`, "i");
const START = new RegExp(String.raw`\b(?:from|after|at|starting(?:\s+at)?|beginning\s+at|by|past)\s+(?:about\s+|around\s+)?${TIME}(?!\d)`, "i");
const BARE_START = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?!\w)/i;
const END = new RegExp(String.raw`\b(?:until|till|til)\s+${TIME}(?!\d)`, "i");
const DAY_ONLY = /^(?:tonight|today|tomorrow(?:\s+night)?|(?:on\s+|this\s+|next\s+)?(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?(?:\s+night)?)$/i;

function dayFrom(text: string, today: string, tonight: string): string | null {
  const t = text.toLowerCase();
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\b(?:tonight|today)\b/.test(t)) return tonight;
  const weekday = t.match(/\b(?:(next)\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?\b/);
  if (weekday) return nextWeekdayDate(today, weekdayIndex(weekday[2]!), { strict: Boolean(weekday[1]) });
  return null;
}

function nightsFrom(text: string): number[] | null {
  const t = text.toLowerCase();
  if (/\b(?:every ?night|nightly|daily|all week|every day)\b/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  if (/\b(?:week ?nights|weekdays|school nights)\b/.test(t)) return [0, 1, 2, 3, 4];
  if (/\bweekends?\b/.test(t)) return [5, 6];
  return null;
}

function cleanReason(text: string): string | null {
  let reason = text.replace(/[\s,;:\-–—]+$/, "").trim();
  const filler = /^(?:hey|hi|guys|all|y'?all|everyone|folks|so|also|and|please|pls|can we|could we|can you|could you|let'?s|lets|we need|i need|need|have|having|some|keep it|keep things|it|be)\b[\s,]*/i;
  while (filler.test(reason)) reason = reason.replace(filler, "");
  reason = reason.replace(/[\s,;:\-–—]*(?:\bso\b|\band\b|\bplease\b|\bpls\b)?[\s,;:\-–—]*$/i, "").trim();
  if (reason.length < 3 || DAY_ONLY.test(reason)) return null;
  return capitalize(reason).slice(0, 80);
}

/**
 * "quiet hours tonight from 10pm", "exam tomorrow, quiet please after 9", "quiet hours" (status),
 * "set quiet hours 11pm-7am weeknights" (household default), "cancel quiet hours".
 */
export function parseQuiet(raw: string, today: string, nowMin: number): QuietCommand | null {
  const text = normalizeText(raw);
  const t = text.toLowerCase();
  if (!/\bquiet\b/.test(t) || text.length > 200) return null;
  if (/^(?:when (?:are|is)\s+)?(?:the\s+|our\s+)?quiet (?:hours|time)\s*[?!.]*$/.test(t)) return { kind: "status" };
  if (/^(?:cancel|end|stop|skip|turn off|no|never ?mind)\s+(?:the\s+)?quiet (?:hours|time)(?:\s+tonight)?[.!]*$/.test(t)) return { kind: "cancel" };
  const tonight = nowMin < 6 * 60 ? addDays(today, -1) : today;

  let match = t.match(/^(?:set|change|make|update)\s+(?:the\s+|our\s+)?(?:default\s+|usual\s+|house\s+|regular\s+)?quiet (?:hours|time)\s+(?:to\s+)?(.+)$/);
  if (match) {
    const range = match[1]!.match(RANGE);
    if (!range) return { kind: "default.invalid" };
    const start = clock(range[1]!, range[2], range[3]);
    const end = clock(range[4]!, range[5], range[6]);
    if (!start || !end) return { kind: "default.invalid" };
    const startMin = startMinutes(start) % 1440;
    return { kind: "default", startMin, endMin: endMinutes(end, startMinutes(start)) % 1440, nights: nightsFrom(match[1]!) };
  }

  const index = t.search(/\bquiet\b/);
  const before = text.slice(0, index).trim();
  const after = text.slice(index + 5);
  const hasCue = /^\s*(?:hours|time|please|pls|after|from|by|starting|tonight|tomorrow|at)\b/i.test(after) || RANGE.test(after) || START.test(after);
  if (!hasCue) return null;
  const beforeIsDay = DAY_ONLY.test(before.replace(/[\s,;:\-–—]+$/, ""));
  const date = dayFrom(after, today, tonight) ?? (beforeIsDay ? dayFrom(before, today, tonight) : null) ?? tonight;
  const reason = beforeIsDay ? null : cleanReason(before);

  let startMin: number | null = null;
  let endMin: number | null = null;
  const range = after.match(RANGE);
  if (range) {
    const start = clock(range[1]!, range[2], range[3]);
    const end = clock(range[4]!, range[5], range[6]);
    if (start && end) {
      // "10-7am": the start takes the evening reading unless it says am.
      startMin = startMinutes(start);
      endMin = endMinutes(end, startMin);
    }
  }
  if (startMin === null) {
    const start = after.match(START) ?? after.match(BARE_START);
    if (start) {
      const value = clock(start[1]!, start[2], start[3]);
      if (value) startMin = startMinutes(value);
    } else if (/\b(?:from|after|at)\s+midnight\b/i.test(after)) {
      startMin = 1440;
    }
    const end = after.match(END);
    if (end && startMin !== null) {
      const value = clock(end[1]!, end[2], end[3]);
      if (value) endMin = endMinutes(value, startMin);
    }
  }
  if (startMin === null && !/\b(?:tonight|tomorrow)\b/i.test(after) && !beforeIsDay) return null;
  return { kind: "adhoc", date, startMin, endMin, reason };
}
