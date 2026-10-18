// Google Calendar free/busy integration: per-member OAuth 2.0 (authorization code
// flow with offline access), access-token refresh, the freeBusy API, and the
// CalendarService that assembles the week view for /calendar and the iMessage
// "calendar" command. Without GOOGLE_CLIENT_ID/SECRET it serves sample schedules.
import { createHash, randomBytes } from "node:crypto";
import {
  addDays, bestFreeTimes, computeAvailability, freeWindowsInDays, isDateString, isValidTimeZone, localDate, mondayOf, nextFreeTimes,
  zonedTimeToEpoch, type Interval, type MemberBusy, type OverlapSegment,
} from "./availability.js";
import { demoBusyBlocks } from "./calendarDemo.js";
import type { CartStore, Member } from "./store.js";

export const GOOGLE_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const STATE_TTL_MS = 10 * 60_000;
const BUSY_CACHE_TTL_MS = 60_000;

/** Hours (local, minutes after midnight) considered for "everyone is free" suggestions. */
export const FREE_DAY_START_MINUTES = 8 * 60;
export const FREE_DAY_END_MINUTES = 21 * 60;

type FetchLike = typeof fetch;

export class GoogleCalendarError extends Error {
  constructor(message: string, readonly needsReconnect = false) {
    super(message);
  }
}

export class GoogleCalendarClient {
  readonly #pending = new Map<string, { memberId: string; codeVerifier: string; createdAt: number }>();
  readonly #accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  createAuthorization(memberId: string): { url: string; state: string } {
    const now = Date.now();
    for (const [key, pending] of this.#pending) if (now - pending.createdAt > STATE_TTL_MS) this.#pending.delete(key);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.#pending.set(state, { memberId, codeVerifier, createdAt: now });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: GOOGLE_FREEBUSY_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state };
  }

  async completeAuthorization(code: string, state: string): Promise<{ memberId: string; refreshToken: string; scope: string }> {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || Date.now() - pending.createdAt > STATE_TTL_MS) {
      throw new GoogleCalendarError("Google sign-in expired or was already used. Open the calendar page and press Connect again.");
    }
    const body = await this.#tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.codeVerifier,
    });
    const scope = typeof body.scope === "string" ? body.scope : "";
    if (!scope.split(/\s+/).includes(GOOGLE_FREEBUSY_SCOPE)) {
      throw new GoogleCalendarError("Calendar availability access was not granted. Press Connect again and allow GroupCart to see when you are busy.");
    }
    if (typeof body.refresh_token !== "string" || !body.refresh_token) {
      throw new GoogleCalendarError("Google did not return a long-lived sign-in. Remove GroupCart from your Google account's third-party access, then connect again.");
    }
    if (typeof body.access_token === "string") {
      this.#accessTokens.set(pending.memberId, { token: body.access_token, expiresAt: Date.now() + expiresInMs(body.expires_in) });
    }
    return { memberId: pending.memberId, refreshToken: body.refresh_token, scope };
  }

  forget(memberId: string): void {
    this.#accessTokens.delete(memberId);
  }

  async freeBusy(memberId: string, refreshToken: string, window: Interval): Promise<Interval[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await this.#accessToken(memberId, refreshToken);
      const response = await this.fetchImpl(FREEBUSY_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          timeMin: new Date(window.start).toISOString(),
          timeMax: new Date(window.end).toISOString(),
          items: [{ id: "primary" }],
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 401) {
        this.forget(memberId);
        if (attempt === 0) continue;
        throw new GoogleCalendarError("Google no longer accepts this calendar connection.", true);
      }
      if (response.status === 403) {
        const detail = await response.text();
        if (/insufficient|scope|forbidden|PERMISSION_DENIED/i.test(detail)) {
          throw new GoogleCalendarError("Calendar availability permission is missing.", true);
        }
        throw new GoogleCalendarError(`Google Calendar refused the request (${response.status}).`);
      }
      if (!response.ok) throw new GoogleCalendarError(`Google Calendar is unavailable right now (${response.status}).`);
      const body = await response.json() as {
        calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ domain?: string; reason?: string }> }>;
      };
      const calendar = body.calendars?.primary ?? Object.values(body.calendars ?? {})[0];
      if (!calendar) throw new GoogleCalendarError("Google Calendar returned no primary calendar.");
      if (calendar.errors?.length) {
        const reason = calendar.errors.map((error) => error.reason ?? "unknown").join(", ");
        throw new GoogleCalendarError(`Google could not read this calendar (${reason}).`, /notFound|forbidden|unauthorized/i.test(reason));
      }
      return (calendar.busy ?? []).flatMap((block) => {
        const start = Date.parse(block.start ?? "");
        const end = Date.parse(block.end ?? "");
        return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end }] : [];
      });
    }
    throw new GoogleCalendarError("Google Calendar request failed.");
  }

  /** Best-effort revoke so the grant disappears from the member's Google account too. */
  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.fetchImpl(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      // The local token is deleted regardless; the member can also remove access in their Google account.
    }
  }

  async #accessToken(memberId: string, refreshToken: string): Promise<string> {
    const cached = this.#accessTokens.get(memberId);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const body = await this.#tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (typeof body.access_token !== "string") throw new GoogleCalendarError("Google did not return an access token.");
    this.#accessTokens.set(memberId, { token: body.access_token, expiresAt: Date.now() + expiresInMs(body.expires_in) });
    return body.access_token;
  }

  async #tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...params, client_id: this.clientId, client_secret: this.clientSecret }),
      signal: AbortSignal.timeout(12_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      // invalid_grant = refresh token revoked/expired (or the auth code was reused).
      throw new GoogleCalendarError(
        error === "invalid_grant" ? "Google sign-in was revoked or expired." : `Google sign-in failed (${error}).`,
        error === "invalid_grant",
      );
    }
    return body;
  }
}

function expiresInMs(value: unknown): number {
  return (typeof value === "number" && value > 0 ? value : 3600) * 1000;
}

// ---------------------------------------------------------------------------

export type CalendarMemberStatus = "sample" | "connected" | "not_connected" | "needs_reconnect" | "error";

export type CalendarWeek = {
  mode: "demo" | "google";
  timeZone: string;
  now: number;
  today: string;
  weekStart: string;
  prevWeek: string;
  nextWeek: string;
  days: Array<{ date: string; start: number; end: number }>;
  freeHours: { startMinutes: number; endMinutes: number };
  members: Array<{ id: string; name: string; colorIndex: number; status: CalendarMemberStatus; detail: string | null; busy: Interval[] }>;
  included: number;
  overlaps: OverlapSegment[];
  everyoneFree: Interval[];
  bestTimes: Interval[];
};

export class CalendarService {
  readonly #busyCache = new Map<string, { at: number; busy: Interval[] }>();

  constructor(
    private readonly store: CartStore,
    private readonly publicUrl: string,
    private readonly client?: GoogleCalendarClient,
  ) {}

  get mode(): "demo" | "google" {
    return this.client ? "google" : "demo";
  }

  get pageUrl(): string {
    return `${this.publicUrl.replace(/\/$/, "")}/calendar`;
  }

  static serverTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  async week(options: { week?: string | null; timeZone?: string | null; now?: number }): Promise<CalendarWeek> {
    const timeZone = options.timeZone && isValidTimeZone(options.timeZone) ? options.timeZone : CalendarService.serverTimeZone();
    const now = options.now ?? Date.now();
    const today = localDate(now, timeZone);
    const weekStart = options.week && isDateString(options.week) ? mondayOf(options.week) : mondayOf(today);
    const days = Array.from({ length: 7 }, (_, offset) => {
      const date = addDays(weekStart, offset);
      return { date, start: zonedTimeToEpoch(date, 0, timeZone), end: zonedTimeToEpoch(addDays(date, 1), 0, timeZone) };
    });
    const window = { start: days[0]!.start, end: days[6]!.end };
    const members = await this.#collect(window, [weekStart], timeZone);
    const included = members.filter((member) => member.status === "sample" || member.status === "connected");
    const busy: MemberBusy[] = included.map((member) => ({ memberId: member.id, busy: member.busy }));
    const overlaps = computeAvailability(busy, window).overlaps;
    const everyoneFree = freeWindowsInDays(busy, days.map((day) => this.#freeHours(day.date, timeZone)), 30);
    return {
      mode: this.mode,
      timeZone,
      now,
      today,
      weekStart,
      prevWeek: addDays(weekStart, -7),
      nextWeek: addDays(weekStart, 7),
      days,
      freeHours: { startMinutes: FREE_DAY_START_MINUTES, endMinutes: FREE_DAY_END_MINUTES },
      members,
      included: included.length,
      overlaps,
      everyoneFree,
      bestTimes: bestFreeTimes(everyoneFree, roundUpToQuarterHour(now), 5, 60),
    };
  }

  /** Free windows for everyone over the next `days` days (used by the iMessage command). */
  async upcomingFreeTimes(now = Date.now(), days = 7, count = 3): Promise<{ times: Interval[]; included: number; total: number; timeZone: string }> {
    const timeZone = CalendarService.serverTimeZone();
    const today = localDate(now, timeZone);
    const dates = Array.from({ length: days + 1 }, (_, offset) => addDays(today, offset));
    const window = { start: zonedTimeToEpoch(today, 0, timeZone), end: zonedTimeToEpoch(addDays(today, days + 1), 0, timeZone) };
    const weekStarts = [...new Set(dates.map(mondayOf))];
    const members = await this.#collect(window, weekStarts, timeZone);
    const included = members.filter((member) => member.status === "sample" || member.status === "connected");
    const windows = freeWindowsInDays(
      included.map((member) => ({ memberId: member.id, busy: member.busy })),
      dates.map((date) => this.#freeHours(date, timeZone)),
      30,
    );
    return { times: nextFreeTimes(windows, roundUpToQuarterHour(now), count, 30), included: included.length, total: members.length, timeZone };
  }

  /** Replies to "calendar"-style group commands; returns null for anything else. Idempotent by message ID. */
  async replyToCommand(messageId: string, text: string): Promise<string | null> {
    if (!isCalendarCommand(text)) return null;
    const existing = this.store.recordedReply(messageId);
    if (existing !== undefined) return existing;
    const { times, included, total, timeZone } = await this.upcomingFreeTimes();
    const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(this.publicUrl);
    const lines = [`Household calendar: ${this.pageUrl}${local ? " (opens on the computer running GroupCart)" : ""}`];
    if (included === 0) {
      lines.push("No one has connected Google Calendar yet. Open the page and press “Connect Google Calendar” to share when you’re busy (no event details).");
    } else if (!times.length) {
      lines.push("I couldn’t find a 30-minute window in the next week (8 AM–9 PM) when everyone is free.");
    } else {
      const format = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      lines.push("Next times everyone is free:");
      for (const time of times) lines.push(`• ${format.formatRange(new Date(time.start), new Date(time.end))}`);
    }
    if (this.mode === "demo") lines.push("These are sample schedules for the demo; connect Google Calendar to use real availability.");
    else if (included > 0 && included < total) lines.push(`Based on ${included} of ${total} calendars; others haven’t connected yet.`);
    const reply = lines.join("\n");
    this.store.recordCommandReply(messageId, reply);
    return reply;
  }

  startAuthorization(memberId: string): { ok: true; url: string } | { ok: false; status: number; message: string } {
    if (!this.client) return { ok: false, status: 503, message: "Google Calendar is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect real calendars." };
    if (!this.store.getMembers().some((member) => member.id === memberId)) return { ok: false, status: 404, message: "That household member was not found." };
    return { ok: true, url: this.client.createAuthorization(memberId).url };
  }

  async completeAuthorization(code: string, state: string): Promise<Member> {
    if (!this.client) throw new GoogleCalendarError("Google Calendar is not configured.");
    const result = await this.client.completeAuthorization(code, state);
    const member = this.store.getMembers().find((candidate) => candidate.id === result.memberId);
    if (!member) throw new GoogleCalendarError("That household member no longer exists.");
    const previous = this.store.googleCalendarAccount(member.id);
    this.store.saveGoogleCalendarAccount(member.id, result.refreshToken, result.scope);
    if (previous && previous.refreshToken !== result.refreshToken) void this.client.revoke(previous.refreshToken);
    this.#clearCache(member.id);
    return member;
  }

  async disconnect(memberId: string): Promise<boolean> {
    const account = this.store.googleCalendarAccount(memberId);
    if (!account) return false;
    this.store.deleteGoogleCalendarAccount(memberId);
    this.client?.forget(memberId);
    this.#clearCache(memberId);
    if (this.client) await this.client.revoke(account.refreshToken);
    return true;
  }

  async #collect(window: Interval, weekStarts: string[], timeZone: string): Promise<CalendarWeek["members"]> {
    const members = this.store.getMembers();
    return Promise.all(members.map(async (member, colorIndex) => {
      const base = { id: member.id, name: member.name, colorIndex };
      if (!this.client) {
        const busy = weekStarts.flatMap((weekStart) => demoBusyBlocks(member.id, colorIndex, weekStart, timeZone))
          .filter((block) => block.end > window.start && block.start < window.end);
        return { ...base, status: "sample" as const, detail: "Sample schedule", busy };
      }
      const account = this.store.googleCalendarAccount(member.id);
      if (!account) return { ...base, status: "not_connected" as const, detail: null, busy: [] };
      if (account.status === "needs_reconnect") return { ...base, status: "needs_reconnect" as const, detail: account.lastError, busy: [] };
      try {
        return { ...base, status: "connected" as const, detail: null, busy: await this.#cachedFreeBusy(member.id, account.refreshToken, window) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Google Calendar request failed.";
        if (error instanceof GoogleCalendarError && error.needsReconnect) {
          this.store.markGoogleCalendarNeedsReconnect(member.id, message);
          this.client.forget(member.id);
          return { ...base, status: "needs_reconnect" as const, detail: message, busy: [] };
        }
        return { ...base, status: "error" as const, detail: message, busy: [] };
      }
    }));
  }

  async #cachedFreeBusy(memberId: string, refreshToken: string, window: Interval): Promise<Interval[]> {
    const key = `${memberId}|${window.start}|${window.end}`;
    const cached = this.#busyCache.get(key);
    if (cached && Date.now() - cached.at < BUSY_CACHE_TTL_MS) return cached.busy;
    const busy = await this.client!.freeBusy(memberId, refreshToken, window);
    if (this.#busyCache.size > 200) this.#busyCache.clear();
    this.#busyCache.set(key, { at: Date.now(), busy });
    return busy;
  }

  #clearCache(memberId: string): void {
    for (const key of this.#busyCache.keys()) if (key.startsWith(`${memberId}|`)) this.#busyCache.delete(key);
  }

  #freeHours(date: string, timeZone: string): Interval {
    return { start: zonedTimeToEpoch(date, FREE_DAY_START_MINUTES, timeZone), end: zonedTimeToEpoch(date, FREE_DAY_END_MINUTES, timeZone) };
  }
}

/** Suggestions start on a quarter hour ("7:30 PM", not "7:17 PM"). */
function roundUpToQuarterHour(ms: number): number {
  return Math.ceil(ms / 900_000) * 900_000;
}

export function isCalendarCommand(text: string): boolean {
  return /^(?:calendar|cal|calendar page|show calendar|open calendar|schedule|free time|free times|when are we free|when is everyone free)[!.?]*$/i.test(text.trim());
}
