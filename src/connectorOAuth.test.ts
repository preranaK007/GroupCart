// Run with: node --import=tsx --test src/connectorOAuth.test.ts
// OAuth 2.1 for the connector: discovery, dynamic client registration, pairing-code sign-in and consent,
// PKCE, token exchange, refresh rotation, revocation, attribution ("Maya via Grok"), and the tunnel guard.
// Requests that should look like they came through a tunnel carry the tunnel Host and forwarding headers.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, type OAuthClientInformationMixed, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { setupConnector } from "./connector.js";
import { assistantLabel } from "./connectorOAuth.js";
import { startDashboard } from "./dashboard.js";
import { setRemoteAuthorizer, setRequestMemberResolver } from "./platform.js";
import { CartStore } from "./store.js";

const TUNNEL_HOST = "abc.trycloudflare.com";
const TUNNEL = `https://${TUNNEL_HOST}`;
const GROK_REDIRECT = "https://grok.com/connectors/oauth/callback";

let directory: string;
let store: CartStore;
let server: Server;
let base: string;
let alex: { id: string; name: string };
let maya: { id: string; name: string };
let ipCounter = 10;

type Raw = { status: number; headers: IncomingMessage["headers"]; body: string };

function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Raw> {
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

/** Headers of a request arriving through the Cloudflare tunnel (a fresh client IP unless given). */
function tunnel(ip = `198.51.100.${ipCounter++}`): Record<string, string> {
  return { host: TUNNEL_HOST, "x-forwarded-for": ip, "x-forwarded-proto": "https", "cf-connecting-ip": ip };
}

const form = (values: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(metadata: Record<string, unknown>, headers = tunnel()): Promise<Raw & { json: Record<string, unknown> }> {
  const response = await raw("POST", "/oauth/register", { ...headers, "content-type": "application/json" }, JSON.stringify(metadata));
  return { ...response, json: JSON.parse(response.body) as Record<string, unknown> };
}

async function pairingCode(memberId: string): Promise<string> {
  const response = await raw("POST", "/api/connector/pairing", { "content-type": "application/json" }, JSON.stringify({ memberId }));
  assert.equal(response.status, 200, response.body);
  const { code } = JSON.parse(response.body) as { code: string };
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return code;
}

type AuthorizeParams = { client_id: string; redirect_uri?: string; code_challenge?: string; code_challenge_method?: string; state?: string; response_type?: string; resource?: string; scope?: string };

function authorizeQuery(params: AuthorizeParams): Record<string, string | undefined> {
  return { response_type: "code", code_challenge_method: "S256", ...params };
}

const ticketOf = (html: string) => html.match(/name="ticket" value="([^"]+)"/)?.[1];

/** Runs the browser part of the flow (pairing code → consent → allow) and returns the redirect. */
async function authorize(params: AuthorizeParams, memberId: string, decision = "allow"): Promise<{ location: URL; consentHtml: string }> {
  const query = authorizeQuery(params);
  const page = await raw("GET", `/oauth/authorize?${form(query)}`, tunnel());
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /Pairing code/);
  const code = await pairingCode(memberId);
  const headers = { ...tunnel(), "content-type": "application/x-www-form-urlencoded" };
  const consent = await raw("POST", "/oauth/authorize", headers, form({ ...query, pairing_code: code.toLowerCase() }));
  assert.equal(consent.status, 200, consent.body);
  const ticket = ticketOf(consent.body);
  assert.ok(ticket, "consent page carries a ticket");
  assert.equal(consent.headers["x-frame-options"], "DENY");
  const done = await raw("POST", "/oauth/authorize", headers, form({ ...query, ticket, decision }));
  assert.equal(done.status, 302, done.body);
  return { location: new URL(String(done.headers.location)), consentHtml: consent.body };
}

async function token(values: Record<string, string | undefined>, headers: Record<string, string> = tunnel()): Promise<{ status: number; json: Record<string, string>; headers: IncomingMessage["headers"] }> {
  const response = await raw("POST", "/oauth/token", { ...headers, "content-type": "application/x-www-form-urlencoded" }, form(values));
  return { status: response.status, json: JSON.parse(response.body) as Record<string, string>, headers: response.headers };
}

async function connectGrok(memberId: string): Promise<{ clientId: string; access: string; refresh: string }> {
  const registered = await register({ client_name: "Grok", redirect_uris: [GROK_REDIRECT], token_endpoint_auth_method: "none" });
  const clientId = String(registered.json.client_id);
  const { verifier, challenge } = pkce();
  const { location } = await authorize({ client_id: clientId, redirect_uri: GROK_REDIRECT, code_challenge: challenge, state: "s1", resource: `${TUNNEL}/mcp` }, memberId);
  const issued = await token({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: GROK_REDIRECT, resource: `${TUNNEL}/mcp` });
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  return { clientId, access: issued.json.access_token!, refresh: issued.json.refresh_token! };
}

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function mcp(accessToken: string, method: string, params: Record<string, unknown> = {}, headers = tunnel()): Promise<Raw & { json?: { result?: Record<string, unknown> } }> {
  const response = await raw("POST", "/mcp", { ...headers, ...MCP_HEADERS, authorization: `Bearer ${accessToken}` }, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return { ...response, json: response.status === 200 ? JSON.parse(response.body) : undefined };
}

async function callTool(accessToken: string, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await mcp(accessToken, "tools/call", { name, arguments: args });
  assert.equal(response.status, 200, response.body);
  const content = response.json!.result!.content as Array<{ text: string }>;
  assert.ok(!response.json!.result!.isError, content[0]?.text);
  return content[0]!.text;
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "gc-oauth-test-"));
  store = new CartStore(join(directory, "test.sqlite"), "test-home", 5000);
  const members = store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }]);
  alex = members.find((member) => member.name === "Alex")!;
  maya = members.find((member) => member.name === "Maya")!;
  setupConnector({ store, demoMode: true, port: 3999, publicUrl: TUNNEL });
  server = startDashboard(store, 0, true);
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("assistantLabel maps client names and redirect hosts", () => {
  assert.equal(assistantLabel("Claude"), "Claude");
  assert.equal(assistantLabel("ChatGPT"), "ChatGPT");
  assert.equal(assistantLabel("OpenAI dots"), "ChatGPT");
  assert.equal(assistantLabel("Grok"), "Grok");
  assert.equal(assistantLabel("MCP client", ["https://chatgpt.com/connector_platform_oauth_redirect"]), "ChatGPT");
  assert.equal(assistantLabel("MCP client", ["https://grok.com/cb"]), "Grok");
  assert.equal(assistantLabel("Some app", ["https://example.com/cb"]), "AI assistant");
});

test("discovery: /mcp 401 points to RFC 9728 metadata; metadata is public through the tunnel", async () => {
  const unauthorized = await raw("POST", "/mcp", { ...tunnel(), ...MCP_HEADERS }, "{}");
  assert.equal(unauthorized.status, 401);
  const challenge = String(unauthorized.headers["www-authenticate"]);
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, new RegExp(`resource_metadata="${TUNNEL}/.well-known/oauth-protected-resource/mcp"`));

  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const response = await raw("GET", path, tunnel());
    assert.equal(response.status, 200);
    const metadata = OAuthProtectedResourceMetadataSchema.parse(JSON.parse(response.body));
    assert.equal(metadata.resource, `${TUNNEL}/mcp`);
    assert.deepEqual(metadata.authorization_servers, [TUNNEL]);
  }
  const as = await raw("GET", "/.well-known/oauth-authorization-server", tunnel());
  assert.equal(as.status, 200);
  const metadata = OAuthMetadataSchema.parse(JSON.parse(as.body));
  assert.equal(metadata.issuer, TUNNEL);
  assert.equal(metadata.authorization_endpoint, `${TUNNEL}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${TUNNEL}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${TUNNEL}/oauth/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
  const local = JSON.parse((await raw("GET", "/.well-known/oauth-authorization-server")).body) as { issuer: string };
  assert.equal(local.issuer, base);
  // A tunnel that rewrites Host to the loopback address still advertises the public origin.
  const rewritten = JSON.parse((await raw("GET", "/.well-known/oauth-authorization-server", { ...tunnel(), host: "127.0.0.1:3000" })).body) as { issuer: string };
  assert.equal(rewritten.issuer, TUNNEL);
});

test("dynamic client registration accepts https and loopback redirects only", async () => {
  const ok = await register({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none" });
  assert.equal(ok.status, 201, ok.body);
  assert.match(String(ok.json.client_id), /^gcl_/);
  assert.equal(ok.json.client_secret, undefined);
  const loopback = await register({ client_name: "Claude Code", redirect_uris: ["http://localhost:53123/callback"], token_endpoint_auth_method: "none" });
  assert.equal(loopback.status, 201);
  const confidential = await register({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" });
  assert.equal(confidential.status, 201);
  assert.match(String(confidential.json.client_secret), /^gcs_/);
  for (const redirect of ["http://evil.example/cb", "myapp://callback", "https://grok.com/cb#frag", "not a url"]) {
    const bad = await register({ client_name: "Bad", redirect_uris: [redirect] });
    assert.equal(bad.status, 400, redirect);
    assert.match(String(bad.json.error), /invalid_redirect_uri|invalid_client_metadata/);
  }
  const badMethod = await register({ client_name: "Bad", redirect_uris: ["https://grok.com/cb"], token_endpoint_auth_method: "private_key_jwt" });
  assert.equal(badMethod.status, 400);
  assert.equal(badMethod.json.error, "invalid_client_metadata");
});

test("full OAuth flow with PKCE: register → pairing code → consent → token → tools → refresh rotation → revoke", async () => {
  const registered = await register({ client_name: "Grok", redirect_uris: [GROK_REDIRECT], token_endpoint_auth_method: "none" });
  const clientId = String(registered.json.client_id);
  const { verifier, challenge } = pkce();
  const { location, consentHtml } = await authorize({ client_id: clientId, redirect_uri: GROK_REDIRECT, code_challenge: challenge, state: "xyz", resource: `${TUNNEL}/mcp` }, maya.id);
  assert.match(consentHtml, /Grok wants to act as Maya in GroupCart/);
  assert.match(consentHtml, /grok\.com/);
  assert.match(consentHtml, /post_to_group/);
  assert.equal(`${location.origin}${location.pathname}`, GROK_REDIRECT);
  assert.equal(location.searchParams.get("state"), "xyz");
  const code = location.searchParams.get("code");
  assert.match(code ?? "", /^gcc_/);

  const issued = await token({ grant_type: "authorization_code", code: code!, code_verifier: verifier, client_id: clientId, redirect_uri: GROK_REDIRECT, resource: `${TUNNEL}/mcp` });
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.equal(issued.json.token_type, "Bearer");
  assert.equal(Number(issued.json.expires_in), 3600);
  assert.match(issued.json.access_token!, /^gca_/);
  assert.match(issued.json.refresh_token!, /^gcr_/);
  assert.equal(issued.headers["cache-control"], "no-store");
  const rows = store.database.prepare("SELECT token_hash FROM connector_oauth_tokens").all() as Array<{ token_hash: string }>;
  assert.ok(!rows.some((row) => row.token_hash === issued.json.access_token || row.token_hash === issued.json.refresh_token), "tokens are stored hashed");

  const list = await mcp(issued.json.access_token!, "tools/list");
  assert.equal(list.status, 200, list.body);
  const names = (list.json!.result!.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(names.includes("add_to_cart") && names.includes("post_to_group"));
  const init = await mcp(issued.json.access_token!, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok", version: "1" } });
  assert.match(String(init.json!.result!.instructions), /connected as Maya \(through Grok\)/);

  await callTool(issued.json.access_token!, "add_to_cart", { request: "eggs" });
  await callTool(issued.json.access_token!, "approve_cart", {});
  await callTool(issued.json.access_token!, "post_to_group", { message: "Movie night Saturday?" });
  const feed = (JSON.parse((await raw("GET", "/api/feed")).body) as { entries: Array<{ text: string }> }).entries.map((entry) => entry.text);
  assert.equal(feed[0], "Maya via Grok: Movie night Saturday?");
  assert.ok(feed.includes("Maya approved the grocery cart via Grok."));

  const status = JSON.parse((await raw("GET", "/api/connector")).body) as { members: Array<{ name: string; connected: boolean; connections: Array<{ grantId: string; via: string; clientName: string; lastUsedAt: string | null }> }> };
  const mayaStatus = status.members.find((member) => member.name === "Maya")!;
  assert.equal(mayaStatus.connected, true);
  assert.equal(mayaStatus.connections.length, 1);
  assert.equal(mayaStatus.connections[0]!.via, "Grok");
  assert.ok(mayaStatus.connections[0]!.lastUsedAt);
  const settings = (await raw("GET", "/settings")).body;
  assert.match(settings, /AI assistants/);
  assert.match(settings, /ChatGPT &amp; dots/);
  assert.ok(!settings.includes(issued.json.access_token!) && !settings.includes(issued.json.refresh_token!));

  // Refresh rotation: a new pair, and the old refresh token can't be used again.
  const refreshed = await token({ grant_type: "refresh_token", refresh_token: issued.json.refresh_token!, client_id: clientId });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.notEqual(refreshed.json.refresh_token, issued.json.refresh_token);
  assert.notEqual(refreshed.json.access_token, issued.json.access_token);
  assert.equal((await mcp(refreshed.json.access_token!, "tools/list")).status, 200);
  const replay = await token({ grant_type: "refresh_token", refresh_token: issued.json.refresh_token!, client_id: clientId });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error, "invalid_grant");
  // Reusing a rotated refresh token is treated as theft: the whole connection is revoked.
  assert.equal((await mcp(refreshed.json.access_token!, "tools/list")).status, 401);
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: refreshed.json.refresh_token!, client_id: clientId })).json.error, "invalid_grant");

  // Revoke from Settings.
  const again = await connectGrok(maya.id);
  assert.equal((await mcp(again.access, "tools/list")).status, 200);
  const grantId = (JSON.parse((await raw("GET", "/api/connector")).body) as typeof status).members.find((member) => member.name === "Maya")!.connections.at(-1)!.grantId;
  const revoked = await raw("POST", "/api/connector/grants/revoke", { "content-type": "application/json" }, JSON.stringify({ grantId }));
  assert.equal(revoked.status, 200);
  assert.equal((await mcp(again.access, "tools/list")).status, 401);
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: again.refresh, client_id: again.clientId })).json.error, "invalid_grant");

  // Revoke through RFC 7009.
  const third = await connectGrok(maya.id);
  const revokeEndpoint = await raw("POST", "/oauth/revoke", { ...tunnel(), "content-type": "application/x-www-form-urlencoded" }, form({ token: third.refresh, client_id: third.clientId }));
  assert.equal(revokeEndpoint.status, 200);
  assert.equal((await mcp(third.access, "tools/list")).status, 401);
});

test("authorize rejects unregistered redirects and requires PKCE S256", async () => {
  const registered = await register({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"], token_endpoint_auth_method: "none" });
  const clientId = String(registered.json.client_id);
  const { challenge } = pkce();
  const badRedirect = await raw("GET", `/oauth/authorize?${form(authorizeQuery({ client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: challenge }))}`, tunnel());
  assert.equal(badRedirect.status, 400);
  assert.equal(badRedirect.headers.location, undefined, "never redirects to an unregistered URI");
  assert.match(badRedirect.body, /didn(&#39;|')t register/);
  const prefix = await raw("GET", `/oauth/authorize?${form(authorizeQuery({ client_id: clientId, redirect_uri: "https://chatgpt.com/cb/extra", code_challenge: challenge }))}`, tunnel());
  assert.equal(prefix.status, 400, "redirect_uri must match exactly");
  const unknown = await raw("GET", `/oauth/authorize?${form(authorizeQuery({ client_id: "gcl_unknown", redirect_uri: "https://chatgpt.com/cb", code_challenge: challenge }))}`, tunnel());
  assert.equal(unknown.status, 400);

  const expectError = async (params: AuthorizeParams, error: string) => {
    const response = await raw("GET", `/oauth/authorize?${form({ response_type: "code", ...params })}`, tunnel());
    assert.equal(response.status, 302, response.body);
    const location = new URL(String(response.headers.location));
    assert.equal(`${location.origin}${location.pathname}`, "https://chatgpt.com/cb");
    assert.equal(location.searchParams.get("error"), error);
    assert.equal(location.searchParams.get("state"), "st");
  };
  await expectError({ client_id: clientId, redirect_uri: "https://chatgpt.com/cb", state: "st" }, "invalid_request");
  await expectError({ client_id: clientId, redirect_uri: "https://chatgpt.com/cb", state: "st", code_challenge: challenge }, "invalid_request");
  await expectError({ client_id: clientId, redirect_uri: "https://chatgpt.com/cb", state: "st", code_challenge: challenge, code_challenge_method: "plain" }, "invalid_request");
  await expectError({ client_id: clientId, redirect_uri: "https://chatgpt.com/cb", state: "st", code_challenge: challenge, code_challenge_method: "S256", response_type: "token" }, "unsupported_response_type");
  await expectError({ client_id: clientId, redirect_uri: "https://chatgpt.com/cb", state: "st", code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/api" }, "invalid_target");
});

test("pairing codes: wrong codes fail, each code works once, and deny returns access_denied", async () => {
  const registered = await register({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"], token_endpoint_auth_method: "none" });
  const { challenge } = pkce();
  const query = authorizeQuery({ client_id: String(registered.json.client_id), redirect_uri: "https://chatgpt.com/cb", code_challenge: challenge, state: "p" });
  const headers = { ...tunnel(), "content-type": "application/x-www-form-urlencoded" };
  const wrong = await raw("POST", "/oauth/authorize", headers, form({ ...query, pairing_code: "ZZZZ-ZZZZ" }));
  assert.equal(wrong.status, 400);
  assert.match(wrong.body, /didn(&#39;|')t work/);
  const code = await pairingCode(alex.id);
  const first = await raw("POST", "/oauth/authorize", headers, form({ ...query, pairing_code: code }));
  assert.equal(first.status, 200);
  assert.match(first.body, /wants to act as Alex/);
  const reused = await raw("POST", "/oauth/authorize", headers, form({ ...query, pairing_code: code }));
  assert.equal(reused.status, 400, "a pairing code works once");
  const ticket = ticketOf(first.body)!;
  const denied = await raw("POST", "/oauth/authorize", headers, form({ ...query, ticket, decision: "deny" }));
  assert.equal(denied.status, 302);
  assert.equal(new URL(String(denied.headers.location)).searchParams.get("error"), "access_denied");
  // Consent must be submitted from GroupCart's own page (same Origin as the Host it was sent to).
  const crossSite = await raw("POST", "/oauth/authorize", { ...headers, origin: "https://evil.example" }, form({ ...query, ticket, decision: "allow" }));
  assert.equal(crossSite.status, 403);
  const nullOrigin = await raw("POST", "/oauth/authorize", { ...headers, origin: "null" }, form({ ...query, ticket, decision: "allow" }));
  assert.equal(nullOrigin.status, 403);
  const replayedTicket = await raw("POST", "/oauth/authorize", headers, form({ ...query, ticket, decision: "allow" }));
  assert.equal(replayedTicket.status, 400, "a consent ticket works once");
  // A ticket is bound to the request it was issued for.
  const fresh = await raw("POST", "/oauth/authorize", { ...headers, origin: TUNNEL }, form({ ...query, pairing_code: await pairingCode(alex.id) }));
  assert.equal(fresh.status, 200, "same-origin form posts are accepted");
  const tampered = await raw("POST", "/oauth/authorize", headers, form({ ...query, state: "other", ticket: ticketOf(fresh.body)!, decision: "allow" }));
  assert.equal(tampered.status, 400);
  // Pairing codes expire.
  const stale = await pairingCode(maya.id);
  store.database.prepare("UPDATE connector_pairing_codes SET expires_at = ?").run(Date.now() - 1);
  assert.equal((await raw("POST", "/oauth/authorize", headers, form({ ...query, pairing_code: stale }))).status, 400);
});

test("token endpoint: wrong verifier, missing verifier, redirect mismatch, expired code, and code reuse", async () => {
  const registered = await register({ client_name: "Grok", redirect_uris: [GROK_REDIRECT], token_endpoint_auth_method: "none" });
  const clientId = String(registered.json.client_id);
  const flow = async () => {
    const { verifier, challenge } = pkce();
    const { location } = await authorize({ client_id: clientId, redirect_uri: GROK_REDIRECT, code_challenge: challenge, state: "t" }, alex.id);
    return { verifier, code: location.searchParams.get("code")! };
  };
  const one = await flow();
  const wrongVerifier = await token({ grant_type: "authorization_code", code: one.code, code_verifier: pkce().verifier, client_id: clientId, redirect_uri: GROK_REDIRECT });
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.json.error, "invalid_grant");
  const noVerifier = await token({ grant_type: "authorization_code", code: one.code, client_id: clientId, redirect_uri: GROK_REDIRECT });
  assert.equal(noVerifier.json.error, "invalid_request");
  const wrongRedirect = await token({ grant_type: "authorization_code", code: one.code, code_verifier: one.verifier, client_id: clientId, redirect_uri: "https://grok.com/other" });
  assert.equal(wrongRedirect.json.error, "invalid_grant");

  // Expired code.
  const two = await flow();
  store.database.prepare("UPDATE connector_oauth_codes SET expires_at = ? WHERE used_at IS NULL").run(Date.now() - 1);
  const expired = await token({ grant_type: "authorization_code", code: two.code, code_verifier: two.verifier, client_id: clientId, redirect_uri: GROK_REDIRECT });
  assert.equal(expired.status, 400);
  assert.equal(expired.json.error, "invalid_grant");
  assert.match(expired.json.error_description!, /expired/);

  // Reused code: the second exchange fails and revokes what the first one produced.
  const three = await flow();
  const firstUse = await token({ grant_type: "authorization_code", code: three.code, code_verifier: three.verifier, client_id: clientId, redirect_uri: GROK_REDIRECT });
  assert.equal(firstUse.status, 200);
  assert.equal((await mcp(firstUse.json.access_token!, "tools/list")).status, 200);
  const secondUse = await token({ grant_type: "authorization_code", code: three.code, code_verifier: three.verifier, client_id: clientId, redirect_uri: GROK_REDIRECT });
  assert.equal(secondUse.status, 400);
  assert.equal(secondUse.json.error, "invalid_grant");
  assert.equal((await mcp(firstUse.json.access_token!, "tools/list")).status, 401);

  // Another client can't redeem this client's code.
  const four = await flow();
  const other = await register({ client_name: "Other", redirect_uris: [GROK_REDIRECT], token_endpoint_auth_method: "none" });
  const stolen = await token({ grant_type: "authorization_code", code: four.code, code_verifier: four.verifier, client_id: String(other.json.client_id), redirect_uri: GROK_REDIRECT });
  assert.equal(stolen.json.error, "invalid_grant");
  assert.equal((await token({ grant_type: "password", client_id: clientId })).json.error, "unsupported_grant_type");
});

test("confidential clients must authenticate with their secret (post or basic)", async () => {
  for (const method of ["client_secret_post", "client_secret_basic"]) {
    const registered = await register({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"], token_endpoint_auth_method: method });
    const clientId = String(registered.json.client_id);
    const secret = String(registered.json.client_secret);
    const { verifier, challenge } = pkce();
    const { location } = await authorize({ client_id: clientId, redirect_uri: "https://chatgpt.com/cb", code_challenge: challenge }, alex.id);
    const values = { grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, redirect_uri: "https://chatgpt.com/cb" };
    const noSecret = await token({ ...values, client_id: clientId });
    assert.equal(noSecret.status, 401);
    assert.equal(noSecret.json.error, "invalid_client");
    const badSecret = await token({ ...values, client_id: clientId, client_secret: "gcs_wrong" });
    assert.equal(badSecret.status, 401);
    const ok = method === "client_secret_post"
      ? await token({ ...values, client_id: clientId, client_secret: secret })
      : await token(values, { ...tunnel(), authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}` });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const posted = await callTool(ok.json.access_token!, "post_to_group", { message: "hi" });
    assert.match(posted, /Alex via ChatGPT: hi/);
  }
});

test("a signed-in web session skips the pairing code", async () => {
  const registered = await register({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
  const { challenge } = pkce();
  const query = form(authorizeQuery({ client_id: String(registered.json.client_id), redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge }));
  setRemoteAuthorizer((_request, url) => url.pathname === "/oauth/authorize");
  setRequestMemberResolver(() => ({ memberId: alex.id }));
  try {
    const page = await raw("GET", `/oauth/authorize?${query}`, tunnel());
    assert.equal(page.status, 200);
    assert.match(page.body, /Claude wants to act as Alex in GroupCart/);
  } finally {
    setRemoteAuthorizer(null);
    setRequestMemberResolver(null);
  }
  // Without the authorizer a remote session is ignored and the pairing code is required.
  setRequestMemberResolver(() => ({ memberId: alex.id }));
  try {
    assert.match((await raw("GET", `/oauth/authorize?${query}`, tunnel())).body, /Pairing code/);
  } finally {
    setRequestMemberResolver(null);
  }
});

test("tunnel guard: OAuth and metadata are public, everything else still 404s", async () => {
  for (const path of ["/", "/settings", "/api/cart", "/api/feed", "/api/connector", "/.well-known/openid-configuration", "/oauth/unknown", "/api/google/oauth/start"]) {
    assert.equal((await raw("GET", path, tunnel())).status, 404, path);
  }
  for (const path of ["/api/connector/pairing", "/api/connector/tokens", "/api/connector/grants/revoke", "/api/demo-message"]) {
    assert.equal((await raw("POST", path, { ...tunnel(), "content-type": "application/json" }, JSON.stringify({ memberId: alex.id }))).status, 404, path);
  }
  assert.equal((await raw("GET", "/.well-known/oauth-authorization-server", tunnel())).status, 200);
  assert.equal((await raw("GET", "/oauth/authorize?client_id=x", tunnel())).status, 400);
  assert.equal((await raw("GET", "/oauth/token", tunnel())).status, 405);
});

test("MCP SDK client completes discovery, registration, PKCE, and token exchange against GroupCart", async () => {
  const serverUrl = `${base}/mcp`;
  let clientInfo: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = "";
  let authorizationUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    get redirectUrl() { return "http://127.0.0.1:43210/callback"; },
    get clientMetadata() {
      return { client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:43210/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    },
    clientInformation: () => clientInfo,
    saveClientInformation: (info) => { clientInfo = info; },
    tokens: () => tokens,
    saveTokens: (saved) => { tokens = saved; },
    redirectToAuthorization: (url) => { authorizationUrl = url; },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier,
  };
  assert.equal(await auth(provider, { serverUrl }), "REDIRECT");
  assert.ok(authorizationUrl && clientInfo);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  // Play the browser: pairing code, then Allow.
  const params = Object.fromEntries(authorizationUrl.searchParams) as Record<string, string>;
  const local = { "content-type": "application/x-www-form-urlencoded" };
  const consent = await raw("POST", "/oauth/authorize", local, form({ ...params, pairing_code: await pairingCode(alex.id) }));
  assert.match(consent.body, /Claude Code wants to act as Alex/);
  const done = await raw("POST", "/oauth/authorize", local, form({ ...params, ticket: ticketOf(consent.body)!, decision: "allow" }));
  const code = new URL(String(done.headers.location)).searchParams.get("code")!;
  assert.equal(await auth(provider, { serverUrl, authorizationCode: code }), "AUTHORIZED");
  assert.match(tokens!.access_token, /^gca_/);
  const client = new Client({ name: "sdk-oauth-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider }));
  try {
    assert.match(client.getInstructions() ?? "", /connected as Alex \(through Claude\)/);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "whats_on_my_plate"));
  } finally {
    await client.close();
  }
});
