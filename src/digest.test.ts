// Run with: node --import=tsx --test src/digest.test.ts
// Sunday digest: the text (short, emoji bullets, empty sections left out), the Sunday 6pm window, and
// once-per-week delivery even with several timers or instances on one database. No network.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildDigest, DigestService, digestWeekKey, emptyDigestData, nextDigestLabel, type DigestData } from "./digest.js";

const sunday6pm = new Date(2026, 9, 18, 18, 5); // Sun Oct 18 2026, 6:05pm local

function fullData(): DigestData {
  return {
    chores: [
      { emoji: "🍽️", name: "Dishes", who: "Maya", late: true },
      { emoji: "🗑️", name: "Take out trash", who: "Alex Kim", late: false },
      { emoji: "🧹", name: "Vacuum", who: null, late: false },
      { emoji: "🪴", name: "Water plants", who: "Jordan", late: false },
    ],
    transfers: [{ from: "Jordan", to: "Alex", cents: 2667 }, { from: "Maya", to: "Alex", cents: 1200 }],
    events: [{ emoji: "🎲", title: "Game night", when: "Fri 7pm" }, { emoji: "🏠", title: "House meeting", when: "Sun 7pm" }],
    polls: ["Movie night"],
    lists: [{ title: "weekly list", when: "Sun" }],
    bills: [{ emoji: "⚡", vendor: "City Light", cents: 11_240, when: "Tue", overdue: false }, { emoji: "📶", vendor: "Xfinity", cents: 8_000, when: "Mon", overdue: true }],
    stat: "🔥 Longest streak: Alex, 4 weeks of chores on time",
  };
}

test("digest text: header plus one emoji line per section, under ten lines", () => {
  const text = buildDigest(fullData(), { now: sunday6pm });
  const lines = text.split("\n");
  assert.ok(lines.length <= 10, text);
  assert.equal(lines[0], "📬 Sunday digest · week of Oct 19");
  assert.equal(lines[1], "🧽 Chores: 🍽️ Dishes (Maya, late) · 🗑️ Take out trash (Alex) · 🧹 Vacuum (open) +1");
  assert.equal(lines[2], "💸 Settle up: Jordan → Alex $26.67 · Maya → Alex $12 ($38.67 total)");
  assert.equal(lines[3], "📅 Coming up: 🗳️ Movie night vote open · 🎲 Game night Fri 7pm · 🏠 House meeting Sun 7pm");
  assert.equal(lines[4], "🛒 Lists due: weekly list Sun");
  assert.equal(lines[5], "🧾 Bills: ⚡ City Light $112.40 Tue · 📶 Xfinity $80 overdue");
  assert.equal(lines[6], "🔥 Longest streak: Alex, 4 weeks of chores on time");
  for (const line of lines) assert.match(line, /^\p{Extended_Pictographic}/u);
});

test("digest text: empty sections are left out; a quiet week says so", () => {
  const quiet = buildDigest(emptyDigestData(), { now: sunday6pm, preview: true }).split("\n");
  assert.deepEqual(quiet, ["📬 Digest preview · week of Oct 19", "💸 Everyone’s settled up.", "🎉 A quiet week: nothing due."]);
  const some = buildDigest({ ...emptyDigestData(), bills: [{ emoji: "⚡", vendor: "City Light", cents: 11_240, when: "Tue", overdue: false }] }, { now: new Date(2026, 9, 14, 9) });
  assert.equal(some, "📬 Sunday digest · week of Oct 19\n💸 Everyone’s settled up.\n🧾 Bills: ⚡ City Light $112.40 Tue");
});

test("send window: Sunday from 6pm, catching up until Monday noon", () => {
  assert.equal(digestWeekKey(new Date(2026, 9, 18, 17, 59)), null);
  assert.equal(digestWeekKey(new Date(2026, 9, 18, 18, 0)), "2026-10-18");
  assert.equal(digestWeekKey(new Date(2026, 9, 18, 23, 59)), "2026-10-18");
  assert.equal(digestWeekKey(new Date(2026, 9, 19, 11, 59)), "2026-10-18");
  assert.equal(digestWeekKey(new Date(2026, 9, 19, 12, 0)), null);
  assert.equal(digestWeekKey(new Date(2026, 9, 17, 18, 30)), null); // Saturday
  assert.equal(nextDigestLabel(new Date(2026, 9, 18, 10)), "Today 6pm");
  assert.equal(nextDigestLabel(new Date(2026, 9, 18, 19)), "Sun 6pm");
  assert.equal(nextDigestLabel(new Date(2026, 9, 14, 10)), "Sun 6pm");
});

test("sent once per week, across timers and a second instance; waits while it can't be delivered", async () => {
  const db = new DatabaseSync(":memory:");
  const now = { value: new Date(2026, 9, 18, 17, 50) };
  const sent: string[] = [];
  let deliverable = false;
  const make = () => new DigestService({ db, household: "h", now: () => now.value, gather: fullData, send: async (text) => { sent.push(text); }, canSend: () => deliverable });
  const first = make();
  const second = make();
  assert.equal(await first.tick(), "not_due");
  now.value = new Date(2026, 9, 18, 18, 5);
  assert.equal(await first.tick(), "waiting"); // e.g. live mode before the bot has seen the group
  assert.equal(first.lastSent(), null);
  deliverable = true;
  assert.deepEqual(await Promise.all([first.tick(), second.tick()]).then((results) => results.sort()), ["already_sent", "sent"]);
  now.value = new Date(2026, 9, 18, 21, 0);
  assert.equal(await first.tick(), "already_sent");
  now.value = new Date(2026, 9, 19, 9, 0); // Monday catch-up window, same week
  assert.equal(await second.tick(), "already_sent");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^📬 Sunday digest · week of Oct 19/);
  assert.equal(first.lastSent()?.week, "2026-10-18");
  now.value = new Date(2026, 9, 25, 18, 1); // next Sunday
  assert.equal(await second.tick(), "sent");
  assert.equal(sent.length, 2);
});

test("most bought counts checkout items once per checkout", () => {
  const db = new DatabaseSync(":memory:");
  const digest = new DigestService({ db, household: "h", now: () => sunday6pm, gather: emptyDigestData, send: async () => {} });
  assert.equal(digest.mostBought(), null);
  digest.recordPurchases("r1", [{ name: "Bananas", quantity: 3 }, { name: "Oat milk", quantity: 1 }], new Date(2026, 9, 10));
  digest.recordPurchases("r1", [{ name: "Bananas", quantity: 3 }], new Date(2026, 9, 10)); // replay
  digest.recordPurchases("r2", [{ name: "bananas", quantity: 1 }, { name: "Oat milk", quantity: 2 }], new Date(2026, 9, 15));
  assert.deepEqual(digest.mostBought(), { name: "bananas", count: 4 });
});
