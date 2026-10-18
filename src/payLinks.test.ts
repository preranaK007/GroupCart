// Run with: node --import=tsx --test src/payLinks.test.ts
// Pay-back links: amounts, URL encoding, handle parsing from profile text, and the "who owes" chat line.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  amountText, cashAppLink, formatPayHandles, parsePayHandles, payLinkLine, payOptions, payOptionsFor, paypalLink, profilePayLinks,
  setPayHandleSource, venmoAppLink, venmoLink,
} from "./payLinks.js";

after(() => setPayHandleSource(null));

test("amounts are always dollars with two decimals", () => {
  assert.equal(amountText(2667), "26.67");
  assert.equal(amountText(5), "0.05");
  assert.equal(amountText(100_000), "1000.00");
  assert.equal(amountText(2666.6), "26.67");
});

test("links put the amount (and Venmo's note) in the right place, URL-encoded", () => {
  assert.equal(venmoLink("alex-k", 2667, "GroupCart settle-up"), "https://venmo.com/alex-k?txn=pay&amount=26.67&note=GroupCart%20settle-up");
  assert.equal(venmoLink("alex-k", 2667, "Rent & bills 🏠 #4B?"), "https://venmo.com/alex-k?txn=pay&amount=26.67&note=Rent%20%26%20bills%20%F0%9F%8F%A0%20%234B%3F");
  assert.equal(venmoAppLink("alex-k", 2667, "Rent & bills"), "venmo://paycharge?txn=pay&recipients=alex-k&amount=26.67&note=Rent%20%26%20bills");
  assert.equal(cashAppLink("alexk", 2667), "https://cash.app/$alexk/26.67");
  assert.equal(paypalLink("alexk", 2667), "https://paypal.me/alexk/26.67");
  // Anything that isn't a plain handle never reaches a URL.
  assert.throws(() => venmoLink("alex k", 100));
  assert.throws(() => venmoLink("alex?txn=charge", 100));
  assert.throws(() => cashAppLink("../evil", 100));
  assert.throws(() => paypalLink("a/b", 100));
});

test("profile text parses into handles: labels, links, bare @ and $, several at once", () => {
  assert.deepEqual(parsePayHandles("Venmo @alex-k"), { venmo: "alex-k", rest: "" });
  assert.deepEqual(parsePayHandles("Venmo @alex-k · Cash App $alexk · PayPal.me/alexk"), { venmo: "alex-k", cashapp: "alexk", paypal: "alexk", rest: "" });
  assert.deepEqual(parsePayHandles("https://venmo.com/u/maya-r, cash.app/$mayar"), { venmo: "maya-r", cashapp: "mayar", rest: "" });
  assert.deepEqual(parsePayHandles("@jordan-p"), { venmo: "jordan-p", rest: "" });
  assert.deepEqual(parsePayHandles("$jordanp"), { cashapp: "jordanp", rest: "" });
  assert.deepEqual(parsePayHandles("paypal: jordanp"), { paypal: "jordanp", rest: "" });
  assert.deepEqual(parsePayHandles("venmo: maya_r / Zelle 555-0100"), { venmo: "maya_r", rest: "Zelle 555-0100" });
  assert.deepEqual(parsePayHandles("Venmo or Cash App $alexk"), { cashapp: "alexk", rest: "Venmo" });
  // Emails and dollar amounts are not handles.
  assert.deepEqual(parsePayHandles("maya@example.com"), { rest: "maya@example.com" });
  assert.deepEqual(parsePayHandles("$20 cash is fine"), { rest: "$20 cash is fine" });
  assert.deepEqual(parsePayHandles(""), { rest: "" });
  // A query string in the text can't sneak into the handle.
  assert.equal(parsePayHandles("venmo @alex?txn=charge").venmo, "alex");
});

test("formatting round-trips through parsing", () => {
  const text = formatPayHandles({ venmo: "@alex-k", cashapp: "$alexk", paypal: "paypal.me/alexk", rest: "" });
  assert.equal(text, "Venmo @alex-k · Cash App $alexk · PayPal.me/alexk");
  assert.deepEqual(parsePayHandles(text), { venmo: "alex-k", cashapp: "alexk", paypal: "alexk", rest: "" });
  assert.equal(formatPayHandles({ venmo: "bad user", rest: "Zelle 555-0100" }), "Zelle 555-0100");
});

test("options are Venmo first, only for a positive amount; profile links have no amount", () => {
  const handles = parsePayHandles("PayPal.me/alexk · Venmo @alex-k");
  assert.deepEqual(payOptions(handles, 2667).map((option) => option.provider), ["venmo", "paypal"]);
  assert.equal(payOptions(handles, 0).length, 0);
  assert.equal(payOptions(handles, 2667)[0]!.appUrl, "venmo://paycharge?txn=pay&recipients=alex-k&amount=26.67&note=GroupCart%20settle-up");
  assert.deepEqual(profilePayLinks(handles).map((link) => link.url), ["https://venmo.com/u/alex-k", "https://paypal.me/alexk"]);
});

test("the chat line uses the creditor's first handle, or nothing without one", () => {
  setPayHandleSource((memberId) => ({ alex: "Cash App $alexk", maya: "" } as Record<string, string>)[memberId] ?? "");
  assert.equal(payLinkLine("alex", "Alex Kim", 2667), "💳 Pay Alex $26.67 on Cash App: https://cash.app/$alexk/26.67");
  assert.equal(payLinkLine("maya", "Maya", 500), null);
  assert.equal(payOptionsFor("nobody", 500).length, 0);
});
