// Run with: node --import=tsx --test src/pantry.test.ts
// Pantry: chat parsing (and what it must not claim), item identity, run-out cadence learning and recurring-list
// suggestions (as store commands, never written by the pantry), "yes" to a cart offer only when it's the sender's
// newest question, idempotency by message id, and checkout marking purchases In stock. Temporary database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Kitchen } from "./kitchen.js";
import { cleanIngredient, itemKey, learnCadence, parsePantryCommand, recurringListCommand, recurringListFor, splitItemNames, suggestionText, type PantryEvent } from "./pantry.js";
import { CartStore, isStoreCommand, type Member } from "./store.js";

let directory: string;
let counter = 0;
const id = () => `pantry-test:${++counter}`;
const DAY = 86_400_000;

before(() => { directory = mkdtempSync(join(tmpdir(), "groupcart-pantry-")); });
after(() => { rmSync(directory, { recursive: true, force: true }); });

function setup(name: string): { store: CartStore; kitchen: Kitchen; alex: Member; maya: Member; jordan: Member } {
  const store = new CartStore(join(directory, `${name}.sqlite`), "household-test", 50_000, "http://127.0.0.1:3999");
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:jordan", name: "Jordan" }]);
  const kitchen = new Kitchen({ store, demoMode: true, timeZone: "UTC" });
  const byName = (memberName: string) => store.getMembers().find((member) => member.name === memberName)!;
  return { store, kitchen, alex: byName("Alex"), maya: byName("Maya"), jordan: byName("Jordan") };
}

function say(kitchen: Kitchen, member: Member, text: string, messageId = id()): Promise<string | null> {
  return kitchen.handle({ messageId, memberId: member.id, memberName: member.name, text, attachments: [] });
}

test("pantry phrases parse; travel, chores, one-off lists, and store phrases don't", () => {
  assert.deepEqual(parsePantryCommand("we're out of olive oil"), { kind: "status", status: "out", text: "olive oil", explicit: true });
  assert.deepEqual(parsePantryCommand("out of eggs!"), { kind: "status", status: "out", text: "eggs", explicit: true });
  assert.deepEqual(parsePantryCommand("we just ran out of milk and eggs"), { kind: "status", status: "out", text: "milk and eggs", explicit: true });
  assert.deepEqual(parsePantryCommand("low on rice"), { kind: "status", status: "low", text: "rice", explicit: true });
  assert.deepEqual(parsePantryCommand("running low on coffee"), { kind: "status", status: "low", text: "coffee", explicit: true });
  assert.deepEqual(parsePantryCommand("restocked eggs"), { kind: "status", status: "stock", text: "eggs", explicit: true });
  assert.deepEqual(parsePantryCommand("got eggs"), { kind: "status", status: "stock", text: "eggs", explicit: false });
  assert.deepEqual(parsePantryCommand("pantry"), { kind: "show" });
  for (const other of ["I'm out of town until Friday", "out of town", "I'm out", "got it", "got salsa on party run", "finished the dishes", "done dishes", "lists", "weekly: milk", "yes", "2 bananas"]) {
    assert.equal(parsePantryCommand(other), null, other);
  }
});

test("item identity: catalog products and plain names", () => {
  assert.equal(itemKey("Extra virgin olive oil"), itemKey("olive oil"));
  assert.equal(itemKey("Eggs"), "p:eggs");
  assert.equal(itemKey("Kroger® Large White Eggs 12 ct"), "p:eggs");
  assert.equal(itemKey("tomatoes"), itemKey("tomato"));
  assert.equal(itemKey("Sea salt"), "sea salt");
  assert.deepEqual(splitItemNames("eggs, rice and olive oil"), ["eggs", "rice", "olive oil"]);
  assert.deepEqual(splitItemNames("mac and cheese", new Set([itemKey("mac and cheese")])), ["mac and cheese"]);
  assert.deepEqual(["2 cups rice", "1 can (15 oz) black beans", "3 cloves garlic, minced", "half a lemon"].map(cleanIngredient), ["rice", "black beans", "garlic", "lemon"]);
});

test("cadence: median days between run-outs, deduped, regular only; suggests the store's list command", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
  const outs = (...days: number[]): PantryEvent[] => days.map((daysAgo) => ({ kind: "out", at: at(daysAgo) }));
  assert.deepEqual(learnCadence(outs(42, 28, 14, 0)), { days: 14, basis: "out", samples: 3 });
  assert.equal(learnCadence(outs(28, 14))?.days, undefined); // one interval isn't a pattern
  assert.deepEqual(learnCadence([...outs(21, 14, 7), { kind: "out", at: at(6.5) }])?.days, 7); // two roommates, same run-out
  assert.equal(learnCadence(outs(60, 57, 10)), null); // 3 days, then 47: not regular
  assert.equal(learnCadence([{ kind: "purchase", at: at(60) }, { kind: "purchase", at: at(30) }, { kind: "stock", at: at(1) }])?.basis, "restock");
  assert.equal(recurringListFor(7), "weekly");
  assert.equal(recurringListFor(14), "biweekly");
  assert.equal(recurringListFor(30), "monthly");
  assert.equal(recurringListFor(90), null);
  // The suggestion is a real store command, which the store (not the pantry) handles.
  const command = recurringListCommand("biweekly", "Olive oil");
  assert.equal(command, "biweekly: olive oil");
  assert.ok(isStoreCommand(command));
  assert.match(suggestionText("Olive oil", { days: 14, basis: "out", samples: 3 }, "biweekly"), /about every 2 weeks\. Text “biweekly: olive oil” to add it to the every-two-weeks list\./);
});

test("“out of olive oil” → “yes” adds it as the sender; checkout marks it In stock", async () => {
  const { store, kitchen, alex, maya, jordan } = setup("offer");
  for (const daysAgo of [42, 28, 14]) kitchen.pantry.logEvent(itemKey("olive oil"), "out", new Date(Date.now() - daysAgo * DAY).toISOString());
  const reply = await say(kitchen, jordan, "we're out of olive oil") ?? "";
  assert.match(reply, /^🫙 Olive oil is out\. Add it to the cart\? Reply “yes”\./);
  assert.match(reply, /Text “biweekly: olive oil” to add it to the every-two-weeks list/);
  assert.equal(kitchen.pantry.find("olive oil")?.status, "out");
  // Someone else's "yes" isn't an answer to Jordan's offer.
  assert.equal(await say(kitchen, maya, "yes"), null);
  const messageId = id();
  const added = await say(kitchen, jordan, "yes", messageId) ?? "";
  assert.match(added, /^🛒 Added 1: olive oil \(for Jordan\)\./);
  assert.equal(await say(kitchen, jordan, "yes", messageId), added); // redelivery: same reply, no second add
  assert.equal(await say(kitchen, jordan, "yes"), null); // the offer is answered
  assert.deepEqual(store.snapshot().items.map((item) => [item.name, item.ownerName]), [["Olive oil", "Jordan"]]);
  // The suggestion isn't repeated right away, and the recurring lists were not touched.
  assert.ok(!(await say(kitchen, alex, "out of olive oil") ?? "").includes("biweekly"));
  assert.ok(store.listsSnapshot().every((list) => !list.items.length));
  // Checkout (approve, then mock checkout) marks what was bought In stock.
  kitchen.watchCheckouts();
  for (const member of [alex, maya, jordan]) store.processIncomingText(id(), member.id, "approve");
  assert.match(store.processIncomingText(id(), alex.id, "checkout") ?? "", /Mock checkout complete/);
  assert.deepEqual(kitchen.watchCheckouts(), ["Olive oil"]);
  assert.equal(kitchen.pantry.find("olive oil")?.status, "stock");
  assert.ok(kitchen.pantry.events(itemKey("olive oil")).some((event) => event.kind === "purchase"));
  store.close();
});

test("a bare “yes” goes to the sender's newest question: a later grocery question wins", async () => {
  const { store, kitchen, jordan } = setup("disambiguation");
  assert.match(await say(kitchen, jordan, "out of eggs") ?? "", /Reply “yes”/);
  // Jordan then asks the store for milk; the store's milk question is newer than the pantry offer.
  assert.match(store.processIncomingText(id(), jordan.id, "milk") ?? "", /What kind of milk/);
  assert.equal(await say(kitchen, jordan, "yes"), null);
  assert.equal(store.snapshot().items.length, 0);
  // Once that's answered, a new pantry offer is the newest question again.
  store.processIncomingText(id(), jordan.id, "2");
  assert.match(await say(kitchen, jordan, "low on rice") ?? "", /Reply “yes”/);
  assert.match(await say(kitchen, jordan, "yes") ?? "", /^🛒 Added 1: rice/);
  // "no" declines an offer.
  await say(kitchen, jordan, "out of bread");
  assert.equal(await say(kitchen, jordan, "no"), "Okay, not adding it.");
  store.close();
});

test("items already in the cart or on a recurring list aren't offered or suggested again", async () => {
  const { store, kitchen, alex } = setup("no-repeat");
  store.processIncomingText(id(), alex.id, "eggs");
  assert.equal(await say(kitchen, alex, "out of eggs"), "🫙 Eggs is out. Eggs is already in the cart.");
  assert.equal(kitchen.pantry.pendingOffer(alex.id), null);
  for (const daysAgo of [21, 14, 7]) kitchen.pantry.logEvent(itemKey("coffee"), "out", new Date(Date.now() - daysAgo * DAY).toISOString());
  store.processIncomingText(id(), alex.id, "weekly: coffee"); // the store's own command adds it to the weekly list
  assert.ok(store.listsSnapshot().find((list) => list.key === "weekly")?.items.some((item) => /coffee/i.test(item.name)));
  assert.ok(!(await say(kitchen, alex, "out of coffee") ?? "").includes("weekly:"));
  // "got X" only counts for things the pantry knows; "restocked" always does.
  assert.equal(await say(kitchen, alex, "got it"), null);
  assert.match(await say(kitchen, alex, "got eggs") ?? "", /^✓ Eggs is in stock\./);
  assert.match(await say(kitchen, alex, "pantry") ?? "", /^🫙 Pantry\nOut: coffee\nIn stock: eggs/);
  store.close();
});
