// Run with: node --import=tsx --test src/house.test.ts
// House: phrase parsers, secret masking, quick polls (votes, bare-number disambiguation, auto-close), guest
// heads-ups and reactions, quiet hours, photo repairs, and the de-duplicated weekly repair nudge.
// Temporary database, fixed clock (UTC), no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { EventsService } from "./events.js";
import { HouseService } from "./house.js";
import {
  buildPoll, maskFields, maskSecret, parseGuest, parseHouseCommand, parseQuiet, parseReaction, parseRepairNew, parseVoteText, SECRET_MASK, trashHint,
} from "./houseParse.js";
import { NamedListsService } from "./namedLists.js";
import { registerCommand, runCommands, type CommandContext } from "./platform.js";
import { CartStore, type Member } from "./store.js";

let directory: string;
let counter = 0;
const id = () => `house-test:${++counter}`;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// Wednesday, Oct 14 2026, 3pm UTC.
const START = Date.UTC(2026, 9, 14, 15, 0);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

before(() => { directory = mkdtempSync(join(tmpdir(), "groupcart-house-")); });
after(() => { rmSync(directory, { recursive: true, force: true }); });

function setup(name: string) {
  let now = START;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; }, set: (ms: number) => { now = ms; } };
  const store = new CartStore(join(directory, `${name}.sqlite`), "household-test", 5000, "http://127.0.0.1:3999", false, { now: () => new Date(now) });
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:jordan", name: "Jordan" }]);
  const byName = (memberName: string) => store.getMembers().find((member) => member.name === memberName)!;
  const sent: string[] = [];
  const lists = new NamedListsService(store, { timeZone: "UTC", now: clock.now });
  const events = new EventsService(store, { lists, timeZone: "UTC", notify: async () => {}, now: clock.now });
  const house = new HouseService(store, { events, timeZone: "UTC", now: clock.now, filesDir: join(directory, `${name}-files`), demoMode: false, publicUrl: "http://127.0.0.1:3999", notify: async (text) => { sent.push(text); } });
  const say = (member: Member, text: string, attachments: CommandContext["attachments"] = []) => house.handleCommand({ messageId: id(), memberId: member.id, memberName: member.name, text, attachments });
  return { store, house, events, clock, sent, say, alex: byName("Alex"), maya: byName("Maya"), jordan: byName("Jordan") };
}

// ---------------------------------------------------------------------------
// Parsers

test("house info and repair phrases parse; grocery, list, and plan phrases don't", () => {
  assert.deepEqual(parseHouseCommand("wifi"), { kind: "info", topic: "wifi" });
  assert.deepEqual(parseHouseCommand("what's the wifi password?"), { kind: "info", topic: "wifi" });
  assert.deepEqual(parseHouseCommand("door code"), { kind: "info", topic: "door", hint: "door" });
  assert.deepEqual(parseHouseCommand("what's the gate code"), { kind: "info", topic: "door", hint: "gate" });
  assert.equal(parseHouseCommand("house rules")?.kind, "info");
  assert.deepEqual(parseHouseCommand("landlord"), { kind: "info", topic: "landlord" });
  assert.deepEqual(parseHouseCommand("when is trash day?"), { kind: "info", topic: "trash" });
  assert.deepEqual(parseHouseCommand("broken: kitchen faucet leaking"), { kind: "repair.new", title: "Kitchen faucet leaking" });
  assert.deepEqual(parseHouseCommand("fixed dishwasher"), { kind: "repair.fixed", query: "dishwasher" });
  assert.deepEqual(parseHouseCommand("the faucet is fixed"), { kind: "repair.fixed", query: "faucet" });
  assert.deepEqual(parseHouseCommand("told the landlord about the faucet"), { kind: "repair.reported", query: "faucet" });
  assert.deepEqual(parseHouseCommand("I'll handle the dishwasher"), { kind: "repair.assign", query: "dishwasher", who: "me" });
  assert.equal(parseRepairNew("the dishwasher won't drain"), "Dishwasher won't drain");
  assert.equal(parseRepairNew("leaky faucet in the bathroom"), "Leaky faucet in the bathroom");
  assert.equal(parseRepairNew("the milk is out"), null);
  for (const text of ["2 bananas", "milk", "weekly: milk", "hey we all want to watch a movie", "lists", "start sharing with Maya", "add event house meeting Sunday 7pm", "poll game night", "cart"]) {
    assert.equal(parseHouseCommand(text), null, text);
  }
});

test("quick polls: question and options", () => {
  assert.deepEqual(buildPoll("takeout tonight? thai, pizza, sushi"), { question: "Takeout tonight?", options: ["Thai", "Pizza", "Sushi"] });
  assert.deepEqual(buildPoll("thermostat 68 or 70?"), { question: "Thermostat 68 or 70?", options: ["68", "70"] });
  assert.deepEqual(buildPoll("should we go to Costco or Trader Joe's"), { question: "Should we go to Costco or Trader Joe's?", options: ["Costco", "Trader Joe's"] });
  assert.deepEqual(buildPoll("get a cleaner?"), { question: "Get a cleaner?", options: ["Yes", "No"] });
  assert.deepEqual(buildPoll("9:30 or 10?"), { question: "9:30 or 10?", options: ["9:30", "10"] });
  assert.ok("error" in buildPoll("pick? one"));
  assert.deepEqual(parseHouseCommand("poll: takeout tonight? thai, pizza, sushi"), { kind: "poll.new", question: "Takeout tonight?", options: ["Thai", "Pizza", "Sushi"] });
  assert.deepEqual(parseHouseCommand("polls"), { kind: "poll.list" });
  assert.deepEqual(parseHouseCommand("close poll"), { kind: "poll.close", hint: null });
  assert.deepEqual(parseVoteText("2"), { kind: "number", option: 2 });
  assert.deepEqual(parseVoteText("I vote 3"), { kind: "number", option: 3 });
  assert.deepEqual(parseVoteText("1 3"), { kind: "multi" });
  assert.deepEqual(parseVoteText("vote pizza"), { kind: "text", text: "pizza" });
  assert.equal(parseVoteText("2 bananas"), null);
});

test("guest heads-ups: who, title, and when", () => {
  const today = "2026-10-14"; // Wednesday
  assert.deepEqual(parseGuest("having friends over Fri 8pm", today, 15 * 60, "Maya"), { who: "Maya’s friends", title: "Maya’s friends over", date: "2026-10-16", endDate: null, startMin: 20 * 60, durationMin: 180 });
  assert.deepEqual(parseGuest("my sister is staying Sat–Sun", today, 15 * 60, "Maya"), { who: "Maya’s sister", title: "Maya’s sister staying", date: "2026-10-17", endDate: "2026-10-18", startMin: null, durationMin: null });
  assert.equal(parseGuest("my parents are visiting this weekend", today, 15 * 60, "Alex")?.date, "2026-10-17");
  assert.equal(parseGuest("Sam is coming over tonight at 8", today, 15 * 60, "Alex")?.title, "Sam coming over");
  assert.equal(parseGuest("having friends over", today, 15 * 60, "Alex")?.date, "");
  assert.equal(parseGuest("Maya is staying late at work", today, 15 * 60, "Alex", ["Alex", "Maya", "Jordan"]), null);
  assert.equal(parseGuest("it is staying cold this week", today, 15 * 60, "Alex"), null);
  assert.deepEqual(parseReaction("ok"), { reaction: "ok", note: null });
  assert.deepEqual(parseReaction("concern: exam friday"), { reaction: "concern", note: "exam friday" });
});

test("quiet hours: tonight, reasons, defaults, and non-matches", () => {
  const today = "2026-10-14";
  assert.deepEqual(parseQuiet("quiet hours tonight from 10pm", today, 15 * 60), { kind: "adhoc", date: today, startMin: 22 * 60, endMin: null, reason: null });
  assert.deepEqual(parseQuiet("exam tomorrow, quiet please after 9", today, 15 * 60), { kind: "adhoc", date: today, startMin: 21 * 60, endMin: null, reason: "Exam tomorrow" });
  assert.deepEqual(parseQuiet("quiet hours tomorrow 10pm-7am", today, 15 * 60), { kind: "adhoc", date: "2026-10-15", startMin: 22 * 60, endMin: 31 * 60, reason: null });
  assert.deepEqual(parseQuiet("quiet after midnight tonight", today, 15 * 60), { kind: "adhoc", date: today, startMin: 24 * 60, endMin: null, reason: null });
  // Just after midnight, "tonight" is still the night that started yesterday.
  assert.equal((parseQuiet("quiet hours tonight from 1am", today, 30) as { date: string }).date, "2026-10-13");
  assert.deepEqual(parseQuiet("quiet hours", today, 15 * 60), { kind: "status" });
  assert.deepEqual(parseQuiet("cancel quiet hours", today, 15 * 60), { kind: "cancel" });
  assert.deepEqual(parseQuiet("set quiet hours 11pm-7am weeknights", today, 15 * 60), { kind: "default", startMin: 23 * 60, endMin: 7 * 60, nights: [0, 1, 2, 3, 4] });
  assert.equal(parseQuiet("the quiet hours are annoying", today, 15 * 60), null);
  assert.equal(parseQuiet("quiet", today, 15 * 60), null);
  assert.equal(trashHint("Tuesday night", "2026-10-13", 10 * 60), "Tonight");
  assert.equal(trashHint("Thursday", "2026-10-14", 10 * 60), "Tomorrow");
});

test("secrets are masked everywhere except reveal, the group commands, and include_secrets", async () => {
  const { house, say, alex } = setup("secrets");
  assert.equal(maskSecret("4821"), SECRET_MASK);
  assert.equal(maskSecret("a-much-longer-password"), SECRET_MASK);
  assert.equal(maskSecret(""), "");
  assert.deepEqual(maskFields("wifi", { network: "Home", password: "pw" }), { network: "Home", password: SECRET_MASK });
  const wifi = house.saveCard({ kind: "wifi", fields: { network: "Apt4B-5G", password: "sunny-otter-42" } }, alex.id);
  const door = house.saveCard({ kind: "door", title: "Front door", fields: { code: "4821" } }, alex.id);
  assert.ok(wifi.ok && door.ok);
  const json = JSON.stringify(house.state(alex.id));
  assert.ok(!json.includes("sunny-otter-42") && !json.includes("4821"), "page state never carries secrets");
  assert.deepEqual(house.cards().find((card) => card.kind === "wifi")?.secrets, ["password"]);
  assert.deepEqual(house.reveal(wifi.card.id), { password: "sunny-otter-42" });
  // Editing without the secret keeps it; "" clears it.
  house.saveCard({ id: door.card.id, fields: { note: "press #" } }, alex.id);
  assert.deepEqual(house.reveal(door.card.id), { code: "4821" });
  const tool = house.tools().find((spec) => spec.name === "get_house_info")!;
  const masked = JSON.stringify(await tool.handler({}, { memberId: alex.id, memberName: alex.name }));
  assert.ok(!masked.includes("sunny-otter-42") && masked.includes(SECRET_MASK));
  const revealed = JSON.stringify(await tool.handler({ include_secrets: true }, { memberId: alex.id, memberName: alex.name }));
  assert.ok(revealed.includes("sunny-otter-42") && revealed.includes("4821"));
  assert.match(await say(alex, "wifi") ?? "", /Apt4B-5G\nPassword: sunny-otter-42/);
  assert.match(await say(alex, "door code") ?? "", /Front door: 4821[\s\S]*tap to reveal[\s\S]*\/house/);
});

// ---------------------------------------------------------------------------
// Polls

test("polls: numbers vote only while the poll is the sender's newest question; everyone voting closes it", async () => {
  const { house, store, events, clock, say, alex, maya, jordan } = setup("polls");
  assert.match(await say(maya, "poll: takeout tonight? thai, pizza, sushi") ?? "", /1\) Thai\n2\) Pizza\n3\) Sushi/);
  clock.advance(60_000);
  assert.match(await say(maya, "2") ?? "", /Maya → Pizza\. Thai 0 · Pizza 1 · Sushi 0 · waiting on Alex, Jordan/);
  assert.match(await say(maya, "1 3") ?? "", /One pick per person/);

  // A newer grocery question (demo milk kind) owns bare numbers for that member.
  clock.advance(60_000);
  store.processIncomingText(id(), alex.id, "milk");
  assert.ok(store.pendingQuestionAt(alex.id), "the store asked Alex which milk");
  assert.equal(await say(alex, "1"), null);
  // Others still vote.
  assert.match(await say(jordan, "vote thai") ?? "", /Jordan → Thai/);

  // A newer events plan vote also takes bare numbers (the events module answers them).
  clock.advance(60_000);
  const plan = await events.createPoll({ shape: { label: "Game night", emoji: "🎲", kind: "game", minutes: 120, window: [18 * 60, 23 * 60], preferred: 19 * 60, preferredDays: [0, 1, 2, 3, 4, 5, 6] }, organizerId: maya.id, mode: "vote", slots: [{ start: START + 2 * DAY, end: START + 2 * DAY + 2 * HOUR, busy: [] }, { start: START + 3 * DAY, end: START + 3 * DAY + 2 * HOUR, busy: [] }] });
  assert.ok(plan.ok);
  assert.equal(await say(jordan, "2"), null);
  events.cancelPoll(plan.poll.id);

  // Alex answers the milk question, then votes; everyone has voted, so the poll closes with the result.
  store.processIncomingText(id(), alex.id, "cancel");
  assert.equal(store.pendingQuestionAt(alex.id), null);
  const result = await say(alex, "2") ?? "";
  assert.match(result, /Everyone voted: Takeout tonight\?\n→ Tie: Thai and Pizza \(1 each\)|Everyone voted: Takeout tonight\?\n→ Pizza wins/);
  assert.equal(house.openPolls().length, 0);
  assert.equal(await say(alex, "3"), null, "no open poll: numbers fall through");
});

test("polls auto-close after 24 hours (once), outside quiet hours", async () => {
  const { house, clock, sent, say, maya, jordan } = setup("poll-expiry");
  house.setQuietDefault({ enabled: false });
  await say(maya, "poll: thermostat 68 or 70?");
  await say(jordan, "2");
  clock.advance(23 * HOUR);
  assert.deepEqual(await house.tick(), []);
  clock.advance(2 * HOUR);
  const closed = await house.tick();
  assert.equal(closed.length, 1);
  assert.match(closed[0]!, /Poll closed: Thermostat 68 or 70\?\n→ 70 wins \(1 of 1\)/);
  assert.deepEqual(await house.tick(), [], "closes once");
  assert.equal(sent.filter((text) => text.includes("Poll closed")).length, 1);
  assert.match(await say(maya, "polls") ?? "", /No open polls/);
});

// ---------------------------------------------------------------------------
// Repairs

test("repairs: log, photo caption, follow-up photo, report, fix", async () => {
  const { house, say, alex, maya, jordan } = setup("repairs");
  assert.match(await say(maya, "broken: dishwasher won't drain") ?? "", /Repair #1 logged: Dishwasher won't drain\. Send a photo if it helps\.\nUpdates: “reported dishwasher”, “fixed dishwasher”/);
  // A photo right after (no text) is attached to Maya's new request.
  assert.match(await say(maya, "", [{ mimeType: "image/png", read: async () => PNG }]) ?? "", /Added the photo to repair #1/);
  assert.ok(house.repairs().open[0]!.photoUrl);
  // A photo with a "broken" caption becomes a request with that photo.
  assert.match(await say(jordan, "broken: bathroom faucet dripping", [{ mimeType: "image/png", read: async () => PNG }]) ?? "", /Repair #2 logged: Bathroom faucet dripping\. 📷/);
  // A stray photo from someone else isn't House's (bills may read it).
  assert.equal(await say(alex, "", [{ mimeType: "image/png", read: async () => PNG }]), null);
  assert.match(await say(alex, "reported faucet") ?? "", /Reported to the landlord: Bathroom faucet dripping \(#2\)/);
  assert.match(await say(alex, "I'll handle the dishwasher") ?? "", /Alex is on it: Dishwasher won't drain/);
  assert.match(await say(alex, "fixed dishwasher") ?? "", /Fixed: Dishwasher won't drain \(#1\)\. Thanks, Alex!/);
  assert.equal(await say(alex, "fixed the lamp"), null, "no matching repair: left to chores and the cart");
  const fixed = house.repairs().fixed[0]!;
  assert.deepEqual(fixed.log.map((entry) => entry.kind), ["opened", "photo", "assigned", "fixed"]);
  assert.match(await say(maya, "repairs") ?? "", /#2 Bathroom faucet dripping · reported/);
});

test("weekly repair nudge: after 7 days, once per week per request", async () => {
  const { house, clock, sent, say, maya } = setup("nudge");
  house.setQuietDefault({ enabled: false });
  clock.set(Date.UTC(2026, 9, 14, 10, 0));
  await say(maya, "broken: kitchen faucet leaking");
  clock.advance(6 * DAY);
  assert.deepEqual(await house.tick(), []);
  clock.advance(DAY + HOUR);
  const first = await house.tick();
  assert.equal(first.length, 1);
  assert.match(first[0]!, /Kitchen faucet leaking \(#1\) has been open 7 days\. Told the landlord\? “reported faucet”\. Fixed\? “fixed faucet”\./);
  assert.deepEqual(await house.tick(), [], "de-duplicated");
  clock.advance(3 * DAY);
  assert.deepEqual(await house.tick(), [], "still the same week");
  clock.advance(4 * DAY);
  assert.equal((await house.tick()).length, 1, "next week nudges again");
  // Overnight (outside 9am–9pm) nothing is sent.
  clock.advance(7 * DAY);
  clock.set(Date.UTC(2026, 10, 4, 23, 0));
  assert.deepEqual(await house.tick(), []);
  assert.equal(sent.length, 2);
});

// ---------------------------------------------------------------------------
// Guests and quiet hours

test("guest heads-up: an event on the calendar, and ok/concern reactions from others", async () => {
  const { house, events, clock, say, alex, maya, jordan } = setup("guests");
  // Thursday night has default quiet hours (11pm); Friday night doesn't.
  assert.match(await say(alex, "having people over Thu 8pm") ?? "", /🧳 Heads-up: Alex’s guests over · Tomorrow 8pm\. Quiet hours start 11pm\.\nReply “ok” or “concern”\./);
  clock.advance(60_000);
  const reply = await say(maya, "having friends over Fri 8pm") ?? "";
  assert.match(reply, /^🧳 Heads-up: Maya’s friends over · Fri 8pm\.\nReply “ok” or “concern”\.$/);
  const event = events.activeEvents().find((candidate) => candidate.title === "Maya’s friends over");
  assert.ok(event && event.emoji === "🧳" && event.startMin === 20 * 60);
  assert.equal(await say(maya, "ok"), null, "the host's own ok isn't a reaction");
  assert.match(await say(alex, "ok") ?? "", /Alex is OK with Maya’s friends over \(1 of 2\)/);
  assert.match(await say(jordan, "concern: exam Saturday morning") ?? "", /Jordan has a concern about Maya’s friends over: exam Saturday morning\. Maya, maybe talk it through\?/);
  assert.deepEqual(Object.fromEntries(Object.entries(house.guests().find((guest) => guest.title === "Maya’s friends over")!.reactions).map(([memberId, value]) => [memberId, value.reaction])), { [alex.id]: "ok", [jordan.id]: "concern" });
  assert.match(await say(jordan, "my sister is staying Sat–Sun") ?? "", /Jordan’s sister staying · Sat–Sun/);
  assert.equal(house.guests().length, 3);
  assert.match(await say(alex, "having people over") ?? "", /When\?/);
});

test("quiet hours: weeknight default, an ad-hoc night replaces it, cancel falls back", async () => {
  const { house, say, alex, jordan } = setup("quiet");
  // Wednesday 3pm: tonight's default is 11pm–8am.
  assert.equal(house.tonightQuiet()?.label, "Tonight 11pm–8am");
  assert.match(await say(jordan, "exam tomorrow, quiet please after 9") ?? "", /🤫 Quiet hours tonight 9pm–8am — Jordan: exam tomorrow\./);
  const tonight = house.tonightQuiet();
  assert.equal(tonight?.kind, "adhoc");
  assert.equal(house.quietWindows(START, START + DAY).length, 1, "the ad-hoc night replaces the default");
  assert.deepEqual(house.homeLine(), { text: "Quiet hours tonight 9pm", icon: "moon", tone: "neutral" });
  assert.match(await say(alex, "quiet hours") ?? "", /weeknights 11pm–8am\.\nTonight 9pm–8am \(Jordan: exam tomorrow\)/);
  assert.match(await say(alex, "cancel quiet hours") ?? "", /usual 11pm–8am still applies/);
  // Friday night isn't in the default; an explicit request adds it.
  assert.match(await say(alex, "quiet hours friday from 10pm") ?? "", /Quiet hours fri 10pm–8am — Alex\./i);
  assert.match(await say(alex, "set quiet hours 10pm-7am every night") ?? "", /every night 10pm–7am/);
  assert.equal(house.inQuiet(Date.UTC(2026, 9, 15, 6, 0)), true);
  assert.equal(house.inQuiet(Date.UTC(2026, 9, 15, 12, 0)), false);
});

test("registerCommand({ before }) puts a narrow handler ahead of a broader one", async () => {
  registerCommand("house-test-broad", ({ text }) => (text === "order-check" ? "broad" : null));
  registerCommand("house-test-narrow", ({ text }) => (text === "order-check" ? "narrow" : null), { before: "house-test-broad" });
  assert.equal(await runCommands({ messageId: id(), memberId: "m", memberName: "M", text: "order-check", attachments: [] }), "narrow");
});
