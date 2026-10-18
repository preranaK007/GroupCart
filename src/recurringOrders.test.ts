import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseListCommand, type ListKey } from "./lists.js";
import { CartStore, isStoreCommand } from "./store.js";
import type { KrogerProduct } from "./kroger.js";

test("order-list wording routes to recurring lists, with explicit repeat protection", () => {
  for (const [text, list] of [
    ["order our weekly list", "weekly"], ["Order the every two weeks list!", "biweekly"],
    ["order our every-two-weeks list", "biweekly"], ["bulk order the monthly list", "monthly"],
    ["order my biweekly list again", "biweekly"],
  ] as Array<[string, ListKey]>) {
    assert.deepEqual(parseListCommand(text), { kind: "load", list, force: /again/.test(text) });
    assert.equal(isStoreCommand(text), true, "feature parsers must not take order-list commands");
  }
  assert.equal(parseListCommand("order pizza"), undefined);
});

for (const [list, command] of [["weekly", "order our weekly list"], ["biweekly", "order our every two weeks list"], ["monthly", "order our monthly list"]] as const) {
  test(`${command} loads the whole list, follows sharing, deduplicates repeats, and undoes in one step`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "gc-recurring-order-"));
    const store = new CartStore(join(directory, "test.sqlite"), "home", 50000);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const members = store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }]);
    const alex = members.find((member) => member.name === "Alex")!;
    let counter = 0;
    const say = (text: string) => store.processIncomingText(`${++counter}`, alex.id, text) ?? "";
    say(`${list}: bread, eggs, bananas, pasta, apples`);
    say(`${list}: peanut butter`);
    say("start sharing with Maya");
    const before = store.snapshot().revision;
    const reply = say(command);
    assert.match(reply, /Loaded 6 items/);
    assert.match(reply, /no retailer order was placed/);
    const snapshot = store.snapshot();
    assert.equal(snapshot.revision, before + 1);
    assert.equal(snapshot.items.length, 6, "list loads are not limited to the five-item search cap");
    assert.ok(snapshot.items.every((item) => item.participantIds.length === 2));
    assert.match(say(command), /already loaded/);
    assert.equal(store.snapshot().revision, snapshot.revision);
    say("undo");
    assert.equal(store.snapshot().items.length, 0);
    assert.match(say(command), /Loaded 6 items/, "undo restores the list's load state too");
  });
}

test("live order-list loads refresh store quotes and recheck the checkout lock after the lookup", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gc-live-order-"));
  const store = new CartStore(join(directory, "test.sqlite"), "home", 50000, undefined, true);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const member = store.registerMembers([{ handle: "demo:alex", name: "Alex" }])[0]!;
  const product: KrogerProduct = {
    productId: "cloths", description: "Cloths", upc: "123", brand: null, size: "1 ct",
    regularPriceCents: 200, promoPriceCents: null, promoEffectiveAt: null, promoExpiresAt: null,
  };
  let counter = 0;
  const say = (text: string, quote?: (id: string) => Promise<KrogerProduct | null>) => store.processLiveIncomingText(
    `live-${++counter}`, member.id, text, async () => ({ total: 1, products: [product] }), "STORE", true, async () => [], quote,
  );
  await say("monthly: cloths"); await say("1");
  let quotes = 0;
  assert.match((await say("order our monthly list", async () => { quotes++; return { ...product, regularPriceCents: 350 }; }))!, /re-checked now/);
  assert.equal(quotes, 1);
  assert.equal(store.snapshot().items[0]!.unitPriceCents, 350);
  await say("approve");
  const before = store.snapshot().revision;
  const blocked = await say("order our monthly list again", async () => {
    assert.match((await say("checkout"))!, /Which household member/);
    return product;
  });
  assert.match(blocked!, /cart is locked/);
  assert.equal(store.snapshot().revision, before);
  assert.equal(store.snapshot().items.length, 1);
});
