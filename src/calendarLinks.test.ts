// Run with: node --import=tsx --test src/calendarLinks.test.ts
// Calendar links (src/icsCalendar.ts, src/calendarLinks.ts): .ics expansion from
// fixture text (recurring class with EXDATE and overrides across DST, all-day,
// transparent, cancelled, private, declined, TZID with and without VTIMEZONE), the
// address checks that keep fetches off localhost and private networks, encrypted
// storage, and the calendar API in live mode (never sample schedules; connect by link).
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { zonedTimeToEpoch } from "./availability.js";
import { CalendarLinkError, CalendarLinkService, fetchCalendarText, isPublicAddress, normalizeCalendarUrl } from "./calendarLinks.js";
import { handleCalendarRequest } from "./calendarPage.js";
import { CalendarService } from "./googleCalendar.js";
import { icsItems, IcsParseError, parseIcs } from "./icsCalendar.js";
import { setRequestMemberResolver } from "./platform.js";
import { CartStore } from "./store.js";

const TZ = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const week = (monday: string) => ({ start: zonedTimeToEpoch(monday, 0, TZ), end: zonedTimeToEpoch(monday, 7 * 24 * 60, TZ) });
let directory: string;

before(() => { directory = mkdtempSync(join(tmpdir(), "groupcart-callinks-")); });
after(() => { rmSync(directory, { recursive: true, force: true }); });

// Google-style feed (VTIMEZONE for Los Angeles, X-WR-CALNAME = owner's email) plus an
// Outlook-style event in a Windows time zone and an IANA TZID without a VTIMEZONE.
const FEED = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:alex@example.com",
  "X-WR-TIMEZONE:America/Los_Angeles",
  "BEGIN:VTIMEZONE",
  "TZID:America/Los_Angeles",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0800",
  "TZOFFSETTO:-0700",
  "TZNAME:PDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0700",
  "TZOFFSETTO:-0800",
  "TZNAME:PST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VTIMEZONE",
  "TZID:Eastern Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  // Weekly class Mon/Wed 9:30-10:50 through March; DST starts Sunday March 8, 2026.
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Los_Angeles:20260302T093000",
  "DTEND;TZID=America/Los_Angeles:20260302T105000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260331T070000Z",
  "EXDATE;TZID=America/Los_Angeles:20260304T093000",
  "UID:class-142@google.com",
  "SUMMARY:CSE 142 Lecture",
  "LOCATION:Kane Hall 120 https://zoom.us/j/123",
  "DESCRIPTION:Syllabus https://example.com/secret",
  "ATTENDEE;CN=prof@example.com;PARTSTAT=ACCEPTED:mailto:prof@example.com",
  "TRANSP:OPAQUE",
  "END:VEVENT",
  // Override: Wednesday March 11 moves to the afternoon.
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Los_Angeles:20260311T130000",
  "DTEND;TZID=America/Los_Angeles:20260311T142000",
  "RECURRENCE-ID;TZID=America/Los_Angeles:20260311T093000",
  "UID:class-142@google.com",
  "SUMMARY:CSE 142 Lecture (moved)",
  "LOCATION:Kane Hall 130",
  "END:VEVENT",
  // Override: Monday March 16 is cancelled.
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Los_Angeles:20260316T093000",
  "DTEND;TZID=America/Los_Angeles:20260316T105000",
  "RECURRENCE-ID;TZID=America/Los_Angeles:20260316T093000",
  "UID:class-142@google.com",
  "SUMMARY:CSE 142 Lecture",
  "STATUS:CANCELLED",
  "END:VEVENT",
  // Override: Wednesday March 25 is moved up to Friday March 13 (into an earlier week).
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Los_Angeles:20260313T100000",
  "DTEND;TZID=America/Los_Angeles:20260313T112000",
  "RECURRENCE-ID;TZID=America/Los_Angeles:20260325T093000",
  "UID:class-142@google.com",
  "SUMMARY:CSE 142 Makeup",
  "END:VEVENT",
  // Another series whose RECURRENCE-ID time collides with the class: must not override the class.
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Los_Angeles:20260309T093000",
  "DTEND;TZID=America/Los_Angeles:20260309T094500",
  "RECURRENCE-ID;TZID=America/Los_Angeles:20260309T093000",
  "UID:other-series@google.com",
  "SUMMARY:Dentist",
  "END:VEVENT",
  // All-day, two days (DTEND exclusive).
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20260305",
  "DTEND;VALUE=DATE:20260307",
  "UID:conference@example.com",
  "SUMMARY:Conference",
  "END:VEVENT",
  // Transparent ("show as available").
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Los_Angeles:20260303T120000",
  "DTEND;TZID=America/Los_Angeles:20260303T130000",
  "UID:lunch@example.com",
  "SUMMARY:Lunch maybe",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  // Cancelled one-off.
  "BEGIN:VEVENT",
  "DTSTART:20260303T170000Z",
  "DTEND:20260303T180000Z",
  "UID:cancelled@example.com",
  "SUMMARY:Cancelled thing",
  "STATUS:CANCELLED",
  "END:VEVENT",
  // Private: time only.
  "BEGIN:VEVENT",
  "DTSTART:20260303T220000Z",
  "DTEND:20260303T230000Z",
  "UID:private@example.com",
  "SUMMARY:Therapy",
  "LOCATION:Clinic",
  "CLASS:PRIVATE",
  "END:VEVENT",
  // Declined by the owner (skipped) and declined by someone else (kept).
  "BEGIN:VEVENT",
  "DTSTART:20260304T000000Z",
  "DTEND:20260304T010000Z",
  "UID:declined@example.com",
  "SUMMARY:Declined party",
  "ATTENDEE;CN=alex@example.com;PARTSTAT=DECLINED:mailto:alex@example.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20260304T020000Z",
  "DTEND:20260304T030000Z",
  "UID:others-declined@example.com",
  "SUMMARY:Book club",
  "ATTENDEE;PARTSTAT=DECLINED:mailto:sam@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:alex@example.com",
  "END:VEVENT",
  // Windows zone name defined by the feed's VTIMEZONE (Outlook), and an IANA TZID with no VTIMEZONE.
  "BEGIN:VEVENT",
  "DTSTART;TZID=Eastern Standard Time:20260303T160000",
  "DTEND;TZID=Eastern Standard Time:20260303T170000",
  "UID:outlook@example.com",
  "SUMMARY:Call with NYC",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Berlin:20260303T090000",
  "DTEND;TZID=Europe/Berlin:20260303T100000",
  "UID:berlin@example.com",
  "SUMMARY:Berlin standup",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const titled = { timeZone: TZ, titles: true };

// ---------------------------------------------------------------------------
// .ics expansion

test("weekly class: EXDATE removes a day, times follow DST, and the series stops at UNTIL", () => {
  const calendar = parseIcs(FEED);
  const first = icsItems(calendar, week("2026-03-02"), titled).filter((item) => item.title?.startsWith("CSE"));
  // Monday 9:30 PST only; Wednesday March 4 is excluded.
  assert.deepEqual(first.map((item) => [item.start, item.end]), [[at("2026-03-02T17:30:00Z"), at("2026-03-02T18:50:00Z")]]);
  // Location keeps the room and drops the meeting link; nothing else is copied.
  assert.deepEqual(first[0], { start: at("2026-03-02T17:30:00Z"), end: at("2026-03-02T18:50:00Z"), title: "CSE 142 Lecture", location: "Kane Hall 120" });
  const april = icsItems(calendar, week("2026-04-06"), titled);
  assert.deepEqual(april, []);
});

test("overrides by RECURRENCE-ID: moved, cancelled, and moved into an earlier week; other UIDs don't interfere", () => {
  const calendar = parseIcs(FEED);
  const items = icsItems(calendar, week("2026-03-09"), titled);
  assert.deepEqual(items.map((item) => [item.title, new Date(item.start).toISOString()]), [
    // Monday March 9 at 9:30 PDT (now UTC-7), untouched by the other series' instance at the same time.
    ["CSE 142 Lecture", "2026-03-09T16:30:00.000Z"],
    ["Dentist", "2026-03-09T16:30:00.000Z"],
    ["CSE 142 Lecture (moved)", "2026-03-11T20:00:00.000Z"],
    ["CSE 142 Makeup", "2026-03-13T17:00:00.000Z"],
  ]);
  assert.equal(items.find((item) => item.title === "CSE 142 Lecture (moved)")!.location, "Kane Hall 130");
  // March 16 is cancelled; March 25 was moved away, so that week has only Monday 23 and Wednesday 18... check both weeks.
  const third = icsItems(calendar, week("2026-03-16"), titled).filter((item) => item.title?.startsWith("CSE"));
  assert.deepEqual(third.map((item) => new Date(item.start).toISOString()), ["2026-03-18T16:30:00.000Z"]);
  const fourth = icsItems(calendar, week("2026-03-23"), titled).filter((item) => item.title?.startsWith("CSE"));
  assert.deepEqual(fourth.map((item) => new Date(item.start).toISOString()), ["2026-03-23T16:30:00.000Z"]);
});

test("all-day, transparent, cancelled, private, declined, and time zones", () => {
  const items = icsItems(parseIcs(FEED), week("2026-03-02"), titled).filter((item) => !item.title?.startsWith("CSE"));
  const byTitle = new Map(items.map((item) => [item.title ?? "(busy)", item]));
  const conference = byTitle.get("Conference")!;
  assert.deepEqual([conference.allDay, conference.start, conference.end], [true, zonedTimeToEpoch("2026-03-05", 0, TZ), zonedTimeToEpoch("2026-03-07", 0, TZ)]);
  assert.equal(byTitle.get("Lunch maybe")!.free, true);
  assert.ok(!byTitle.has("Cancelled thing"));
  assert.ok(!byTitle.has("Declined party"));
  assert.ok(byTitle.has("Book club"), "someone else's decline doesn't hide the event");
  const privateItem = items.find((item) => item.start === at("2026-03-03T22:00:00Z"))!;
  assert.deepEqual(privateItem, { start: at("2026-03-03T22:00:00Z"), end: at("2026-03-03T23:00:00Z"), title: null });
  assert.equal(byTitle.get("Call with NYC")!.start, at("2026-03-03T21:00:00Z")); // 4 PM EST via the feed's VTIMEZONE
  assert.equal(byTitle.get("Berlin standup")!.start, at("2026-03-03T08:00:00Z")); // 9 AM CET via Intl
});

test("busy-only sharing: no titles or places, and 'available' events are left out", () => {
  const items = icsItems(parseIcs(FEED), week("2026-03-02"), { timeZone: TZ, titles: false });
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.title === null && item.location === undefined && !item.free));
  assert.ok(!items.some((item) => item.start === zonedTimeToEpoch("2026-03-03", 12 * 60, TZ)), "transparent lunch is not shown");
  assert.ok(items.some((item) => item.allDay), "all-day busy days stay all-day");
});

test("not a calendar: an HTML page or garbage is rejected", () => {
  assert.throws(() => parseIcs("<!doctype html><html><body>Sign in</body></html>"), IcsParseError);
  assert.throws(() => parseIcs(""), IcsParseError);
});

test("a daily series from years ago still expands quickly", () => {
  const text = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:daily@example.com", "DTSTART:20100104T160000Z", "DTEND:20100104T170000Z", "RRULE:FREQ=DAILY", "SUMMARY:Standup", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const started = performance.now();
  const items = icsItems(parseIcs(text), week("2026-03-02"), titled);
  assert.equal(items.length, 7);
  assert.ok(performance.now() - started < 2_000);
});

// ---------------------------------------------------------------------------
// Address checks (SSRF)

test("calendar addresses: https only, standard port, public hosts; webcal becomes https", () => {
  const google = "https://calendar.google.com/calendar/ical/alex%40gmail.com/private-0123456789abcdef/basic.ics";
  const accepted = normalizeCalendarUrl(`  ${google}  `);
  assert.ok(accepted.ok);
  assert.equal(accepted.url.toString(), google);
  const icloud = normalizeCalendarUrl("webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5#frag");
  assert.ok(icloud.ok);
  assert.equal(icloud.url.toString(), "https://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5");
  assert.ok(normalizeCalendarUrl("https://calendar.google.com:443/calendar/ical/x/basic.ics").ok);
  for (const bad of [
    "http://calendar.google.com/calendar/ical/x/basic.ics",
    "ftp://calendar.google.com/x.ics",
    "https://localhost/x.ics",
    "https://calendar.localhost/x.ics",
    "https://127.0.0.1/x.ics",
    "https://2130706433/x.ics", // 127.0.0.1 written as a number
    "https://10.0.0.8/x.ics",
    "https://172.20.1.1/x.ics",
    "https://192.168.1.10/x.ics",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x.ics",
    "https://[fe80::1]/x.ics",
    "https://[fd12:3456::1]/x.ics",
    "https://[::ffff:127.0.0.1]/x.ics",
    "https://nas.local/x.ics",
    "https://intranet/x.ics",
    "https://calendar.google.com:8443/x.ics",
    "https://user:pass@calendar.google.com/x.ics",
    "not a url",
    "",
  ]) assert.equal(normalizeCalendarUrl(bad).ok, false, bad);
});

test("public address check covers private, link-local, CGNAT, and IPv6 ranges", () => {
  for (const address of ["8.8.8.8", "142.250.72.14", "2607:f8b0:4005:80a::200e"]) assert.equal(isPublicAddress(address), true, address);
  for (const address of ["10.1.2.3", "172.16.0.1", "192.168.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "2001:db8::1", "64:ff9b::a00:1", "not-an-ip"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("fetching refuses a public-looking name that resolves to a private address (checked at connect time)", async () => {
  const url = new URL("https://calendar.example.com/feed.ics");
  await assert.rejects(
    fetchCalendarText(url, { resolveHost: async () => [{ address: "127.0.0.1", family: 4 }] }),
    (error: unknown) => error instanceof CalendarLinkError && /private network/.test(error.message) && !error.message.includes("feed.ics"),
  );
  await assert.rejects(
    fetchCalendarText(url, { resolveHost: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] }),
    /private network/,
  );
});

// ---------------------------------------------------------------------------
// Storage

test("links are stored encrypted, reported by host only, and replaced or removed by their owner's actions", async () => {
  const store = new CartStore(join(directory, "links.sqlite"), "household-links", 5000);
  const [alex] = store.registerMembers([{ handle: "demo:alex", name: "Alex" }]);
  const secret = "https://calendar.google.com/calendar/ical/alex%40example.com/private-SECRET123/basic.ics";
  const fetched: string[] = [];
  const links = new CalendarLinkService(store.database, { fetchCalendar: async (url) => { fetched.push(url.toString()); return FEED; } });
  assert.deepEqual(await links.connect(alex!.id, "http://calendar.google.com/x.ics"), { ok: false, error: "Use the calendar’s https:// or webcal:// address." });
  const result = await links.connect(alex!.id, secret);
  assert.ok(result.ok);
  assert.deepEqual([result.info.host, result.info.titles], ["calendar.google.com", false]);
  const row = store.database.prepare("SELECT * FROM calendar_links WHERE member_id = ?").get(alex!.id) as Record<string, unknown>;
  assert.ok(!JSON.stringify(row).includes("SECRET123"), "the address is not stored in plain text");
  // Cached: reading the week doesn't fetch again.
  const busy = await links.items(alex!.id, week("2026-03-02"), TZ);
  assert.ok(busy.length > 0 && busy.every((item) => item.title === null));
  assert.equal(fetched.length, 1);
  assert.ok(links.setTitles(alex!.id, true));
  assert.ok((await links.items(alex!.id, week("2026-03-02"), TZ)).some((item) => item.title === "CSE 142 Lecture"));
  // A new service (restart) decrypts the stored address with the saved key.
  const reopened = new CalendarLinkService(store.database, { fetchCalendar: async (url) => { fetched.push(url.toString()); return FEED; } });
  await reopened.items(alex!.id, week("2026-03-02"), TZ);
  assert.equal(fetched.at(-1), secret);
  // A feed that turns into an error page is reported, not silently empty.
  const broken = new CalendarLinkService(store.database, { fetchCalendar: async () => "<html>Not found</html>" });
  await assert.rejects(broken.items(alex!.id, week("2026-03-02"), TZ), (error: unknown) => error instanceof CalendarLinkError && error.kind === "error");
  assert.ok(links.disconnect(alex!.id));
  assert.equal(links.info(alex!.id), undefined);
  store.close();
});

// ---------------------------------------------------------------------------
// /api/calendar

async function startCalendarServer(service: CalendarService): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void handleCalendarRequest(service, request, response, url).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const postJson = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("live mode never returns sample schedules: unconnected members are 'Not connected' and nobody is assumed free", async () => {
  const store = new CartStore(join(directory, "live.sqlite"), "household-live", 5000);
  store.registerMembers([{ handle: "+15550000001", name: "Alex" }, { handle: "+15550000002", name: "Maya" }]);
  // Even a showcase file is ignored in live mode.
  const file = join(directory, "showcase.json");
  writeFileSync(file, JSON.stringify({ timeZone: TZ, members: { Alex: [{ title: "Seminar", start: "2026-03-03T10:00", end: "2026-03-03T11:00" }] } }));
  const warn = console.warn;
  console.warn = () => {};
  let service: CalendarService;
  try { service = new CalendarService(store, "http://127.0.0.1:3999", undefined, { demoMode: false, demoCalendarFile: file }); } finally { console.warn = warn; }
  const { server, base } = await startCalendarServer(service);
  try {
    const body = await (await fetch(`${base}/api/calendar?week=2026-03-02&tz=${encodeURIComponent(TZ)}`)).json() as {
      mode: string; included: number; everyoneFree: unknown[]; bestTimes: unknown[];
      members: Array<{ status: string; source: string | null; events: unknown[]; busy: unknown[] }>;
    };
    assert.equal(body.mode, "live");
    assert.deepEqual(body.members.map((member) => [member.status, member.source, member.events.length, member.busy.length]), [["not_connected", null, 0, 0], ["not_connected", null, 0, 0]]);
    assert.deepEqual([body.included, body.everyoneFree, body.bestTimes], [0, [], []]);
    const upcoming = await service.upcomingFreeTimes(at("2026-03-02T12:00:00Z"));
    assert.deepEqual([upcoming.times, upcoming.included, upcoming.missing], [[], 0, ["Alex", "Maya"]]);
  } finally {
    server.close();
    store.close();
  }
});

test("connect by link: only the viewer's own calendar, busy times by default, and the address never reaches the browser", async () => {
  const store = new CartStore(join(directory, "live-link.sqlite"), "household-live-link", 5000);
  const [alex, maya] = store.registerMembers([{ handle: "+15550000001", name: "Alex" }, { handle: "+15550000002", name: "Maya" }]);
  const secret = "webcal://p12-caldav.icloud.com/published/2/SECRETTOKEN42";
  const service = new CalendarService(store, "http://127.0.0.1:3999", undefined, {
    demoMode: false,
    fetchCalendar: async (url) => {
      if (url.toString() !== secret.replace("webcal://", "https://")) throw new CalendarLinkError("This calendar address no longer works.", "needs_reconnect");
      return FEED;
    },
  });
  const { server, base } = await startCalendarServer(service);
  let viewer: string | null = null;
  setRequestMemberResolver(() => (viewer ? { memberId: viewer } : null));
  try {
    assert.equal((await postJson(base, "/api/calendar/link", { url: secret })).status, 401, "no viewer, no link");
    viewer = alex!.id;
    const bad = await postJson(base, "/api/calendar/link", { url: "https://192.168.1.2/cal.ics" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json() as { error: string }).error, /private network/);
    const connected = await postJson(base, "/api/calendar/link", { url: secret });
    assert.equal(connected.status, 200);
    const connectedText = await connected.text();
    assert.ok(!connectedText.includes("SECRETTOKEN42"));
    assert.deepEqual(JSON.parse(connectedText), { ok: true, host: "p12-caldav.icloud.com" });

    const weekText = await (await fetch(`${base}/api/calendar?week=2026-03-02&tz=${encodeURIComponent(TZ)}`)).text();
    assert.ok(!weekText.includes("SECRETTOKEN42"), "the secret address is never sent back");
    const data = JSON.parse(weekText) as { viewerId: string; included: number; members: Array<{ id: string; status: string; source: string; linkHost: string | null; titles: boolean; events: Array<{ title: string | null }> }> };
    const mine = data.members.find((member) => member.id === alex!.id)!;
    assert.equal(data.viewerId, alex!.id);
    assert.deepEqual([mine.status, mine.source, mine.linkHost, mine.titles, data.included], ["connected", "link", "p12-caldav.icloud.com", false, 1]);
    assert.ok(mine.events.length > 0 && mine.events.every((item) => item.title === null));
    assert.equal(data.members.find((member) => member.id === maya!.id)!.status, "not_connected");

    // Titles are the owner's opt-in; Maya can't change Alex's link (she only ever acts on her own).
    viewer = maya!.id;
    assert.equal((await postJson(base, "/api/calendar/link/titles", { enabled: true })).status, 404);
    viewer = alex!.id;
    assert.equal((await postJson(base, "/api/calendar/link/titles", { enabled: true })).status, 200);
    const withTitles = await service.week({ week: "2026-03-02", timeZone: TZ });
    assert.ok(withTitles.members.find((member) => member.id === alex!.id)!.events.some((item) => item.title === "CSE 142 Lecture"));

    // The coordinator's free-time tools read the same calendars.
    const free = await service.upcomingFreeTimes(at("2026-03-02T15:00:00Z"), 2, 3);
    assert.deepEqual([free.included, free.total, free.missing], [1, 2, ["Maya"]]);
    assert.ok(free.times.length > 0 && free.times.every((time) => time.end <= at("2026-03-02T17:30:00Z") || time.start >= at("2026-03-02T18:50:00Z")), "class time is not free");

    assert.equal((await postJson(base, "/api/calendar/link/disconnect", {})).status, 200);
    const afterDisconnect = await service.week({ week: "2026-03-02", timeZone: TZ });
    assert.equal(afterDisconnect.members.find((member) => member.id === alex!.id)!.status, "not_connected");
  } finally {
    setRequestMemberResolver(null);
    server.close();
    store.close();
  }
});

test("a link that stops working shows 'Reconnect needed' instead of an empty calendar", async () => {
  const store = new CartStore(join(directory, "live-broken.sqlite"), "household-live-broken", 5000);
  const [alex] = store.registerMembers([{ handle: "+15550000001", name: "Alex" }]);
  const working = new CalendarService(store, "http://127.0.0.1:3999", undefined, { demoMode: false, fetchCalendar: async () => FEED });
  assert.ok((await working.connectLink(alex!.id, "https://calendar.google.com/calendar/ical/a/private-b/basic.ics")).ok);
  // Later (a new process, so nothing cached), the owner has reset the secret address.
  const reset = new CalendarService(store, "http://127.0.0.1:3999", undefined, {
    demoMode: false,
    fetchCalendar: async () => { throw new CalendarLinkError("This calendar address no longer works (it may have been reset). Paste the new secret address.", "needs_reconnect"); },
  });
  const member = (await reset.week({ week: "2026-03-02", timeZone: TZ })).members[0]!;
  assert.deepEqual([member.status, member.source, member.linkHost, member.events.length], ["needs_reconnect", "link", "calendar.google.com", 0]);
  assert.match(member.detail ?? "", /no longer works/);
  store.close();
});
