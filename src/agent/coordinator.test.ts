// Run with: node --import=tsx --test src/agent/coordinator.test.ts
// Household coordinator with a scripted turn runner: messages become turns for the sender, "(no reply)" posts
// nothing, poll cards collect votes, and everyone voting starts a proactive turn. No Claude Code, no network.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ChatCard, ChatMessage } from "../chat.js";
import type { Member } from "../store.js";
import { HouseholdCoordinator, type CoordinatorChannel, type TurnRunner } from "./coordinator.js";
import { coordinatorTools } from "./tools.js";

const members: Member[] = [
  { id: "m-ana", handle: "demo:ana", name: "Ana" },
  { id: "m-ben", handle: "demo:ben", name: "Ben" },
];

function setup(replies: Array<string | null>) {
  const posted: Array<{ text: string; card?: ChatCard }> = [];
  const messages: ChatMessage[] = [];
  const channel: CoordinatorChannel = {
    post: async (text, card) => {
      posted.push({ text, card });
      const message = { id: messages.length + 1, kind: "bot", memberId: null, name: "Claude", text, attachments: [], source: "reply", via: null, card: card ?? null, at: new Date().toISOString(), updatedAt: new Date().toISOString() } as ChatMessage;
      messages.push(message);
      return message;
    },
    updateCard: (id, card) => { const found = messages.find((message) => message.id === id); if (found) found.card = card; },
    findCard: (cardId) => { const found = messages.find((message) => message.card?.id === cardId); return found?.card ? { messageId: found.id, card: found.card } : null; },
    recent: () => messages,
  };
  const turns: Array<Parameters<TurnRunner>[0]> = [];
  const coordinator = new HouseholdCoordinator({
    runTurn: async (input) => { turns.push(input); return replies.shift() ?? null; },
    db: new DatabaseSync(":memory:"),
    members: () => members,
    channel,
    groceriesFrom: "sample",
    timeZone: "America/Los_Angeles",
  });
  const tools = coordinatorTools({ coordinator, channel, findGroceries: async () => [], groceriesFrom: "sample", photos: async () => [] });
  const tool = (name: string) => tools.find((spec) => spec.name === name)!;
  return { coordinator, posted, turns, tool };
}

const message = (memberId: string, text: string) => ({ messageId: `x:${text}`, memberId, memberName: members.find((m) => m.id === memberId)!.name, text, attachments: [] });

test("a message is a turn for its sender, and the final text is posted", async () => {
  const { coordinator, posted, turns } = setup(["Done, Ben."]);
  assert.equal(coordinator.status().active, false, "off until a roommate connects it");
  coordinator.connect("m-ana");
  assert.deepEqual(coordinator.status(), { active: true, connectedBy: members[0] });
  await coordinator.handleMessage(message("m-ben", "do the thing"));
  assert.deepEqual(posted.map((entry) => entry.text), ["Done, Ben."]);
  assert.equal(turns[0]!.memberId, "m-ben");
  assert.match(turns[0]!.prompt, /Connected by: Ana/);
  assert.match(turns[0]!.prompt, /Respond to the newest message, from Ben: “do the thing”/);
  assert.ok(turns[0]!.disallowedTools.includes("send_group_message"), "its replies are the group messages");
});

test("banter gets no post", async () => {
  const { coordinator, posted } = setup(["(no reply)"]);
  coordinator.connect("m-ana");
  await coordinator.handleMessage(message("m-ben", "lol"));
  assert.equal(posted.length, 0);
});

test("a poll card collects votes, and everyone voting starts a proactive turn", async () => {
  const { coordinator, posted, turns, tool } = setup(["Thursday at 8 it is 🎬"]);
  coordinator.connect("m-ana");
  await tool("post_poll").handler({ text: "Movie night? Tap what works.", question: "Movie night", options: [{ label: "Wed 9pm" }, { label: "Thu 8pm" }] }, { memberId: "m-ana", memberName: "Ana", via: "Claude" });
  const card = posted[0]!.card!;
  assert.equal(card.kind, "poll");
  const afterAna = coordinator.handleCardAction({ memberId: "m-ana", card, optionIds: ["o2"] })!.card!;
  assert.equal(turns.length, 0, "one vote isn't everyone");
  const afterBen = coordinator.handleCardAction({ memberId: "m-ben", card: afterAna, optionIds: ["o1", "o2"] })!.card!;
  assert.deepEqual(afterBen.kind === "poll" && afterBen.votes, { o1: ["m-ben"], o2: ["m-ana", "m-ben"] });
  await coordinator.handleEvent("(drain)").catch(() => undefined);
  assert.match(turns[0]!.prompt, /Everyone has voted on your poll “Movie night”.*Thu 8pm: 2 \(Ana, Ben\)/);
  assert.equal(turns[0]!.memberId, "m-ben");
  assert.equal(posted.at(-1)!.text, "Thursday at 8 it is 🎬");
});

test("a primary button resolves the card and wakes the coordinator; link buttons do nothing", async () => {
  const { coordinator, turns, tool, posted } = setup([]);
  coordinator.connect("m-ana");
  await tool("post_choices").handler({ text: "Found these.", title: "Groceries", items: [{ label: "2% milk", price: "$3.49" }], actions: [{ label: "Add these" }, { label: "Swap something", style: "secondary" }] }, { memberId: "m-ana", memberName: "Ana" });
  const card = posted[0]!.card!;
  assert.deepEqual(coordinator.handleCardAction({ memberId: "m-ben", card, actionId: "a1" }), { card: { ...card, resolved: "Ben: Add these" } });
  await coordinator.handleEvent("(drain)").catch(() => undefined);
  assert.match(turns[0]!.prompt, /Ben tapped “Add these” on “Groceries”.*2% milk · \$3\.49/);
  await assert.rejects(Promise.resolve().then(() => tool("post_buttons").handler({ text: "Pay up", buttons: [{ label: "Pay", url: "javascript:alert(1)" }] }, { memberId: "m-ana", memberName: "Ana" })), /https links/);
});

test("no recap when a tool already posted to the group during the turn", async () => {
  const log: ChatMessage[] = [];
  const say = (text: string) => { log.push({ id: log.length + 1, kind: "bot", text, attachments: [], card: null } as unknown as ChatMessage); };
  const coordinator = new HouseholdCoordinator({
    // Like add_bill: the tool announces the bill, then the model also writes a recap.
    runTurn: async () => { say("Ben added ⚡ Gas $46.82."); return "I saved the bill and split it."; },
    db: new DatabaseSync(":memory:"),
    members: () => members,
    channel: { post: async (text) => { say(text); return null; }, updateCard: () => undefined, findCard: () => null, recent: () => log },
    groceriesFrom: "sample",
    timeZone: "UTC",
  });
  coordinator.connect("m-ben");
  await coordinator.handleMessage(message("m-ben", "split this bill"));
  assert.deepEqual(log.map((entry) => entry.text), ["Ben added ⚡ Gas $46.82."]);
});
