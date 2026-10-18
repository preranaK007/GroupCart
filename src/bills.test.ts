// Run with: node --import=tsx --test src/bills.test.ts
// Bills from group-chat photos when no ANTHROPIC_API_KEY is set: a photo becomes a bill draft only when its caption
// says so (bill, receipt, rent, due, or a $ amount), so ordinary photos in the group chat stay out of Bills. Live
// mode without Splitwise credentials says nothing about Splitwise; only the demo calls it simulated.
// Temporary database, fixed clock, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { mentionsBill } from "./billParse.js";
import { renderSampleBill } from "./billSample.js";
import { BillsService } from "./bills.js";
import { CartStore, type Member } from "./store.js";
import { billsSplitwiseCard, setBillsIntegrationStatus } from "./ui/billsHome.js";

let directory: string;
let counter = 0;
const id = () => `bills-test:${++counter}`;
const NOW = new Date(2026, 9, 14, 15, 0);
// A PNG signature plus filler: big enough not to be skipped as a sticker, and never a known demo sample.
const photo = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4_000, fill)]);
const openStores: CartStore[] = [];

before(() => { directory = mkdtempSync(join(tmpdir(), "groupcart-bills-")); });
// Close every store before cleanup: Windows refuses to delete an open SQLite file.
after(() => {
  for (const store of openStores) store.close();
  rmSync(directory, { recursive: true, force: true });
});

function setup(name: string): { bills: BillsService; alex: Member; send: (text: string, data: Buffer) => Promise<string | null> } {
  const store = new CartStore(join(directory, `${name}.sqlite`), "household-test", 5000);
  openStores.push(store);
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }]);
  const alex = store.getMembers().find((member) => member.name === "Alex")!;
  const bills = new BillsService({ store, liveMode: false, filesDir: join(directory, `${name}-files`), now: () => NOW });
  const send = (text: string, data: Buffer) => bills.handleCommand({ messageId: id(), memberId: alex.id, memberName: alex.name, text, attachments: [{ mimeType: "image/png", read: async () => data }] });
  return { bills, alex, send };
}

test("bill hints: bill, receipt, rent, due, or a $ amount", () => {
  for (const text of ["electric bill", "Receipt from Costco", "rent for November", "internet due Friday", "$42.50 for pizza", "split this $ 30"]) assert.equal(mentionsBill(text), true, text);
  for (const text of ["", "lol look at this", "the view from the roof", "billboard downtown", "reduce noise please"]) assert.equal(mentionsBill(text), false, text);
});

test("without an API key, only a photo whose caption calls it a bill becomes a draft", async () => {
  const { bills, send } = setup("no-key");
  assert.equal(await send("", photo(1)), null, "a photo with no caption isn't a bill");
  assert.equal(await send("lol look at this", photo(2)), null);
  assert.equal(bills.listBills().length, 0);

  assert.match(await send("water bill", photo(3)) ?? "", /Got the bill image/);
  assert.match(await send("$18 for the pizza", photo(4)) ?? "", /Got the bill image/);
  assert.deepEqual(bills.listBills().map((bill) => bill.state), ["needs_reading", "needs_reading"]);

  // Demo samples are read from their known fields, so they need no caption.
  assert.match(await send("", renderSampleBill("gas", NOW).png) ?? "", /\$/);
  assert.equal(bills.listBills().length, 3);
});

test("live mode without Splitwise credentials never claims to log or simulate Splitwise; the demo still says simulated", async () => {
  const save = async (liveMode: boolean) => {
    const store = new CartStore(join(directory, `splitwise-${liveMode}.sqlite`), "household-test", 5000);
    openStores.push(store);
    store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }]);
    const ids = store.getMembers().map((member) => member.id);
    const bills = new BillsService({ store, liveMode, filesDir: join(directory, `splitwise-${liveMode}-files`), now: () => NOW });
    const result = await bills.updateFromInput({ vendor: "Internet", totalCents: 6_000, payerId: ids[0], split: { mode: "equal", memberIds: ids } }, { actorId: ids[0]!, save: true, announce: false, source: "manual" });
    assert.ok(result.ok, result.message);
    return { message: result.message, bill: result.bill!, status: bills.integrationStatus().splitwise };
  };
  const live = await save(true);
  assert.doesNotMatch(live.message, /Splitwise|simulated/i);
  assert.equal(live.bill.splitwise, null, "nothing is recorded as sent or simulated");
  assert.deepEqual([live.status.liveMode, live.status.live], [true, false]);
  const demo = await save(false);
  assert.match(demo.message, /Splitwise: simulated/);
});

test("Settings' Splitwise card: Not connected in live mode without credentials, Simulated only in the demo", () => {
  const status = (liveMode: boolean) => ({ splitwise: { configured: false, live: false, liveMode, warnings: [], lastBill: null, lastCheckout: { state: "simulated" } }, anthropic: { configured: false, model: "" } });
  try {
    setBillsIntegrationStatus(() => status(true));
    assert.equal(billsSplitwiseCard().status.label, "Not connected");
    assert.equal(billsSplitwiseCard().facts, undefined, "no simulated log rows in live mode");
    setBillsIntegrationStatus(() => status(false));
    assert.equal(billsSplitwiseCard().status.label, "Simulated");
  } finally {
    setBillsIntegrationStatus(null);
  }
});

test("who owes whom is one line per pair, with what it's for; a payment back settles the oldest shares first", async () => {
  const store = new CartStore(join(directory, "pairs.sqlite"), "household-test", 5000);
  openStores.push(store);
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:sam", name: "Sam" }]);
  const [alex, maya, sam] = store.getMembers().map((member) => member.id) as [string, string, string];
  let clock = new Date(2026, 9, 1, 12);
  const bills = new BillsService({ store, liveMode: true, filesDir: join(directory, "pairs-files"), now: () => clock });
  const save = async (vendor: string, totalCents: number, payerId: string, category: string, on: Date) => {
    clock = on;
    const result = await bills.updateFromInput({ vendor, category, totalCents, payerId, split: { mode: "equal", memberIds: [alex, maya, sam] } }, { actorId: payerId, save: true, announce: false, source: "manual" });
    assert.ok(result.ok, result.message);
    return result.bill!;
  };
  await save("Rent", 300_000, alex, "rent", new Date(2026, 9, 1, 12));
  const snacks = await save("Snacks", 3_000, maya, "groceries", new Date(2026, 9, 5, 12));
  await save("Pizza", 6_000, alex, "other", new Date(2026, 9, 6, 12));
  clock = new Date(2026, 9, 7, 12);
  assert.ok(bills.recordPayment({ fromId: maya, toId: alex, cents: 100_000, createdBy: maya }).ok);

  const line = (from: string, to: string) => bills.balances().transfers.find((transfer) => transfer.fromId === from && transfer.toId === to);
  // Maya paid her rent share back, so her line is just pizza, less what Alex owes her for snacks.
  assert.deepEqual(line(maya, alex)?.items, [{ label: "Pizza", cents: 2_000 }, { label: "Snacks", cents: -1_000 }]);
  assert.equal(line(maya, alex)?.cents, 1_000);
  // Sam never paid anything back: rent and pizza to Alex, snacks to Maya, each its own line.
  assert.deepEqual(line(sam, alex)?.items, [{ label: "Rent", cents: 100_000 }, { label: "Pizza", cents: 2_000 }]);
  assert.deepEqual(line(sam, maya)?.items, [{ label: "Snacks", cents: 1_000 }]);
  // The pairs add up to each member's net.
  const net = new Map(bills.balances().net.map((entry) => [entry.memberId, entry.cents]));
  for (const id of [alex, maya, sam]) {
    const pairs = bills.balances().transfers.reduce((sum, transfer) => sum + (transfer.toId === id ? transfer.cents : 0) - (transfer.fromId === id ? transfer.cents : 0), 0);
    assert.equal(pairs, net.get(id));
  }
  // Receipts and one-off expenses with no due date were paid when they happened; rent waits for the company.
  assert.ok(snacks.paidAt);
  assert.ok(bills.listBills(["saved"]).find((bill) => bill.vendor === "Pizza")?.paidAt);
  assert.equal(bills.listBills(["saved"]).find((bill) => bill.vendor === "Rent")?.paidAt, null);
});
