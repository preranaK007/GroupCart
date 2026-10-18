// Run with: node --import=tsx --test src/bills.test.ts
// Bills from group-chat photos when no ANTHROPIC_API_KEY is set: a photo becomes a bill draft only when its caption
// says so (bill, receipt, rent, due, or a $ amount), so ordinary photos in the group chat stay out of Bills.
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
