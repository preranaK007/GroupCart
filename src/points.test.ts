// Run with: node --import=tsx --test src/points.test.ts
// Points rules, levels, streaks, the monthly MVP, the ledger (idempotent keys, caps, level-ups), and the hooks
// in chores and grocery checkout. Temporary databases, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { ChoreService } from "./chores.js";
import { LEADERBOARD_PATTERN, POINTS_PATTERN, withCheckoutObserver } from "./moneyPoints.js";
import {
  activePoints, awardPoints, computeStreak, levelFor, levelThreshold, monthlyMvp, PointsService, pointsFor, POINT_RULES, revokePoints,
  setActivePoints, weekOf, weekStatuses, type WeekStatus,
} from "./points.js";
import { SplitwiseService } from "./splitwise.js";
import { CartStore } from "./store.js";

let directory: string;
let counter = 0;
const id = () => `points-test:${++counter}`;

before(() => { directory = mkdtempSync(join(tmpdir(), "groupcart-points-")); });
after(() => { setActivePoints(null); rmSync(directory, { recursive: true, force: true }); });

const members = [{ id: "alex", name: "Alex" }, { id: "maya", name: "Maya" }, { id: "jordan", name: "Jordan" }];

function service(now: { value: Date }, onLevelUp?: (member: { id: string; name: string }, level: number) => void): PointsService {
  return new PointsService({ db: new DatabaseSync(":memory:"), household: "h", members: () => members, now: () => now.value, onLevelUp });
}

test("rules: on time beats covering beats late; events and lists by kind", () => {
  assert.equal(pointsFor({ kind: "chore", onTime: true }), POINT_RULES.choreOnTime);
  assert.equal(pointsFor({ kind: "chore", onTime: true, covering: true }), POINT_RULES.choreCovering);
  assert.equal(pointsFor({ kind: "chore", onTime: false, covering: true }), POINT_RULES.choreLate);
  assert.ok(POINT_RULES.choreOnTime > POINT_RULES.choreCovering && POINT_RULES.choreCovering > POINT_RULES.choreLate && POINT_RULES.choreLate > 0);
  assert.equal(pointsFor({ kind: "bill", onTime: true }), POINT_RULES.billOnTime);
  assert.equal(pointsFor({ kind: "bill", onTime: false }), POINT_RULES.billLate);
  assert.equal(pointsFor({ kind: "payback" }), POINT_RULES.payback);
  assert.equal(pointsFor({ kind: "checkout" }), POINT_RULES.checkout);
  assert.equal(pointsFor({ kind: "event", social: true, timed: true }), POINT_RULES.eventHost);
  assert.equal(pointsFor({ kind: "event", social: false, timed: true }), POINT_RULES.eventBook);
  assert.equal(pointsFor({ kind: "event", social: false, timed: false }), 0);
  assert.equal(pointsFor({ kind: "list" }), POINT_RULES.listDone);
});

test("levels grow: 0, 50, 125, 225, 350", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(levelThreshold), [0, 50, 125, 225, 350]);
  assert.deepEqual(levelFor(0), { level: 1, floor: 0, next: 50 });
  assert.equal(levelFor(49).level, 1);
  assert.equal(levelFor(50).level, 2);
  assert.deepEqual(levelFor(130), { level: 3, floor: 125, next: 225 });
});

test("weeks start on Monday", () => {
  assert.equal(weekOf("2026-10-18"), "2026-10-12"); // Sunday
  assert.equal(weekOf("2026-10-12"), "2026-10-12"); // Monday
  assert.equal(weekOf("2026-10-01"), "2026-09-28"); // Thursday
});

test("streaks: consecutive clean weeks; the current week counts once clean; misses and gaps end it", () => {
  const week = (iso: string) => weekOf(iso);
  const current = "2026-10-12";
  const clean = (...weeks: string[]) => new Map<string, WeekStatus>(weeks.map((w) => [week(w), "clean"]));
  assert.equal(computeStreak(clean("2026-10-05", "2026-09-28", "2026-09-21"), current), 3); // nothing yet this week
  assert.equal(computeStreak(clean("2026-10-12", "2026-10-05"), current), 2); // this week already clean
  assert.equal(computeStreak(clean("2026-10-05", "2026-09-21"), current), 1); // gap on Sep 28
  const missed = clean("2026-10-05", "2026-09-28");
  missed.set(current, "miss");
  assert.equal(computeStreak(missed, current), 0);
  assert.equal(computeStreak(new Map(), current), 0);
});

test("week status: your own late chore or a recorded miss breaks the week; covering late never does", () => {
  const weeks = weekStatuses([
    { day: "2026-10-06", onTime: true, covering: false },
    { day: "2026-10-08", onTime: false, covering: true },
    { day: "2026-09-30", onTime: true, covering: false },
    { day: "2026-10-01", onTime: false, covering: false },
  ], [{ day: "2026-09-22" }]);
  assert.equal(weeks.get("2026-10-05"), "clean");
  assert.equal(weeks.get("2026-09-28"), "miss");
  assert.equal(weeks.get("2026-09-21"), "miss");
});

test("monthly MVP: most points in the month; ties go to whoever got there first", () => {
  const rows = [
    { memberId: "alex", points: 15, at: new Date(2026, 8, 30, 12).toISOString() },
    { memberId: "maya", points: 10, at: new Date(2026, 9, 2, 12).toISOString() },
    { memberId: "alex", points: 10, at: new Date(2026, 9, 3, 12).toISOString() },
    { memberId: "jordan", points: 5, at: new Date(2026, 9, 1, 12).toISOString() },
  ];
  assert.deepEqual(monthlyMvp(rows, "2026-10"), { memberId: "maya", points: 10 }); // Maya hit 10 on Oct 2, Alex on Oct 3
  assert.deepEqual(monthlyMvp(rows, "2026-09"), { memberId: "alex", points: 15 });
  assert.equal(monthlyMvp(rows, "2026-08"), null);
});

test("ledger: one award per key, revocable, weekly caps, level-ups announced once", () => {
  const now = { value: new Date(2026, 9, 14, 12) };
  const levels: string[] = [];
  const points = service(now, (member, level) => levels.push(`${member.name}:${level}`));
  assert.equal(points.award({ kind: "chore", memberId: "alex", key: "chore:1", onTime: true, label: "Dishes" })?.points, 15);
  assert.equal(points.award({ kind: "chore", memberId: "alex", key: "chore:1", onTime: true }), null); // replay
  assert.equal(points.award({ kind: "chore", memberId: "stranger", key: "chore:2", onTime: true }), null);
  for (let index = 0; index < 4; index += 1) points.award({ kind: "event", memberId: "maya", key: `event:${index}`, social: true });
  assert.equal(points.standings().find((entry) => entry.memberId === "maya")!.month, 3 * POINT_RULES.eventHost); // capped at 3 a week
  // 15 + 3 × 12 = 51 → level 2, announced once.
  for (let index = 0; index < 3; index += 1) points.award({ kind: "checkout", memberId: "alex", key: `checkout:${index}` });
  assert.deepEqual(levels, ["Alex:2"]);
  assert.equal(points.pendingLevelUp("alex"), 2);
  points.markLevelsSeen("alex");
  assert.equal(points.pendingLevelUp("alex"), null);
  assert.ok(points.revoke("checkout:2"));
  points.award({ kind: "checkout", memberId: "alex", key: "checkout:2" });
  assert.deepEqual(levels, ["Alex:2"]); // re-crossing a level is not announced again
  // Silent (demo) awards never announce.
  points.award({ kind: "payback", memberId: "jordan", key: "payback:x", at: new Date(2026, 9, 13, 12) }, { silent: true });
  assert.equal(points.pendingLevelUp("jordan"), null);
});

test("standings, streak, MVP badge, and chat replies", () => {
  const now = { value: new Date(2026, 9, 17, 12) }; // Saturday
  const points = service(now);
  const at = (month: number, day: number) => new Date(2026, month, day, 18);
  // Alex: on time three weeks running (Sep 21, Sep 28, Oct 5 weeks) and September's MVP.
  points.award({ kind: "chore", memberId: "alex", key: "c1", onTime: true, day: "2026-09-24", at: at(8, 24), label: "Dishes" });
  points.award({ kind: "chore", memberId: "alex", key: "c2", onTime: true, day: "2026-10-01", at: at(9, 1), label: "Trash" });
  points.award({ kind: "chore", memberId: "alex", key: "c3", onTime: true, day: "2026-10-08", at: at(9, 8), label: "Dishes" });
  // Maya: more points in October, but a chore went overdue on her turn this week.
  points.award({ kind: "checkout", memberId: "maya", key: "k1", at: at(9, 10) });
  points.award({ kind: "checkout", memberId: "maya", key: "k2", at: at(9, 12) });
  points.award({ kind: "chore", memberId: "maya", key: "c4", onTime: true, day: "2026-10-13", at: at(9, 13), label: "Recycling" });
  points.recordMiss("dishes", "2026-10-15", "maya");
  const standings = points.standings();
  assert.deepEqual(standings.map((entry) => [entry.name, entry.rank, entry.month, entry.streak]), [["Maya", 1, 39, 0], ["Alex", 2, 30, 3], ["Jordan", 3, 0, 0]]);
  assert.ok(standings[0]!.mvp);
  const alex = points.summary("alex")!;
  assert.equal(alex.total, 45);
  assert.ok(alex.badges.some((badge) => badge.label === "MVP · Sep"));
  assert.ok(alex.badges.some((badge) => badge.label === "3-week streak"));
  assert.match(points.pointsReply("alex"), /Alex: 30 points this month · level 1 \(45 all-time\)\n🔥 3-week streak · #2 this month · 5 to level 2/);
  assert.match(points.leaderboardReply(), /🏆 October leaderboard\n1\. Maya 39 👑\n2\. Alex 30 🔥3\n3\. Jordan 0\nLast month’s MVP: Alex \(15\)\./);
});

test("module hooks are no-ops until points are set up", () => {
  setActivePoints(null);
  assert.equal(awardPoints({ kind: "chore", memberId: "alex", key: "x", onTime: true }), null);
  revokePoints("x");
  assert.equal(activePoints(), null);
});

test("commands are tight phrases that don't collide with store commands", () => {
  for (const text of ["points", "my points", "XP", "my streak", "level?"]) assert.ok(POINTS_PATTERN.test(text), text);
  for (const text of ["leaderboard", "Leaderboard?", "standings", "who's winning", "mvp"]) assert.ok(LEADERBOARD_PATTERN.test(text), text);
  for (const text of ["points for groceries", "2 bananas", "cart", "leaderboard snacks"]) assert.ok(!POINTS_PATTERN.test(text) && !LEADERBOARD_PATTERN.test(text), text);
});

function newStore(name: string): { store: CartStore; alex: string; maya: string; jordan: string } {
  const store = new CartStore(join(directory, `${name}.sqlite`), "household-test", 5000, "http://127.0.0.1:3999", false);
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:jordan", name: "Jordan" }]);
  const idOf = (memberName: string) => store.getMembers().find((member) => member.name === memberName)!.id;
  return { store, alex: idOf("Alex"), maya: idOf("Maya"), jordan: idOf("Jordan") };
}

test("chores award the doer (covering counts) and undo takes the points back", () => {
  const { store, alex, maya } = newStore("chores");
  const points = new PointsService({ db: store.database, household: store.household, members: () => store.getMembers() });
  setActivePoints(points);
  const chores = new ChoreService(store, { demoMode: false });
  const today = chores.today();
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const created = chores.create({ name: "Dishes", schedule: { kind: "weekly", weekday }, pool: [alex, maya] });
  assert.ok(created.ok);
  const turn = created.chore.assigneeId!;
  const other = turn === alex ? maya : alex;
  const reply = chores.handleCommand({ messageId: id(), memberId: other, memberName: "Someone", text: "done dishes", attachments: [] });
  assert.match(reply ?? "", /Thanks for covering/);
  const entry = points.standings().find((standing) => standing.memberId === other)!;
  assert.equal(entry.total, POINT_RULES.choreCovering);
  const logId = (store.database.prepare("SELECT id FROM chore_log ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
  assert.ok(chores.undo(logId).ok);
  assert.equal(points.standings().find((standing) => standing.memberId === other)!.total, 0);
  setActivePoints(null);
  store.close();
});

test("checkout: the shopper earns points next to Splitwise's log, which keeps working", () => {
  const { store, alex, maya, jordan } = newStore("checkout");
  const points = new PointsService({ db: store.database, household: store.household, members: () => store.getMembers() });
  const seen: string[] = [];
  store.setCheckoutHooks(withCheckoutObserver(new SplitwiseService(store, {}), (checkout) => {
    seen.push(checkout.checkoutKey);
    if (checkout.payer) points.award({ kind: "checkout", memberId: checkout.payer.id, key: `checkout:${checkout.checkoutKey}` });
  }));
  store.processIncomingText(id(), alex, "2 bananas");
  store.processIncomingText(id(), maya, "bread");
  for (const member of [alex, maya, jordan]) store.processIncomingText(id(), member, "approve");
  const reply = store.processIncomingText(id(), maya, "checkout") ?? "";
  assert.match(reply, /Mock checkout complete/);
  assert.match(reply, /Splitwise \(simulated\)/);
  assert.equal(store.latestSplitwiseExpense()?.payerName, "Maya");
  assert.equal(seen.length, 1);
  assert.equal(points.standings().find((entry) => entry.memberId === maya)!.total, POINT_RULES.checkout);
  assert.match(store.processIncomingText(id(), maya, "splitwise") ?? "", /simulated/);
  store.close();
});
