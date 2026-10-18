// Run with: node --import=tsx --test src/checkoutReview.test.ts
// The group's checkout review of unavailable Kroger items: choices by number only, held until every item has one,
// applied as one undoable change, and never triggered by ordinary chat. Temporary database, fake Kroger, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { KrogerCartAvailabilityIssue, KrogerProduct } from "./kroger.js";
import { parseReviewCommand } from "./store/parsing.js";
import { CartStore, type Member } from "./store.js";

let directory: string;
let counter = 0;
const id = () => `review:${++counter}`;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "groupcart-review-"));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

function product(name: string, index: number, cents: number | null = 199 + index * 150): KrogerProduct {
  const slug = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return {
    productId: `${slug}-${index}`, description: index === 0 ? name : `${name} option ${index}`, brand: "B", upc: `upc-${slug}-${index}`,
    size: "1 ct", regularPriceCents: cents, promoPriceCents: null, promoEffectiveAt: null, promoExpiresAt: null,
  };
}

type Harness = {
  store: CartStore; alex: Member; maya: Member; jordan: Member;
  searches: string[];
  say: (member: Member, text: string, messageId?: string) => Promise<string>;
  names: () => string[];
  revision: () => number;
};

/**
 * Sami-style setup: each item is added by `owner` (optionally inside a sharing session), everyone approves, and
 * Alex starts checkout. `unavailable` maps an item name to its number of in-stock alternatives.
 */
async function reviewWith(
  items: Array<[string, Member["name"]?]>,
  unavailable: Record<string, number>,
  options: { share?: boolean; beforeCheckout?: (h: Harness) => Promise<void> } = {},
): Promise<Harness & { opening: string }> {
  const store = new CartStore(join(directory, `${++counter}.sqlite`), "household-review", 50_000, "http://127.0.0.1:3999", true);
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:jordan", name: "Jordan" }]);
  const byName = (memberName: string) => store.getMembers().find((member) => member.name === memberName)!;
  const alex = byName("Alex"), maya = byName("Maya"), jordan = byName("Jordan");
  const searches: string[] = [];
  // Searches return the item under its original capitalization (the store lowercases queries).
  const original = new Map(items.map(([name]) => [name.toLocaleLowerCase(), name]));
  const search = async (query: string) => {
    searches.push(query);
    return { total: 1, products: [product(original.get(query) ?? query, 0)] };
  };
  const availability = async (cartItems: Array<{ id: string; name: string; upc: string; quantity: number }>): Promise<KrogerCartAvailabilityIssue[]> =>
    cartItems.filter((item) => item.name in unavailable).map((item) => ({
      itemId: item.id, name: item.name, upc: item.upc, quantity: item.quantity,
      alternatives: Array.from({ length: unavailable[item.name]! }, (_, index) => product(`alt ${item.name}`, index + 1)),
    }));
  const say = async (member: Member, text: string, messageId = id()) =>
    (await store.processLiveIncomingText(messageId, member.id, text, search, "LOC-70500807", true, availability)) ?? "<null>";
  if (options.share) await say(alex, "start sharing with Maya");
  for (const [name, ownerName] of items) {
    const owner = byName(ownerName ?? "Alex");
    await say(owner, name);
    await say(owner, "1");
  }
  if (options.share) await say(alex, "stop sharing");
  const harness: Harness = {
    store, alex, maya, jordan, searches, say,
    names: () => store.snapshot().items.map((item) => item.name).sort(),
    revision: () => store.snapshot().revision,
  };
  await options.beforeCheckout?.(harness);
  for (const member of [alex, maya, jordan]) await say(member, "approve");
  const opening = await say(alex, "checkout");
  searches.length = 0;
  return { ...harness, opening };
}

test("parser: numbers only, natural wrappers, never names", () => {
  const cases: Array<[string, unknown]> = [
    ["remove 1", { kind: "remove", which: [1] }],
    ["ok remove 1, 2", { kind: "remove", which: [1, 2] }],
    ["Can you remove 1, 2?", { kind: "remove", which: [1, 2] }],
    ["remove items 1 and 2 please", { kind: "remove", which: [1, 2] }],
    ["remove item 1 and item 2", { kind: "remove", which: [1, 2] }],
    ["remove 1, 2, and 3", { kind: "remove", which: [1, 2, 3] }],
    ["remove 1 3", { kind: "remove", which: [1, 3] }],
    ["remove #1.", { kind: "remove", which: [1] }],
    ["please drop 2 pls", { kind: "remove", which: [2] }],
    ["remove １", { kind: "remove", which: [1] }],
    ["remove 1,2 from cart", { kind: "remove", which: [1, 2] }],
    ["remove all unavailable", { kind: "remove", which: "all" }],
    ["remove the unavailable items please", { kind: "remove", which: "all" }],
    ["remove the unavailable item", { kind: "remove", which: "single" }],
    ["replace 1 with 2", { kind: "replace", item: 1, option: 2 }],
    ["replace #1 with 2.", { kind: "replace", item: 1, option: 2 }],
    ["swap item 2 for option 1", { kind: "replace", item: 2, option: 1 }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(parseReviewCommand(text), expected, text);
  for (const text of ["remove the hooks", "drop it", "cancel it", "remove all", "don't remove the eggs", "remove 2 eggs", "remove the 12 pack", "remove 100% juice", "wait, did you remove the eggs?", "I don't want one", "remove"]) {
    assert.equal(parseReviewCommand(text), undefined, text);
  }
});

test("no alternatives: remove by number applies once every item has a choice, for everyone, undoably", async () => {
  const h = await reviewWith([["Command Hooks"], ["Whole Milk"]], { "Command Hooks": 0 }, { share: true });
  assert.match(h.opening, /Command Hooks/);
  assert.match(h.opening, /didn’t return any in-stock alternatives/);
  assert.match(h.opening, /“remove 1”/);
  assert.doesNotMatch(h.opening, /“replace 1 with/);
  assert.match(h.opening, /store LOC-70500807/);
  assert.match(await h.say(h.jordan, "replace 1 with 1"), /didn’t return any in-stock alternatives.*remove 1/);
  const nudge = await h.say(h.jordan, "ok sounds good");
  assert.match(nudge, /^Checkout is paused/);
  assert.ok(nudge.length < 400, `nudge stays short (${nudge.length})`);
  const revision = h.revision();
  const done = await h.say(h.maya, "remove 1");
  assert.match(done, /Checkout review done: removed Command Hooks for everyone/);
  assert.match(done, /“undo” reverts it/);
  assert.deepEqual(h.names(), ["Whole Milk"]);
  assert.equal(h.revision(), revision + 1, "one cart change");
  assert.equal(h.store.pendingKrogerCheckout(), undefined, "review ended");
  assert.ok(h.store.snapshot().members.every((member) => !member.approved), "approvals reset once");
  await h.say(h.jordan, "undo");
  const hooks = h.store.snapshot().items.find((item) => item.name === "Command Hooks");
  assert.ok(hooks, "undo restores the removed item");
  assert.equal(hooks.participantIds.length, 2, "with its shared split");
});

test("choices are held: nothing changes until every item has one, and cancel discards them", async () => {
  const h = await reviewWith([["Hooks"], ["Bread"], ["Eggs"]], { Hooks: 0, Bread: 2, Eggs: 1 });
  const revision = h.revision();
  const noted = await h.say(h.maya, "remove 1");
  assert.match(noted, /Noted: remove Hooks for everyone\. Nothing in GroupCart changes/);
  assert.match(noted, /Still to decide: 2\) Bread.*3\) Eggs/);
  assert.equal(h.revision(), revision, "cart untouched while choices are pending");
  assert.deepEqual(h.names(), ["Bread", "Eggs", "Hooks"]);
  assert.match(await h.say(h.jordan, "replace 2 with 2"), /Noted: swap Bread for alt Bread option 2/);
  const cancelled = await h.say(h.jordan, "Cancel the checkout.");
  assert.match(cancelled, /Cancelled the checkout review\. GroupCart is unchanged \(the swaps and removals chosen so far were discarded\)/);
  assert.deepEqual(h.names(), ["Bread", "Eggs", "Hooks"]);
  assert.equal(h.revision(), revision);
  assert.equal(h.store.pendingKrogerCheckout(), undefined);
});

test("a choice can be changed before the last one applies everything as one change", async () => {
  const h = await reviewWith([["Hooks"], ["Bread"]], { Hooks: 0, Bread: 2 });
  await h.say(h.maya, "remove 2");
  assert.match(await h.say(h.alex, "replace #2 with 1."), /Noted: swap Bread for alt Bread option 1/);
  const done = await h.say(h.jordan, "remove all unavailable");
  assert.match(done, /removed Hooks for everyone; swapped Bread for alt Bread option 1/);
  assert.deepEqual(h.names(), ["alt Bread option 1"]);
});

test("ordinary chat never changes the cart: vague words, negations, questions, and look-alike names", async () => {
  const h = await reviewWith(
    [["Kroger White Bread"], ["Vital Farms Eggs"], ["Reynolds Aluminum Foil"], ["Kroger Party Ice"], ["Mahatma Rice"], ["Dr Pepper 12 Pack"], ["Tide Laundry Detergent"]],
    { "Kroger White Bread": 1, "Vital Farms Eggs": 0, "Reynolds Aluminum Foil": 0, "Kroger Party Ice": 0, "Mahatma Rice": 0, "Dr Pepper 12 Pack": 0, "Tide Laundry Detergent": 0 },
  );
  const before = h.names();
  const revision = h.revision();
  for (const text of [
    "drop it", "cancel it", "cancel all", "cancel the whole thing", "remove it", "we don't need it", "I don't want one",
    "don't remove the eggs!", "let's not remove it", "wait, did you remove the eggs?", "remove the oil", "remove the ice",
    "remove the Dr. Pepper", "remove the 12 pack", "remove the ham", "remove all",
  ]) {
    const reply = await h.say(h.maya, text);
    assert.doesNotMatch(reply, /Checkout review done|Removed /, `${text} -> ${reply}`);
    assert.deepEqual(h.names(), before, text);
    assert.equal(h.revision(), revision, text);
  }
  assert.ok(h.store.pendingKrogerCheckout(), "review still open");
  assert.match(await h.say(h.jordan, "remove the eggs"), /handled by number.*2\) Vital Farms Eggs.*“remove 2”.*Nothing was changed/);
  assert.equal(h.searches.length, 0, "nothing went to Kroger search");
});

test("numbered removals in natural wording pick exactly those items", async () => {
  const h = await reviewWith([["Honey Wheat Bread"], ["Almondmilk"], ["Coca-Cola 12 Pack"]], { "Honey Wheat Bread": 0, Almondmilk: 0, "Coca-Cola 12 Pack": 1 });
  assert.match(await h.say(h.maya, "ok remove 1, 2"), /Noted: remove Honey Wheat Bread and Almondmilk for everyone/);
  assert.deepEqual(h.names(), ["Almondmilk", "Coca-Cola 12 Pack", "Honey Wheat Bread"]);
  assert.match(await h.say(h.maya, "remove 9"), /9 isn’t one of the unavailable items \(choose from 1, 2 and 3\)/);
  await h.say(h.alex, "Can you replace 3 with 1?");
  assert.deepEqual(h.names(), ["alt Coca-Cola 12 Pack option 1"]);
});

test("“the unavailable item” asks which when several are open", async () => {
  const h = await reviewWith([["Hooks"], ["Bread"]], { Hooks: 0, Bread: 0 });
  assert.match(await h.say(h.maya, "remove the unavailable item"), /More than one item is unavailable: 1\) Hooks; 2\) Bread.*Nothing was changed/);
  await h.say(h.maya, "remove 1");
  assert.match(await h.say(h.maya, "remove the unavailable one"), /removed Bread for everyone/);
});

test("a member's own pending question gets their cancel; a bare cancel otherwise ends the review", async () => {
  // Maya asked to clear the cart before checkout; during the review her “cancel” answers that, not the review.
  const h = await reviewWith([["Hooks"], ["Bread"]], { Hooks: 0 }, { beforeCheckout: async (x) => { await x.say(x.maya, "clear all"); } });
  assert.match(h.opening, /availability check/);
  assert.match(await h.say(h.maya, "cancel"), /left the shared cart unchanged/);
  assert.ok(h.store.pendingKrogerCheckout(), "review untouched");
  assert.match(await h.say(h.maya, "yes"), /^Checkout is paused/, "her clear-all is no longer armed");
  assert.deepEqual(h.names(), ["Bread", "Hooks"]);
  // Jordan starts a weekly-list clear during the review (list commands keep working) and backs out of it.
  await h.say(h.jordan, "weekly: bread");
  await h.say(h.jordan, "1");
  assert.match(await h.say(h.jordan, "clear weekly list"), /confirm clear weekly list/);
  assert.match(await h.say(h.jordan, "cancel"), /left the weekly list unchanged/);
  assert.ok(h.store.pendingKrogerCheckout(), "review untouched");
  // Alex has nothing pending, so a bare “never mind” ends the review.
  assert.match(await h.say(h.alex, "never mind"), /Cancelled the checkout review\. GroupCart is unchanged/);
});

test("list commands keep working during the review and aren't read as removals", async () => {
  const h = await reviewWith([["Dust Cloths"]], { "Dust Cloths": 0 });
  const reply = await h.say(h.maya, "monthly: drop cloths");
  assert.match(reply, /For the monthly list, Kroger found/);
  assert.deepEqual(h.names(), ["Dust Cloths"]);
  assert.match(await h.say(h.maya, "1"), /Saved to the household’s monthly list/);
  assert.deepEqual(h.names(), ["Dust Cloths"]);
  assert.match(await h.say(h.maya, "load monthly list"), /^Checkout is paused/, "loading into the cart waits");
});

test("anyone's checkout shows the review; approve passes through; the store number stays", async () => {
  const h = await reviewWith([["Hooks"], ["Bread"]], { Hooks: 0, Bread: 1 });
  await h.say(h.maya, "remove 1");
  const shown = await h.say(h.jordan, "checkout");
  assert.match(shown, /Kroger’s availability check at store LOC-70500807/);
  assert.match(shown, /1\) Hooks: will be removed for everyone/);
  assert.match(shown, /“replace 2 with 1”/);
  assert.doesNotMatch(shown, /already being prepared/);
  assert.match(await h.say(h.jordan, "approve"), /approved/i);
});

test("late review commands after the review ended don't become a product search", async () => {
  const h = await reviewWith([["Hooks"]], { Hooks: 0 });
  assert.equal(h.store.ownsMessage("remove 1"), true, "the store claims review commands during a review");
  await h.say(h.maya, "remove 1");
  const late = await h.say(h.jordan, "remove 1");
  assert.match(late, /That checkout review is already finished, so nothing was changed/);
  assert.equal(h.searches.length, 0);
  assert.equal(h.store.hasPendingChoice(h.jordan.id), false);
  assert.equal(h.store.ownsMessage("remove 1"), true, "still claimed right after the review");
  assert.equal(h.store.ownsMessage("skip 1"), true);
});

test("ownsMessage leaves review words to other features when no review is open", async () => {
  const store = new CartStore(join(directory, `${++counter}.sqlite`), "household-review", 50_000, "http://127.0.0.1:3999", true);
  assert.equal(store.ownsMessage("skip 1"), false);
  assert.equal(store.ownsMessage("remove 2"), false);
  assert.equal(store.ownsMessage("Cancel checkout."), true);
  store.close();
});

test("the same message twice applies once", async () => {
  const h = await reviewWith([["Hooks"], ["Bread"]], { Hooks: 0, Bread: 0 });
  await h.say(h.maya, "remove 1");
  const first = await h.say(h.maya, "remove 2", "dup-1");
  const revision = h.revision();
  assert.equal(await h.say(h.maya, "remove 2", "dup-1"), first);
  assert.equal(h.revision(), revision);
});

test("a cart change during the review discards it instead of applying stale choices", async () => {
  const h = await reviewWith([["Hooks"], ["Bread"]], { Hooks: 0, Bread: 0 });
  await h.say(h.maya, "remove 1");
  // Demo path edits bypass the live review lock; simulate any cart change.
  h.store.processIncomingText(id(), h.jordan.id, "2 bananas");
  assert.match(await h.say(h.maya, "remove 2"), /The cart changed during the availability review, so I discarded that review/);
  assert.ok(h.names().includes("Hooks"), "the staged removal never applied");
});

test("cancel while items are being sent to Kroger says it can't be stopped", async () => {
  const h = await reviewWith([["Bread"]], {});
  assert.match(h.opening, /Which household member’s Kroger account/);
  await h.say(h.alex, "1");
  let duringAdd = "";
  const result = await h.store.completeKrogerCartCheckout(h.alex.id, async () => {
    duringAdd = await h.say(h.alex, "cancel checkout");
  });
  assert.match(duringAdd, /can’t be stopped now/);
  assert.equal(result.ok, true);
});
