import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KrogerProduct } from "./kroger.js";
import { SplitwiseService } from "./splitwise.js";
import { CartStore } from "./store.js";
import { receiptShares } from "./store/purchases.js";
import { cartViewHelpers } from "./ui/cartView.js";

async function household(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "gc-purchases-"));
  const path = join(directory, "test.sqlite");
  let store = new CartStore(path, "home", 50000, undefined, true);
  const members = store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:jordan", name: "Jordan" }]);
  const alex = members.find((member) => member.name === "Alex")!;
  const maya = members.find((member) => member.name === "Maya")!;
  let counter = 0;
  store.setCheckoutHooks(new SplitwiseService(store, {}));
  const search = async (query: string) => ({ total: 1, products: [{
    productId: query, description: query, brand: null, upc: `upc-${query}`, size: null,
    regularPriceCents: query === "bread" ? 200 : 100, promoPriceCents: null, promoEffectiveAt: null, promoExpiresAt: null,
  } satisfies KrogerProduct] });
  const say = async (memberId: string, text: string, messageId = `message-${++counter}`) =>
    (await store.processLiveIncomingText(messageId, memberId, text, search, "STORE", true, async () => [])) ?? "";
  await say(alex.id, "start sharing with Maya");
  await say(alex.id, "bread"); await say(alex.id, "1");
  await say(alex.id, "stop sharing");
  await say(alex.id, "tea"); await say(alex.id, "1");
  for (const member of members) await say(member.id, "approve");
  await say(alex.id, "checkout");
  await say(alex.id, String(store.getMembers().findIndex((member) => member.id === maya.id) + 1));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; }, alex, maya, say,
    restart() {
      store.close(); store = new CartStore(path, "home", 50000, undefined, true);
      store.setCheckoutHooks(new SplitwiseService(store, {}));
    },
    async transfer() {
      let sends = 0;
      const result = await store.completeKrogerCartCheckout(maya.id, async () => { sends++; });
      assert.equal(result.ok, true);
      assert.equal(sends, 1);
      const id = result.message.match(/Purchase ([a-f0-9]{8})/)?.[1];
      assert.ok(id);
      return id;
    },
  };
}

test("a transfer creates no debt; only the shopper's reviewed actual total gets logged once", async (t) => {
  const h = await household(t);
  const id = await h.transfer();
  assert.equal(h.store.latestSplitwiseExpense(), undefined);
  assert.equal(h.store.snapshot().items.length, 0);
  assert.match(await h.say(h.alex.id, `purchase ${id} total $10.01`), /Only the shopper/);
  assert.match(await h.say(h.maya.id, `confirm purchase ${id}`), /receipt total first/);
  const preview = await h.say(h.maya.id, `purchase ${id} total $10.01`);
  assert.match(preview, /Alex \$6.67 \/ Maya \$3.34/);
  assert.match(preview, /Nothing is logged yet/);
  assert.equal(h.store.latestSplitwiseExpense(), undefined);
  h.restart();
  const reply = await h.say(h.maya.id, `confirm purchase ${id}`, "confirmed-once");
  assert.match(reply, /actually paid/);
  const expense = h.store.latestSplitwiseExpense()!;
  assert.equal(expense.totalCents, 1001, "receipt total, not the $3 quote");
  assert.equal(expense.payerMemberId, h.maya.id);
  assert.equal(expense.shares.reduce((sum, share) => sum + share.owedCents, 0), 1001);
  assert.equal(expense.shares.reduce((sum, share) => sum + share.paidCents, 0), 1001);
  assert.match(await h.say(h.maya.id, `confirm purchase ${id}`), /already confirmed/);
  assert.match(await h.say(h.maya.id, `purchase ${id} total $50.00`), /already confirmed/);
  await h.say(h.maya.id, `confirm purchase ${id}`, "confirmed-once");
  assert.equal(h.store.database.prepare("SELECT count(*) AS n FROM splitwise_expenses").get()!.n, 1);
});

test("abandoned and malformed purchase drafts never create expenses", async (t) => {
  const h = await household(t);
  const id = await h.transfer();
  for (const total of ["$0.00", "$-1.00", "$1.234", "$NaN", "$9999999.00"]) {
    await h.say(h.maya.id, `purchase ${id} total ${total}`);
    assert.equal(h.store.latestSplitwiseExpense(), undefined);
  }
  await h.say(h.maya.id, `purchase ${id} total $3.00`);
  assert.match(await h.say(h.maya.id, `cancel purchase ${id}`), /does not cancel or refund/);
  assert.match(await h.say(h.maya.id, `confirm purchase ${id}`), /already cancelled/);
  assert.equal(h.store.latestSplitwiseExpense(), undefined);
});

test("cent allocation is deterministic, exact, and never charges a zero-share member", async (t) => {
  const h = await household(t);
  const snapshot = h.store.snapshot();
  for (const total of [1, 2, 99, 1001, 99999999]) {
    const shares = receiptShares(snapshot, total);
    assert.equal([...shares.values()].reduce((sum, cents) => sum + cents, 0), total);
    const jordan = snapshot.members.find((member) => member.name === "Jordan")!;
    assert.equal(shares.get(jordan.id), 0);
    assert.deepEqual(receiptShares({ ...snapshot, members: [...snapshot.members].reverse() }, total), shares);
  }
});

test("receipt allocation does not amplify repeated per-item rounding for equal participants", async (t) => {
  const h = await household(t);
  const snapshot = h.store.snapshot();
  const participants = [h.alex.id, h.maya.id];
  const equalSharing = {
    ...snapshot, totalCents: 1227,
    items: [329, 199, 699].map((cents, index) => ({
      ...snapshot.items[0]!, id: `item-${index}`, quantity: 1,
      unitPriceCents: cents, totalCents: cents, participantIds: participants,
    })),
    members: snapshot.members.map((member) => ({ ...member, shareCents: member.id === h.alex.id ? 615 : member.id === h.maya.id ? 612 : 0 })),
  };
  const shares = receiptShares(equalSharing, 1907);
  assert.deepEqual(participants.map((id) => shares.get(id)!).sort((a, b) => a - b), [953, 954]);
  assert.deepEqual(receiptShares({ ...equalSharing, items: [...equalSharing.items].reverse() }, 1907), shares);
});

test("recovery never automatically reissues a Kroger transfer with an unknown outcome", async (t) => {
  const h = await household(t);
  h.store.database.prepare("UPDATE pending_kroger_checkouts SET status = 'adding'").run();
  h.restart();
  assert.equal(h.store.pendingKrogerCheckout()?.status, "transfer_uncertain");
  const cart = { ...h.store.snapshot(), demoMode: false, krogerConfigured: true, krogerCheckout: h.store.pendingKrogerCheckout() };
  assert.deepEqual(cartViewHelpers().orderState({ ...cart, viewerId: h.alex.id }), { step: "uncertain", canCancel: true });
  assert.deepEqual(cartViewHelpers().orderState({ ...cart, viewerId: h.maya.id }), { step: "uncertain", canCancel: false });
  assert.match(await h.say(h.alex.id, "checkout"), /may have received/);
  let calls = 0;
  assert.equal((await h.store.completeKrogerCartCheckout(h.maya.id, async () => { calls++; })).ok, false);
  assert.equal(calls, 0);
  assert.match(await h.say(h.alex.id, "clear all"), /interrupted/);
  assert.match(await h.say(h.alex.id, "cancel checkout"), /Kroger may already have the items/);
  assert.equal(h.store.snapshot().items.length, 2);
  assert.equal(h.store.latestSplitwiseExpense(), undefined);
});

test("a lost Kroger response keeps the transfer locked and never invents a purchase", async (t) => {
  const h = await household(t);
  const result = await h.store.completeKrogerCartCheckout(h.maya.id, async () => { throw new Error("response lost"); });
  assert.equal(result.ok, false);
  assert.equal(h.store.pendingKrogerCheckout()?.status, "transfer_uncertain");
  assert.equal(h.store.database.prepare("SELECT count(*) AS n FROM grocery_purchases").get()!.n, 0);
  assert.match(await h.say(h.alex.id, "checkout"), /may have received/);
});

test("a concurrent cart edit preserves the transferred basket as a draft without clearing the changed cart", async (t) => {
  const h = await household(t);
  const result = await h.store.completeKrogerCartCheckout(h.maya.id, async () => {
    h.store.processIncomingText("other-cart-edit", h.alex.id, "apples");
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Purchase [a-f0-9]{8} is awaiting/);
  assert.equal(h.store.snapshot().items.length, 3);
  const draft = h.store.database.prepare("SELECT snapshot_json FROM grocery_purchases").get()!;
  assert.equal(JSON.parse(String(draft.snapshot_json)).items.length, 2);
  assert.equal(h.store.latestSplitwiseExpense(), undefined);
});

test("a local save failure after Kroger accepted the cart preserves items and marks the transfer uncertain", async (t) => {
  const h = await household(t);
  h.store.database.exec("CREATE TRIGGER reject_draft BEFORE INSERT ON grocery_purchases BEGIN SELECT RAISE(ABORT, 'save failed'); END");
  const result = await h.store.completeKrogerCartCheckout(h.maya.id, async () => {});
  assert.equal(result.ok, false);
  assert.match(result.message, /Kroger confirmed receiving the items/);
  assert.equal(h.store.pendingKrogerCheckout()?.status, "transfer_uncertain");
  assert.equal(h.store.snapshot().items.length, 2);
  assert.equal(h.store.latestSplitwiseExpense(), undefined);
});
