// Calendar links: a roommate connects their calendar by pasting its secret iCal
// address (Google Calendar "Secret address in iCal format", an iCloud public
// calendar link, an Outlook ICS link) instead of signing in with Google. GroupCart
// fetches the .ics server-side and treats it like a connected calendar (busy times
// for everyone; titles only if that member opted in; see icsCalendar.ts).
//
// The address is a secret: anyone holding it can read the whole calendar. So it is
// - stored only in SQLite, encrypted (AES-256-GCM; the key is in app_state, like
//   auth's code key), and never sent back to a browser (pages see only its host name);
// - set, changed, or removed only by its owner (the signed-in member, or the
//   "Viewing as" member on the host computer; see calendarPage.ts);
// - fetched only over https, port 443, from public addresses: localhost, private,
//   link-local, and other reserved ranges are refused when the address is checked
//   AND when it is resolved for the connection itself (no DNS-rebinding window),
//   redirects included; at most 5 MB in 10 seconds; never logged.
// Feeds are cached for 5 minutes (failures for 30 seconds).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { Interval } from "./availability.js";
import type { CalendarItem } from "./calendarItems.js";
import { icsItems, IcsParseError, parseIcs, type IcsCalendar } from "./icsCalendar.js";

export const MAX_FEED_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2_048;
const FEED_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const KEY_STATE = "calendar_link_key";

/** "needs_reconnect": the address stopped working (reset or deleted); "error": try again later. */
export class CalendarLinkError extends Error {
  constructor(message: string, readonly kind: "needs_reconnect" | "error" = "error") {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Address checks

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
// IPv6: only global unicast (2000::/3) is public, minus documentation, Teredo/IETF, 6to4, and NAT64 ranges.
const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["64:ff9b::", 96]] as const) blocked.addSubnet(network, prefix, "ipv6");

/** True for an address on the public internet (not loopback, private, link-local, CGNAT, multicast, or reserved). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return globalUnicastV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
  return false;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

/**
 * A pasted calendar address → the https URL GroupCart may fetch, or why not.
 * webcal:// and webcals:// become https://. Only https on the standard port, with a
 * public host name (or public IP), and no user name or password.
 */
export function normalizeCalendarUrl(input: string): { ok: true; url: URL } | { ok: false; error: string } {
  const text = input.trim();
  if (!text) return { ok: false, error: "Paste your calendar’s secret address." };
  if (text.length > MAX_URL_LENGTH) return { ok: false, error: "That address is too long." };
  let url: URL;
  try {
    url = new URL(text.replace(/^webcals?:\/\//i, "https://"));
  } catch {
    return { ok: false, error: "That doesn’t look like a web address. Copy the whole link, starting with https:// or webcal://." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Use the calendar’s https:// or webcal:// address." };
  if (url.username || url.password) return { ok: false, error: "Calendar addresses can’t include a user name or password." };
  if (url.port) return { ok: false, error: "Calendar addresses must use the standard https port." };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const local = host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (local || (isIP(host) ? !isPublicAddress(host) : !host.includes("."))) {
    return { ok: false, error: "That address points to this computer or a private network. Use your calendar’s public secret address." };
  }
  url.hash = "";
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Fetching

export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

const systemResolve: ResolveHost = (hostname) => new Promise((resolve, reject) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
});

/** Connection-time lookup: every address the name resolves to must be public, or nothing is connected. */
function publicOnlyLookup(resolveHost: ResolveHost): LookupFunction {
  return (hostname, options, callback) => {
    resolveHost(hostname).then((addresses) => {
      const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
      const wanted = family === 4 || family === 6 ? addresses.filter((entry) => entry.family === family) : addresses;
      if (!wanted.length) throw new CalendarLinkError(`Couldn’t find ${hostname}.`);
      if (!wanted.every((entry) => isPublicAddress(entry.address))) throw new CalendarLinkError("That address points to a private network, so GroupCart won’t fetch it.");
      if (options.all) callback(null, wanted);
      else callback(null, wanted[0]!.address, wanted[0]!.family);
    }).catch((error: unknown) => callback(error instanceof Error ? error as NodeJS.ErrnoException : new Error("lookup failed"), "", 0));
  };
}

/**
 * GETs a calendar feed: https only, public addresses only (checked at connection time),
 * up to 3 redirects (each re-checked), at most 5 MB, within 10 seconds overall.
 * Errors never include the address's path or query (the secret part).
 */
export async function fetchCalendarText(start: URL, options: { resolveHost?: ResolveHost; now?: () => number } = {}): Promise<string> {
  const now = options.now ?? Date.now;
  const deadline = now() + FETCH_TIMEOUT_MS;
  const lookup = publicOnlyLookup(options.resolveHost ?? systemResolve);
  let url = start;
  for (let redirects = 0; ; redirects += 1) {
    const response = await getOnce(url, lookup, deadline - now());
    if (response.kind === "body") return response.text;
    if (redirects >= MAX_REDIRECTS) throw new CalendarLinkError(`${url.hostname} redirected too many times.`);
    const next = normalizeCalendarUrl(new URL(response.location, url).toString());
    if (!next.ok) throw new CalendarLinkError(`${url.hostname} redirected to an address GroupCart won’t fetch.`);
    url = next.url;
  }
}

type Once = { kind: "body"; text: string } | { kind: "redirect"; location: string };

function getOnce(url: URL, lookup: LookupFunction, timeoutMs: number): Promise<Once> {
  const host = url.hostname;
  if (timeoutMs <= 0) return Promise.reject(new CalendarLinkError(`${host} took too long to respond.`));
  return new Promise<Once>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error: Error | null, value?: Once) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        request.destroy();
        reject(error);
      } else resolve(value!);
    };
    const request = httpsRequest(url, {
      method: "GET",
      lookup,
      headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.5", "user-agent": "GroupCart household calendar" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location) return finish(new CalendarLinkError(`${host} returned a redirect without a destination.`));
        return finish(null, { kind: "redirect", location });
      }
      if (status !== 200) {
        response.resume();
        return finish([401, 403, 404, 410].includes(status)
          ? new CalendarLinkError("This calendar address no longer works (it may have been reset). Paste the new secret address.", "needs_reconnect")
          : new CalendarLinkError(`${host} returned an error (HTTP ${status}). GroupCart will try again in a few minutes.`));
      }
      if (Number(response.headers["content-length"] ?? 0) > MAX_FEED_BYTES) return finish(new CalendarLinkError("That calendar is larger than 5 MB, so GroupCart can’t load it."));
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_FEED_BYTES) return finish(new CalendarLinkError("That calendar is larger than 5 MB, so GroupCart can’t load it."));
        chunks.push(chunk);
      });
      response.on("end", () => finish(null, { kind: "body", text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => finish(new CalendarLinkError(`Couldn’t finish loading the calendar from ${host}.`)));
    });
    timer = setTimeout(() => finish(new CalendarLinkError(`${host} took too long to respond.`)), timeoutMs);
    request.on("error", (error) => finish(error instanceof CalendarLinkError ? error : new CalendarLinkError(`Couldn’t reach ${host}.`)));
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Storage and the service used by CalendarService

/** What the page may know about a member's link: never the address itself. */
export type CalendarLinkInfo = { host: string; titles: boolean; connectedAt: string };

export type FetchCalendar = (url: URL) => Promise<string>;

/** One member's loaded feed, plus its expansions by window (a week is asked for by the page, Home, and planners). */
type Feed = { urlHash: string; at: number; failed: boolean; calendar: Promise<IcsCalendar>; expansions: Map<string, CalendarItem[]> };
const MAX_EXPANSIONS_PER_FEED = 32;

export class CalendarLinkService {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #fetch: FetchCalendar;
  readonly #feeds = new Map<string, Feed>();

  constructor(db: DatabaseSync, options: { fetchCalendar?: FetchCalendar } = {}) {
    this.#db = db;
    this.#fetch = options.fetchCalendar ?? ((url) => fetchCalendarText(url));
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_links (
        member_id TEXT PRIMARY KEY,
        url_encrypted TEXT NOT NULL,
        host TEXT NOT NULL,
        show_titles INTEGER NOT NULL DEFAULT 0,
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const stored = db.prepare("SELECT value FROM app_state WHERE key = ?").get(KEY_STATE) as { value: string } | undefined;
    if (stored) {
      this.#key = Buffer.from(stored.value, "base64");
    } else {
      this.#key = randomBytes(32);
      db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(KEY_STATE, this.#key.toString("base64"));
    }
  }

  info(memberId: string): CalendarLinkInfo | undefined {
    const row = this.#db.prepare("SELECT host, show_titles, connected_at FROM calendar_links WHERE member_id = ?").get(memberId) as
      { host: string; show_titles: number; connected_at: string } | undefined;
    return row ? { host: row.host, titles: row.show_titles === 1, connectedAt: row.connected_at } : undefined;
  }

  /**
   * Checks the address, loads it once (so a wrong link fails here, not later), and saves it for `memberId`.
   * Keeps the member's "Show event titles" choice when they replace an existing link.
   */
  async connect(memberId: string, input: string): Promise<{ ok: true; info: CalendarLinkInfo } | { ok: false; error: string }> {
    const checked = normalizeCalendarUrl(input);
    if (!checked.ok) return { ok: false, error: checked.error };
    const url = checked.url.toString();
    try {
      const calendar = await this.#load(checked.url);
      this.#feeds.set(memberId, { urlHash: hashUrl(url), at: Date.now(), failed: false, calendar: Promise.resolve(calendar), expansions: new Map() });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Couldn’t load that calendar." };
    }
    const now = new Date().toISOString();
    this.#db.prepare(
      "INSERT INTO calendar_links (member_id, url_encrypted, host, show_titles, connected_at, updated_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(member_id) DO UPDATE SET url_encrypted = excluded.url_encrypted, host = excluded.host, connected_at = excluded.connected_at, updated_at = excluded.updated_at",
    ).run(memberId, this.#encrypt(url), checked.url.hostname, now, now);
    return { ok: true, info: this.info(memberId)! };
  }

  setTitles(memberId: string, enabled: boolean): boolean {
    return Number(this.#db.prepare("UPDATE calendar_links SET show_titles = ?, updated_at = ? WHERE member_id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), memberId).changes) > 0;
  }

  disconnect(memberId: string): boolean {
    this.#feeds.delete(memberId);
    return Number(this.#db.prepare("DELETE FROM calendar_links WHERE member_id = ?").run(memberId).changes) > 0;
  }

  /** The member's entries in `window` (titled only if they opted in). Throws CalendarLinkError when the feed can't be loaded. */
  async items(memberId: string, window: Interval, timeZone: string): Promise<CalendarItem[]> {
    const row = this.#db.prepare("SELECT url_encrypted, show_titles FROM calendar_links WHERE member_id = ?").get(memberId) as
      { url_encrypted: string; show_titles: number } | undefined;
    if (!row) throw new CalendarLinkError("No calendar link is saved.", "needs_reconnect");
    const url = this.#decrypt(row.url_encrypted);
    if (!url) throw new CalendarLinkError("GroupCart can’t read the saved calendar address anymore. Paste it again.", "needs_reconnect");
    const feed = this.#feed(memberId, url);
    const calendar = await feed.calendar;
    const titles = row.show_titles === 1;
    const key = `${titles}|${timeZone}|${window.start}|${window.end}`;
    let items = feed.expansions.get(key);
    if (!items) {
      items = icsItems(calendar, window, { timeZone, titles });
      if (feed.expansions.size >= MAX_EXPANSIONS_PER_FEED) feed.expansions.clear();
      feed.expansions.set(key, items);
    }
    return items.slice();
  }

  #feed(memberId: string, url: string): Feed {
    const now = Date.now();
    for (const [key, feed] of this.#feeds) if (now - feed.at >= (feed.failed ? FAILURE_TTL_MS : FEED_TTL_MS)) this.#feeds.delete(key);
    const urlHash = hashUrl(url);
    const cached = this.#feeds.get(memberId);
    if (cached && cached.urlHash === urlHash) return cached;
    const calendar = this.#load(new URL(url));
    const feed: Feed = { urlHash, at: now, failed: false, calendar, expansions: new Map() };
    calendar.catch(() => { feed.failed = true; feed.at = Date.now(); });
    this.#feeds.set(memberId, feed);
    return feed;
  }

  /** Fetch + parse; every failure becomes a CalendarLinkError that names only the host. */
  async #load(url: URL): Promise<IcsCalendar> {
    try {
      return parseIcs(await this.#fetch(url));
    } catch (error) {
      if (error instanceof CalendarLinkError) throw error;
      throw new CalendarLinkError(error instanceof IcsParseError ? error.message : `Couldn’t load the calendar from ${url.hostname}.`);
    }
  }

  #encrypt(text: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const sealed = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64")}`;
  }

  #decrypt(value: string): string | null {
    if (!value.startsWith("v1:")) return null;
    try {
      const raw = Buffer.from(value.slice(3), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}
