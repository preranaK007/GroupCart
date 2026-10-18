// Google Calendar integration: per-member OAuth 2.0 (authorization code flow with
// offline access), access-token refresh, the freeBusy API, and the CalendarService
// that assembles the week view for /calendar, the iMessage "calendar" command, and the
// free-time tools. Each member's calendar comes from Google (when GOOGLE_CLIENT_ID/SECRET
// are set and they signed in) or from a calendar link they pasted (src/calendarLinks.ts,
// no Google setup needed). Demo mode shows sample schedules for everyone else; live mode
// never does: an unconnected member is "Not connected" and is left out of free time.
//
// Free/busy is the default. A member can opt in to "Show event titles": GroupCart then
// asks Google again for calendar.events.readonly as well, stores the granted scope, and
// reads that member's primary calendar with events.list (title, time, and location
// only; see calendarItems.ts) instead of freeBusy.
import { createHash, randomBytes } from "node:crypto";
import {
  addDays, bestFreeTimes, computeAvailability, freeWindowsInDays, isDateString, isValidTimeZone, localDate, mondayOf, nextFreeTimes,
  zonedTimeToEpoch, type Interval, type MemberBusy, type OverlapSegment,
} from "./availability.js";
import { DemoCalendarFile, demoCalendarEvents, demoEvents } from "./calendarDemo.js";
import { busyFromItems, itemsFromBusy, normalizeGoogleEvents, overlapsWindow, type CalendarItem } from "./calendarItems.js";
import { CalendarLinkError, CalendarLinkService, type CalendarLinkInfo, type FetchCalendar } from "./calendarLinks.js";
import type { CartStore, GoogleCalendarAccount, Member } from "./store.js";

export const GOOGLE_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
/** Opt-in, per member: read-only events, so the page can show titles, times, and locations. */
export const GOOGLE_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
/** Partial response: only what the page shows (plus the member's own RSVP to skip declined events). */
const EVENT_FIELDS = "items(status,summary,location,start,end,transparency,visibility,eventType,attendees(self,responseStatus)),nextPageToken";
const MAX_EVENT_PAGES = 4;

/** True when a stored grant includes event access (the member opted in to titles). */
export function hasEventTitlesScope(scope: string | null | undefined): boolean {
  return String(scope ?? "").split(/\s+/).includes(GOOGLE_EVENTS_SCOPE);
}
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
  constructor(message: string, readonly needsReconnect = false, readonly code: "titles_forbidden" | null = null) {
    super(message);
  }
}

export class GoogleCalendarClient {
  readonly #pending = new Map<string, { memberId: string; codeVerifier: string; createdAt: number; titles: boolean }>();
  readonly #accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** `titles`: also ask for read-only events (the member's "Show event titles" opt-in). */
  createAuthorization(memberId: string, options: { titles?: boolean } = {}): { url: string; state: string } {
    const now = Date.now();
    for (const [key, pending] of this.#pending) if (now - pending.createdAt > STATE_TTL_MS) this.#pending.delete(key);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const titles = Boolean(options.titles);
    this.#pending.set(state, { memberId, codeVerifier, createdAt: now, titles });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: titles ? `${GOOGLE_FREEBUSY_SCOPE} ${GOOGLE_EVENTS_SCOPE}` : GOOGLE_FREEBUSY_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state };
  }

  async completeAuthorization(code: string, state: string): Promise<{ memberId: string; refreshToken: string; scope: string; titlesRequested: boolean }> {
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
    return { memberId: pending.memberId, refreshToken: body.refresh_token, scope, titlesRequested: pending.titles };
  }

  forget(memberId: string): void {
    this.#accessTokens.delete(memberId);
  }

  async freeBusy(memberId: string, refreshToken: string, window: Interval): Promise<Interval[]> {
    const body = await this.#calendarRequest(memberId, refreshToken, FREEBUSY_URL, {
      method: "POST",
      body: JSON.stringify({
        timeMin: new Date(window.start).toISOString(),
        timeMax: new Date(window.end).toISOString(),
        items: [{ id: "primary" }],
      }),
    }, "Calendar availability permission is missing.") as {
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

  /**
   * The member's primary-calendar events in `window` (events.list, recurring events
   * expanded), normalized to title/time/location entries. Needs GOOGLE_EVENTS_SCOPE;
   * without it this throws a GoogleCalendarError with code "titles_forbidden".
   */
  async events(memberId: string, refreshToken: string, window: Interval, timeZone: string): Promise<CalendarItem[]> {
    const items: unknown[] = [];
    let pageToken = "";
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const url = new URL(EVENTS_URL);
      url.search = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        timeMin: new Date(window.start).toISOString(),
        timeMax: new Date(window.end).toISOString(),
        maxResults: "250",
        fields: EVENT_FIELDS,
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const body = await this.#calendarRequest(memberId, refreshToken, url.toString(), { method: "GET" }, "Event titles permission is missing.", "titles_forbidden") as { items?: unknown[]; nextPageToken?: string };
      if (Array.isArray(body.items)) items.push(...body.items);
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
      if (!pageToken) break;
    }
    return normalizeGoogleEvents(items, timeZone);
  }

  /** Authorized Calendar API call with one retry after a 401 (stale access token). */
  async #calendarRequest(
    memberId: string,
    refreshToken: string,
    url: string,
    init: { method: "GET" | "POST"; body?: string },
    scopeMessage: string,
    scopeCode: "titles_forbidden" | null = null,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await this.#accessToken(memberId, refreshToken);
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
        ...(init.body ? { body: init.body } : {}),
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
          // Missing event access only downgrades to busy times; missing free/busy access needs a reconnect.
          throw new GoogleCalendarError(scopeMessage, scopeCode === null, scopeCode);
        }
        throw new GoogleCalendarError(`Google Calendar refused the request (${response.status}).`);
      }
      if (!response.ok) throw new GoogleCalendarError(`Google Calendar is unavailable right now (${response.status}).`);
      return await response.json();
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
  /** "demo": members without a connected calendar show sample schedules; "live": they show as not connected. */
  mode: "demo" | "live";
  /** Google sign-in is configured (otherwise members connect with a calendar link). */
  googleAvailable: boolean;
  timeZone: string;
  now: number;
  today: string;
  weekStart: string;
  prevWeek: string;
  nextWeek: string;
  days: Array<{ date: string; start: number; end: number }>;
  freeHours: { startMinutes: number; endMinutes: number };
  members: CalendarWeekMember[];
  included: number;
  overlaps: OverlapSegment[];
  everyoneFree: Interval[];
  bestTimes: Interval[];
};

/**
 * Where a member's calendar comes from: generated samples or the GROUP_CART_DEMO_CALENDAR
 * file (demo mode only), Google (titles or busy-only), a calendar link, or nothing yet.
 */
export type CalendarSource = "generated" | "file" | "google" | "link" | null;

export type CalendarWeekMember = {
  id: string;
  name: string;
  colorIndex: number;
  status: CalendarMemberStatus;
  detail: string | null;
  source: CalendarSource;
  /** Entries carry titles (samples, the demo file, or a member who opted in to event titles). */
  titles: boolean;
  /** The member opted in to event titles (their Google grant includes event access, or their link's setting); drives the "Show event titles" switch. */
  titlesGranted: boolean;
  /** Host name of the member's calendar link ("calendar.google.com"); the address itself is never sent. */
  linkHost: string | null;
  /** Busy time used for overlaps and free time ("show as available" entries excluded). */
  busy: Interval[];
  /** What the page draws: titled entries, or untitled busy blocks for free/busy-only calendars. */
  events: CalendarItem[];
};

type GoogleFetch = { events: CalendarItem[]; titles: boolean; detail: string | null };
type MemberBase = Pick<CalendarWeekMember, "id" | "name" | "colorIndex" | "titlesGranted" | "linkHost">;

export type CalendarServiceOptions = {
  /** Local demo (no Spectrum credentials): unconnected members get sample schedules. Live mode never shows samples. */
  demoMode: boolean;
  /** GROUP_CART_DEMO_CALENDAR: titled showcase events by member name (demo mode only). */
  demoCalendarFile?: string;
  /** Loads a calendar link's .ics text (tests); defaults to the guarded https fetch in calendarLinks.ts. */
  fetchCalendar?: FetchCalendar;
};

export class CalendarService {
  readonly #googleCache = new Map<string, { at: number; value: GoogleFetch }>();
  readonly #demoFile: DemoCalendarFile | undefined;
  readonly #links: CalendarLinkService;
  readonly #demoMode: boolean;

  constructor(
    private readonly store: CartStore,
    private readonly publicUrl: string,
    private readonly client: GoogleCalendarClient | undefined,
    options: CalendarServiceOptions,
  ) {
    this.#demoMode = options.demoMode;
    if (options.demoCalendarFile && !options.demoMode) console.warn("GROUP_CART_DEMO_CALENDAR is ignored in live mode: the calendar shows only real, connected calendars.");
    this.#demoFile = options.demoCalendarFile && options.demoMode ? new DemoCalendarFile(options.demoCalendarFile, CalendarService.serverTimeZone) : undefined;
    this.#links = new CalendarLinkService(store.database, { fetchCalendar: options.fetchCalendar });
  }

  get mode(): "demo" | "live" {
    return this.#demoMode ? "demo" : "live";
  }

  get googleAvailable(): boolean {
    return Boolean(this.client);
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
      googleAvailable: this.googleAvailable,
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

  /**
   * Free windows for everyone whose calendar is included, over the next `days` days (the iMessage command,
   * Home, and the free_times tool). `missing` names the members left out (not connected or not loading);
   * with nobody included there are no times, never "everyone is free".
   */
  async upcomingFreeTimes(now = Date.now(), days = 7, count = 3): Promise<{ times: Interval[]; included: number; total: number; missing: string[]; timeZone: string }> {
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
    const missing = members.filter((member) => !included.includes(member)).map((member) => member.name);
    return { times: nextFreeTimes(windows, roundUpToQuarterHour(now), count, 30), included: included.length, total: members.length, missing, timeZone };
  }

  /** Replies to "calendar"-style group commands; returns null for anything else. Idempotent by message ID. */
  async replyToCommand(messageId: string, text: string): Promise<string | null> {
    if (!isCalendarCommand(text)) return null;
    const existing = this.store.recordedReply(messageId);
    if (existing !== undefined) return existing;
    const { times, included, total, missing, timeZone } = await this.upcomingFreeTimes();
    const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(this.publicUrl);
    const lines = [`Household calendar: ${this.pageUrl}${local ? " (opens on the computer running GroupCart)" : ""}`];
    if (included === 0) {
      lines.push("No one has connected a calendar yet. Open the page and press “Connect” to share when you’re busy (no event details).");
    } else if (!times.length) {
      lines.push("I couldn’t find a 30-minute window in the next week (8 AM–9 PM) when everyone is free.");
    } else {
      const format = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      lines.push("Next times everyone is free:");
      for (const time of times) lines.push(`• ${format.formatRange(new Date(time.start), new Date(time.end))}`);
    }
    if (this.mode === "demo") lines.push("Demo mode: calendars that aren’t connected are sample schedules.");
    else if (included > 0 && missing.length) lines.push(`Based on ${included} of ${total} calendars (not included: ${missing.join(", ")}).`);
    const reply = lines.join("\n");
    this.store.recordCommandReply(messageId, reply);
    return reply;
  }

  /** `titles`: the "Show event titles" opt-in (asks Google for read-only events as well as free/busy). */
  startAuthorization(memberId: string, options: { titles?: boolean } = {}): { ok: true; url: string } | { ok: false; status: number; message: string } {
    if (!this.client) return { ok: false, status: 503, message: "Google Calendar is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect real calendars." };
    if (!this.store.getMembers().some((member) => member.id === memberId)) return { ok: false, status: 404, message: "That household member was not found." };
    return { ok: true, url: this.client.createAuthorization(memberId, { titles: options.titles }).url };
  }

  /** `titles`: "on" / "denied" when the member asked for event titles, null for a plain connect. */
  async completeAuthorization(code: string, state: string): Promise<{ member: Member; titles: "on" | "denied" | null }> {
    if (!this.client) throw new GoogleCalendarError("Google Calendar is not configured.");
    const result = await this.client.completeAuthorization(code, state);
    const member = this.store.getMembers().find((candidate) => candidate.id === result.memberId);
    if (!member) throw new GoogleCalendarError("That household member no longer exists.");
    const previous = this.store.googleCalendarAccount(member.id);
    this.store.saveGoogleCalendarAccount(member.id, result.refreshToken, result.scope);
    this.#links.disconnect(member.id); // one calendar per member: Google replaces a calendar link
    // Adding event access extends the same Google grant; revoking the old token there could
    // revoke the new one with it, so only a plain reconnect revokes the previous token.
    if (previous && previous.refreshToken !== result.refreshToken && !result.titlesRequested) void this.client.revoke(previous.refreshToken);
    this.#clearCache(member.id);
    return { member, titles: result.titlesRequested ? (hasEventTitlesScope(result.scope) ? "on" : "denied") : null };
  }

  /**
   * "Show event titles" switch. On: returns the Google sign-in URL that adds event access.
   * Off: revokes the grant that includes event access (so GroupCart truly loses it) and
   * returns the sign-in URL for busy times only.
   */
  async setEventTitles(memberId: string, enabled: boolean): Promise<{ ok: true; url: string } | { ok: false; status: number; message: string }> {
    if (!this.client) return { ok: false, status: 503, message: "Event titles need Google Calendar. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first." };
    if (!this.store.getMembers().some((member) => member.id === memberId)) return { ok: false, status: 404, message: "That household member was not found." };
    const start = `/api/google/oauth/start?memberId=${encodeURIComponent(memberId)}`;
    if (enabled) return { ok: true, url: `${start}&titles=1` };
    const account = this.store.googleCalendarAccount(memberId);
    if (account && hasEventTitlesScope(account.scope)) await this.disconnect(memberId);
    return { ok: true, url: start };
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

  // --- Calendar links (src/calendarLinks.ts): set, changed, and removed only by their owner (see calendarPage.ts) ---

  /** Saves `memberId`'s calendar link after loading it once. A link replaces that member's Google connection. */
  async connectLink(memberId: string, url: string): Promise<{ ok: true; host: string } | { ok: false; status: number; error: string }> {
    if (!this.store.getMembers().some((member) => member.id === memberId)) return { ok: false, status: 404, error: "That household member was not found." };
    const result = await this.#links.connect(memberId, url);
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    if (this.store.googleCalendarAccount(memberId)) await this.disconnect(memberId);
    return { ok: true, host: result.info.host };
  }

  /** The member's "Show event titles" choice for their link; false when they have no link. */
  setLinkTitles(memberId: string, enabled: boolean): boolean {
    return this.#links.setTitles(memberId, enabled);
  }

  disconnectLink(memberId: string): boolean {
    return this.#links.disconnect(memberId);
  }

  async #collect(window: Interval, weekStarts: string[], timeZone: string): Promise<CalendarWeekMember[]> {
    const members = this.store.getMembers();
    const file = this.#demoFile?.get() ?? null;
    return Promise.all(members.map(async (member, colorIndex): Promise<CalendarWeekMember> => {
      const base: MemberBase = { id: member.id, name: member.name, colorIndex, titlesGranted: false, linkHost: null };
      const account = this.client ? this.store.googleCalendarAccount(member.id) : undefined;
      if (account) return this.#googleMember(base, account, window, timeZone);
      const link = this.#links.info(member.id);
      if (link) return this.#linkMember(base, link, window, timeZone);
      if (!this.#demoMode) return { ...base, status: "not_connected", detail: null, source: null, titles: false, busy: [], events: [] };
      // Demo mode: GROUP_CART_DEMO_CALENDAR replaces the generated sample schedule for members it names.
      const listed = demoCalendarEvents(file, member.name, window);
      if (listed) return { ...base, status: "sample", detail: "Demo calendar file", source: "file", titles: true, events: listed, busy: busyFromItems(listed) };
      const events = weekStarts.flatMap((weekStart) => demoEvents(member.id, colorIndex, weekStart, timeZone))
        .filter((item) => overlapsWindow(item, window));
      return { ...base, status: "sample", detail: "Sample schedule", source: "generated", titles: true, events, busy: busyFromItems(events) };
    }));
  }

  async #googleMember(base: MemberBase, account: GoogleCalendarAccount, window: Interval, timeZone: string): Promise<CalendarWeekMember> {
    const titlesGranted = hasEventTitlesScope(account.scope);
    const failed = { ...base, titlesGranted, source: "google" as const, titles: false, busy: [], events: [] };
    if (account.status === "needs_reconnect") return { ...failed, status: "needs_reconnect", detail: account.lastError };
    try {
      const fetched = await this.#cachedGoogle(base.id, account.refreshToken, window, timeZone, titlesGranted);
      return { ...base, titlesGranted, status: "connected", detail: fetched.detail, source: "google", titles: fetched.titles, events: fetched.events, busy: busyFromItems(fetched.events) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar request failed.";
      if (error instanceof GoogleCalendarError && error.needsReconnect) {
        this.store.markGoogleCalendarNeedsReconnect(base.id, message);
        this.client?.forget(base.id);
        return { ...failed, status: "needs_reconnect", detail: message };
      }
      return { ...failed, status: "error", detail: message };
    }
  }

  async #linkMember(base: MemberBase, link: CalendarLinkInfo, window: Interval, timeZone: string): Promise<CalendarWeekMember> {
    const known = { ...base, titlesGranted: link.titles, linkHost: link.host, source: "link" as const };
    try {
      const events = await this.#links.items(base.id, window, timeZone);
      return { ...known, status: "connected", detail: null, titles: link.titles, events, busy: busyFromItems(events) };
    } catch (error) {
      if (!(error instanceof CalendarLinkError)) console.warn(`Calendar link for ${base.name} failed:`, error instanceof Error ? error.message : error);
      const status = error instanceof CalendarLinkError && error.kind === "needs_reconnect" ? "needs_reconnect" : "error";
      const detail = error instanceof CalendarLinkError ? error.message : "Couldn’t load this calendar.";
      return { ...known, status, detail, titles: false, busy: [], events: [] };
    }
  }

  /** events.list for members who opted in to titles (falls back to busy times if that access is gone), else freeBusy. */
  async #cachedGoogle(memberId: string, refreshToken: string, window: Interval, timeZone: string, titles: boolean): Promise<GoogleFetch> {
    const key = `${memberId}|${titles ? `events|${timeZone}` : "busy"}|${window.start}|${window.end}`;
    const cached = this.#googleCache.get(key);
    if (cached && Date.now() - cached.at < BUSY_CACHE_TTL_MS) return cached.value;
    let value: GoogleFetch;
    if (titles) {
      try {
        value = { events: await this.client!.events(memberId, refreshToken, window, timeZone), titles: true, detail: null };
      } catch (error) {
        if (!(error instanceof GoogleCalendarError) || error.code !== "titles_forbidden") throw error;
        const busy = await this.client!.freeBusy(memberId, refreshToken, window);
        value = { events: itemsFromBusy(busy), titles: false, detail: "Event titles access was removed in Google; showing busy times." };
      }
    } else {
      value = { events: itemsFromBusy(await this.client!.freeBusy(memberId, refreshToken, window)), titles: false, detail: null };
    }
    if (this.#googleCache.size > 200) this.#googleCache.clear();
    this.#googleCache.set(key, { at: Date.now(), value });
    return value;
  }

  #clearCache(memberId: string): void {
    for (const key of this.#googleCache.keys()) if (key.startsWith(`${memberId}|`)) this.#googleCache.delete(key);
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
