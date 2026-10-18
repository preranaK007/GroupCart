// iCalendar (.ics) feeds → calendar entries. Parsing and recurrence expansion use
// ical.js (Mozilla's RFC 5545 parser); this module only decides what an occurrence
// means for the /calendar page, with the same privacy rules as Google events
// (calendarItems.ts): title, time, and location only, never descriptions,
// attendees, or links. No I/O; src/calendarLinks.ts fetches the feeds.
//
// - Recurring events: RRULE/RDATE expanded by ical.js, EXDATE removed, and
//   RECURRENCE-ID overrides applied (related by UID: ical.js would otherwise relate
//   every override in the file to every event).
// - STATUS:CANCELLED events and occurrences are skipped, and so are events the owner
//   declined when the feed names its owner (Google names a primary calendar after its
//   owner's email in X-WR-CALNAME).
// - TRANSP:TRANSPARENT (or Outlook's busy status FREE) = shown as available, never busy.
// - All-day events (DATE values) run local midnight to midnight in the page's zone.
// - Time zones: a TZID that names an IANA zone is converted with Intl; other TZIDs
//   (Outlook's Windows names) use the feed's VTIMEZONE; floating times use the feed's
//   X-WR-TIMEZONE, else the page's zone.
// - CLASS:PRIVATE/CONFIDENTIAL events keep their time but show as "Busy".
import ICAL from "ical.js";
import { addDays, isValidTimeZone, zonedTimeToEpoch, type Interval } from "./availability.js";
import { cleanLocation, cleanText, MAX_TITLE_LENGTH, overlapsWindow, sortItems, UNTITLED, type CalendarItem } from "./calendarItems.js";

/** Expansion limits, so a hostile or huge feed cannot stall the server. */
const MAX_STEPS_PER_EVENT = 20_000;
const MAX_STEPS_PER_EXPANSION = 200_000;
const MAX_ITEMS = 1_500;

export class IcsParseError extends Error {}

/** A parsed feed, expanded on demand for any window. Treat as read-only. */
export type IcsCalendar = {
  /** One-off events and recurring masters (with their RECURRENCE-ID overrides related). */
  events: ICAL.Event[];
  /** X-WR-TIMEZONE, used for floating times. */
  floatingZone: string | null;
  /** X-WR-CALNAME when it is an email address, used to skip events the owner declined. */
  ownerEmail: string | null;
};

export type IcsExpandOptions = {
  /** The page's time zone: all-day events become its local midnights. */
  timeZone: string;
  /** The member opted in to event titles; otherwise entries are untitled busy blocks. */
  titles: boolean;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parses .ics text. Throws IcsParseError when it is not an iCalendar document. */
export function parseIcs(text: string): IcsCalendar {
  let parsed: unknown;
  try {
    parsed = ICAL.parse(text);
  } catch {
    throw new IcsParseError("That address didn't return a calendar GroupCart can read.");
  }
  // ICAL.parse returns one jCal component, or an array of them for concatenated calendars.
  const jcals = (Array.isArray(parsed) && typeof parsed[0] === "string" ? [parsed] : Array.isArray(parsed) ? parsed : []) as unknown[][];
  const roots = jcals.map((jcal) => new ICAL.Component(jcal)).filter((root) => root.name === "vcalendar");
  if (!roots.length) throw new IcsParseError("That address didn't return a calendar GroupCart can read.");

  const masters = new Map<string, ICAL.Component>();
  const overrides = new Map<string, ICAL.Component[]>();
  const loose: ICAL.Component[] = [];
  for (const root of roots) {
    for (const vevent of root.getAllSubcomponents("vevent")) {
      const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
      if (!uid) loose.push(vevent);
      else if (vevent.hasProperty("recurrence-id")) overrides.set(uid, [...(overrides.get(uid) ?? []), vevent]);
      else if (!masters.has(uid)) masters.set(uid, vevent);
    }
  }
  const events: ICAL.Event[] = [];
  for (const [uid, master] of masters) events.push(eventWithOverrides(master, overrides.get(uid) ?? []));
  for (const [uid, list] of overrides) {
    // Instances without their series (e.g. an invitation to one occurrence) stand alone.
    if (!masters.has(uid)) for (const vevent of list) events.push(new ICAL.Event(vevent, { exceptions: [] }));
  }
  for (const vevent of loose) events.push(new ICAL.Event(vevent, { exceptions: [] }));

  const first = roots[0]!;
  const zone = String(first.getFirstPropertyValue("x-wr-timezone") ?? "").trim();
  const name = String(first.getFirstPropertyValue("x-wr-calname") ?? "").trim().toLowerCase();
  return { events, floatingZone: zone && isValidTimeZone(zone) ? zone : null, ownerEmail: EMAIL.test(name) ? name : null };
}

function eventWithOverrides(master: ICAL.Component, list: ICAL.Component[]): ICAL.Event {
  const event = new ICAL.Event(master, { exceptions: [], strictExceptions: true });
  for (const override of list) {
    try {
      event.relateException(override);
    } catch {
      // An override with an unreadable RECURRENCE-ID cannot be placed; the series keeps its usual time.
    }
  }
  return event;
}

/** Entries of `calendar` that overlap `window`, sorted by start. */
export function icsItems(calendar: IcsCalendar, window: Interval, options: IcsExpandOptions): CalendarItem[] {
  const items: CalendarItem[] = [];
  const budget = { steps: MAX_STEPS_PER_EXPANSION };
  for (const event of calendar.events) {
    if (items.length >= MAX_ITEMS || budget.steps <= 0) break;
    try {
      if (event.isRecurring()) expandSeries(event, calendar, window, options, items, budget);
      else if (nearWindow(event.startDate, event.endDate, window)) addOccurrence(event.component, ownRange(event.component, event.startDate, event.endDate, calendar, options), window, calendar, options, items);
    } catch {
      // A malformed event (bad date, bad RRULE) is skipped; the rest of the calendar still shows.
    }
  }
  return sortItems(items.slice(0, MAX_ITEMS));
}

type Range = Interval & { allDay: boolean };

function expandSeries(event: ICAL.Event, calendar: IcsCalendar, window: Interval, options: IcsExpandOptions, items: CalendarItem[], budget: { steps: number }): void {
  if (isCancelled(event.component)) return;
  const startZone = tzidOf(event.component, "dtstart");
  // Every occurrence lasts as long as the first one (in real time, so a DST change mid-event is handled).
  const first = ownRange(event.component, event.startDate, event.endDate, calendar, options);
  const durationMs = first ? first.end - first.start : 0;
  const iterator = event.iterator();
  const seen = new Set<string>();
  for (let steps = 0; steps < MAX_STEPS_PER_EVENT && budget.steps > 0; steps += 1) {
    budget.steps -= 1;
    const occurrence = iterator.next();
    if (!occurrence) break;
    // Cheap wall-clock test first: exact time-zone conversion is the expensive part, and long-running
    // series have hundreds of occurrences before the window. (Overrides of skipped ones are checked below.)
    const wall = wallClockAsUtc(occurrence);
    if (wall + durationMs + SLACK_MS < window.start) continue;
    // Occurrences come in order of their original start; a later one can only be moved here by an override (below).
    if (wall - SLACK_MS >= window.end) break;
    const start = epochOf(occurrence, startZone, calendar, options);
    if (start >= window.end) break;
    seen.add(occurrence.toString()).add(occurrence.convertToZone(ICAL.Timezone.utcTimezone).toString());
    const details = event.getOccurrenceDetails(occurrence);
    if (details.item !== event) {
      addOccurrence(details.item.component, ownRange(details.item.component, details.startDate, details.endDate, calendar, options), window, calendar, options, items);
    } else if (occurrence.isDate) {
      addOccurrence(event.component, allDayRange(details.startDate, details.endDate, options.timeZone), window, calendar, options, items);
    } else {
      addOccurrence(event.component, { start, end: start + durationMs, allDay: false }, window, calendar, options, items);
    }
  }
  // Overrides that move a later occurrence into the window.
  for (const [id, override] of Object.entries(event.exceptions)) {
    if (!seen.has(id)) addOccurrence(override.component, ownRange(override.component, override.startDate, override.endDate, calendar, options), window, calendar, options, items);
  }
}

function addOccurrence(component: ICAL.Component, range: Range | null, window: Interval, calendar: IcsCalendar, options: IcsExpandOptions, items: CalendarItem[]): void {
  if (!range || range.end <= range.start || !overlapsWindow(range, window)) return;
  if (isCancelled(component) || declinedByOwner(component, calendar.ownerEmail)) return;
  const free = isTransparent(component);
  if (free && !options.titles) return; // Busy-only sharing leaves out "available" events, like Google free/busy.
  const hidden = !options.titles || isPrivate(component);
  const item: CalendarItem = { start: range.start, end: range.end, title: hidden ? null : cleanText(component.getFirstPropertyValue("summary"), MAX_TITLE_LENGTH) || UNTITLED };
  const location = hidden ? undefined : cleanLocation(component.getFirstPropertyValue("location"));
  if (location) item.location = location;
  if (free) item.free = true;
  if (range.allDay) item.allDay = true;
  items.push(item);
}

/** Wider than any UTC offset (and a DST shift), so wall-clock comparisons never drop a real overlap. */
const SLACK_MS = 2 * 86_400_000;

function wallClockAsUtc(time: ICAL.Time): number {
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

/** Could this one-off event overlap `window` in any time zone? (Avoids exact conversion for far-away events.) */
function nearWindow(start: ICAL.Time | null, end: ICAL.Time | null, window: Interval): boolean {
  if (!start) return false;
  const from = wallClockAsUtc(start);
  const to = end ? Math.max(from, wallClockAsUtc(end)) : from + 86_400_000;
  return to + SLACK_MS >= window.start && from - SLACK_MS < window.end;
}

/** The time range a component states for itself (its DTSTART and DTEND/DURATION). */
function ownRange(component: ICAL.Component, start: ICAL.Time | null, end: ICAL.Time | null, calendar: IcsCalendar, options: IcsExpandOptions): Range | null {
  if (!start) return null;
  if (start.isDate) return allDayRange(start, end, options.timeZone);
  if (!end) return null;
  const startZone = tzidOf(component, "dtstart");
  // An end computed from DURATION is in the start's zone.
  const endZone = component.hasProperty("dtend") ? tzidOf(component, "dtend") : startZone;
  return { start: epochOf(start, startZone, calendar, options), end: epochOf(end, endZone, calendar, options), allDay: false };
}

function allDayRange(start: ICAL.Time, end: ICAL.Time | null, timeZone: string): Range {
  const first = dateOf(start);
  const last = end && dateOf(end) > first ? dateOf(end) : addDays(first, 1); // DTEND is exclusive
  return { start: zonedTimeToEpoch(first, 0, timeZone), end: zonedTimeToEpoch(last, 0, timeZone), allDay: true };
}

/** Epoch milliseconds of an ICAL date-time. `tzid` is the TZID parameter of the property it came from. */
function epochOf(time: ICAL.Time, tzid: string | null, calendar: IcsCalendar, options: IcsExpandOptions): number {
  if (time.isDate) return zonedTimeToEpoch(dateOf(time), 0, options.timeZone);
  if (time.zone === ICAL.Timezone.utcTimezone) return time.toUnixTime() * 1000;
  if (tzid && isValidTimeZone(tzid)) return wallClock(time, tzid);
  // A TZID defined only by the feed's VTIMEZONE (e.g. "Pacific Standard Time"): ical.js resolved it.
  if (time.zone && time.zone !== ICAL.Timezone.localTimezone) return time.toUnixTime() * 1000;
  return wallClock(time, calendar.floatingZone ?? options.timeZone);
}

function wallClock(time: ICAL.Time, timeZone: string): number {
  return zonedTimeToEpoch(dateOf(time), time.hour * 60 + time.minute, timeZone) + time.second * 1000;
}

function dateOf(time: ICAL.Time): string {
  return `${String(time.year).padStart(4, "0")}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

function tzidOf(component: ICAL.Component, name: "dtstart" | "dtend"): string | null {
  const value = component.getFirstProperty(name)?.getParameter("tzid");
  return typeof value === "string" && value ? value : null;
}

function upper(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isCancelled(component: ICAL.Component): boolean {
  return upper(component.getFirstPropertyValue("status")) === "CANCELLED";
}

function isTransparent(component: ICAL.Component): boolean {
  return upper(component.getFirstPropertyValue("transp")) === "TRANSPARENT" || upper(component.getFirstPropertyValue("x-microsoft-cdo-busystatus")) === "FREE";
}

function isPrivate(component: ICAL.Component): boolean {
  const value = upper(component.getFirstPropertyValue("class"));
  return value === "PRIVATE" || value === "CONFIDENTIAL";
}

function declinedByOwner(component: ICAL.Component, ownerEmail: string | null): boolean {
  if (!ownerEmail) return false;
  return component.getAllProperties("attendee").some((attendee) =>
    String(attendee.getFirstValue() ?? "").replace(/^mailto:/i, "").trim().toLowerCase() === ownerEmail
    && upper(attendee.getParameter("partstat")) === "DECLINED");
}
