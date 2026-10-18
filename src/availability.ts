// Pure availability math for the household calendar. No I/O, no clocks: every
// function takes explicit inputs so it can be checked with hand-made cases
// (see availability.test.ts).

/** Half-open interval [start, end) in epoch milliseconds. */
export type Interval = { start: number; end: number };
export type MemberBusy = { memberId: string; busy: Interval[] };
export type OverlapSegment = Interval & { count: number; memberIds: string[] };
export type Availability = {
  /** Ranges where two or more members are busy at once, split wherever the set of busy members changes. */
  overlaps: OverlapSegment[];
  /** Ranges inside the window where no member is busy. */
  everyoneFree: Interval[];
};

/** Sorts, drops empty intervals, and merges overlapping or touching intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push(interval);
  }
  return merged;
}

export function clipIntervals(intervals: Interval[], window: Interval): Interval[] {
  return intervals.flatMap((interval) => {
    const start = Math.max(interval.start, window.start);
    const end = Math.min(interval.end, window.end);
    return end > start ? [{ start, end }] : [];
  });
}

/**
 * Sweeps every member's busy time across `window`. Each member's own intervals are
 * merged first, so one person double-booked never counts as an overlap. Intervals
 * that only touch (10:00-11:00 and 11:00-12:00) do not overlap.
 */
export function computeAvailability(members: MemberBusy[], window: Interval): Availability {
  if (!(window.end > window.start)) return { overlaps: [], everyoneFree: [] };
  const perMember = members.map((member) => ({
    memberId: member.memberId,
    busy: mergeIntervals(clipIntervals(member.busy, window)),
  }));
  const points = new Set<number>([window.start, window.end]);
  for (const member of perMember) {
    for (const interval of member.busy) { points.add(interval.start); points.add(interval.end); }
  }
  const boundaries = [...points].sort((a, b) => a - b);
  const cursors = perMember.map(() => 0);
  const overlaps: OverlapSegment[] = [];
  const free: Interval[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    const active: string[] = [];
    perMember.forEach((member, memberIndex) => {
      while (member.busy[cursors[memberIndex]!] && member.busy[cursors[memberIndex]!]!.end <= start) cursors[memberIndex]! += 1;
      const current = member.busy[cursors[memberIndex]!];
      if (current && current.start <= start && current.end >= end) active.push(member.memberId);
    });
    if (active.length === 0) {
      const last = free[free.length - 1];
      if (last && last.end === start) last.end = end;
      else free.push({ start, end });
    } else if (active.length >= 2) {
      const last = overlaps[overlaps.length - 1];
      if (last && last.end === start && last.memberIds.join("\u0000") === active.join("\u0000")) last.end = end;
      else overlaps.push({ start, end, count: active.length, memberIds: active });
    }
  }
  return { overlaps, everyoneFree: free };
}

/** Everyone-free windows inside each day's allowed hours (e.g. 8 AM-9 PM), at least `minMinutes` long. */
export function freeWindowsInDays(members: MemberBusy[], dayWindows: Interval[], minMinutes = 30): Interval[] {
  if (members.length === 0) return [];
  return dayWindows.flatMap((day) => computeAvailability(members, day).everyoneFree)
    .filter((window) => window.end - window.start >= minMinutes * 60_000);
}

/** Future part of each window (clipped to `now`), longest first, then returned in time order. */
export function bestFreeTimes(windows: Interval[], now: number, limit = 5, minMinutes = 60): Interval[] {
  return windows
    .map((window) => ({ start: Math.max(window.start, now), end: window.end }))
    .filter((window) => window.end - window.start >= minMinutes * 60_000)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
    .slice(0, limit)
    .sort((a, b) => a.start - b.start);
}

/** The next `count` future windows in time order. */
export function nextFreeTimes(windows: Interval[], now: number, count = 2, minMinutes = 30): Interval[] {
  return windows
    .map((window) => ({ start: Math.max(window.start, now), end: window.end }))
    .filter((window) => window.end - window.start >= minMinutes * 60_000)
    .sort((a, b) => a.start - b.start)
    .slice(0, count);
}

// ---------------------------------------------------------------------------
// Time-zone helpers (Intl only). Dates are "YYYY-MM-DD" strings in the zone.

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try { zoneFormatter(timeZone); return true; } catch { return false; }
}

function zoneParts(instant: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: (parts.hour ?? 0) % 24, mi: parts.minute ?? 0, s: parts.second ?? 0 };
}

function offsetMs(instant: number, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - (instant - (((instant % 1000) + 1000) % 1000));
}

/** Epoch ms for a wall-clock time (`minutes` after local midnight) on `date` in `timeZone`. */
export function zonedTimeToEpoch(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const first = guess - offsetMs(guess, timeZone);
  const second = guess - offsetMs(first, timeZone);
  return second;
}

export function localDate(instant: number, timeZone: string): string {
  const p = zoneParts(instant, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday on or before `date`. */
export function mondayOf(date: string): string {
  return addDays(date, -((dayOfWeek(date) + 6) % 7));
}

export function isDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return addDays(value, 0) === value;
}
