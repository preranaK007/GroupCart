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

function setup(replies: Array<string | null>, chance = 1) {
  const posted: Array<{ text: string; card?: ChatCard }> = [];
  const messages: ChatMessage[] = [];
  const channel: CoordinatorChannel = {
    post: async (text, card) => {
      posted.push({ text, card });
      const message = { id: messages.length + 1, kind: "bot", memberId: null, name: "Claude", text, attachments: [], source: "reply", via: null, card: card ?? null, reactions: [], replyTo: null, at: new Date().toISOString(), updatedAt: new Date().toISOString() } as ChatMessage;
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
    pollSettleMs: 0,
    random: () => chance,
  });
  const commands: Array<{ memberId: string; text: string }> = [];
  const images: Array<{ url: string; caption: string }> = [];
  const reactions: Array<{ messageId: number; emoji: string }> = [];
  const groupCartPosts: string[] = [];
  const tools = coordinatorTools({ coordinator, channel, findGroceries: async () => [], groceriesFrom: "sample", photos: async () => [], postImage: async (url, caption) => { images.push({ url, caption }); }, react: async (messageId, emoji) => { reactions.push({ messageId, emoji }); }, runCommand: async (memberId, text) => { commands.push({ memberId, text }); return "Started sharing for Ben and Ana."; }, postAsGroupCart: async (text) => { groupCartPosts.push(text); } });
  const tool = (name: string) => tools.find((spec) => spec.name === name)!;
  return { coordinator, posted, turns, tool, channel, commands, images, reactions, groupCartPosts };
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
  const { coordinator, posted, turns, tool, channel } = setup(["Thursday at 8 it is 🎬"]);
  // Like POST /api/chat/cards: run the handler, then store the card it returns.
  const tap = (memberId: string, card: ChatCard, optionIds: string[]) => {
    const updated = coordinator.handleCardAction({ memberId, card, optionIds })!.card!;
    channel.updateCard(1, updated);
    return updated;
  };
  coordinator.connect("m-ana");
  await tool("post_poll").handler({ text: "Movie night? Tap what works.", question: "Movie night", options: [{ label: "Wed 9pm" }, { label: "Thu 8pm" }] }, { memberId: "m-ana", memberName: "Ana", via: "Claude" });
  const card = posted[0]!.card!;
  assert.equal(card.kind, "poll");
  const afterAna = tap("m-ana", card, ["o2"]);
  assert.equal(turns.length, 0, "one vote isn't everyone");
  const afterBen = tap("m-ben", afterAna, ["o1", "o2"]);
  assert.deepEqual(afterBen.kind === "poll" && afterBen.votes, { o1: ["m-ben"], o2: ["m-ana", "m-ben"] });
  await new Promise((resolve) => setTimeout(resolve, 5)); // the poll settles
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

test("run_groupcart_command runs a built-in command as the roommate being answered", async () => {
  const { tool, commands } = setup([]);
  const result = await tool("run_groupcart_command").handler({ text: "start sharing with Ana" }, { memberId: "m-ben", memberName: "Ben", via: "Claude" });
  assert.deepEqual(commands, [{ memberId: "m-ben", text: "start sharing with Ana" }]);
  assert.deepEqual(result, { reply: "Started sharing for Ben and Ana." });
});

test("staying quiet: banter skips the turn, and a reply that explains itself before \"(no reply)\" posts nothing", async () => {
  const { coordinator, posted, turns } = setup(["Sami's message is banter, not a request for me.\n\n(no reply)"]);
  coordinator.connect("m-ana");
  await coordinator.handleMessage(message("m-ben", "lol 👍"));
  assert.equal(turns.length, 0, "banter never reaches Claude");
  await coordinator.handleMessage(message("m-ben", "I thought photon was supposed to"));
  assert.equal(turns.length, 1);
  assert.equal(posted.length, 0);
});

test("a bare \"yes\" right after Claude spoke still reaches Claude (it may answer its question)", async () => {
  const { coordinator, turns, channel } = setup(["(no reply)"]);
  coordinator.connect("m-ana");
  await channel.post("Found 2% milk and flour. Do these work?");
  await coordinator.handleMessage(message("m-ben", "yes"));
  assert.equal(turns.length, 1);
});

test("post_image hands the link and caption to the poster", async () => {
  const { tool, images } = setup([]);
  assert.deepEqual(await tool("post_image").handler({ url: "https://media.giphy.com/media/x/giphy.gif", caption: "movie night energy" }, { memberId: "m-ana", memberName: "Ana" }), { posted: true });
  assert.deepEqual(images, [{ url: "https://media.giphy.com/media/x/giphy.gif", caption: "movie night energy" }]);
});

test("now and then banter gets a turn, so Claude can react or chime in; at most once per 20 minutes", async () => {
  const { coordinator, posted, turns, tool, reactions } = setup(["(no reply)", "(no reply)"], 0);
  coordinator.connect("m-ana");
  await coordinator.handleMessage(message("m-ben", "lmao"));
  assert.equal(turns.length, 1, "the lucky laugh gets a turn");
  assert.match(turns[0]!.prompt, /isn't for you\. Only if it's a genuinely funny moment/);
  await tool("react_to_message").handler({ message_id: 7, emoji: "😂" }, { memberId: "m-ben", memberName: "Ben", via: "Claude" });
  assert.deepEqual(reactions, [{ messageId: 7, emoji: "😂" }]);
  await coordinator.handleMessage(message("m-ana", "lol"));
  assert.equal(turns.length, 1, "the next laugh soon after doesn't");
  assert.equal(posted.length, 0, "a reaction posts no message");
});

test("a direct reply to Claude is always for Claude, even a one-word laugh", async () => {
  const { coordinator, turns } = setup(["(no reply)"]);
  coordinator.connect("m-ana");
  await coordinator.handleMessage({ ...message("m-ben", "lol"), replyTo: { messageId: 4, name: "Claude", text: "Bananas are in the cart 🍌", fromBot: true } });
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.prompt, /a direct reply to your message #4 \(“Bananas are in the cart 🍌”\), so it's for you: answer it, or if words would add nothing .*react to it with one fitting emoji.*: “lol”/);
  await coordinator.handleMessage({ ...message("m-ben", "lol"), replyTo: { messageId: 5, name: "Ana", text: "the fridge is a crime scene", fromBot: false } });
  assert.equal(turns.length, 1, "a laugh replying to a roommate is still banter");
});

test("groceries go through GroupCart's Kroger flow: with post, GroupCart's own reply goes to the group", async () => {
  const { coordinator, tool, commands, groupCartPosts, posted } = setup([]);
  coordinator.connect("m-ana");
  const result = await tool("run_groupcart_command").handler({ text: "milk, flour", post: true }, { memberId: "m-ben", memberName: "Ben", via: "Claude" }) as { posted?: boolean };
  assert.deepEqual(commands, [{ memberId: "m-ben", text: "milk, flour" }]);
  assert.equal(result.posted, true);
  assert.deepEqual(groupCartPosts, ["Started sharing for Ben and Ana."], "posted as GroupCart, not as Claude");
  assert.equal(posted.length, 0);
  await tool("run_groupcart_command").handler({ text: "cart" }, { memberId: "m-ben", memberName: "Ben", via: "Claude" });
  assert.equal(groupCartPosts.length, 1, "without post, nothing is posted");
});

test("only when asked: Claude takes messages that name it or reply to it, nothing else", () => {
  const { coordinator } = setup([]);
  coordinator.connect("m-ana");
  assert.equal(coordinator.onlyWhenAsked, false);
  coordinator.setOnlyWhenAsked(true);
  assert.equal(coordinator.onlyWhenAsked, true);
  assert.equal(coordinator.isAskedDirectly(message("m-ben", "claude we need eggs")), true);
  assert.equal(coordinator.isAskedDirectly(message("m-ben", "we need eggs")), false);
  assert.equal(coordinator.isAskedDirectly({ ...message("m-ben", "lol"), replyTo: { messageId: 3, name: "Claude", text: "Done", fromBot: true } }), true);
  coordinator.setOnlyWhenAsked(false);
  assert.equal(coordinator.onlyWhenAsked, false);
});
