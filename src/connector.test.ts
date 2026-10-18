// Run with: node --import=tsx --test src/connector.test.ts
// End-to-end checks for the Claude connector: token storage, the remote-access guard, and real MCP
// JSON-RPC over HTTP through the official SDK client (demo cart, no network, temporary database).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectorTokens, FailedAuthLimiter, setupConnector, validateArguments } from "./connector.js";
import { registerSummaryProvider } from "./coreTools.js";
import { startDashboard } from "./dashboard.js";
import { CalendarService } from "./googleCalendar.js";
import { recentFeed, registerRoute, registerTools, setRemoteAuthorizer } from "./platform.js";
import { isRemoteRequest } from "./remoteAccess.js";
import { CartStore } from "./store.js";

// 1x1 transparent PNG.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const TUNNEL_HOST = "abc.trycloudflare.com";

let directory: string;
let store: CartStore;
let server: Server;
let base: string;
let alex: { id: string; name: string };
let maya: { id: string; name: string };

type RawResponse = { status: number; headers: IncomingMessage["headers"]; body: string };

function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

async function issueToken(memberId: string): Promise<string> {
  const response = await raw("POST", "/api/connector/tokens", { "content-type": "application/json" }, JSON.stringify({ memberId }));
  assert.equal(response.status, 200, response.body);
  const data = JSON.parse(response.body) as { token: string; snippets: Array<{ id: string; code: string | null }> };
  assert.match(data.token, /^gct_[A-Za-z0-9_-]{43}$/);
  assert.ok(data.snippets.some((snippet) => snippet.code?.includes(`Authorization: Bearer ${data.token}`)));
  return data.token;
}

async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "groupcart-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((block) => block.text ?? "").join("\n");
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "gc-connector-test-"));
  store = new CartStore(join(directory, "test.sqlite"), "test-home", 5000);
  const members = store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }]);
  alex = members.find((member) => member.name === "Alex")!;
  maya = members.find((member) => member.name === "Maya")!;
  setupConnector({ store, demoMode: true, calendar: new CalendarService(store, "http://127.0.0.1:3999"), port: 3999, publicUrl: `https://${TUNNEL_HOST}` });
  registerTools([{
    name: "list_bill_images_to_read",
    description: "Test tool returning an image for Claude to read.",
    inputSchema: { type: "object", properties: {} },
    handler: () => ({ mcpContent: [{ type: "text", text: "Bill 1" }, { type: "image", data: TINY_PNG, mimeType: "image/png" }] }),
  }, {
    name: "echo_count",
    description: "Test tool with typed arguments.",
    inputSchema: { type: "object", properties: { count: { type: "integer" }, kind: { type: "string", enum: ["a", "b"] } }, required: ["count"] },
    handler: (args, caller) => ({ count: args.count, caller: caller.memberName }),
  }]);
  registerSummaryProvider("chores", (caller) => ({ due: [`Trash (${caller.memberName})`] }));
  registerRoute((request, response, url) => {
    if (url.pathname !== "/signin" && url.pathname !== "/members-only") return false;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return true;
  });
  server = startDashboard(store, 0, true);
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("tokens are stored only as SHA-256 hashes, rotate, and revoke", () => {
  const tokens = new ConnectorTokens(store.database);
  const first = tokens.issue(alex.id);
  assert.equal(tokens.verify(first), alex.id);
  const rows = store.database.prepare("SELECT * FROM connector_tokens").all() as Array<Record<string, unknown>>;
  assert.ok(rows.every((row) => !Object.values(row).some((value) => String(value).includes(first))));
  const second = tokens.issue(alex.id);
  assert.equal(tokens.verify(first), undefined, "rotating replaces the old token");
  assert.equal(tokens.verify(second), alex.id);
  assert.equal(tokens.verify("gct_short"), undefined);
  assert.ok(tokens.revoke(alex.id));
  assert.equal(tokens.verify(second), undefined);
});

test("isRemoteRequest: loopback only when socket, Host, and headers are all local", () => {
  const fake = (address: string, headers: Record<string, string>) => ({ socket: { remoteAddress: address }, headers }) as unknown as IncomingMessage;
  assert.equal(isRemoteRequest(fake("127.0.0.1", { host: "127.0.0.1:3000" })), false);
  assert.equal(isRemoteRequest(fake("::1", { host: "localhost:3000" })), false);
  assert.equal(isRemoteRequest(fake("::ffff:127.0.0.1", { host: "[::1]:3000" })), false);
  assert.equal(isRemoteRequest(fake("127.0.0.1", { host: TUNNEL_HOST })), true);
  assert.equal(isRemoteRequest(fake("127.0.0.1", { host: "127.0.0.1:3000", "x-forwarded-for": "203.0.113.9" })), true);
  assert.equal(isRemoteRequest(fake("127.0.0.1", { host: "127.0.0.1:3000", "cf-connecting-ip": "203.0.113.9" })), true);
  assert.equal(isRemoteRequest(fake("192.168.1.20", { host: "127.0.0.1:3000" })), true);
  assert.equal(isRemoteRequest(fake("127.0.0.1", { host: "evil.example@127.0.0.1" })), true);
  assert.equal(isRemoteRequest(fake("127.0.0.1", {})), true);
});

test("failed-auth limiter locks a client out after repeated failures", () => {
  const limiter = new FailedAuthLimiter(3, 100, 60_000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(limiter.retryAfterMs("a", 1_000), 0);
    limiter.recordFailure("a", 1_000);
  }
  assert.ok(limiter.retryAfterMs("a", 2_000) > 0);
  assert.equal(limiter.retryAfterMs("b", 2_000), 0);
  assert.equal(limiter.retryAfterMs("a", 62_000), 0, "failures expire after the window");
});

test("validateArguments checks required keys, types, and enums", () => {
  const schema = { type: "object" as const, properties: { count: { type: "integer" }, kind: { type: "string", enum: ["a", "b"] } }, required: ["count"] };
  assert.equal(validateArguments(schema, { count: 2, kind: "a" }), null);
  assert.match(validateArguments(schema, {}) ?? "", /Missing required argument "count"/);
  assert.match(validateArguments(schema, { count: "2" }) ?? "", /integer/);
  assert.match(validateArguments(schema, { count: 1, kind: "c" }) ?? "", /one of/);
  assert.match(validateArguments(schema, []) ?? "", /object/);
});

test("tunnel guard: remote requests reach only /mcp, sign-in, and authorized routes", async () => {
  const remote = { host: TUNNEL_HOST, "x-forwarded-for": "198.51.100.7", "cf-connecting-ip": "198.51.100.7" };
  for (const path of ["/", "/settings", "/groceries", "/calendar", "/api/cart", "/api/feed", "/api/connector", "/api/google/oauth/start?memberId=x", "/api/kroger/oauth/start?memberId=x", "/members-only"]) {
    assert.equal((await raw("GET", path, remote)).status, 404, `GET ${path}`);
  }
  for (const path of ["/api/demo-message", "/api/approve", "/api/checkout", "/api/connector/tokens"]) {
    const response = await raw("POST", path, { ...remote, "content-type": "application/json" }, JSON.stringify({ memberId: alex.id, text: "eggs" }));
    assert.equal(response.status, 404, `POST ${path}`);
  }
  // DNS rebinding: a local socket with a foreign Host is remote too.
  assert.equal((await raw("GET", "/settings", { host: "rebind.example:3000" })).status, 404);
  // Sign-in routes pass the guard (the profiles module checks them itself).
  assert.equal((await raw("GET", "/signin", remote)).status, 200);
  // /mcp passes the guard and then requires a token.
  assert.equal((await raw("POST", "/mcp", { ...remote, ...MCP_HEADERS }, INITIALIZE)).status, 401);
  // A remote authorizer (profiles module) can open other routes.
  setRemoteAuthorizer((_request, url) => url.pathname === "/members-only");
  try {
    assert.equal((await raw("GET", "/members-only", remote)).status, 200);
    assert.equal((await raw("GET", "/settings", remote)).status, 404);
  } finally {
    setRemoteAuthorizer(null);
  }
  // Local requests still reach the dashboard.
  assert.equal((await raw("GET", "/settings")).status, 200);
});

test("settings API is local-only JSON and the card never embeds tokens", async () => {
  assert.equal((await raw("POST", "/api/connector/tokens", { "content-type": "text/plain" }, JSON.stringify({ memberId: alex.id }))).status, 415);
  assert.equal((await raw("POST", "/api/connector/tokens", { "content-type": "application/json", origin: "https://evil.example" }, JSON.stringify({ memberId: alex.id }))).status, 403);
  assert.equal((await raw("POST", "/api/connector/tokens", { "content-type": "application/json" }, JSON.stringify({ memberId: "nobody" }))).status, 404);
  const token = await issueToken(maya.id);
  const status = JSON.parse((await raw("GET", "/api/connector")).body) as { members: Array<{ name: string; connected: boolean }>; publicUrl: string; toolGroups: Array<{ group: string; tools: Array<{ name: string }> }> };
  assert.equal(status.publicUrl, `https://${TUNNEL_HOST}/mcp`);
  assert.ok(status.members.find((member) => member.name === "Maya")?.connected);
  assert.ok(status.toolGroups.find((group) => group.group === "Groceries")?.tools.some((tool) => tool.name === "add_to_cart"));
  assert.ok(status.toolGroups.find((group) => group.group === "Bills")?.tools.some((tool) => tool.name === "list_bill_images_to_read"));
  const page = (await raw("GET", "/settings")).body;
  assert.match(page, /Connect Claude/);
  assert.match(page, /cc-token-dialog/);
  assert.ok(!page.includes(token));
  assert.ok(!(await raw("GET", "/api/connector")).body.includes(token));
});

test("MCP over HTTP: unauthorized requests fail, GET is 405, cross-origin is 403, failures are rate-limited", async () => {
  assert.equal((await raw("POST", "/mcp", MCP_HEADERS, INITIALIZE)).status, 401);
  const bad = await raw("POST", "/mcp", { ...MCP_HEADERS, authorization: `Bearer gct_${"x".repeat(43)}` }, INITIALIZE);
  assert.equal(bad.status, 401);
  assert.match(String(bad.headers["www-authenticate"]), /Bearer/);
  assert.equal((await raw("POST", `/mcp/t/gct_${"y".repeat(43)}`, MCP_HEADERS, INITIALIZE)).status, 401);
  const token = await issueToken(alex.id);
  assert.equal((await raw("GET", "/mcp", { authorization: `Bearer ${token}`, accept: "text/event-stream" })).status, 405);
  assert.equal((await raw("POST", "/mcp", { ...MCP_HEADERS, authorization: `Bearer ${token}`, origin: "https://evil.example" }, INITIALIZE)).status, 403);
  const attacker = { ...MCP_HEADERS, host: TUNNEL_HOST, "cf-connecting-ip": "203.0.113.66" };
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) statuses.push((await raw("POST", "/mcp", { ...attacker, authorization: "Bearer nope" }, INITIALIZE)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);
  // Locked out even with a valid token until the window passes; other clients are unaffected.
  assert.equal((await raw("POST", "/mcp", { ...attacker, authorization: `Bearer ${token}` }, INITIALIZE)).status, 429);
  assert.equal((await raw("POST", "/mcp", { ...MCP_HEADERS, authorization: `Bearer ${token}` }, INITIALIZE)).status, 200);
});

test("MCP over HTTP: tools/list and tool calls run as the token's member", async () => {
  const token = await issueToken(alex.id);
  const client = await connect(`${base}/mcp`, { Authorization: `Bearer ${token}` });
  try {
    assert.match(client.getInstructions() ?? "", /connected as Alex/);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ["whats_on_my_plate", "view_cart", "add_to_cart", "choose_product", "approve_cart", "household_members", "free_times", "recent_activity", "post_to_group", "list_bill_images_to_read"]) {
      assert.ok(names.includes(name), name);
    }
    const viewCart = tools.find((tool) => tool.name === "view_cart")!;
    assert.equal(viewCart.annotations?.readOnlyHint, true);
    const post = tools.find((tool) => tool.name === "post_to_group")!;
    assert.equal(post.annotations?.readOnlyHint, false);
    assert.equal(post.annotations?.destructiveHint, false);
    assert.equal(post.annotations?.openWorldHint, true);

    const added = await client.callTool({ name: "add_to_cart", arguments: { request: "2 bananas" } });
    assert.ok(!added.isError, text(added));
    assert.match(text(added), /Bananas/);

    const milk = await client.callTool({ name: "add_to_cart", arguments: { request: "milk" } });
    assert.match(text(milk), /choose_product/);
    const oat = await client.callTool({ name: "choose_product", arguments: { choice: "oat" } });
    assert.match(text(oat), /Oat milk/);
    const noPending = await client.callTool({ name: "choose_product", arguments: { choice: "1" } });
    assert.equal(noPending.isError, true);

    const checkout = await client.callTool({ name: "add_to_cart", arguments: { request: "checkout" } });
    assert.equal(checkout.isError, true);
    const missing = await client.callTool({ name: "add_to_cart", arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /Missing required argument "request"/);
    const wrongType = await client.callTool({ name: "echo_count", arguments: { count: "two" } });
    assert.equal(wrongType.isError, true);
    const echo = await client.callTool({ name: "echo_count", arguments: { count: 2 } });
    assert.deepEqual(JSON.parse(text(echo)), { count: 2, caller: "Alex" });
    const unknown = await client.callTool({ name: "does_not_exist", arguments: {} });
    assert.equal(unknown.isError, true);

    const cart = JSON.parse(text(await client.callTool({ name: "view_cart", arguments: {} }))) as { items: Array<{ name: string; addedBy: string; price: string }>; you: { name: string } };
    assert.equal(cart.you.name, "Alex");
    assert.ok(cart.items.some((item) => item.name === "Bananas" && item.addedBy === "Alex" && item.price === "sample estimate"));

    const plate = JSON.parse(text(await client.callTool({ name: "whats_on_my_plate", arguments: {} }))) as { member: string; groceries: { approval: string; yourItems: unknown[] }; chores: { due: string[] } };
    assert.equal(plate.member, "Alex");
    assert.match(plate.groceries.approval, /Needs your approval/);
    assert.equal(plate.groceries.yourItems.length, 2);
    assert.deepEqual(plate.chores.due, ["Trash (Alex)"]);

    const approved = await client.callTool({ name: "approve_cart", arguments: {} });
    assert.ok(!approved.isError, text(approved));
    assert.match(text(approved), /Waiting for: Maya/);

    const posted = await client.callTool({ name: "post_to_group", arguments: { message: "Pizza night Friday?" } });
    assert.ok(!posted.isError, text(posted));
    const feed = JSON.parse((await raw("GET", "/api/feed")).body) as { entries: Array<{ text: string }> };
    assert.equal(feed.entries[0]?.text, "Alex via Claude: Pizza night Friday?");
    assert.ok(feed.entries.some((entry) => entry.text === "Alex approved the grocery cart via Claude."));
    assert.equal(recentFeed(1)[0]?.text, "Alex via Claude: Pizza night Friday?");

    const free = JSON.parse(text(await client.callTool({ name: "free_times", arguments: { days: 3, count: 2 } }))) as { source: string; times: Array<{ start: string; label: string }> };
    assert.match(free.source, /sample/);
    assert.ok(free.times.length <= 2);
    const badDays = await client.callTool({ name: "free_times", arguments: { days: 40 } });
    assert.equal(badDays.isError, true);
  } finally {
    await client.close();
  }
});

test("MCP image results pass through as image content (bills read by the caller's Claude)", async () => {
  const token = await issueToken(maya.id);
  const client = await connect(`${base}/mcp/t/${token}`);
  try {
    assert.match(client.getInstructions() ?? "", /connected as Maya/);
    const result = await client.callTool({ name: "list_bill_images_to_read", arguments: {} });
    assert.ok(!result.isError);
    assert.deepEqual(result.content, [
      { type: "text", text: "Bill 1" },
      { type: "image", data: TINY_PNG, mimeType: "image/png" },
    ]);
  } finally {
    await client.close();
  }
});

test("secret-path URL works through the tunnel host, and revoking cuts access", async () => {
  const token = await issueToken(maya.id);
  const tunneled = { ...MCP_HEADERS, host: TUNNEL_HOST, "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "https" };
  const ok = await raw("POST", `/mcp/t/${token}`, tunneled, INITIALIZE);
  assert.equal(ok.status, 200, ok.body);
  assert.match(ok.body, /"name":"groupcart"/);
  const revoke = await raw("POST", "/api/connector/tokens/revoke", { "content-type": "application/json" }, JSON.stringify({ memberId: maya.id }));
  assert.equal(revoke.status, 200);
  assert.equal((await raw("POST", `/mcp/t/${token}`, tunneled, INITIALIZE)).status, 401);
});
