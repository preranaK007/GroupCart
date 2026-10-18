// Run with: node --import=tsx --test src/store.test.ts
// CartStore after the upstream module split: our facade API on top of upstream's modules (sharing sessions feeding
// the Splitwise log, member handle normalization, help registry, idempotency helpers), and the one persisted
// household group used by list check-ins, notifyGroup(), and web chat relays. Temporary database, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Space } from "spectrum-ts";
import { ChatService } from "./chat.js";
import { HouseholdGroup, type GroupRef } from "./householdGroup.js";
import { notifyGroup, recentFeed, registerHelp, setGroupSender } from "./platform.js";
import { deliverDueListReminders } from "./reminders.js";
import { SplitwiseService } from "./splitwise.js";
import { CartStore, isStoreCommand, type Member } from "./store.js";

let directory: string;
let counter = 0;
const id = () => `test:${++counter}`;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "groupcart-store-"));
});

after(() => {
  setGroupSender(null);
  rmSync(directory, { recursive: true, force: true });
});

function newStore(name: string, now?: () => Date): { store: CartStore; alex: Member; maya: Member; jordan: Member } {
  const store = new CartStore(join(directory, `${name}.sqlite`), "household-test", 5000, "http://127.0.0.1:3999", false, now ? { now } : {});
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:jordan", name: "Jordan" }]);
  const byName = (memberName: string) => store.getMembers().find((member) => member.name === memberName)!;
  return { store, alex: byName("Alex"), maya: byName("Maya"), jordan: byName("Jordan") };
}

test("sharing sessions decide the split, and checkout logs that split to Splitwise (simulated)", () => {
  const { store, alex, maya, jordan } = newStore("sharing");
  store.setCheckoutHooks(new SplitwiseService(store, {}));
  store.processIncomingText(id(), alex.id, "2 bananas");
  assert.match(store.processIncomingText(id(), alex.id, "start sharing with Maya") ?? "", /Started sharing for Alex and Maya/);
  assert.match(store.processIncomingText(id(), maya.id, "bread") ?? "", /shared by Alex and Maya/);
  store.processIncomingText(id(), maya.id, "stop sharing");
  // Per-item sharing phrases no longer share anything (upstream); the item is the sender's.
  assert.match(store.processIncomingText(id(), jordan.id, "pasta for everyone") ?? "", /start sharing/);
  const before = store.snapshot();
  assert.deepEqual(before.items.map((item) => [item.name, item.participantIds.length]), [["Bananas", 1], ["Bread", 2], ["Pasta", 1]]);
  for (const member of [alex, maya, jordan]) store.processIncomingText(id(), member.id, "approve");
  const reply = store.processIncomingText(id(), alex.id, "checkout") ?? "";
  assert.match(reply, /Mock checkout complete/);
  assert.match(reply, /Splitwise \(simulated\)/);
  const logged = store.latestSplitwiseExpense()!;
  assert.equal(logged.totalCents, before.totalCents);
  assert.equal(logged.payerName, "Alex");
  for (const member of before.members) {
    assert.equal(logged.shares.find((share) => share.memberId === member.id)?.owedCents, member.shareCents);
  }
  assert.match(store.processIncomingText(id(), maya.id, "splitwise") ?? "", /simulated/);
  store.close();
});

test("splitwise status never feeds a pending recurring-list selection; pending questions are visible to features", () => {
  const { store, alex } = newStore("splitwise-pending");
  assert.equal(store.pendingQuestionAt(alex.id), null);
  assert.match(store.processIncomingText(id(), alex.id, "weekly: milk") ?? "", /which kind of milk/);
  assert.equal(store.hasPendingChoice(alex.id), true, "other features leave bare numbers to the store now");
  assert.match(store.processIncomingText(id(), alex.id, "splitwise") ?? "", /Splitwise logging isn’t set up/);
  assert.match(store.processIncomingText(id(), alex.id, "1") ?? "", /Whole milk/);
  assert.equal(store.pendingQuestionAt(alex.id), null);
  store.close();
});

test("quiet bot: banter gets no reply unless a question is open; grocery items still reach the cart", () => {
  const { store, alex, maya } = newStore("quiet");
  for (const text of ["lol", "👍", "thanks!", "ok", "haha ok 👍", "sounds good", "LMAOOO", "thank you 🙏"]) {
    assert.equal(store.processIncomingText(id(), alex.id, text), null, `no reply to “${text}”`);
  }
  assert.match(store.processIncomingText(id(), alex.id, "we need eggs") ?? "", /^Added eggs · cart \$[\d.]+ est\. \(1 item\)$/);
  assert.match(store.processIncomingText(id(), maya.id, "bread") ?? "", /^Added bread · cart/);
  assert.deepEqual(store.snapshot().items.map((item) => item.name), ["Eggs", "Bread"]);
  // With a question open (which milk?), a reply still gets an answer instead of silence.
  assert.match(store.processIncomingText(id(), alex.id, "milk") ?? "", /What kind of milk/);
  assert.notEqual(store.processIncomingText(id(), alex.id, "ok"), null);
  store.close();
});

test("member handles are normalized, aliases map to one member, and old rows keep their ids", () => {
  const path = join(directory, "members.sqlite");
  const first = new CartStore(path, "household-test", 5000);
  first.registerMembers([{ handle: "(555) 555-0100", name: "Alex" }]);
  const original = first.getMembers()[0]!;
  first.close();
  const second = new CartStore(path, "household-test", 5000);
  second.registerMembers([{ handle: "+15555550100", name: "Alex", aliases: ["alex@example.com"] }]);
  assert.equal(second.getMembers().length, 1);
  assert.equal(second.memberForHandle("555.555.0100")?.id, original.id);
  assert.equal(second.memberForHandle("+1 (555) 555-0100")?.id, original.id);
  second.close();
});

test("help keeps upstream's text and adds the calendar, splits/Splitwise, and registered lines", () => {
  const { store, alex } = newStore("help");
  registerHelp("Test feature: “ping” answers “pong”.");
  const help = store.processIncomingText(id(), alex.id, "help") ?? "";
  for (const expected of [/start sharing with Maya and Jordan/, /Recurring lists:/, /Calendar: “calendar”/, /Purchases: sending products to Kroger creates a draft/, /Test feature: “ping”/]) {
    assert.match(help, expected);
  }
  store.close();
});

test("idempotency helpers and store-owned phrases", () => {
  const { store } = newStore("idempotency");
  assert.equal(store.markMessageProcessed("event:1", null), true);
  assert.equal(store.markMessageProcessed("event:1", null), false);
  assert.equal(store.recordedReply("command:1"), undefined);
  store.recordCommandReply("command:1", "Household calendar: …");
  assert.equal(store.recordedReply("command:1"), "Household calendar: …");
  for (const text of ["cart", "approve", "start sharing with Maya", "stop sharing", "weekly: milk, eggs", "lists", "load weekly list", "monthly list on the 15th"]) {
    assert.equal(isStoreCommand(text), true, text);
  }
  for (const text of ["chores", "done dishes", "bill internet $90 due Nov 1", "calendar", "2 bananas", "yes"]) {
    assert.equal(isStoreCommand(text), false, text);
  }
  store.close();
});

type SentText = { space: string; text: string };

function fakeSpace(spaceId: string, sent: SentText[]): Space & { type: string } {
  return {
    id: spaceId,
    type: "group",
    send: async (content: unknown) => { sent.push({ space: spaceId, text: String(content) }); },
    responding: async (work: () => Promise<void>) => { await work(); },
  } as unknown as Space & { type: string };
}

test("one persisted household group: list check-ins, notifyGroup, and web chat relays after a restart", async () => {
  let now = new Date(2026, 9, 12, 12, 0); // Monday; the weekly list starts its first cycle on Sunday the 18th.
  const path = join(directory, "group.sqlite");
  const { store, alex } = newStore("group", () => now);
  store.processIncomingText(id(), alex.id, "weekly: eggs, bread");
  now = new Date(2026, 9, 18, 10, 0); // Sunday 10:00, after the 9:00 reminder hour.

  const sent: SentText[] = [];
  const opened: GroupRef[] = [];
  const opener = async (ref: GroupRef) => { opened.push(ref); return fakeSpace(ref.id, sent); };

  // Nothing is sent before an allowlisted member has written from the group.
  assert.equal((await deliverDueListReminders(store, () => new HouseholdGroup(store, opener).reminderTarget(() => {}))).status, "no-group");
  new HouseholdGroup(store, opener).remember(fakeSpace("chat-guid-1", sent), "+15550001111");
  store.close();

  // "Restart": a new store and group object reopen the persisted group by chat id and serving line.
  const restarted = new CartStore(path, "household-test", 5000, "http://127.0.0.1:3999", false, { now: () => now });
  const group = new HouseholdGroup(restarted, opener);
  assert.equal(group.known, true);
  const mirrored: string[] = [];
  const result = await deliverDueListReminders(restarted, () => group.reminderTarget((text) => mirrored.push(text)));
  assert.equal(result.status, "sent");
  assert.deepEqual(opened, [{ id: "chat-guid-1", phone: "+15550001111" }]);
  assert.match(sent.at(-1)!.text, /Weekly groceries are due/);
  assert.equal(mirrored.length, 1);
  assert.equal((await deliverDueListReminders(restarted, () => group.reminderTarget(() => {}))).status, "none");

  // notifyGroup() goes to the same group (and the feed).
  setGroupSender((text) => group.send(text));
  await notifyGroup("🧹 Friendly nudge: dishes");
  assert.deepEqual(sent.at(-1), { space: "chat-guid-1", text: "🧹 Friendly nudge: dishes" });
  assert.equal(recentFeed(1)[0]?.text, "🧹 Friendly nudge: dishes");
  setGroupSender(null);

  // The web chat relays through the same group without anyone texting first.
  const chat = new ChatService({
    db: restarted.database,
    filesDir: join(directory, "chat-files"),
    liveMode: true,
    members: () => restarted.getMembers(),
    process: async ({ text }) => (text === "cart" ? "Cart is empty." : null),
  });
  chat.useGroup(group.channel(), () => group.known);
  assert.equal(chat.groupConnected, true);
  const member = restarted.getMembers().find((candidate) => candidate.name === "Alex")!;
  const relayed = await chat.send(member, { text: "cart" }, { source: "web", awaitReply: true });
  assert.equal(relayed.reply, "Cart is empty.");
  assert.deepEqual(sent.slice(-2).map((entry) => entry.text), ["Alex: cart", "Cart is empty."]);
  assert.equal(opened.length, 1, "the reopened group is reused");
  restarted.close();
});
