// Shared helpers for the connector's token and OAuth code paths: random secrets, hashing,
// log redaction, failed-attempt rate limiting, and small request utilities.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Prefixes: gct_ connector token, gca_ access, gcr_ refresh, gcc_ auth code, gcs_ client secret, gcl_ client id. */
export function randomSecret(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two strings (false when lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Replaces anything that looks like a GroupCart secret (tokens, codes, client secrets) so it never reaches logs. */
export function redactTokens(text: string): string {
  return text.replace(/\bgc[a-z]_[A-Za-z0-9_-]+/g, (match) => `${match.slice(0, 4)}…`);
}

export class FailedAuthLimiter {
  readonly #clients = new Map<string, number[]>();
  #global: number[] = [];
  #warned = false;

  constructor(
    private readonly perClient = 10,
    private readonly global = 200,
    private readonly windowMs = 15 * 60_000,
    private readonly label = "connector sign-in",
  ) {}

  /** Milliseconds until this client may try again (0 = allowed). */
  retryAfterMs(key: string, now = Date.now()): number {
    const cutoff = now - this.windowMs;
    this.#global = this.#global.filter((at) => at > cutoff);
    if (this.#global.length < this.global) this.#warned = false;
    const client = (this.#clients.get(key) ?? []).filter((at) => at > cutoff);
    if (client.length) this.#clients.set(key, client); else this.#clients.delete(key);
    if (client.length >= this.perClient) return client[0]! + this.windowMs - now;
    if (this.#global.length >= this.global) return this.#global[0]! + this.windowMs - now;
    return 0;
  }

  recordFailure(key: string, now = Date.now()): void {
    if (this.#clients.size > 5_000) this.#clients.clear();
    this.#clients.set(key, [...(this.#clients.get(key) ?? []), now]);
    this.#global.push(now);
    if (this.#global.length >= this.global && !this.#warned) {
      this.#warned = true;
      console.warn(`Claude connector: too many failed ${this.label} attempts recently; pausing them for up to ${Math.round(this.windowMs / 60_000)} minutes.`);
    }
  }

  reset(key: string): void {
    this.#clients.delete(key);
  }
}

export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Best-effort client identity for rate limiting: the tunnel's client IP when present, else the socket. */
export function clientKey(request: IncomingMessage): string {
  const cloudflare = headerValue(request, "cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = headerValue(request, "x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean);
  if (forwarded?.length) return forwarded[forwarded.length - 1]!;
  return request.socket.remoteAddress ?? "unknown";
}

/** A browser request from another site carries an Origin that does not match the Host it was sent to. */
export function crossOrigin(request: IncomingMessage): boolean {
  const origin = headerValue(request, "origin");
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() !== (request.headers.host ?? "").toLowerCase();
  } catch {
    return true;
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

/** Reads a small request body as text (rejects bodies over `limit` bytes). */
export function readBody(request: IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/** Parses a JSON or form-urlencoded body into a flat string/unknown record. */
export async function readParams(request: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  const body = await readBody(request, limit);
  if (!body) return {};
  const type = headerValue(request, "content-type") ?? "";
  if (/^application\/json\b/i.test(type)) {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  }
  return Object.fromEntries(new URLSearchParams(body));
}
