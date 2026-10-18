// Run with: node --import=tsx --test src/liveActions.test.ts
// The web buttons that used to be demo-only, in live mode: the pantry's "add to cart", "shop for meals", a one-off
// list's "To cart", event RSVPs, and plan votes act as the signed-in (or "Viewing as") member only: 401 without one,
// 403 when the request names someone else, never the first member or the list's creator. The group hears who did
// it ("Maya: …"), live Kroger's product choices included, and the demo keeps acting as whoever the page names.
// Temporary databases, a fake viewer resolver, a fake iMessage group, and a fake Kroger client (no network).
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { addDays } from "./availability.js";
import { EventsService, planShape } from "./events.js";
import { Kitchen, handleKitchenRoutes } from "./kitchen.js";
import { KrogerClient, type KrogerProduct } from "./kroger.js";
import { handleListsEventsRoutes } from "./listsEvents.js";
import { NamedListsService } from "./namedLists.js";
import { setGroupSender, setRequestMemberResolver } from "./platform.js";
import { CartStore, type Member } from "./store.js";

/** Kroger without the network: every search returns the same products. */
class FakeKroger extends KrogerClient {
  constructor(private readonly products: KrogerProduct[]) { super("test-client", "test-secret", "LOC-1"); }
  override async searchProducts(_term: string): Promise<{ total: number; products: KrogerProduct[] }> {
    return { total: this.products.length, products: this.products };
  }
}

function product(productId: string, description: string, cents: number): KrogerProduct {
  return { productId, description, brand: "Kroger", upc: `upc-${productId}`, size: "1 ct", regularPriceCents: cents, promoPriceCents: null, promoEffectiveAt: null, promoExpiresAt: null };
}

let directory: string;
/** Who the request resolver says is signed in (null: nobody). */
let viewer: string | null = null;
/** Everything that reached the fake iMessage group, in order. */
const group: string[] = [];

before(() => {
  directory = mkdtempSync(join(tmpdir(), "groupcart-live-actions-"));
  setRequestMemberResolver(() => (viewer ? { memberId: viewer } : null));
  setGroupSender(async (text) => { group.push(text); });
});
after(() => {
  setRequestMemberResolver(null);
  setGroupSender(null);
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => { viewer = null; group.length = 0; });

type Home = { store: CartStore; kitchen: Kitchen; lists: NamedListsService; events: EventsService; alex: Member; maya: Member; base: string; close: () => void };

/** A two-member household (Alex, Maya Lee) behind the kitchen and lists/events routes. */
async function household(name: string, options: { demoMode: boolean; kroger?: KrogerClient }): Promise<Home> {
  const store = new CartStore(join(directory, `${name}.sqlite`), `household-${name}`, 50_000);
  store.registerMembers([{ handle: "+15550000001", name: "Alex" }, { handle: "+15550000002", name: "Maya Lee" }]);
  const kitchen = new Kitchen({ store, demoMode: options.demoMode, kroger: options.kroger, timeZone: "UTC" });
  const lists = new NamedListsService(store, { timeZone: "UTC", kroger: options.kroger });
  const events = new EventsService(store, { lists, timeZone: "UTC", notify: async () => {} });
  const context = { store, lists, events, demoMode: options.demoMode };
  const route = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (await handleKitchenRoutes(kitchen, request, response, url)) return;
    if (await handleListsEventsRoutes(context, request, response, url)) return;
    response.writeHead(404);
    response.end();
  };
  const server = createServer((request, response) => { void route(request, response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const byName = (memberName: string) => store.getMembers().find((member) => member.name === memberName)!;
  return {
    store, kitchen, lists, events, alex: byName("Alex"), maya: byName("Maya Lee"),
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => { server.close(); store.close(); },
  };
}

async function post(home: Home, path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${home.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test("pantry “add to cart” adds for the signed-in member only and tells the group who did it", async () => {
  const home = await household("pantry", { demoMode: false });
  try {
    const { alex, maya } = home;
    const eggs = home.kitchen.pantry.set("Eggs", "out", alex.id).item;
    assert.equal((await post(home, "/api/kitchen/pantry/to-cart", { itemIds: [eggs.id] })).status, 401, "no viewer, not the first member");
    viewer = maya.id;
    assert.equal((await post(home, "/api/kitchen/pantry/to-cart", { itemIds: [eggs.id], memberId: alex.id })).status, 403);
    assert.deepEqual([home.store.snapshot().items.length, group.length], [0, 0]);

    const added = await post(home, "/api/kitchen/pantry/to-cart", { itemIds: [eggs.id] });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.status, "added");
    const items = home.store.snapshot().items;
    assert.deepEqual(items.map((item) => [item.name, item.ownerId, item.participantIds]), [["Eggs", maya.id, [maya.id]]]);
    assert.deepEqual(group, ["Maya: 🛒 Added 1: eggs (for Maya)."]);
  } finally { home.close(); }
});

test("shop for meals adds the week's ingredients as the signed-in member", async () => {
  const home = await household("meals", { demoMode: false });
  try {
    const { alex, maya, kitchen } = home;
    kitchen.meals.setNight(kitchen.meals.today(), { recipeId: "b:tofu-stir-fry", cookId: alex.id }, alex.id);
    assert.equal((await post(home, "/api/kitchen/meals/shop", {})).status, 401);
    viewer = maya.id;
    assert.equal((await post(home, "/api/kitchen/meals/shop", { memberId: alex.id })).status, 403);
    assert.equal(home.store.snapshot().items.length, 0);

    const shopped = await post(home, "/api/kitchen/meals/shop", {});
    assert.equal(shopped.status, 200, JSON.stringify(shopped.body));
    const items = home.store.snapshot().items;
    assert.ok(items.some((item) => item.name === "Tofu"));
    assert.ok(items.every((item) => item.ownerId === maya.id && item.participantIds.length === 1), "Maya's, not the cook's or the first member's");
    assert.equal(group.length, 1);
    assert.match(group[0]!, /^Maya: 🛒 Added \d+: .*tofu.*\(for Maya\)\./);
  } finally { home.close(); }
});

test("a one-off list goes to the cart as the signed-in member, not its creator", async () => {
  const home = await household("lists", { demoMode: false });
  try {
    const { alex, maya } = home;
    const created = home.lists.createList({ name: "Party run", items: ["Salsa", "Party cups"], createdBy: alex.id });
    assert.ok(created.ok);
    const listId = created.list.id;
    assert.equal((await post(home, "/api/named-lists/to-cart", { listId })).status, 401, "no viewer, not the list's creator");
    viewer = maya.id;
    assert.equal((await post(home, "/api/named-lists/to-cart", { listId, memberId: alex.id })).status, 403);
    assert.deepEqual([home.store.snapshot().items.length, group.length], [0, 0]);

    const moved = await post(home, "/api/named-lists/to-cart", { listId });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body.added, ["Salsa", "Party cups"]);
    assert.ok(home.store.snapshot().items.every((item) => item.ownerId === maya.id));
    assert.deepEqual(group, ["Maya: 🛒 Moved 2 from Party run to the cart: salsa, party cups."]);
  } finally { home.close(); }
});

test("live Kroger: product choices go to the group as the member's, and their pick adds it for them", async () => {
  const kroger = new FakeKroger([product("eggs-12", "Large Eggs", 299), product("eggs-18", "Large Eggs 18 ct", 449)]);
  const home = await household("kroger", { demoMode: false, kroger });
  try {
    const { alex, maya, store } = home;
    const eggs = home.kitchen.pantry.set("Eggs", "out", alex.id).item;
    viewer = maya.id;
    const choosing = await post(home, "/api/kitchen/pantry/to-cart", { itemIds: [eggs.id] });
    assert.equal(choosing.status, 200, JSON.stringify(choosing.body));
    assert.equal(choosing.body.status, "choosing");
    assert.match(group.at(-1)!, /^Maya: Kroger found 2 matching options for “eggs”/);
    // Maya answers in the group by number; the product is hers.
    await store.processLiveIncomingText("test:pick", maya.id, "1", (query) => kroger.searchProducts(query), kroger.selectedLocationId);
    assert.deepEqual(store.snapshot().items.map((item) => [item.name, item.ownerId]), [["Large Eggs", maya.id]]);

    const created = home.lists.createList({ name: "Party run", items: ["Salsa", "Party cups"], createdBy: maya.id });
    assert.ok(created.ok);
    viewer = alex.id;
    const moved = await post(home, "/api/named-lists/to-cart", { listId: created.list.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body.pending, ["Salsa", "Party cups"]);
    assert.match(group.at(-1)!, /^Alex: I found options for your 2 items/);
    assert.ok(store.pendingQuestionAt(alex.id), "Alex, who pressed To cart, picks the products");
    assert.ok(!store.pendingQuestionAt(maya.id));
  } finally { home.close(); }
});

test("RSVP on the web: only your own, and the group sees it", async () => {
  const home = await household("rsvp", { demoMode: false });
  try {
    const { alex, maya, events } = home;
    const created = events.create({ title: "Game night", emoji: "🎲", kind: "game", date: addDays(events.today(), 2), startMin: 19 * 60, durationMin: 120 }, alex.id);
    assert.ok(created.ok);
    const eventId = created.event.id;
    const before = events.rsvps(eventId);
    assert.equal((await post(home, "/api/events/rsvp", { eventId, memberId: maya.id, status: "going" })).status, 401);
    viewer = maya.id;
    assert.equal((await post(home, "/api/events/rsvp", { eventId, memberId: alex.id, status: "no" })).status, 403, "nobody RSVPs for someone else");
    assert.deepEqual([events.rsvps(eventId), group.length], [before, 0]);

    const going = await post(home, "/api/events/rsvp", { eventId, memberId: maya.id, status: "going" });
    assert.equal(going.status, 200, JSON.stringify(going.body));
    assert.deepEqual(going.body.rsvps, { ...before, [maya.id]: "going" });
    assert.match(group.at(-1)!, /^Maya: I’m in\. 🎲 Game night .*✓ .*Maya Lee/);
    const maybe = await post(home, "/api/events/rsvp", { eventId, status: "maybe" });
    assert.equal(maybe.body.rsvps[maya.id], "maybe", "no memberId: the viewer");
    assert.match(group.at(-1)!, /^Maya: I’m a maybe\. /);
  } finally { home.close(); }
});

test("plan votes on the web: you vote as yourself; a majority books it and the group hears who voted", async () => {
  const home = await household("votes", { demoMode: false });
  try {
    const { alex, maya, events } = home;
    const start = Date.now() + 3 * 86_400_000;
    const created = await events.createPoll({ shape: planShape("game"), organizerId: alex.id, mode: "vote", slots: [{ start, end: start + 7_200_000, busy: [] }, { start: start + 86_400_000, end: start + 86_400_000 + 7_200_000, busy: [] }] });
    assert.ok(created.ok);
    const { poll } = created;
    assert.equal((await post(home, "/api/events/polls/vote", { pollId: poll.id, memberId: maya.id, option: 1 })).status, 401);
    viewer = maya.id;
    assert.equal((await post(home, "/api/events/polls/vote", { pollId: poll.id, memberId: alex.id, option: 1 })).status, 403, "nobody votes for someone else");
    assert.deepEqual(events.getPoll(poll.id)!.options.map((option) => option.yes), [[], []]);

    const mine = await post(home, "/api/events/polls/vote", { pollId: poll.id, memberId: maya.id, option: 1 });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.booked, null);
    assert.deepEqual(mine.body.poll.options[0].yes, [maya.id]);
    assert.equal(group.at(-1), `Maya: 1 ✓ for ${poll.emoji} ${poll.title}. Votes — 1) 1 · 2) 0`);
    assert.equal((await post(home, "/api/events/polls/vote", { pollId: poll.id, option: 2, yes: false })).body.poll.options[1].no[0], maya.id);

    viewer = alex.id;
    const booked = await post(home, "/api/events/polls/vote", { pollId: poll.id, option: 1 });
    assert.ok(booked.body.booked, "two of two say yes");
    const [line, announcement] = group.at(-1)!.split("\n");
    assert.equal(line, `Alex: 1 ✓ for ${poll.emoji} ${poll.title}.`);
    assert.match(announcement!, new RegExp(`^${poll.emoji} ${poll.title} is on: `));
  } finally { home.close(); }
});

test("demo mode is unchanged: no sign-in needed, and the page still acts as the member it names", async () => {
  const home = await household("demo", { demoMode: true });
  try {
    const { alex, maya, events, store } = home;
    // Pantry: the first member without a viewer; announced without a name.
    const eggs = home.kitchen.pantry.set("Eggs", "out", maya.id).item;
    assert.equal((await post(home, "/api/kitchen/pantry/to-cart", { itemIds: [eggs.id] })).status, 200);
    assert.equal(store.snapshot().items.find((item) => item.name === "Eggs")?.ownerId, alex.id);
    assert.equal(group.at(-1), "🛒 Added 1: eggs (for Alex).");
    // Meals: the first member too.
    home.kitchen.meals.setNight(home.kitchen.meals.today(), { recipeId: "b:tofu-stir-fry", cookId: maya.id }, maya.id);
    assert.equal((await post(home, "/api/kitchen/meals/shop", {})).status, 200);
    assert.equal(store.snapshot().items.find((item) => item.name === "Tofu")?.ownerId, alex.id);
    // A one-off list: its creator, announced without a name.
    const created = home.lists.createList({ name: "Party run", items: ["Salsa"], createdBy: maya.id });
    assert.ok(created.ok);
    assert.equal((await post(home, "/api/named-lists/to-cart", { listId: created.list.id })).status, 200);
    assert.equal(store.snapshot().items.find((item) => item.name === "Salsa")?.ownerId, maya.id);
    assert.equal(group.at(-1), "🛒 Moved 1 from Party run to the cart: salsa.");

    // RSVPs and votes for whichever face was tapped, without posting to the group.
    const posted = group.length;
    const event = events.create({ title: "Game night", emoji: "🎲", kind: "game", date: addDays(events.today(), 2), startMin: 19 * 60, durationMin: 120 }, alex.id);
    assert.ok(event.ok);
    assert.equal((await post(home, "/api/events/rsvp", { eventId: event.event.id, memberId: maya.id, status: "no" })).body.rsvps[maya.id], "no");
    const start = Date.now() + 3 * 86_400_000;
    const poll = await events.createPoll({ shape: planShape("game"), organizerId: alex.id, mode: "vote", slots: [{ start, end: start + 7_200_000, busy: [] }] });
    assert.ok(poll.ok);
    assert.deepEqual((await post(home, "/api/events/polls/vote", { pollId: poll.poll.id, memberId: maya.id, option: 1 })).body.poll.options[0].yes, [maya.id]);
    assert.equal(group.length, posted);
  } finally { home.close(); }
});
