// Group-chat parsing for bills: amounts, due dates, categories, and commands. Pure
// functions (no I/O) so they can be checked offline. Dates are local calendar dates
// in YYYY-MM-DD form.

export const BILL_CATEGORIES = ["rent", "utilities", "internet", "groceries", "household", "other"] as const;
export type BillCategory = (typeof BILL_CATEGORIES)[number];

export const CATEGORY_EMOJI: Record<BillCategory, string> = {
  rent: "🏠",
  utilities: "⚡",
  internet: "📶",
  groceries: "🛒",
  household: "🧻",
  other: "🧾",
};

export const CATEGORY_LABEL: Record<BillCategory, string> = {
  rent: "Rent",
  utilities: "Utilities",
  internet: "Internet",
  groceries: "Groceries",
  household: "Household",
  other: "Other",
};

const CATEGORY_KEYWORDS: Array<[BillCategory, RegExp]> = [
  ["rent", /\b(rent|landlord|lease|apartment|apt|property|hoa|mortgage)\b/i],
  ["internet", /\b(internet|wi-?fi|broadband|comcast|xfinity|spectrum|fios|verizon|at&t|att|sonic|starlink|centurylink|cox|optimum|frontier|google fiber|t-mobile home|ziply|astound|wave)\b/i],
  ["utilities", /\b(utilit(y|ies)|electric(ity)?|power|energy|pg&e|pge|edison|con ?ed|duke|dominion|national grid|xcel|water|sewer|trash|garbage|recycling|gas|heating|puget|seattle city light|scl|ladwp|dwp)\b/i],
  ["groceries", /\b(grocer(y|ies)|costco|kroger|safeway|trader joe'?s?|whole foods|walmart|target|aldi|qfc|fred meyer|wegmans|publix|h-?e-?b|sprouts|food|market|instacart)\b/i],
  ["household", /\b(household|cleaning|supplies|toilet paper|paper towels?|detergent|ikea|amazon|home depot|lowe'?s|furniture|repair|plumber|cleaner)\b/i],
];

export function inferCategory(text: string): BillCategory {
  for (const [category, pattern] of CATEGORY_KEYWORDS) if (pattern.test(text)) return category;
  return "other";
}

export function isCategory(value: unknown): value is BillCategory {
  return typeof value === "string" && (BILL_CATEGORIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

const AMOUNT_RE = /(?:^|[\s(])(\$|usd\s?)?\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\.\d{1,2})(?:\s?(dollars?|bucks|usd))?(?=$|[\s),.!?;:])/gi;

/** Finds the most likely money amount: a "$" amount first, then one with cents, then the last number. */
export function findAmount(text: string): { cents: number; start: number; end: number } | null {
  const source = ` ${text}`;
  const matches = [...source.matchAll(AMOUNT_RE)].flatMap((match) => {
    const cents = decimalToCents(match[2]!);
    return cents === null ? [] : [{ cents, start: Math.max(0, match.index - 1), end: match.index - 1 + match[0].length, marked: Boolean(match[1] || match[3]), decimal: match[2]!.includes(".") }];
  });
  const best = matches.find((match) => match.marked) ?? matches.find((match) => match.decimal) ?? matches[matches.length - 1];
  return best ? { cents: best.cents, start: best.start, end: best.end } : null;
}

/** Parses "$1,234.5" / "80" / "80 dollars" into cents. Returns null when there is no amount. */
export function parseAmountCents(text: string): number | null {
  return findAmount(text)?.cents ?? null;
}

/** Strict decimal string ("1234.56", "$1,234.56") to integer cents; null if malformed. */
export function decimalToCents(value: string): number | null {
  const cleaned = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^(\d{1,9}(\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) return null;
  const [whole = "0", fraction = ""] = cleaned.split(".");
  const cents = Number(whole || "0") * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Tool/JSON input: a number of dollars (80, 26.67) or a decimal string ("$80.00"). */
export function dollarsInputToCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 10_000_000) return null;
    return Math.round(value * 100);
  }
  if (typeof value === "string") return decimalToCents(value);
  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "nov", "november", "sept" → 10 / 8; -1 when not a month. */
function monthIndex(token: string): number {
  if (token === "sept") return 8;
  const index = MONTHS.indexOf(token.slice(0, 3));
  return index >= 0 && token.length >= 3 && MONTH_NAMES[index]!.startsWith(token) ? index : -1;
}

export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Parses YYYY-MM-DD into a local Date at noon (avoids DST edges); null when invalid. */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function validIsoDate(value: unknown): string | null {
  const date = parseIsoDate(value);
  return date ? isoDate(date) : null;
}

export function addDays(iso: string, days: number): string {
  const date = parseIsoDate(iso)!;
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

/** Same day next month, clamped to the month's last day (Jan 31 → Feb 28). */
export function addMonths(iso: string, months: number): string {
  const date = parseIsoDate(iso)!;
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, 12);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(day, last));
  return isoDate(target);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = parseIsoDate(fromIso)!;
  const to = parseIsoDate(toIso)!;
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86_400_000);
}

function makeDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month, day, 12);
  return date.getMonth() === month && date.getDate() === day ? date : null;
}

/** A date without a year: this year, or next year when it would be more than ~2 months in the past. */
function inferYear(month: number, day: number, today: Date): Date | null {
  const candidate = makeDate(today.getFullYear(), month, day);
  if (!candidate) return makeDate(today.getFullYear() + 1, month, day);
  const ageDays = (today.getTime() - candidate.getTime()) / 86_400_000;
  return ageDays > 62 ? makeDate(today.getFullYear() + 1, month, day) : candidate;
}

/**
 * Parses a due-date phrase: "Nov 1", "November 1st", "11/1", "11/1/26", "2026-11-01",
 * "today", "tomorrow", "friday", "the 15th". Returns YYYY-MM-DD or null.
 */
export function parseDateText(text: string, today: Date): string | null {
  const value = text.trim().toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!value) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  if (value === "today" || value === "tonight") return isoDate(base);
  if (value === "tomorrow" || value === "tmrw") { base.setDate(base.getDate() + 1); return isoDate(base); }
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (match) { const date = makeDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])); return date ? isoDate(date) : null; }
  match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(value);
  if (match) {
    const month = Number(match[1]) - 1;
    const day = Number(match[2]);
    if (match[3]) { const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]); const date = makeDate(year, month, day); return date ? isoDate(date) : null; }
    const date = inferYear(month, day, today);
    return date ? isoDate(date) : null;
  }
  match = /^([a-z]+)\s(\d{1,2})(?:st|nd|rd|th)?(?:\s(\d{4}))?$/.exec(value);
  if (match && monthIndex(match[1]!) >= 0) {
    const month = monthIndex(match[1]!);
    const day = Number(match[2]);
    const date = match[3] ? makeDate(Number(match[3]), month, day) : inferYear(month, day, today);
    return date ? isoDate(date) : null;
  }
  match = /^(\d{1,2})(?:st|nd|rd|th)?\s([a-z]+)(?:\s(\d{4}))?$/.exec(value);
  if (match) {
    const month = monthIndex(match[2]!);
    if (month >= 0) {
      const day = Number(match[1]);
      const date = match[3] ? makeDate(Number(match[3]), month, day) : inferYear(month, day, today);
      return date ? isoDate(date) : null;
    }
  }
  match = /^(?:the\s)?(\d{1,2})(?:st|nd|rd|th)$/.exec(value);
  if (match) {
    const day = Number(match[1]);
    for (let offset = 0; offset < 3; offset += 1) {
      const date = makeDate(today.getFullYear(), today.getMonth() + offset, day);
      if (date && date.getTime() >= base.getTime() - 43_200_000) return isoDate(date);
    }
    return null;
  }
  match = /^(?:next\s|this\s)?([a-z]+)$/.exec(value);
  if (match) {
    const weekday = WEEKDAYS.indexOf(match[1]!.slice(0, 3));
    if (weekday >= 0 && /^(sun|mon|tue|wed|thu|fri|sat)/.test(match[1]!)) {
      let delta = (weekday - base.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      base.setDate(base.getDate() + delta);
      return isoDate(base);
    }
  }
  return null;
}

/** "Nov 1" (adds the year when it isn't the current one). */
export function shortDate(iso: string, today: Date): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

/** "today", "tomorrow", "Fri, Oct 20", or "Nov 1". */
export function relativeDue(iso: string, today: Date): string {
  const days = daysBetween(isoDate(today), iso);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  const date = parseIsoDate(iso)!;
  if (days > 1 && days < 7) return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return shortDate(iso, today);
}

// ---------------------------------------------------------------------------
// Names and text helpers
// ---------------------------------------------------------------------------

export type NamedMember = { id: string; name: string };

/** Finds a member by full or first name (case-insensitive); "me"/"I"/"myself" is the sender. */
export function findMemberByName(name: string, members: readonly NamedMember[], senderId?: string): NamedMember | undefined {
  const query = name.trim().toLowerCase().replace(/^@/, "").replace(/[.,!?]+$/, "");
  if (!query) return undefined;
  if (senderId && /^(me|i|myself|mine)$/.test(query)) return members.find((member) => member.id === senderId);
  return members.find((member) => member.name.toLowerCase() === query)
    ?? members.find((member) => member.name.toLowerCase().split(/\s+/)[0] === query)
    ?? (query.length >= 3 ? members.find((member) => member.name.toLowerCase().startsWith(query)) : undefined);
}

/** Splits "Maya, Alex and Jordan" into names. */
export function splitNames(text: string): string[] {
  return text.split(/\s*(?:,|&|\+|\band\b)\s*/i).map((part) => part.trim()).filter(Boolean);
}

/** Removes control characters and trims a free-text label to `max` characters. */
export function cleanLabel(value: unknown, max = 48): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function titleCase(value: string): string {
  return value.replace(/\b([a-z])([a-z]*)/g, (_, first: string, rest: string) => first.toUpperCase() + rest);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type SplitInput =
  | { kind: "equal" }
  | { kind: "weights"; values: number[] }
  | { kind: "named"; entries: Array<{ name: string; value: number; dollars: boolean }> }
  | { kind: "items" };

export type DraftEdit =
  | { kind: "confirm" }
  | { kind: "cancel"; explicit: boolean }
  | { kind: "split"; split: SplitInput }
  | { kind: "exclude"; names: string[] }
  | { kind: "include"; names: string[] }
  | { kind: "only"; names: string[] }
  | { kind: "payer"; name: string }
  | { kind: "due"; dueDate: string }
  | { kind: "amount"; cents: number }
  | { kind: "vendor"; vendor: string }
  | { kind: "recurring"; recurring: boolean };

export type BillCommand =
  | { kind: "list" }
  | { kind: "balances" }
  | { kind: "help" }
  | { kind: "add"; vendor: string; cents: number | null; dueDate: string | null; recurring: boolean; payerName?: string; split?: SplitInput }
  | { kind: "payment"; toName: string; fromName?: string; cents: number }
  | { kind: "markPaid"; query: string; paid: boolean }
  | { kind: "edit"; edit: DraftEdit };

function parseSplit(rest: string): SplitInput | null {
  const value = rest.trim().toLowerCase();
  if (/^(equal(ly)?|evenly|even|equal ways|\d+ ways)$/.test(value)) return { kind: "equal" };
  if (/^(by items?|by line items?|items?)$/.test(value)) return { kind: "items" };
  if (/^\d+(\.\d+)?%?(\s*[/:,\s-]\s*\d+(\.\d+)?%?)+$/.test(value)) {
    const values = value.split(/\s*[/:,\s-]\s*/).map((part) => Number(part.replace("%", "")));
    return values.every((number) => Number.isFinite(number) && number >= 0) ? { kind: "weights", values } : null;
  }
  const cleaned = rest.replace(/\band\b/gi, " ");
  const pattern = /([a-z][a-z']*(?:\s[a-z][a-z']*)?)\s*[:=]?\s*(\$)?(\d+(?:\.\d{1,2})?)\s*(%)?/gi;
  const entries = [...cleaned.matchAll(pattern)].map((match) => ({ name: match[1]!.trim(), value: Number(match[3]), dollars: Boolean(match[2]) }));
  if (entries.length && !cleaned.replace(pattern, "").replace(/[\s,;]+/g, "")) return { kind: "named", entries };
  return null;
}

/** Pulls "due <date>" out of free text; returns the date and the text without it. */
function takeDue(text: string, today: Date): { dueDate: string | null; rest: string } {
  const match = /\b(?:due|on|by)\s+((?:next |this )?[a-z]+\s?\d{0,2}(?:st|nd|rd|th)?(?:,?\s\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|(?:the\s)?\d{1,2}(?:st|nd|rd|th))\b/i.exec(text);
  if (!match) return { dueDate: null, rest: text };
  const dueDate = parseDateText(match[1]!, today);
  return dueDate ? { dueDate, rest: (text.slice(0, match.index) + " " + text.slice(match.index + match[0].length)).trim() } : { dueDate: null, rest: text };
}

/**
 * Recognizes bill commands. Returns null for anything else (so cart processing
 * continues). Draft edits ("ok", "split 50/30/20", ...) are returned as `edit`
 * and only applied by the service when the sender has a draft waiting.
 */
export function parseBillCommand(rawText: string, today: Date): BillCommand | null {
  const text = rawText.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
  const lower = text.toLowerCase().replace(/[.!]+$/, "");
  if (!lower) return null;

  if (/^(bills|my bills|show bills|list bills|bills due|upcoming bills|what bills are due|what('s| is) due)\??$/.test(lower)) return { kind: "list" };
  if (/^(balances?|who owes( who| whom)?( what)?|who owes what|settle up|what do i owe|how much do i owe|debts|show balances)\??$/.test(lower)) return { kind: "balances" };
  if (/^(bill|bills help|help bills|bill help)$/.test(lower)) return { kind: "help" };

  // Draft edits.
  if (/^(ok|okay|k|yes|yep|yup|save|save it|save bill|ok bill|confirm|confirm bill|looks good|lgtm|👍|✅)$/.test(lower)) return { kind: "edit", edit: { kind: "confirm" } };
  if (/^(cancel bill|discard bill|delete draft|cancel draft|discard draft|nevermind bill)$/.test(lower)) return { kind: "edit", edit: { kind: "cancel", explicit: true } };
  if (/^(cancel|discard|never ?mind)$/.test(lower)) return { kind: "edit", edit: { kind: "cancel", explicit: false } };
  let match = /^split\s+(.+)$/i.exec(text);
  if (match) {
    const split = parseSplit(match[1]!);
    if (split) return { kind: "edit", edit: { kind: "split", split } };
  }
  match = /^(?:exclude|without|remove|minus|not|skip)\s+(.+)$/i.exec(text);
  if (match && !/\$|\d/.test(match[1]!)) return { kind: "edit", edit: { kind: "exclude", names: splitNames(match[1]!) } };
  match = /^(?:include|add|plus|with)\s+([a-z][a-z' ,&+]*)$/i.exec(text);
  if (match && splitNames(match[1]!).length <= 6) return { kind: "edit", edit: { kind: "include", names: splitNames(match[1]!) } };
  match = /^(?:only|just|split between|split with|between)\s+([a-z][a-z' ,&+]*)$/i.exec(text);
  if (match) return { kind: "edit", edit: { kind: "only", names: splitNames(match[1]!) } };
  match = /^(?:paid by|payer is|payer)\s+([a-z][a-z' -]*)$/i.exec(text);
  if (match) return { kind: "edit", edit: { kind: "payer", name: match[1]!.trim() } };
  match = /^([a-z][a-z'-]*)\s+paid( it| for it| the bill)?$/i.exec(text);
  if (match && !/^(i|we|it|bill)$/i.test(match[1]!)) return { kind: "edit", edit: { kind: "payer", name: match[1]! } };
  if (/^i paid( it| for it| the bill)?$/i.test(lower)) return { kind: "edit", edit: { kind: "payer", name: "me" } };
  match = /^(?:due|due date)\s+(.+)$/i.exec(text);
  if (match) {
    const dueDate = parseDateText(match[1]!, today);
    if (dueDate) return { kind: "edit", edit: { kind: "due", dueDate } };
  }
  match = /^(?:amount|total|it'?s|its)?\s*\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/i.exec(text);
  if (match) {
    const cents = decimalToCents(match[1]!);
    if (cents) return { kind: "edit", edit: { kind: "amount", cents } };
  }
  match = /^(?:vendor|name it|call it|rename(?: it)?(?: to)?)\s+(.+)$/i.exec(text);
  if (match) return { kind: "edit", edit: { kind: "vendor", vendor: match[1]! } };
  if (/^(monthly|repeat monthly|repeats monthly|every month|recurring|make it monthly)$/.test(lower)) return { kind: "edit", edit: { kind: "recurring", recurring: true } };
  if (/^(one time|one-time|once|not monthly|no repeat|don't repeat)$/.test(lower)) return { kind: "edit", edit: { kind: "recurring", recurring: false } };

  // Payments: "paid Maya $20", "I paid Maya 20", "paid $20 to Maya", "sent Maya $20".
  match = /^(?:i\s+)?(?:paid|sent|venmo'?d|zelle'?d|gave|repaid|paid back)\s+([a-z][a-z' -]*?)\s+\$?\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?:\s.*)?$/i.exec(text);
  if (match && !/^by$/i.test(match[1]!)) {
    const cents = decimalToCents(match[2]!);
    if (cents) return { kind: "payment", toName: match[1]!.trim(), cents };
  }
  match = /^(?:i\s+)?(?:paid|sent|venmo'?d|zelle'?d|gave|repaid)\s+\$?\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s+(?:to|back to)\s+([a-z][a-z' -]*)$/i.exec(text);
  if (match) {
    const cents = decimalToCents(match[1]!);
    if (cents) return { kind: "payment", toName: match[2]!.trim(), cents };
  }
  match = /^([a-z][a-z'-]*)\s+(?:paid|sent|venmo'?d|zelle'?d|gave)\s+([a-z][a-z' -]*?)\s+\$?\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/i.exec(text);
  if (match && !/^(i|we)$/i.test(match[1]!)) {
    const cents = decimalToCents(match[3]!);
    if (cents) return { kind: "payment", fromName: match[1]!, toName: match[2]!.trim(), cents };
  }

  // Mark a bill paid/unpaid: "mark internet paid", "mark the rent as paid", "internet is paid".
  match = /^mark\s+(?:the\s+)?(.+?)\s+(?:as\s+)?(paid|unpaid|not paid)$/i.exec(text) ?? /^(?:the\s+)?(.+?)\s+(?:bill\s+)?is\s+(paid|unpaid|not paid)$/i.exec(text);
  if (match) return { kind: "markPaid", query: match[1]!.trim().replace(/\s+bill$/i, ""), paid: match[2]!.toLowerCase() === "paid" };

  // New bill: "bill internet $80 due Nov 1", "add bill rent 2400 due the 1st monthly".
  match = /^(?:add\s+(?:a\s+)?bill|new bill|bill)[:\s]+(.+)$/i.exec(text);
  if (match) {
    let body = match[1]!;
    let recurring = false;
    body = body.replace(/\b(monthly|every month|each month|recurring|repeats monthly)\b/gi, () => { recurring = true; return " "; });
    let payerName: string | undefined;
    body = body.replace(/\bpaid by\s+([a-z][a-z'-]*)/i, (_, name: string) => { payerName = name; return " "; });
    let split: SplitInput | undefined;
    body = body.replace(/\bsplit\s+((?:\d+(?:\.\d+)?%?\s*[/:]\s*)+\d+(?:\.\d+)?%?|equal(?:ly)?|evenly)\b/i, (_, value: string) => { split = parseSplit(value) ?? undefined; return " "; });
    const due = takeDue(body, today);
    body = due.rest;
    const amount = findAmount(body);
    const cents = amount?.cents ?? null;
    if (amount) body = `${body.slice(0, amount.start)} ${body.slice(amount.end)}`;
    const vendor = body.replace(/\b(for|of|bill|is|the|a|an)\b/gi, " ").replace(/[^\p{L}\p{N}&'.\- ]+/gu, " ").replace(/\s+/g, " ").trim();
    if (!vendor && cents === null) return { kind: "help" };
    return { kind: "add", vendor, cents, dueDate: due.dueDate, recurring, payerName, split };
  }
  return null;
}
