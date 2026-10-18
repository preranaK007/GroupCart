// Run with: node --import=tsx --test src/availability.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays, bestFreeTimes, computeAvailability, freeWindowsInDays, localDate, mergeIntervals, mondayOf, nextFreeTimes, zonedTimeToEpoch,
} from "./availability.js";

const H = 3_600_000;
const at = (hours: number) => hours * H; // hours since an arbitrary epoch 0
const span = (a: number, b: number) => ({ start: at(a), end: at(b) });
const day = span(8, 20);

test("mergeIntervals merges overlapping and touching intervals, drops empty ones", () => {
  assert.deepEqual(mergeIntervals([span(11, 12), span(9, 10), span(10, 11), span(13, 13), span(12.5, 14)]), [span(9, 12), span(12.5, 14)]);
});

test("two members: touching intervals do not overlap", () => {
  const result = computeAvailability([
    { memberId: "a", busy: [span(9, 10)] },
    { memberId: "b", busy: [span(10, 11)] },
  ], day);
  assert.deepEqual(result.overlaps, []);
  assert.deepEqual(result.everyoneFree, [span(8, 9), span(11, 20)]);
});

test("two members: nested interval overlaps only in the inner range", () => {
  const result = computeAvailability([
    { memberId: "a", busy: [span(9, 13)] },
    { memberId: "b", busy: [span(10, 11)] },
  ], day);
  assert.deepEqual(result.overlaps, [{ ...span(10, 11), count: 2, memberIds: ["a", "b"] }]);
  assert.deepEqual(result.everyoneFree, [span(8, 9), span(13, 20)]);
});

test("a member's own double-booking is not an overlap", () => {
  const result = computeAvailability([
    { memberId: "a", busy: [span(9, 11), span(10, 12)] },
    { memberId: "b", busy: [] },
  ], day);
  assert.deepEqual(result.overlaps, []);
  assert.deepEqual(result.everyoneFree, [span(8, 9), span(12, 20)]);
});

test("three members: counts rise and fall, segments split when the busy set changes", () => {
  const result = computeAvailability([
    { memberId: "a", busy: [span(9, 12)] },
    { memberId: "b", busy: [span(10, 14)] },
    { memberId: "c", busy: [span(11, 11.5), span(12, 13)] },
  ], day);
  assert.deepEqual(result.overlaps, [
    { ...span(10, 11), count: 2, memberIds: ["a", "b"] },
    { ...span(11, 11.5), count: 3, memberIds: ["a", "b", "c"] },
    { ...span(11.5, 12), count: 2, memberIds: ["a", "b"] },
    { ...span(12, 13), count: 2, memberIds: ["b", "c"] },
  ]);
  assert.deepEqual(result.everyoneFree, [span(8, 9), span(14, 20)]);
});

test("three members: chained touching blocks leave no shared free gap and no overlap", () => {
  const result = computeAvailability([
    { memberId: "a", busy: [span(8, 10)] },
    { memberId: "b", busy: [span(10, 15)] },
    { memberId: "c", busy: [span(15, 20)] },
  ], day);
  assert.deepEqual(result.overlaps, []);
  assert.deepEqual(result.everyoneFree, []);
});

test("busy time outside the window is clipped", () => {
  const result = computeAvailability([
    { memberId: "a", busy: [span(6, 9)] },
    { memberId: "b", busy: [span(19, 23)] },
  ], day);
  assert.deepEqual(result.everyoneFree, [span(9, 19)]);
});

test("free windows, best times, and next times", () => {
  const members = [{ memberId: "a", busy: [span(9, 12), span(32, 40)] }, { memberId: "b", busy: [span(12.25, 18)] }];
  const windows = freeWindowsInDays(members, [span(8, 20), span(32, 44)], 30);
  assert.deepEqual(windows, [span(8, 9), span(18, 20), span(40, 44)]);
  assert.deepEqual(bestFreeTimes(windows, at(8.5), 2, 60), [span(18, 20), span(40, 44)]);
  assert.deepEqual(nextFreeTimes(windows, at(8.5), 2, 30), [span(8.5, 9), span(18, 20)]);
  assert.deepEqual(freeWindowsInDays([], [span(8, 20)]), []);
});

test("time-zone helpers handle DST and week starts", () => {
  // 2026-03-08 is the US spring-forward day; 9 AM is UTC-7 after the change.
  assert.equal(new Date(zonedTimeToEpoch("2026-03-08", 9 * 60, "America/Los_Angeles")).toISOString(), "2026-03-08T16:00:00.000Z");
  assert.equal(new Date(zonedTimeToEpoch("2026-03-07", 9 * 60, "America/Los_Angeles")).toISOString(), "2026-03-07T17:00:00.000Z");
  assert.equal(localDate(Date.parse("2026-10-17T06:30:00Z"), "America/Los_Angeles"), "2026-10-16");
  assert.equal(mondayOf("2026-10-17"), "2026-10-12");
  assert.equal(mondayOf("2026-10-12"), "2026-10-12");
  assert.equal(addDays("2026-12-28", 7), "2027-01-04");
});
