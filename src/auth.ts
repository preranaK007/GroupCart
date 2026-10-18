// Web sign-in for roommates who open GroupCart from their own phones and laptops.
//
// Local requests (loopback socket, loopback Host header, no proxy/tunnel headers) count as signed in as a
// chosen member: the "Viewing as" switcher stores that choice in the gc_view_as cookie, so the host machine
// and the demo work with zero setup. Every other request is remote: it may reach only /signin*, /api/auth/*,
// and the connector's /mcp, /oauth/*, and /.well-known/* paths until it carries a session cookie. A session is created by entering a
// one-time 6-digit code that GroupCart texts to the member by iMessage DM (demo mode shows it on screen).
//
// Codes: random, HMAC-hashed at rest, expire in 10 minutes, single-use, at most 5 guesses each, and
// rate-limited per client and per member. Sessions: 32 random bytes in an HttpOnly, SameSite=Lax cookie
// (Secure on HTTPS), stored only as a SHA-256 hash, valid for 30 days. Tables use the auth_ prefix.
import { isRemotePublicPath, isRemoteRequest } from "./remoteAccess.js";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { findMember, maskHandle, normalizeHandle } from "./config.js";
import { isRemoteAuthorized } from "./platform.js";
import type { Member, MemberConfig } from "./store.js";

export const SESSION_COOKIE = "gc_session";
export const VIEW_AS_COOKIE = "gc_view_as";
export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Local vs remote requests (same rules as the connector's tunnel guard)
// ---------------------------------------------------------------------------

// One policy for "is this request local?" and "which paths are public remotely?", shared with the connector.
export { isRemoteRequest, isRemotePublicPath } from "./remoteAccess.js";

/** True only for requests made on the host machine itself, not through a LAN address, proxy, or tunnel. */
export function isLocalRequest(request: IncomingMessage): boolean {
  return !isRemoteRequest(request);
}

/**
 * Remote access guard, called first in the dashboard request handler. Returns true when it answered the request
 * (302 to /signin for pages, 401 JSON for everything else); false lets the request through.
 */
export function remoteAccessGuard(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  if (isLocalRequest(request) || isRemotePublicPath(url.pathname)) return false;
  let authorized = false;
  try { authorized = isRemoteAuthorized(request, url); } catch { authorized = false; }
  if (authorized) return false;
  const wantsPage = request.method === "GET" && !url.pathname.startsWith("/api/") && (request.headers.accept ?? "").includes("text/html");
  if (wantsPage) {
    redirect(response, `/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
  } else {
    sendJson(response, 401, { error: "Sign in to GroupCart first.", signIn: "/signin" });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers shared by the profile, chat, and auth routes
// ---------------------------------------------------------------------------

export function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string | string[]> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

export function sendHtml(response: ServerResponse, status: number, html: string, headers: Record<string, string | string[]> = {}): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(html);
}

export function redirect(response: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  response.writeHead(302, { location, "cache-control": "no-store", ...headers });
  response.end();
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      request.resume();
      reject(new HttpError(413, "That file is too large."));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new HttpError(413, "That file is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    request.on("error", reject);
  });
}

export async function readJsonBody(request: IncomingMessage, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const body = await readRawBody(request, maxBytes);
  if (!body.length) return {};
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
}

/**
 * Cross-site request check for state-changing routes: the Origin (when sent) must match the Host, and the body
 * must be JSON or carry the x-gc-request header. Plain HTML forms on other sites can do neither without a CORS
 * preflight, which this server never approves.
 */
export function isSameOriginMutation(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host.toLowerCase() !== (request.headers.host ?? "").toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  const type = String(request.headers["content-type"] ?? "").toLowerCase();
  return type.startsWith("application/json") || request.headers["x-gc-request"] === "1";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name || name in cookies) continue;
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}

/** Best-effort client key for rate limiting (socket address plus the first forwarded address, if any). */
export function clientKey(request: IncomingMessage): string {
  const forwarded = String(request.headers["cf-connecting-ip"] ?? request.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return `${request.socket.remoteAddress ?? "?"}|${forwarded ?? ""}`;
}

/** Only same-site relative paths are accepted as post-sign-in destinations. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.startsWith("/signin")) return "/";
  return value;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  constructor(readonly limit: number, readonly windowMs: number, readonly now: () => number = Date.now) {}

  /** Records one attempt for `key`; returns ok=false (and when to retry) once the window's limit is used. */
  take(key: string): { ok: boolean; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.#hits.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1_000, this.windowMs - (now - recent[0]!)) };
    }
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > 2_000) {
      for (const [entry, times] of this.#hits) if (!times.some((time) => now - time < this.windowMs)) this.#hits.delete(entry);
    }
    return { ok: true, retryAfterMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// Auth service
// ---------------------------------------------------------------------------

/** Sends one iMessage DM to a member's handle (installed by index.ts in live mode). */
export type DirectSender = (handle: string, text: string) => Promise<void>;

export type Viewer = { member: Member; via: "local" | "session" };

export type StartResult =
  | { ok: true; challengeId: string; destination: string; demoCode?: string }
  | { ok: false; status: number; error: string; hostOnly?: boolean; retryAfterSeconds?: number };

export type VerifyResult =
  | { ok: true; member: Member; token: string; expiresAt: number }
  | { ok: false; status: number; error: string; retryAfterSeconds?: number };

export type AuthOptions = {
  db: DatabaseSync;
  /** Current household members (store.getMembers). */
  members: () => Member[];
  /** Allowlist entries (with alias handles) used to match what people type on /signin. */
  memberConfigs: MemberConfig[];
  demoMode: boolean;
  /** Always mark cookies Secure (e.g. GROUP_CART_PUBLIC_URL is https). */
  secureCookies?: boolean;
  now?: () => number;
};

const HOST_ONLY_ERROR = "GroupCart can’t text sign-in codes right now. Sign in on the computer running GroupCart instead.";

let activeAuth: AuthService | null = null;

/** The member a request acts as (local "Viewing as" choice or a remote session), for other feature modules. */
export function requestViewer(request: IncomingMessage): Viewer | null {
  return activeAuth?.viewer(request) ?? null;
}

export class AuthService {
  readonly #db: DatabaseSync;
  readonly #members: () => Member[];
  readonly #configs: MemberConfig[];
  readonly #demo: boolean;
  readonly #forceSecure: boolean;
  readonly #now: () => number;
  readonly #codeKey: Buffer;
  #sender: DirectSender | null = null;
  readonly #startByClient: RateLimiter;
  readonly #startByMember: RateLimiter;
  readonly #verifyByClient: RateLimiter;

  constructor(options: AuthOptions) {
    this.#db = options.db;
    this.#members = options.members;
    this.#configs = options.memberConfigs;
    this.#demo = options.demoMode;
    this.#forceSecure = Boolean(options.secureCookies);
    this.#now = options.now ?? Date.now;
    this.#startByClient = new RateLimiter(5, CODE_TTL_MS, this.#now);
    this.#startByMember = new RateLimiter(3, CODE_TTL_MS, this.#now);
    this.#verifyByClient = new RateLimiter(20, CODE_TTL_MS, this.#now);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS auth_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_codes (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent TEXT
      );
    `);
    const stored = this.#db.prepare("SELECT value FROM auth_state WHERE key = 'code_key'").get() as { value: string } | undefined;
    if (stored) {
      this.#codeKey = Buffer.from(stored.value, "base64");
    } else {
      this.#codeKey = randomBytes(32);
      this.#db.prepare("INSERT INTO auth_state (key, value) VALUES ('code_key', ?)").run(this.#codeKey.toString("base64"));
    }
    this.purgeExpired();
    activeAuth = this;
  }

  get demoMode(): boolean {
    return this.#demo;
  }

  /** Live mode installs this once Spectrum is connected; null means codes can't be texted. */
  setDirectSender(sender: DirectSender | null): void {
    this.#sender = sender;
  }

  /** Whether /signin can deliver codes at all (demo shows them; live needs iMessage DMs). */
  get canSendCodes(): boolean {
    return this.#demo || this.#sender !== null;
  }

  purgeExpired(): void {
    const now = this.#now();
    this.#db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(now - CODE_TTL_MS);
    this.#db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(now);
  }

  #hashCode(challengeId: string, code: string): string {
    return createHmac("sha256", this.#codeKey).update(`${challengeId}:${code}`).digest("hex");
  }

  static hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** Finds the member for what someone typed: any of their allowlisted handles (demo also accepts a name). */
  #resolve(input: string): { member: Member; destination: string } | null {
    const typed = input.trim().slice(0, 120);
    if (!typed) return null;
    const members = this.#members();
    const configured = findMember(this.#configs, typed);
    if (configured) {
      const primary = normalizeHandle(configured.handle);
      const member = members.find((candidate) => candidate.handle === primary);
      if (member) return { member, destination: normalizeHandle(typed) };
    }
    if (this.#demo) {
      const lowered = typed.toLowerCase();
      const member = members.find((candidate) => candidate.name.toLowerCase() === lowered || candidate.handle === normalizeHandle(typed));
      if (member) return { member, destination: member.handle };
    }
    return null;
  }

  async startSignIn(input: string, client: string): Promise<StartResult> {
    const byClient = this.#startByClient.take(client);
    if (!byClient.ok) return { ok: false, status: 429, error: "Too many sign-in requests. Try again in a few minutes.", retryAfterSeconds: Math.ceil(byClient.retryAfterMs / 1000) };
    const target = this.#resolve(input);
    if (!target) {
      if (this.#demo) {
        const example = this.#members()[0]?.name;
        return { ok: false, status: 404, error: example ? `No household member matches that. Try a name like “${example}”.` : "No household member matches that." };
      }
      // Same answer as a real send, so the form doesn't reveal who is in the household.
      return { ok: true, challengeId: randomBytes(18).toString("base64url"), destination: maskHandle(input) };
    }
    const byMember = this.#startByMember.take(target.member.id);
    if (!byMember.ok) return { ok: false, status: 429, error: "A few codes were just sent. Wait a few minutes, then try again.", retryAfterSeconds: Math.ceil(byMember.retryAfterMs / 1000) };
    if (!this.#demo && !this.#sender) return { ok: false, status: 503, error: HOST_ONLY_ERROR, hostOnly: true };

    const now = this.#now();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const challengeId = randomBytes(18).toString("base64url");
    // One live code per member: requesting a new one retires the previous ones.
    this.#db.prepare("UPDATE auth_codes SET used_at = ? WHERE member_id = ? AND used_at IS NULL").run(now, target.member.id);
    this.#db.prepare(
      "INSERT INTO auth_codes (id, member_id, code_hash, created_at, expires_at, used_at, attempts) VALUES (?, ?, ?, ?, ?, NULL, 0)",
    ).run(challengeId, target.member.id, this.#hashCode(challengeId, code), now, now + CODE_TTL_MS);

    if (this.#demo) return { ok: true, challengeId, destination: target.member.name, demoCode: code };
    try {
      await this.#sender!(target.destination, `${code} is your GroupCart sign-in code. It expires in 10 minutes. If you didn’t try to sign in, ignore this message.`);
    } catch (error) {
      this.#db.prepare("DELETE FROM auth_codes WHERE id = ?").run(challengeId);
      console.warn(`Could not text a sign-in code to ${maskHandle(target.destination)}: ${error instanceof Error ? error.message : "unknown error"}`);
      return { ok: false, status: 502, error: HOST_ONLY_ERROR, hostOnly: true };
    }
    return { ok: true, challengeId, destination: maskHandle(target.destination) };
  }

  verifyCode(challengeId: string, rawCode: string, client: string, userAgent?: string): VerifyResult {
    const byClient = this.#verifyByClient.take(client);
    if (!byClient.ok) return { ok: false, status: 429, error: "Too many tries. Wait a few minutes, then request a new code.", retryAfterSeconds: Math.ceil(byClient.retryAfterMs / 1000) };
    const code = rawCode.replace(/\D/g, "");
    if (code.length !== 6) return { ok: false, status: 400, error: "Enter the 6-digit code." };
    const now = this.#now();
    const row = this.#db.prepare(
      "SELECT id, member_id, code_hash, expires_at, used_at, attempts FROM auth_codes WHERE id = ?",
    ).get(String(challengeId).slice(0, 64)) as { id: string; member_id: string; code_hash: string; expires_at: number; used_at: number | null; attempts: number } | undefined;
    if (!row) return { ok: false, status: 400, error: "That code didn’t work. Check it or request a new one." };
    if (row.used_at !== null || row.expires_at <= now) return { ok: false, status: 400, error: "That code expired. Request a new one." };
    if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, status: 429, error: "Too many tries. Request a new code." };
    this.#db.prepare("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    const expected = Buffer.from(row.code_hash, "hex");
    const actual = Buffer.from(this.#hashCode(row.id, code), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, status: 400, error: row.attempts + 1 >= MAX_CODE_ATTEMPTS ? "Too many tries. Request a new code." : "That code didn’t work. Check it or request a new one." };
    }
    // Single use: only the first successful verification consumes the code.
    const consumed = Number(this.#db.prepare("UPDATE auth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, row.id).changes);
    if (consumed !== 1) return { ok: false, status: 400, error: "That code expired. Request a new one." };
    const member = this.#members().find((candidate) => candidate.id === row.member_id);
    if (!member) return { ok: false, status: 400, error: "That member is no longer in the household." };
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    this.#db.prepare(
      "INSERT INTO auth_sessions (token_hash, member_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(AuthService.hashToken(token), member.id, now, expiresAt, now, (userAgent ?? "").slice(0, 200) || null);
    return { ok: true, member, token, expiresAt };
  }

  /** The member behind a valid, unexpired session cookie (members removed from the allowlist lose access). */
  sessionMember(request: IncomingMessage): Member | null {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token || token.length > 128) return null;
    const now = this.#now();
    const row = this.#db.prepare(
      "SELECT member_id, expires_at, last_seen_at FROM auth_sessions WHERE token_hash = ?",
    ).get(AuthService.hashToken(token)) as { member_id: string; expires_at: number; last_seen_at: number } | undefined;
    if (!row || row.expires_at <= now) return null;
    const member = this.#members().find((candidate) => candidate.id === row.member_id);
    if (!member) return null;
    if (now - row.last_seen_at > 60 * 60_000) {
      this.#db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, AuthService.hashToken(token));
    }
    return member;
  }

  /** Who a request acts as: local requests use the "Viewing as" cookie (default: first member); remote ones need a session. */
  viewer(request: IncomingMessage): Viewer | null {
    if (isLocalRequest(request)) {
      const members = this.#members();
      const chosen = parseCookies(request.headers.cookie)[VIEW_AS_COOKIE];
      const member = members.find((candidate) => candidate.id === chosen) ?? members[0];
      return member ? { member, via: "local" } : null;
    }
    const member = this.sessionMember(request);
    return member ? { member, via: "session" } : null;
  }

  signOut(request: IncomingMessage): void {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) this.#db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(AuthService.hashToken(token));
  }

  #secure(request: IncomingMessage): boolean {
    const proto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase();
    return this.#forceSecure || Boolean((request.socket as { encrypted?: boolean }).encrypted) || proto === "https";
  }

  sessionCookie(token: string, request: IncomingMessage): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${this.#secure(request) ? "; Secure" : ""}`;
  }

  clearSessionCookie(request: IncomingMessage): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.#secure(request) ? "; Secure" : ""}`;
  }

  viewAsCookie(memberId: string): string {
    return `${VIEW_AS_COOKIE}=${encodeURIComponent(memberId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 60 * 60}`;
  }
}
