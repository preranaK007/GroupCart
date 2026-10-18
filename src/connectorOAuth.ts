// OAuth 2.1 authorization for the connector's /mcp endpoint, for hosted assistants that expect OAuth
// (ChatGPT and dots, Grok, claude.ai). It sits alongside the per-member bearer/secret-path tokens.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 protected resource metadata
//   GET  /.well-known/oauth-authorization-server       RFC 8414 authorization server metadata
//   POST /oauth/register                               RFC 7591 dynamic client registration
//   GET|POST /oauth/authorize                          authorization code flow, PKCE S256 required. The
//                                                      roommate signs in with a one-time pairing code made in
//                                                      Settings (or a web session), then approves on a consent page
//   POST /oauth/token                                  authorization_code and refresh_token grants
//   POST /oauth/revoke                                 RFC 7009 token revocation
//
// Access tokens last 1 hour; refresh tokens last 30 days and rotate on every use (presenting a rotated
// one revokes the whole connection). Codes, tokens, client secrets, and pairing codes are stored only as
// SHA-256 hashes. Redirect URIs must be https (http only on loopback) and must match a registered URI
// exactly. These routes are reachable through a tunnel (see src/remoteAccess.ts).
import { createHash, randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { OAuthClientMetadataSchema, type OAuthMetadata, type OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { FailedAuthLimiter, clientKey, headerValue, randomSecret, readBody, readParams, safeEqual, sendJson, sha256Hex } from "./connectorSecurity.js";
import { isRemoteAuthorized, listTools, requestMember } from "./platform.js";
import { hostNameOf, isRemoteRequest } from "./remoteAccess.js";
import type { CartStore } from "./store.js";
import { renderConsentPage, renderOAuthErrorPage, renderPairingPage, type AuthorizeFields } from "./ui/oauthPages.js";

export const OAUTH_SCOPE = "groupcart";
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
export const PAIRING_TTL_MS = 10 * 60_000;
const CONSENT_TTL_MS = 10 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

type ClientRow = {
  client_id: string; client_secret_hash: string | null; auth_method: string; client_name: string;
  redirect_uris_json: string; created_at: string;
};
type OAuthClient = { id: string; name: string; authMethod: string; secretHash: string | null; redirectUris: string[] };
type CodeRow = {
  client_id: string; member_id: string; redirect_uri: string; code_challenge: string; resource: string | null;
  expires_at: number; used_at: number | null; grant_id: string | null;
};
type Consent = { memberId: string; clientId: string; redirectUri: string; codeChallenge: string; state: string | undefined; resource: string | undefined; expiresAt: number };
type TokenResponse = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string };
type Failure = { ok: false; status: number; error: string; description: string };

export type AccessCheck =
  | { status: "valid"; memberId: string; via: string; grantId: string }
  | { status: "expired" }
  | { status: "invalid" };

export type OAuthConnection = {
  grantId: string;
  memberId: string;
  clientName: string;
  via: string;
  redirectHost: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/** "Claude", "ChatGPT", "Grok", or "AI assistant", from the client name, then its redirect hosts. */
export function assistantLabel(clientName: string, redirectUris: readonly string[] = []): string {
  const match = (text: string): string | null => {
    if (/claude|anthropic/i.test(text)) return "Claude";
    if (/chatgpt|openai|\bdots?\b/i.test(text)) return "ChatGPT";
    if (/grok|\bx\.ai\b|(^|\.)x\.com$/i.test(text)) return "Grok";
    return null;
  };
  const byName = match(clientName);
  if (byName) return byName;
  for (const uri of redirectUris) {
    try {
      const byHost = match(new URL(uri).hostname);
      if (byHost) return byHost;
    } catch {
      // ignore malformed stored URI
    }
  }
  return "AI assistant";
}

/** Allowed redirect URI: absolute, no fragment, https, or http on a loopback host. */
export function isAllowedRedirectUri(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/**
 * Origin the client used to reach GroupCart: the tunnel's https origin, or the loopback origin. When a
 * proxy rewrote Host to a loopback address, the configured public origin (GROUP_CART_PUBLIC_URL) is used.
 */
export function requestOrigin(request: IncomingMessage, publicOrigin: string | null = null): string {
  const forwardedHost = headerValue(request, "x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = forwardedHost && hostNameOf(forwardedHost) ? forwardedHost : request.headers.host;
  const host = (hostHeader && hostNameOf(hostHeader) ? hostHeader : "127.0.0.1").toLowerCase();
  if (!isRemoteRequest(request)) return `http://${host}`;
  if (publicOrigin && LOOPBACK_HOSTS.has(hostNameOf(host) ?? "")) return publicOrigin;
  const proto = headerValue(request, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https" || proto === "http") return `${proto}://${host}`;
  const proxied = Boolean(headerValue(request, "cf-connecting-ip") || headerValue(request, "x-forwarded-for") || headerValue(request, "forwarded"));
  return `${proxied ? "https" : "http"}://${host}`;
}

export function resourceMetadataUrl(request: IncomingMessage, publicOrigin: string | null = null): string {
  return `${requestOrigin(request, publicOrigin)}/.well-known/oauth-protected-resource/mcp`;
}

/** Origin of a non-loopback public URL (e.g. the tunnel in GROUP_CART_PUBLIC_URL), or null. */
export function publicOriginOf(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const parsed = new URL(publicUrl);
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ? null : parsed.origin;
  } catch {
    return null;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cleanName(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  // same-origin (not no-referrer) so the forms' POSTs carry a real Origin header for the same-origin check.
  "referrer-policy": "same-origin",
};

function sendPage(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, PAGE_HEADERS);
  response.end(html);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  response.end();
}

function errorRedirectUrl(redirectUri: string, error: string, description: string, state: string | undefined): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state !== undefined) target.searchParams.set("state", state);
  return target.toString();
}

type Validated =
  | { kind: "ok"; client: OAuthClient; fields: AuthorizeFields }
  | { kind: "page"; status: number; title: string; message: string }
  | { kind: "redirect"; location: string };

export class ConnectorOAuth {
  readonly #consents = new Map<string, Consent>();
  readonly #pairingLimiter = new FailedAuthLimiter(10, 100, 15 * 60_000, "pairing code");
  readonly #tokenLimiter = new FailedAuthLimiter(30, 300, 15 * 60_000, "OAuth token");
  readonly #registrationLimiter = new FailedAuthLimiter(20, 100, 60 * 60_000, "client registration");

  readonly #publicOrigin: string | null;

  constructor(private readonly db: DatabaseSync, private readonly store: CartStore, publicUrl?: string) {
    this.#publicOrigin = publicOriginOf(publicUrl);
    db.exec(`
      CREATE TABLE IF NOT EXISTS connector_oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        auth_method TEXT NOT NULL,
        client_name TEXT NOT NULL,
        redirect_uris_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_oauth_grants (
        grant_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS connector_oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        grant_id TEXT
      );
      CREATE TABLE IF NOT EXISTS connector_oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        rotated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS connector_oauth_tokens_grant ON connector_oauth_tokens (grant_id);
      CREATE TABLE IF NOT EXISTS connector_pairing_codes (
        member_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------------------
  // Pairing codes (made in Settings on the host computer)

  /** New one-time pairing code for the member (replaces any earlier one). Format "ABCD-EFGH". */
  issuePairingCode(memberId: string, now = Date.now()): { code: string; expiresAt: string } {
    let raw = "";
    for (let index = 0; index < 8; index += 1) raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
    this.db.prepare(
      "INSERT INTO connector_pairing_codes (member_id, code_hash, expires_at) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at",
    ).run(memberId, sha256Hex(raw), now + PAIRING_TTL_MS);
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() };
  }

  /** Active pairing codes by member id → expiry (ISO). */
  pairingExpiries(now = Date.now()): Map<string, string> {
    const rows = this.db.prepare("SELECT member_id, expires_at FROM connector_pairing_codes WHERE expires_at > ?").all(now) as Array<{ member_id: string; expires_at: number }>;
    return new Map(rows.map((row) => [row.member_id, new Date(row.expires_at).toISOString()]));
  }

  #consumePairingCode(input: string, now: number): string | undefined {
    const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (raw.length !== 8) return undefined;
    const hash = sha256Hex(raw);
    const row = this.db.prepare("SELECT member_id, expires_at FROM connector_pairing_codes WHERE code_hash = ?").get(hash) as { member_id: string; expires_at: number } | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM connector_pairing_codes WHERE code_hash = ?").run(hash);
    return row.expires_at > now ? row.member_id : undefined;
  }

  // -------------------------------------------------------------------------
  // Clients, grants, tokens

  #client(clientId: string | undefined): OAuthClient | undefined {
    if (!clientId) return undefined;
    const row = this.db.prepare("SELECT * FROM connector_oauth_clients WHERE client_id = ?").get(clientId) as ClientRow | undefined;
    return row ? {
      id: row.client_id,
      name: row.client_name,
      authMethod: row.auth_method,
      secretHash: row.client_secret_hash,
      redirectUris: JSON.parse(row.redirect_uris_json) as string[],
    } : undefined;
  }

  #member(memberId: string): { id: string; name: string } | undefined {
    return this.store.getMembers().find((member) => member.id === memberId);
  }

  /** Checks an OAuth access token presented at /mcp. */
  verifyAccessToken(token: string, now = Date.now()): AccessCheck {
    if (!/^gca_[A-Za-z0-9_-]{43}$/.test(token)) return { status: "invalid" };
    const row = this.db.prepare(`
      SELECT t.expires_at, g.grant_id, g.member_id, c.client_name, c.redirect_uris_json
      FROM connector_oauth_tokens t
      JOIN connector_oauth_grants g ON g.grant_id = t.grant_id
      JOIN connector_oauth_clients c ON c.client_id = g.client_id
      WHERE t.token_hash = ? AND t.kind = 'access'
    `).get(sha256Hex(token)) as { expires_at: number; grant_id: string; member_id: string; client_name: string; redirect_uris_json: string } | undefined;
    if (!row) return { status: "invalid" };
    if (row.expires_at <= now) return { status: "expired" };
    this.db.prepare("UPDATE connector_oauth_grants SET last_used_at = ? WHERE grant_id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
      .run(new Date(now).toISOString(), row.grant_id, new Date(now - TOUCH_INTERVAL_MS).toISOString());
    return { status: "valid", memberId: row.member_id, via: assistantLabel(row.client_name, JSON.parse(row.redirect_uris_json) as string[]), grantId: row.grant_id };
  }

  /** Every connected OAuth app, for the Settings card. */
  connections(): OAuthConnection[] {
    const rows = this.db.prepare(`
      SELECT g.grant_id, g.member_id, g.created_at, g.last_used_at, c.client_name, c.redirect_uris_json
      FROM connector_oauth_grants g JOIN connector_oauth_clients c ON c.client_id = g.client_id
      ORDER BY g.created_at
    `).all() as Array<{ grant_id: string; member_id: string; created_at: string; last_used_at: string | null; client_name: string; redirect_uris_json: string }>;
    return rows.map((row) => {
      const uris = JSON.parse(row.redirect_uris_json) as string[];
      let redirectHost = "";
      try { redirectHost = uris[0] ? new URL(uris[0]).host : ""; } catch { redirectHost = ""; }
      return {
        grantId: row.grant_id,
        memberId: row.member_id,
        clientName: row.client_name,
        via: assistantLabel(row.client_name, uris),
        redirectHost,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      };
    });
  }

  /** Disconnects one app: deletes the grant and all of its tokens. */
  revokeGrant(grantId: string): boolean {
    this.db.prepare("DELETE FROM connector_oauth_tokens WHERE grant_id = ?").run(grantId);
    return Number(this.db.prepare("DELETE FROM connector_oauth_grants WHERE grant_id = ?").run(grantId).changes) > 0;
  }

  /** Disconnects every app a member has connected (e.g. when they leave the household). */
  revokeMember(memberId: string): void {
    for (const connection of this.connections().filter((entry) => entry.memberId === memberId)) this.revokeGrant(connection.grantId);
  }

  #issueTokens(grantId: string, now: number): TokenResponse {
    this.db.prepare("DELETE FROM connector_oauth_tokens WHERE expires_at < ?").run(now);
    const accessToken = randomSecret("gca_");
    const refreshToken = randomSecret("gcr_");
    const insert = this.db.prepare("INSERT INTO connector_oauth_tokens (token_hash, grant_id, kind, expires_at, rotated_at) VALUES (?, ?, ?, ?, NULL)");
    insert.run(sha256Hex(accessToken), grantId, "access", now + ACCESS_TTL_MS);
    insert.run(sha256Hex(refreshToken), grantId, "refresh", now + REFRESH_TTL_MS);
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken, scope: OAUTH_SCOPE };
  }

  // -------------------------------------------------------------------------
  // HTTP

  /** Handles /.well-known/oauth-* and /oauth/*; returns false for anything else. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      if (request.method !== "GET" && request.method !== "HEAD") { this.#methodNotAllowed(response, "GET"); return true; }
      sendJson(response, 200, this.#protectedResourceMetadata(requestOrigin(request, this.#publicOrigin)), { "access-control-allow-origin": "*" });
      return true;
    }
    if (path === "/.well-known/oauth-authorization-server") {
      if (request.method !== "GET" && request.method !== "HEAD") { this.#methodNotAllowed(response, "GET"); return true; }
      sendJson(response, 200, this.#authorizationServerMetadata(requestOrigin(request, this.#publicOrigin)), { "access-control-allow-origin": "*" });
      return true;
    }
    if (!path.startsWith("/oauth/")) return false;
    try {
      if (path === "/oauth/register") {
        if (request.method !== "POST") { this.#methodNotAllowed(response, "POST"); return true; }
        await this.#register(request, response);
      } else if (path === "/oauth/authorize") {
        if (request.method === "GET") this.#authorizeGet(request, response, url);
        else if (request.method === "POST") await this.#authorizePost(request, response, url);
        else this.#methodNotAllowed(response, "GET, POST");
      } else if (path === "/oauth/token") {
        if (request.method !== "POST") { this.#methodNotAllowed(response, "POST"); return true; }
        await this.#token(request, response);
      } else if (path === "/oauth/revoke") {
        if (request.method !== "POST") { this.#methodNotAllowed(response, "POST"); return true; }
        await this.#revoke(request, response);
      } else {
        sendJson(response, 404, { error: "Not found." });
      }
    } catch (error) {
      console.warn(`Connector OAuth request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      if (!response.headersSent) sendJson(response, 400, { error: "invalid_request", error_description: "The request could not be read." });
    }
    return true;
  }

  #methodNotAllowed(response: ServerResponse, allow: string): void {
    sendJson(response, 405, { error: "invalid_request", error_description: "Method not allowed." }, { allow });
  }

  #protectedResourceMetadata(origin: string): OAuthProtectedResourceMetadata {
    return {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "GroupCart",
    };
  }

  #authorizationServerMetadata(origin: string): OAuthMetadata {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      scopes_supported: [OAUTH_SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      code_challenge_methods_supported: ["S256"],
    };
  }

  // --- RFC 7591 dynamic client registration --------------------------------

  async #register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const key = clientKey(request);
    if (this.#registrationLimiter.retryAfterMs(key) > 0) {
      return sendJson(response, 429, { error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." });
    }
    this.#registrationLimiter.recordFailure(key);
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request, 16_384));
    } catch {
      return sendJson(response, 400, { error: "invalid_client_metadata", error_description: "Send the client metadata as JSON." });
    }
    const parsed = OAuthClientMetadataSchema.safeParse(body);
    if (!parsed.success) {
      return sendJson(response, 400, { error: "invalid_client_metadata", error_description: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ").slice(0, 300) });
    }
    const metadata = parsed.data;
    const redirectUris = [...new Set(metadata.redirect_uris.map(String))];
    if (!redirectUris.length || redirectUris.length > 10 || redirectUris.some((uri) => uri.length > 2_000 || !isAllowedRedirectUri(uri))) {
      return sendJson(response, 400, { error: "invalid_redirect_uri", error_description: "Redirect URIs must be https (or http on localhost/127.0.0.1) with no fragment." });
    }
    const authMethod = metadata.token_endpoint_auth_method ?? "client_secret_basic";
    if (!AUTH_METHODS.includes(authMethod)) {
      return sendJson(response, 400, { error: "invalid_client_metadata", error_description: `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}.` });
    }
    const grantTypes = metadata.grant_types ?? ["authorization_code", "refresh_token"];
    if (!grantTypes.includes("authorization_code") || grantTypes.some((type) => type !== "authorization_code" && type !== "refresh_token")) {
      return sendJson(response, 400, { error: "invalid_client_metadata", error_description: "grant_types may only be authorization_code and refresh_token." });
    }
    const responseTypes = metadata.response_types ?? ["code"];
    if (responseTypes.some((type) => type !== "code")) {
      return sendJson(response, 400, { error: "invalid_client_metadata", error_description: "response_types may only be code." });
    }
    const clientName = cleanName(metadata.client_name) || "AI assistant";
    const clientId = randomSecret("gcl_", 16);
    const clientSecret = authMethod === "none" ? undefined : randomSecret("gcs_");
    const now = Date.now();
    // Drop registrations that never connected anyone after a week.
    this.db.prepare("DELETE FROM connector_oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM connector_oauth_grants)")
      .run(new Date(now - 7 * 24 * 60 * 60_000).toISOString());
    this.db.prepare(
      "INSERT INTO connector_oauth_clients (client_id, client_secret_hash, auth_method, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(clientId, clientSecret ? sha256Hex(clientSecret) : null, authMethod, clientName, JSON.stringify(redirectUris), new Date(now).toISOString());
    console.log(`Connector OAuth: registered client "${clientName}".`);
    sendJson(response, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: authMethod,
      scope: OAUTH_SCOPE,
    });
  }

  // --- Authorization endpoint ----------------------------------------------

  #validateAuthorize(params: Record<string, unknown>): Validated {
    const client = this.#client(text(params.client_id));
    if (!client) {
      return { kind: "page", status: 400, title: "Unknown app", message: "This app isn't registered with GroupCart. Remove the GroupCart connector in your assistant and add it again." };
    }
    const requested = text(params.redirect_uri);
    const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { kind: "page", status: 400, title: "Redirect not allowed", message: "The app asked GroupCart to send you to an address it didn't register, so GroupCart stopped here." };
    }
    const state = text(params.state);
    const fail = (error: string, description: string): Validated => ({ kind: "redirect", location: errorRedirectUrl(redirectUri, error, description, state) });
    if (state !== undefined && state.length > 2_048) return fail("invalid_request", "state is too long.");
    if (text(params.response_type) !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const codeChallenge = text(params.code_challenge);
    if (!codeChallenge) return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
    if (text(params.code_challenge_method) !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
    if (!PKCE_VALUE.test(codeChallenge)) return fail("invalid_request", "code_challenge is malformed.");
    const resource = text(params.resource);
    if (resource !== undefined) {
      let valid = false;
      try { valid = /^\/mcp\/?$/.test(new URL(resource).pathname); } catch { valid = false; }
      if (!valid) return fail("invalid_target", "resource must be this GroupCart's /mcp URL.");
    }
    return {
      kind: "ok",
      client,
      fields: {
        client_id: client.id,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        ...(state !== undefined ? { state } : {}),
        ...(resource !== undefined ? { resource } : {}),
        scope: OAUTH_SCOPE,
      },
    };
  }

  #respondInvalid(response: ServerResponse, result: Exclude<Validated, { kind: "ok" }>): void {
    if (result.kind === "redirect") return redirect(response, result.location);
    sendPage(response, result.status, renderOAuthErrorPage({ title: result.title, message: result.message }));
  }

  #consentPage(response: ServerResponse, client: OAuthClient, fields: AuthorizeFields, memberId: string, fromSession = false): void {
    const member = this.#member(memberId);
    if (!member) return sendPage(response, 400, renderOAuthErrorPage({ title: "Member not found", message: "That household member isn't in GroupCart anymore." }));
    const now = Date.now();
    for (const [key, consent] of this.#consents) if (consent.expiresAt <= now) this.#consents.delete(key);
    if (this.#consents.size > 1_000) this.#consents.clear();
    const ticket = randomSecret("gck_", 24);
    this.#consents.set(sha256Hex(ticket), {
      memberId: member.id, clientId: client.id, redirectUri: fields.redirect_uri, codeChallenge: fields.code_challenge,
      state: fields.state, resource: fields.resource, expiresAt: now + CONSENT_TTL_MS,
    });
    let redirectHost = fields.redirect_uri;
    try { redirectHost = new URL(fields.redirect_uri).host; } catch { /* keep raw */ }
    sendPage(response, 200, renderConsentPage({
      fields,
      ticket,
      clientName: client.name,
      via: assistantLabel(client.name, client.redirectUris),
      memberName: member.name,
      redirectHost,
      tools: listTools().map((tool) => ({ name: tool.name, description: tool.description, mutates: Boolean(tool.mutates) })),
      fromSession,
    }));
  }

  #sessionMember(request: IncomingMessage, url: URL): string | undefined {
    if (isRemoteRequest(request) && !isRemoteAuthorized(request, url)) return undefined;
    const signedIn = requestMember(request);
    return signedIn && this.#member(signedIn.memberId) ? signedIn.memberId : undefined;
  }

  #authorizeGet(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const result = this.#validateAuthorize(Object.fromEntries(url.searchParams));
    if (result.kind !== "ok") return this.#respondInvalid(response, result);
    const memberId = this.#sessionMember(request, url);
    if (memberId) return this.#consentPage(response, result.client, result.fields, memberId, true);
    sendPage(response, 200, renderPairingPage({ fields: result.fields, clientName: result.client.name }));
  }

  async #authorizePost(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    // Browsers send Origin on form POSTs; only GroupCart's own sign-in pages may submit here.
    if (!this.#sameOriginPost(request)) {
      return sendPage(response, 403, renderOAuthErrorPage({ title: "Request blocked", message: "This sign-in form was submitted from another site, so GroupCart ignored it. Start connecting again from your assistant." }));
    }
    const params = await readParams(request, 16_384);
    const result = this.#validateAuthorize(params);
    if (result.kind !== "ok") return this.#respondInvalid(response, result);
    const { client, fields } = result;
    const ticket = text(params.ticket);
    if (ticket) {
      const key = sha256Hex(ticket);
      const consent = this.#consents.get(key);
      this.#consents.delete(key);
      const matches = consent && consent.expiresAt > Date.now() && consent.clientId === client.id && consent.redirectUri === fields.redirect_uri
        && consent.codeChallenge === fields.code_challenge && consent.state === fields.state && consent.resource === fields.resource;
      if (!consent || !matches) {
        return sendPage(response, 400, renderOAuthErrorPage({ title: "Sign-in expired", message: "This approval page expired or was already used. Start connecting again from your assistant." }));
      }
      if (text(params.decision) !== "allow") {
        return redirect(response, errorRedirectUrl(fields.redirect_uri, "access_denied", "The household member declined.", fields.state));
      }
      const code = randomSecret("gcc_");
      this.db.prepare(
        "INSERT INTO connector_oauth_codes (code_hash, client_id, member_id, redirect_uri, code_challenge, resource, expires_at, used_at, grant_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
      ).run(sha256Hex(code), client.id, consent.memberId, fields.redirect_uri, fields.code_challenge, fields.resource ?? null, Date.now() + CODE_TTL_MS);
      this.db.prepare("DELETE FROM connector_oauth_codes WHERE expires_at < ?").run(Date.now() - 24 * 60 * 60_000);
      const target = new URL(fields.redirect_uri);
      target.searchParams.set("code", code);
      if (fields.state !== undefined) target.searchParams.set("state", fields.state);
      return redirect(response, target.toString());
    }
    if (text(params.use_pairing) === "1") return sendPage(response, 200, renderPairingPage({ fields, clientName: client.name }));
    const sessionMemberId = this.#sessionMember(request, url);
    const pairingCode = text(params.pairing_code);
    if (pairingCode === undefined) {
      if (sessionMemberId) return this.#consentPage(response, client, fields, sessionMemberId, true);
      return sendPage(response, 200, renderPairingPage({ fields, clientName: client.name }));
    }
    const limitKey = clientKey(request);
    if (this.#pairingLimiter.retryAfterMs(limitKey) > 0) {
      return sendPage(response, 429, renderPairingPage({ fields, clientName: client.name, error: "Too many tries. Wait a few minutes, then make a new pairing code." }));
    }
    const memberId = this.#consumePairingCode(pairingCode, Date.now());
    if (!memberId || !this.#member(memberId)) {
      this.#pairingLimiter.recordFailure(limitKey);
      return sendPage(response, 400, renderPairingPage({ fields, clientName: client.name, error: "That code didn't work. Codes work once and expire after 10 minutes; make a new one in GroupCart Settings." }));
    }
    this.#consentPage(response, client, fields, memberId);
  }

  // --- Token and revocation endpoints --------------------------------------

  /** True without an Origin header (non-browser), or when it names the Host, forwarded host, or public URL. */
  #sameOriginPost(request: IncomingMessage): boolean {
    const origin = headerValue(request, "origin");
    if (origin === undefined) return true;
    let host: string;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    const allowed = [request.headers.host, headerValue(request, "x-forwarded-host")?.split(",")[0]?.trim(), this.#publicOrigin ? new URL(this.#publicOrigin).host : undefined];
    return allowed.some((candidate) => candidate !== undefined && candidate.toLowerCase() === host);
  }

  #authenticateClient(request: IncomingMessage, params: Record<string, unknown>): { ok: true; client: OAuthClient } | { ok: false; basic: boolean } {
    let clientId = text(params.client_id);
    let secret = text(params.client_secret);
    const basic = headerValue(request, "authorization")?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) return { ok: false, basic: true };
      try {
        const basicId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
        if (clientId && clientId !== basicId) return { ok: false, basic: true };
        clientId = basicId;
        secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
      } catch {
        return { ok: false, basic: true };
      }
    }
    const client = this.#client(clientId);
    if (!client) return { ok: false, basic: Boolean(basic) };
    if (client.authMethod !== "none" && !(secret && client.secretHash && safeEqual(sha256Hex(secret), client.secretHash))) {
      return { ok: false, basic: Boolean(basic) };
    }
    return { ok: true, client };
  }

  #exchangeCode(client: OAuthClient, params: Record<string, unknown>, now: number): TokenResponse | Failure {
    const invalid = (description: string): Failure => ({ ok: false, status: 400, error: "invalid_grant", description });
    const code = text(params.code);
    const verifier = text(params.code_verifier);
    if (!code) return { ok: false, status: 400, error: "invalid_request", description: "code is required." };
    if (!verifier) return { ok: false, status: 400, error: "invalid_request", description: "code_verifier is required (PKCE)." };
    const hash = sha256Hex(code);
    const row = this.db.prepare("SELECT * FROM connector_oauth_codes WHERE code_hash = ?").get(hash) as CodeRow | undefined;
    if (!row || row.client_id !== client.id) return invalid("Unknown authorization code.");
    if (row.used_at !== null) {
      // A replayed code may have been stolen: disconnect whatever it produced.
      if (row.grant_id) this.revokeGrant(row.grant_id);
      return invalid("This authorization code was already used.");
    }
    if (row.expires_at <= now) return invalid("This authorization code expired.");
    const redirectUri = text(params.redirect_uri);
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) return invalid("redirect_uri doesn't match the authorization request.");
    if (!PKCE_VALUE.test(verifier) || !safeEqual(pkceChallenge(verifier), row.code_challenge)) return invalid("code_verifier doesn't match the code_challenge.");
    const resource = text(params.resource);
    if (resource !== undefined && row.resource !== null && resource !== row.resource) {
      return { ok: false, status: 400, error: "invalid_target", description: "resource doesn't match the authorization request." };
    }
    if (!this.#member(row.member_id)) return invalid("That household member isn't in GroupCart anymore.");
    // One connection per app and member: a new sign-in replaces the old one.
    const previous = this.db.prepare("SELECT grant_id FROM connector_oauth_grants WHERE client_id = ? AND member_id = ?").all(client.id, row.member_id) as Array<{ grant_id: string }>;
    for (const { grant_id } of previous) this.revokeGrant(grant_id);
    const grantId = randomSecret("", 12);
    this.db.prepare("INSERT INTO connector_oauth_grants (grant_id, client_id, member_id, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)")
      .run(grantId, client.id, row.member_id, new Date(now).toISOString());
    this.db.prepare("UPDATE connector_oauth_codes SET used_at = ?, grant_id = ? WHERE code_hash = ?").run(now, grantId, hash);
    const member = this.#member(row.member_id);
    console.log(`Connector OAuth: ${member?.name ?? "a member"} connected "${client.name}".`);
    return this.#issueTokens(grantId, now);
  }

  #refresh(client: OAuthClient, params: Record<string, unknown>, now: number): TokenResponse | Failure {
    const invalid = (description: string): Failure => ({ ok: false, status: 400, error: "invalid_grant", description });
    const token = text(params.refresh_token);
    if (!token) return { ok: false, status: 400, error: "invalid_request", description: "refresh_token is required." };
    const hash = sha256Hex(token);
    const row = this.db.prepare(`
      SELECT t.grant_id, t.expires_at, t.rotated_at, g.client_id
      FROM connector_oauth_tokens t JOIN connector_oauth_grants g ON g.grant_id = t.grant_id
      WHERE t.token_hash = ? AND t.kind = 'refresh'
    `).get(hash) as { grant_id: string; expires_at: number; rotated_at: number | null; client_id: string } | undefined;
    if (!row || row.client_id !== client.id) return invalid("Unknown refresh token.");
    if (row.rotated_at !== null) {
      // Refresh tokens rotate on every use; an old one coming back means it leaked.
      this.revokeGrant(row.grant_id);
      return invalid("This refresh token was already used, so GroupCart disconnected this app. Connect it again.");
    }
    if (row.expires_at <= now) return invalid("This refresh token expired. Connect the app again.");
    this.db.prepare("UPDATE connector_oauth_tokens SET rotated_at = ? WHERE token_hash = ?").run(now, hash);
    return this.#issueTokens(row.grant_id, now);
  }

  async #token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const headers = { pragma: "no-cache" };
    const key = clientKey(request);
    const waitMs = this.#tokenLimiter.retryAfterMs(key);
    if (waitMs > 0) {
      return sendJson(response, 429, { error: "temporarily_unavailable", error_description: "Too many failed requests. Try again later." }, { ...headers, "retry-after": String(Math.ceil(waitMs / 1000)) });
    }
    let params: Record<string, unknown>;
    try {
      params = await readParams(request);
    } catch {
      return sendJson(response, 400, { error: "invalid_request", error_description: "Send form-encoded parameters." }, headers);
    }
    const auth = this.#authenticateClient(request, params);
    if (!auth.ok) {
      this.#tokenLimiter.recordFailure(key);
      return sendJson(response, 401, { error: "invalid_client", error_description: "Client authentication failed." }, auth.basic ? { ...headers, "www-authenticate": 'Basic realm="GroupCart"' } : headers);
    }
    const grantType = text(params.grant_type);
    const now = Date.now();
    const result = grantType === "authorization_code" ? this.#exchangeCode(auth.client, params, now)
      : grantType === "refresh_token" ? this.#refresh(auth.client, params, now)
        : { ok: false as const, status: 400, error: "unsupported_grant_type", description: "Use authorization_code or refresh_token." };
    if ("ok" in result) {
      this.#tokenLimiter.recordFailure(key);
      return sendJson(response, result.status, { error: result.error, error_description: result.description }, headers);
    }
    sendJson(response, 200, result, headers);
  }

  async #revoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let params: Record<string, unknown>;
    try {
      params = await readParams(request);
    } catch {
      return sendJson(response, 400, { error: "invalid_request" });
    }
    const auth = this.#authenticateClient(request, params);
    if (!auth.ok) {
      this.#tokenLimiter.recordFailure(clientKey(request));
      return sendJson(response, 401, { error: "invalid_client" }, auth.basic ? { "www-authenticate": 'Basic realm="GroupCart"' } : {});
    }
    const token = text(params.token);
    if (token) {
      const row = this.db.prepare(
        "SELECT t.grant_id, g.client_id FROM connector_oauth_tokens t JOIN connector_oauth_grants g ON g.grant_id = t.grant_id WHERE t.token_hash = ?",
      ).get(sha256Hex(token)) as { grant_id: string; client_id: string } | undefined;
      if (row && row.client_id === auth.client.id) this.revokeGrant(row.grant_id);
    }
    sendJson(response, 200, {});
  }
}
