// Run with: node --import=tsx --test src/chat.test.ts
// Web chat: a message an AI assistant sends for a member keeps the assistant's name for the chat to show; bot
// messages carry cards (polls, buttons) that survive storage, update in place, and dispatch taps to their owner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { ChatError, ChatService, type ChatCard, type PollCard } from "./chat.js";
import { EventsService } from "./events.js";
import { NamedListsService } from "./namedLists.js";
import { cardHandler, cardReply, cardText, postCard, postMessage, registerCardHandler, setGroupSender } from "./platform.js";
import { CartStore, type Member } from "./store.js";

const directory = mkdtempSync(join(tmpdir(), "groupcart-chat-"));
const db = new DatabaseSync(":memory:");
const stores: CartStore[] = [];
after(() => {
  db.close();
  for (const store of stores) store.close(); // Windows refuses to delete an open SQLite file.
  rmSync(directory, { recursive: true, force: true });
});

const sami: Member = { id: "m-sami", handle: "demo:sami", name: "Sami" };
const maya: Member = { id: "m-maya", handle: "demo:maya", name: "Maya" };
const newChat = () => new ChatService({ db, filesDir: directory, liveMode: false, members: () => [sami, maya], process: async () => null });
const poll = (id: string, multi: boolean): PollCard => ({
  kind: "poll", id, question: "Movie night?", multi, votes: {},
  options: [{ id: "fri", label: "Fri 8 PM" }, { id: "sat", label: "Sat 7 PM", detail: "Maya busy" }],
});

test("connector messages record which assistant sent them; web messages don't", async () => {
  const chat = newChat();
  const viaGrok = await chat.send(sami, { text: "add movie Interstellar" }, { source: "connector", via: "Grok", awaitReply: true });
  const typed = await chat.send(sami, { text: "milk" }, { source: "web", awaitReply: true });
  assert.equal(chat.get(viaGrok.message.id)?.via, "Grok");
  assert.equal(chat.get(typed.message.id)?.via, null);
});

test("cards: stored with the bot message, replaced in place, found by card id, and reported as changed", async () => {
  const chat = newChat();
  const card: ChatCard = { kind: "actions", id: "test:pay", title: "Settle up", actions: [{ id: "pay", label: "Pay", url: "https://venmo.com/x" }, { id: "paid", label: "Mark paid" }] };
  const posted = chat.recordBot("You owe Ashwin $24.70.", "notify", undefined, card, { author: "Claude" })!;
  assert.deepEqual(chat.get(posted.id)?.card, card);
  assert.equal(posted.name, "Claude");
  assert.equal(chat.recordBot("Plain reply")?.name, "GroupCart");
  assert.equal(chat.recordBot("Plain reply")?.card, null);

  const before = new Date(Date.parse(posted.updatedAt) + 1).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const resolved = { ...card, resolved: "Paid back" };
  const updated = chat.updateCard(posted.id, resolved)!;
  assert.deepEqual(updated.card, resolved);
  assert.ok(updated.updatedAt > posted.updatedAt, "an update bumps updatedAt");
  assert.equal(updated.text, "You owe Ashwin $24.70.");
  assert.equal(chat.findByCardId("test:pay")?.id, posted.id);
  assert.ok(chat.changedSince(before).some((message) => message.id === posted.id), "pollers see the changed card");
  assert.equal(chat.updateCard(chat.recordBot("no card")!.id, card), null, "only messages with a card take updates");
});

test("cards: a tap goes to the owner's handler; a poll without one toggles the member's vote", async () => {
  const chat = newChat();
  // No handler for "loose": the default toggles votes (single choice moves the vote; a second tap removes it).
  const single = chat.recordBot("", "notify", undefined, poll("loose:1", false))!;
  let result = await chat.actOnCard(sami, single.id, { optionIds: ["fri"] });
  assert.deepEqual((result.message.card as PollCard).votes, { fri: ["m-sami"], sat: [] });
  result = await chat.actOnCard(sami, single.id, { optionIds: ["sat"] });
  assert.deepEqual((result.message.card as PollCard).votes, { fri: [], sat: ["m-sami"] });
  result = await chat.actOnCard(sami, single.id, { optionIds: ["sat"] });
  assert.deepEqual((result.message.card as PollCard).votes, { fri: [], sat: [] });
  const multi = chat.recordBot("", "notify", undefined, poll("loose:2", true))!;
  await chat.actOnCard(sami, multi.id, { optionIds: ["fri"] });
  result = await chat.actOnCard(maya, multi.id, { optionIds: ["fri"] });
  result = await chat.actOnCard(sami, multi.id, { optionIds: ["sat"] });
  assert.deepEqual((result.message.card as PollCard).votes, { fri: ["m-sami", "m-maya"], sat: ["m-sami"] });

  // A registered owner gets the member and button; its card is stored and its reply posted.
  const calls: Array<{ memberId: string; actionId?: string }> = [];
  registerCardHandler("chattest", ({ memberId, card, actionId }) => {
    calls.push({ memberId, actionId });
    if (memberId !== "m-sami") return { error: "Only Sami can mark this paid." };
    return card.kind === "actions" ? { card: { ...card, resolved: "Paid back" }, reply: "Recorded: Sami paid Maya $5." } : null;
  });
  const buttons = chat.recordBot("You owe Maya $5.00.", "notify", undefined, { kind: "actions", id: "chattest:settle", actions: [{ id: "paid", label: "Mark paid" }] })!;
  await assert.rejects(chat.actOnCard(maya, buttons.id, { actionId: "paid" }), (error: unknown) => error instanceof ChatError && error.message === "Only Sami can mark this paid.");
  await assert.rejects(chat.actOnCard(sami, buttons.id, { actionId: "nope" }), ChatError, "unknown buttons are refused before the handler");
  const paid = await chat.actOnCard(sami, buttons.id, { actionId: "paid" });
  assert.equal(paid.message.card?.kind === "actions" && paid.message.card.resolved, "Paid back");
  assert.equal(paid.reply?.text, "Recorded: Sami paid Maya $5.");
  assert.deepEqual(calls, [{ memberId: "m-maya", actionId: "paid" }, { memberId: "m-sami", actionId: "paid" }]);
  await assert.rejects(chat.actOnCard(sami, buttons.id, { actionId: "paid" }), ChatError, "a resolved card takes no more taps");
});

test("cardText: numbered options and how to answer for iMessage; cardReply gives the web chat the card back", () => {
  assert.equal(cardText(poll("x:1", true)), "Movie night?\n1. Fri 8 PM\n2. Sat 7 PM (Maya busy)\nReply with every number that works, e.g. “1 2”.");
  assert.equal(cardText(poll("x:1", false)), "Movie night?\n1. Fri 8 PM\n2. Sat 7 PM (Maya busy)\nReply 1/2.");
  assert.equal(cardText({ ...poll("x:1", false), closed: true, result: "Booked: Fri 8 PM" }), "Movie night?: Booked: Fri 8 PM");
  const pay: ChatCard = { kind: "actions", id: "x:2", actions: [{ id: "pay", label: "Pay Ashwin · Venmo", url: "https://venmo.com/ashwin" }, { id: "edit", label: "Edit", url: "/bills" }, { id: "paid", label: "Mark paid" }] };
  assert.equal(cardText(pay), "Pay Ashwin · Venmo: https://venmo.com/ashwin", "web-only buttons and app paths are left out");
  assert.equal(cardText({ ...pay, resolved: "Paid back" }), "✓ Paid back");
  assert.equal(cardText({ kind: "choices", id: "x:3", title: "Pick one", items: [{ id: "a", label: "Oat milk", price: "$4.29", detail: "64 oz" }], actions: [] }), "Pick one\n1. Oat milk · $4.29 (64 oz)");

  const chat = newChat();
  const sent = cardReply("You owe Ashwin $24.70.", pay, "After paying, reply “paid Ashwin $24.70”.");
  assert.equal(sent, "You owe Ashwin $24.70.\nPay Ashwin · Venmo: https://venmo.com/ashwin\nAfter paying, reply “paid Ashwin $24.70”.");
  const recorded = chat.recordBot(`${sent}\n\n[Demo reminder] Weekly groceries are due.`)!;
  assert.equal(recorded.text, "You owe Ashwin $24.70.\n\n[Demo reminder] Weekly groceries are due.");
  assert.deepEqual(recorded.card, pay);
  assert.equal(chat.recordBot(sent)?.card, null, "a reply card is claimed once");
});

test("events: tapping a plan's poll card votes like texting the number, and a majority books it", async () => {
  const store = new CartStore(join(directory, "events-card.sqlite"), "household-test", 5000, "http://127.0.0.1:3999", false);
  stores.push(store);
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:jordan", name: "Jordan" }]);
  const [alex, mayaMember] = store.getMembers();
  const lists = new NamedListsService(store, { timeZone: "UTC" });
  const events = new EventsService(store, { lists, timeZone: "UTC", notify: async () => {} });
  const start = Date.now() + 2 * 86_400_000;
  const created = await events.createPoll({ shape: { label: "Game night", emoji: "🎲", kind: "game", minutes: 120, window: [18 * 60, 23 * 60], preferred: 19 * 60, preferredDays: [0, 1, 2, 3, 4, 5, 6] }, organizerId: alex!.id, mode: "vote", slots: [{ start, end: start + 7_200_000, busy: [] }, { start: start + 86_400_000, end: start + 93_600_000, busy: [] }] });
  assert.ok(created.ok);
  const tap = (memberId: string, option: string) => cardHandler("events")!({ memberId, card: events.pollCard(events.getPoll(created.poll.id)!), optionIds: [option] });

  let result = await tap(alex!.id, "2");
  assert.deepEqual(events.getPoll(created.poll.id)!.options[1]!.yes, [alex!.id], "the tap is a real vote");
  result = await tap(alex!.id, "2");
  assert.deepEqual(events.getPoll(created.poll.id)!.options[1]!.yes, [], "a second tap takes it back");
  await tap(alex!.id, "1");
  result = await tap(mayaMember!.id, "1");
  assert.equal(result?.card?.kind === "poll" && result.card.closed, true, "two of three is a majority");
  assert.match(result?.reply ?? "", /^🎲 Game night is on: /);
  assert.equal(events.getPoll(created.poll.id)!.status, "booked");
});

test("in iMessage, the coordinator's messages are signed with its name; GroupCart's are not", async () => {
  const sent: string[] = [];
  setGroupSender(async (text) => { sent.push(text); });
  try {
    await postMessage("Booked for Thu 8pm.", { author: "Claude" });
    const poll: ChatCard = { kind: "poll", id: "test:sign", question: "Movie night", options: [{ id: "o1", label: "Thu 8pm" }, { id: "o2", label: "Fri 9pm" }], multi: false, votes: {} };
    await postCard("Movie night?", poll, { author: "Claude" });
    await postCard("Movie night?", poll);
  } finally {
    setGroupSender(null);
  }
  assert.equal(sent[0], "Claude: Booked for Thu 8pm.");
  assert.match(sent[1]!, /^Claude: Movie night\?\n/);
  assert.match(sent[2]!, /^Movie night\?\n/);
});
