// Run with: node --import=tsx --test src/groceryActions.test.ts
// The Groceries page in live mode (src/groceryActions.ts, src/ui/cartView.ts): each button acts as the signed-in
// member only, is posted to the iMessage group as their line, and runs GroupCart's built-in commands (never the
// coordinator), so "Order with Kroger" is the same checkout as texting "checkout". The demo keeps its own controls.
// Temporary database, a fake Kroger client (no network), and a fake iMessage group.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startDashboard } from "./dashboard.js";
import { setupGroceryActions } from "./groceryActions.js";
import { KrogerClient, type KrogerCartAvailabilityIssue, type KrogerProduct, type KrogerUserAuthorization } from "./kroger.js";
import { runCommands, setBuiltInCommands, setGroupSender, type CommandContext } from "./platform.js";
import { setupProfilesAndChat, type ProfilesAndChat } from "./profilesAndChat.js";
import { SplitwiseService } from "./splitwise.js";
import { NOT_YOUR_ITEM_REPLY } from "./store/cartLedger.js";
import { CartStore, type Member } from "./store.js";
import { cartViewHelpers } from "./ui/cartView.js";

const REMOTE_HOST = "groupcart.example.com";

function product(productId: string, description: string, cents: number | null, size = "1 ct"): KrogerProduct {
  return { productId, description, brand: "Kroger", upc: `upc-${productId}`, size, regularPriceCents: cents, promoPriceCents: null, promoEffectiveAt: null, promoExpiresAt: null };
}

/** Kroger without the network: products by id, unavailable UPCs with suggestions, and a recorded cart add. */
class FakeKroger extends KrogerClient {
  readonly products = new Map<string, KrogerProduct>();
  readonly unavailable = new Map<string, KrogerProduct[]>();
  readonly cartAdds: Array<{ upc: string; quantity: number }> = [];
  #signInFor = "";

  constructor() { super("test-client", "test-secret", "LOC-1"); } // default redirect: http://127.0.0.1:3000/…

  override async searchProducts(_term: string): Promise<{ total: number; products: KrogerProduct[] }> {
    return { total: this.products.size, products: [...this.products.values()] };
  }
  override async getProduct(productId: string): Promise<KrogerProduct | null> {
    return this.products.get(productId) ?? null;
  }
  override async checkCartAvailability(items: Array<{ id: string; name: string; upc: string; quantity: number }>): Promise<KrogerCartAvailabilityIssue[]> {
    return items.filter((item) => this.unavailable.has(item.upc)).map((item) => ({ itemId: item.id, name: item.name, upc: item.upc, quantity: item.quantity, alternatives: this.unavailable.get(item.upc)! }));
  }
  override createUserAuthorization(memberId: string): { url: string; state: string } {
    this.#signInFor = memberId;
    return { url: "https://api.kroger.com/v1/connect/oauth2/authorize?state=test-state", state: "test-state" };
  }
  override async completeUserAuthorization(_code: string, state: string): Promise<KrogerUserAuthorization> {
    if (state !== "test-state") throw new Error("unexpected state");
    return { memberId: this.#signInFor, accessToken: "test-token" };
  }
  override async addItemsToCart(_token: string, items: Array<{ upc: string; quantity: number }>): Promise<void> {
    this.cartAdds.push(...items);
  }
}

let directory: string;
let store: CartStore;
let social: ProfilesAndChat;
let server: Server;
let base: string;
let alex: Member;
let maya: Member;
let mayaCookie: string;
const kroger = new FakeKroger();
/** Everything that reached the fake iMessage group, in order. */
const group: string[] = [];
/** Texts that went through GroupCart's built-in command handling, and what the coordinator saw. */
const commands: Array<{ memberId: string; text: string }> = [];
let coordinatorCalls = 0;

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function call(method: string, path: string, options: { as?: "alex" | "maya-remote" | "remote"; body?: unknown; headers?: Record<string, string>; on?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.as === "alex") headers.cookie = `gc_view_as=${alex.id}`;
  if (options.as === "maya-remote" || options.as === "remote") headers.host = REMOTE_HOST;
  if (options.as === "maya-remote") headers.cookie = mayaCookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${options.on ?? base}${path}`, { method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const json = (response: Response) => JSON.parse(response.body) as Record<string, unknown>;
const cart = async (as: "alex" | "maya-remote") => json(await call("GET", "/api/cart", { as }));
const items = () => store.snapshot().items;
const approved = (member: Member) => store.snapshot().members.find((candidate) => candidate.id === member.id)!.approved;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "groupcart-grocery-actions-"));
  store = new CartStore(join(directory, "live.sqlite"), "household-live", 50_000, "http://127.0.0.1:3000", true);
  store.registerMembers([{ handle: "+15550000001", name: "Alex" }, { handle: "+15550000002", name: "Maya" }]);
  [alex, maya] = ["Alex", "Maya"].map((name) => store.getMembers().find((member) => member.name === name)!) as [Member, Member];
  store.setCheckoutHooks(new SplitwiseService(store, {})); // Splitwise not configured
  social = setupProfilesAndChat({
    store,
    memberConfigs: [{ handle: "+15550000001", name: "Alex" }, { handle: "+15550000002", name: "Maya" }],
    liveMode: true,
    databasePath: join(directory, "live.sqlite"),
    publicUrl: "http://127.0.0.1:3000",
    // A connected coordinator takes every typed chat message; buttons must never reach it.
    processMessage: async () => { coordinatorCalls += 1; return null; },
  });
  social.chat.useGroup({ sendText: async (text) => { group.push(text); }, sendImage: async () => {}, respond: async (text) => { group.push(text); } });
  setGroupSender(async (text) => { group.push(text); });
  // The same handling index.ts installs (runGroupCartCommand): feature commands, then the live store with Kroger.
  setBuiltInCommands(async (context: CommandContext) => {
    commands.push({ memberId: context.memberId, text: context.text });
    const commandReply = store.ownsMessage(context.text, context.memberId) ? null : await runCommands(context);
    if (commandReply) return commandReply;
    return store.processLiveIncomingText(context.messageId, context.memberId, context.text, (query) => kroger.searchProducts(query), kroger.selectedLocationId, true, (cartItems) => kroger.checkCartAvailability(cartItems), (id) => kroger.getProduct(id));
  });
  setupGroceryActions({ store, chat: social.chat, kroger });
  const invite = social.auth.createInvite(maya.id);
  const session = social.auth.redeemInvite(invite.token, "test-client");
  assert.ok(session.ok);
  mayaCookie = `gc_session=${session.token}`;

  kroger.products.set("eggs", product("eggs", "Large Eggs", 299, "12 ct"));
  kroger.products.set("milk", product("milk", "Whole Milk", 389, "1 gal"));
  kroger.products.set("bread", product("bread", "Wheat Bread", 249));
  kroger.products.set("noprice", product("noprice", "Mystery Snack", null));
  server = startDashboard(store, 0, false, kroger);
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("Add puts that exact Kroger product in the cart for the signed-in member and tells the group", async () => {
  const added = await call("POST", "/api/groceries/add", { as: "alex", body: { productId: "eggs" } });
  assert.equal(added.status, 200, added.body);
  assert.match(String(json(added).message), /^Added Large Eggs/);
  const eggs = items().find((item) => item.name === "Large Eggs")!;
  assert.deepEqual([eggs.ownerId, eggs.participantIds, eggs.unitPriceCents, eggs.priceSource, eggs.upc], [alex.id, [alex.id], 299, "kroger", "upc-eggs"]);
  assert.equal(group.at(-2), "Alex: add Large Eggs (12 ct)");
  assert.match(group.at(-1)!, /^Added Large Eggs/);

  // Refused before anything reaches the group: no store price, or not a Kroger product at this store.
  const before = group.length;
  assert.equal((await call("POST", "/api/groceries/add", { as: "alex", body: { productId: "noprice" } })).status, 409);
  assert.equal((await call("POST", "/api/groceries/add", { as: "alex", body: { productId: "gone" } })).status, 404);
  assert.equal(group.length, before);
  assert.equal(coordinatorCalls, 0, "buttons never go to the coordinator");
});

test("Remove takes a roommate off only their own items, as the chat's “remove” does", async () => {
  assert.equal((await call("POST", "/api/groceries/add", { as: "maya-remote", body: { productId: "milk" } })).status, 200);
  const milk = items().find((item) => item.name === "Whole Milk")!;
  assert.equal(milk.ownerId, maya.id, "a remote session adds as its own member");

  const before = group.length;
  const notYours = await call("POST", "/api/groceries/remove", { as: "alex", body: { itemId: milk.id } });
  assert.equal(notYours.status, 403);
  assert.ok(items().some((item) => item.id === milk.id), "someone else's item is left alone");
  assert.equal(group.length, before, "a refused removal isn't posted");
  assert.equal(store.removeItemForMember("test:not-yours", alex.id, milk.id), NOT_YOUR_ITEM_REPLY, "the store enforces the same rule");

  // A shared item loses only the remover's share.
  await store.processLiveIncomingText("test:share", alex.id, "start sharing with Maya", (query) => kroger.searchProducts(query));
  assert.equal((await call("POST", "/api/groceries/add", { as: "alex", body: { productId: "bread" } })).status, 200);
  await store.processLiveIncomingText("test:unshare", alex.id, "stop sharing", (query) => kroger.searchProducts(query));
  const bread = items().find((item) => item.name === "Wheat Bread")!;
  assert.deepEqual([...bread.participantIds].sort(), [alex.id, maya.id].sort());
  const share = await call("POST", "/api/groceries/remove", { as: "alex", body: { itemId: bread.id } });
  assert.equal(share.status, 200, share.body);
  assert.match(String(json(share).message), /^Removed your share of Wheat Bread; Maya still has it/);
  assert.deepEqual(items().find((item) => item.id === bread.id)?.participantIds, [maya.id]);
  assert.equal(group.at(-2), "Alex: remove my share of Wheat Bread");

  const own = await call("POST", "/api/groceries/remove", { as: "maya-remote", body: { itemId: milk.id } });
  assert.equal(own.status, 200, own.body);
  assert.ok(!items().some((item) => item.id === milk.id));
  assert.equal(group.at(-2), "Maya: remove Whole Milk");
});

test("Approve acts only as the signed-in member; a signed-out remote request is refused", async () => {
  const before = group.length;
  const signedOut = await call("POST", "/api/groceries/approve", { as: "remote", body: {} });
  assert.equal(signedOut.status, 401);
  const forAlex = await call("POST", "/api/groceries/approve", { as: "maya-remote", body: { memberId: alex.id } });
  assert.equal(forAlex.status, 403, "nobody approves for someone else");
  const crossSite = await call("POST", "/api/groceries/approve", { as: "maya-remote", body: {}, headers: { origin: "https://evil.example" } });
  assert.equal(crossSite.status, 403);
  assert.deepEqual([approved(alex), approved(maya), group.length], [false, false, before]);

  const mine = await call("POST", "/api/groceries/approve", { as: "maya-remote", body: {} });
  assert.equal(mine.status, 200, mine.body);
  assert.deepEqual([approved(alex), approved(maya)], [false, true]);
  assert.deepEqual(group.slice(-2), ["Maya: approve", String(json(mine).message)]);
  assert.match(String(json(mine).message), /^Approved\. Waiting on Alex/);
});

test("Order with Kroger is the same checkout as texting “checkout”, with the orderer's own Kroger account", async () => {
  // Approvals missing: the reply names who is waiting, and nothing else happens.
  commands.length = 0;
  const early = await call("POST", "/api/groceries/order", { as: "alex", body: {} });
  assert.equal(early.status, 200);
  assert.match(String(json(early).message), /waiting for approval from: Alex/);
  assert.deepEqual(commands, [{ memberId: alex.id, text: "checkout" }]);
  assert.equal(store.pendingKrogerCheckout(), undefined);
  const view = cartViewHelpers();
  assert.deepEqual(view.orderState(await cart("alex")), { step: "approvals", waiting: [{ id: alex.id, name: "Alex", you: true }], viewerApproved: false });

  assert.equal((await call("POST", "/api/groceries/approve", { as: "alex", body: {} })).status, 200);
  assert.deepEqual(view.orderState(await cart("alex")), { step: "ready" });
  commands.length = 0;
  const ordered = await call("POST", "/api/groceries/order", { as: "alex", body: {} });
  assert.equal(ordered.status, 200, ordered.body);
  // Exactly what Alex would text: “checkout”, then his number when GroupCart asks whose Kroger account to use.
  const alexNumber = String(store.getMembers().findIndex((member) => member.id === alex.id) + 1);
  assert.deepEqual(commands, [{ memberId: alex.id, text: "checkout" }, { memberId: alex.id, text: alexNumber }]);
  assert.deepEqual(group.slice(-4).filter((_, index) => index % 2 === 0), ["Alex: checkout", `Alex: ${alexNumber}`]);
  assert.match(group.at(-3)!, /Which household member’s Kroger account/);
  assert.deepEqual({ ...store.pendingKrogerCheckout() }, { requesterId: alex.id, revision: store.snapshot().revision, selectedMemberId: alex.id, status: "awaiting_oauth" });
  assert.equal(coordinatorCalls, 0);

  // Alex on the host computer gets the sign-in link; Maya on her phone waits for him.
  const signin = view.orderState(await cart("alex"));
  assert.deepEqual(signin, { step: "signin", mine: true, accountName: "Alex", signInUrl: `/api/kroger/oauth/start?memberId=${alex.id}`, canSignInHere: true, needsHost: false, canCancel: true });
  const mayaView = await cart("maya-remote");
  assert.equal(mayaView.krogerSignInNeedsHost, true, "Kroger returns to 127.0.0.1, so a phone can't finish sign-in");
  assert.deepEqual(view.orderState(mayaView), { step: "signin", mine: false, accountName: "Alex", signInUrl: `/api/kroger/oauth/start?memberId=${alex.id}`, canSignInHere: false, needsHost: true, canCancel: false });

  // The cart is locked while the checkout is open.
  assert.equal((await call("POST", "/api/groceries/add", { as: "alex", body: { productId: "milk" } })).status, 409);

  // Sign-in finishes: the items go to Alex's Kroger cart, the group hears it, and the page offers the Kroger cart.
  const start = await call("GET", `/api/kroger/oauth/start?memberId=${alex.id}`, { as: "alex" });
  assert.equal(start.status, 302);
  const sentItems = items().map((item) => ({ upc: item.upc, quantity: item.quantity }));
  const callback = await call("GET", "/api/kroger/oauth/callback?code=test-code&state=test-state", { as: "alex" });
  assert.equal(callback.status, 200, callback.body);
  assert.match(callback.body, /https:\/\/www\.kroger\.com\/cart/);
  assert.deepEqual(kroger.cartAdds, sentItems);
  assert.match(group.at(-1)!, /^Added 2 items to Alex’s Kroger cart\. No order was placed/);
  assert.match(group.at(-1)!, /Purchase [a-f0-9]{8} is awaiting the actual paid total/);
  assert.equal(store.latestSplitwiseExpense(), undefined, "a cart transfer must not create debt or a Bills balance");
  assert.deepEqual(view.orderState(await cart("maya-remote")), { step: "sent", mine: false, accountName: "Alex", itemCount: 2, at: store.lastKrogerCart()!.at });
});

test("Unavailable items show on the page and are answered by number, like the chat review", async () => {
  kroger.products.set("ham", product("ham", "Deli Ham", 599));
  kroger.unavailable.set("upc-ham", [product("turkey", "Deli Turkey", 549)]);
  assert.equal((await call("POST", "/api/groceries/add", { as: "alex", body: { productId: "ham" } })).status, 200);
  for (const as of ["alex", "maya-remote"] as const) assert.equal((await call("POST", "/api/groceries/approve", { as, body: {} })).status, 200);
  assert.equal((await call("POST", "/api/groceries/order", { as: "maya-remote", body: {} })).status, 200);
  const state = cartViewHelpers().orderState(await cart("maya-remote"));
  assert.deepEqual(state, { step: "review", items: [{ number: 1, name: "Deli Ham", quantity: 1, choice: null, alternatives: [{ option: 1, description: "Deli Turkey", size: "1 ct", priceCents: 549 }] }] });
  assert.equal((await call("POST", "/api/groceries/review", { as: "alex", body: { item: 7 } })).status, 200, "an unknown number gets the store's answer");

  const swapped = await call("POST", "/api/groceries/review", { as: "alex", body: { item: 1, option: 1 } });
  assert.equal(swapped.status, 200, swapped.body);
  assert.equal(group.at(-2), "Alex: replace 1 with 1");
  assert.deepEqual(items().map((item) => item.name), ["Deli Turkey"]);
  assert.equal(store.pendingKrogerCheckout(), undefined, "the review ended; the changed cart needs fresh approvals");
  assert.equal((await call("POST", "/api/groceries/review", { as: "alex", body: { item: 1 } })).status, 409, "no review is open now");
});

test("Demo mode keeps its own controls; live mode refuses them", async () => {
  const liveApprove = await call("POST", "/api/approve", { as: "alex", body: { memberId: maya.id } });
  assert.equal(liveApprove.status, 403, "live mode never approves for someone else");

  const demoStore = new CartStore(join(directory, "demo.sqlite"), "household-demo", 5000);
  demoStore.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }]);
  const demoMaya = demoStore.getMembers().find((member) => member.name === "Maya")!;
  demoStore.processIncomingText("demo:1", demoMaya.id, "2 bananas");
  const demo = startDashboard(demoStore, 0, true);
  await new Promise<void>((resolve) => (demo.listening ? resolve() : demo.once("listening", () => resolve())));
  const on = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
  try {
    const approve = await call("POST", "/api/approve", { on, body: { memberId: demoMaya.id } });
    assert.equal(approve.status, 200, approve.body);
    const demoCart = json(await call("GET", "/api/cart", { on }));
    assert.equal(demoCart.demoMode, true);
    assert.equal(cartViewHelpers().orderState(demoCart), null, "the demo shows its demo controls, not the Order card");
  } finally {
    demo.close();
    demoStore.close();
  }
});

test("Cart items group by roommate: shared first, then each member's own, with subtotals that add up", () => {
  const item = (name: string, participantIds: string[], totalCents: number) => ({ name, participantIds, ownerId: participantIds[0], totalCents });
  const members = [{ id: "a", name: "Alex" }, { id: "m", name: "Maya" }, { id: "j", name: "Jordan" }];
  const groups = cartViewHelpers().groupItems({
    members,
    items: [item("Eggs", ["a"], 300), item("Pasta", ["a", "m"], 400), item("Milk", ["m"], 250), item("Cheese", ["a"], 500), item("Old", ["gone"], 100)],
  });
  assert.deepEqual(groups.map((group) => [group.key, group.items.map((entry) => (entry as { name: string }).name), group.totalCents]), [
    ["shared", ["Pasta"], 400],
    ["a", ["Eggs", "Cheese"], 800],
    ["m", ["Milk"], 250],
    ["others", ["Old"], 100],
  ]);
  assert.equal(groups.reduce((sum, group) => sum + group.totalCents, 0), 1550);
});
