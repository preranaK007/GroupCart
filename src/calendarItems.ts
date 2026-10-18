// Calendar entries as the /calendar page shows them, and the pure rules that turn
// Google Calendar events (events.list) into them. No I/O and no clocks, so every
// rule is checked with hand-made events in calendarDetail.test.ts.
//
// Privacy: an entry carries only a title, a time range, and a location. Event
// descriptions, attendees, conference data, and links are never requested from
// Google (see EVENT_FIELDS in googleCalendar.ts) and never kept here; URLs are
// stripped out of locations, and events the owner marked private show as "Busy".
import { addDays, isDateString, zonedTimeToEpoch, type Interval } from "./availability.js";

/** One entry on a member's calendar. */
export type CalendarItem = {
  start: number;
  end: number;
  /** Event title; null when only free/busy is shared (the page labels it "Busy"). */
  title: string | null;
  location?: string;
  /** Google "Show as: Available" (transparency "transparent"): an outlined chip that never counts as busy. */
  free?: boolean;
  /** All-day event: start/end are local midnights in the page's time zone (end exclusive). */
  allDay?: boolean;
};

export const MAX_TITLE_LENGTH = 120;
export const MAX_LOCATION_LENGTH = 120;
export const UNTITLED = "(No title)";

/** Busy time for the overlap / everyone-free math: every entry except "Show as available" ones. */
export function busyFromItems(items: readonly CalendarItem[]): Interval[] {
  return items.filter((item) => !item.free).map(({ start, end }) => ({ start, end }));
}

/** Free/busy-only calendars: one untitled entry per busy block. */
export function itemsFromBusy(busy: readonly Interval[]): CalendarItem[] {
  return busy.map(({ start, end }) => ({ start, end, title: null }));
}

export function overlapsWindow(item: Interval, window: Interval): boolean {
  return item.end > window.start && item.start < window.end;
}

/** Single-line, trimmed, control characters removed, clamped with an ellipsis. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const LINK_PATTERN = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s)\]>]+|\b(?:[\w-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|meet\.jit\.si)(?:\/[^\s)\]>]*)?/gi;

/** A location without links (video-call URLs often live there); undefined when nothing is left. */
export function cleanLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = cleanText(value.replace(LINK_PATTERN, " ").replace(/[([<]\s*[)\]>]/g, " "), 400)
    .replace(/\s*(?:[,;|·]\s*)+$/u, "")
    .replace(/^(?:[,;|·:-]\s*)+/u, "")
    .trim();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return undefined;
  return cleanText(text, MAX_LOCATION_LENGTH);
}

type GoogleTime = { date?: unknown; dateTime?: unknown };
type GoogleEvent = {
  status?: unknown;
  summary?: unknown;
  location?: unknown;
  transparency?: unknown;
  visibility?: unknown;
  eventType?: unknown;
  start?: GoogleTime;
  end?: GoogleTime;
  attendees?: unknown;
};

function declinedBySelf(attendees: unknown): boolean {
  return Array.isArray(attendees) && attendees.some((attendee) => Boolean(attendee) && typeof attendee === "object"
    && (attendee as { self?: unknown }).self === true && (attendee as { responseStatus?: unknown }).responseStatus === "declined");
}

/** Start/end of a Google event; all-day dates become local midnights in `timeZone` (end date is exclusive). */
function googleRange(start: GoogleTime | undefined, end: GoogleTime | undefined, timeZone: string): (Interval & { allDay: boolean }) | null {
  if (start && typeof start.dateTime === "string") {
    const from = Date.parse(start.dateTime);
    const to = end && typeof end.dateTime === "string" ? Date.parse(end.dateTime) : Number.NaN;
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? { start: from, end: to, allDay: false } : null;
  }
  if (start && typeof start.date === "string" && isDateString(start.date)) {
    const endDate = end && typeof end.date === "string" && isDateString(end.date) && end.date > start.date ? end.date : addDays(start.date, 1);
    return { start: zonedTimeToEpoch(start.date, 0, timeZone), end: zonedTimeToEpoch(endDate, 0, timeZone), allDay: true };
  }
  return null;
}

/**
 * Google Calendar events.list items → calendar entries, sorted by start.
 * - cancelled events, events the member declined, and working-location markers are skipped;
 * - transparency "transparent" ("Show as available") → `free: true` (not busy);
 * - all-day events (`start.date`) → `allDay: true`, local midnight to midnight in `timeZone`;
 * - private/confidential events keep their time but show as "Busy" (no title or location);
 * - only the title and location are kept, never descriptions, attendees, or links.
 */
export function normalizeGoogleEvents(items: unknown, timeZone: string): CalendarItem[] {
  if (!Array.isArray(items)) return [];
  const entries: CalendarItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as GoogleEvent;
    if (event.status === "cancelled") continue;
    if (event.eventType === "workingLocation") continue;
    if (declinedBySelf(event.attendees)) continue;
    const range = googleRange(event.start, event.end, timeZone);
    if (!range) continue;
    const hidden = event.visibility === "private" || event.visibility === "confidential";
    const entry: CalendarItem = { start: range.start, end: range.end, title: hidden ? null : cleanText(event.summary, MAX_TITLE_LENGTH) || UNTITLED };
    const location = hidden ? undefined : cleanLocation(event.location);
    if (location) entry.location = location;
    if (event.transparency === "transparent") entry.free = true;
    if (range.allDay) entry.allDay = true;
    entries.push(entry);
  }
  return sortItems(entries);
}

export function sortItems(items: CalendarItem[]): CalendarItem[] {
  return items.sort((a, b) => a.start - b.start || b.end - a.end || String(a.title ?? "").localeCompare(String(b.title ?? "")));
}
