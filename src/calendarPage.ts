// The /calendar page and its HTTP routes. The page is split into separable
// pieces (renderCalendarBody -> { styles, body, script }) so it can be dropped
// into a shared app shell; renderCalendarPage() wraps it as a standalone document.
// Colors come from --gc-* custom properties (defined by the wrapper or a shell).
import { renderNotice, renderPage } from "./ui/shell.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GoogleCalendarError, type CalendarService } from "./googleCalendar.js";

const styles = String.raw`
.cal { --cal-hour-px: 44px; --cal-gutter: 52px;
  --cal-line: var(--gc-border); --cal-line-soft: color-mix(in srgb, var(--gc-border) 55%, transparent);
  --cal-surface-2: var(--gc-surface-2, color-mix(in srgb, var(--gc-text) 3%, var(--gc-surface)));
  --cal-free-bg: rgba(24,128,56,.09); --cal-free-edge: #1e8e3e; --cal-free-text: #137333;
  --cal-ovl-2: rgba(60,64,67,.12); --cal-ovl-3: rgba(60,64,67,.24); --cal-ovl-4: rgba(60,64,67,.34); --cal-ovl-edge: #5f6368;
  --cal-now: #d93025; --cal-warn: #b06000; --cal-danger: #c5221f;
  color: var(--gc-text); }
.cal .m0 { --m-solid:#1a73e8; --m-soft:#e8f0fe; --m-on:#174ea6; }
.cal .m1 { --m-solid:#e37400; --m-soft:#feefe3; --m-on:#9a4a00; }
.cal .m2 { --m-solid:#9334e6; --m-soft:#f3e8fd; --m-on:#681da8; }
.cal .m3 { --m-solid:#12a4af; --m-soft:#e2f6f8; --m-on:#0a6b73; }
.cal .m4 { --m-solid:#d01884; --m-soft:#fde7f3; --m-on:#9b1063; }
.cal .m5 { --m-solid:#8d6e63; --m-soft:#f2ebe8; --m-on:#5d4037; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cal { --cal-free-bg: rgba(129,201,149,.13); --cal-free-edge:#81c995; --cal-free-text:#a8dab5;
    --cal-ovl-2: rgba(255,255,255,.07); --cal-ovl-3: rgba(255,255,255,.14); --cal-ovl-4: rgba(255,255,255,.2); --cal-ovl-edge:#9aa0a6; --cal-now:#f28b82; --cal-warn:#fdd663; --cal-danger:#f28b82; }
  :root:not([data-theme="light"]) .cal .m0 { --m-solid:#8ab4f8; --m-soft:rgba(138,180,248,.2); --m-on:#d2e3fc; }
  :root:not([data-theme="light"]) .cal .m1 { --m-solid:#fcad70; --m-soft:rgba(252,173,112,.2); --m-on:#fde3cf; }
  :root:not([data-theme="light"]) .cal .m2 { --m-solid:#c58af9; --m-soft:rgba(197,138,249,.2); --m-on:#efe1fd; }
  :root:not([data-theme="light"]) .cal .m3 { --m-solid:#78d9ec; --m-soft:rgba(120,217,236,.18); --m-on:#cbf0f8; }
  :root:not([data-theme="light"]) .cal .m4 { --m-solid:#ff8bcb; --m-soft:rgba(255,139,203,.2); --m-on:#fdd5ea; }
  :root:not([data-theme="light"]) .cal .m5 { --m-solid:#bcaaa4; --m-soft:rgba(188,170,164,.2); --m-on:#efebe9; }
}
:root[data-theme="dark"] .cal { --cal-free-bg: rgba(129,201,149,.13); --cal-free-edge:#81c995; --cal-free-text:#a8dab5;
  --cal-ovl-2: rgba(255,255,255,.07); --cal-ovl-3: rgba(255,255,255,.14); --cal-ovl-4: rgba(255,255,255,.2); --cal-ovl-edge:#9aa0a6; --cal-now:#f28b82; --cal-warn:#fdd663; --cal-danger:#f28b82; }
:root[data-theme="dark"] .cal .m0 { --m-solid:#8ab4f8; --m-soft:rgba(138,180,248,.2); --m-on:#d2e3fc; }
:root[data-theme="dark"] .cal .m1 { --m-solid:#fcad70; --m-soft:rgba(252,173,112,.2); --m-on:#fde3cf; }
:root[data-theme="dark"] .cal .m2 { --m-solid:#c58af9; --m-soft:rgba(197,138,249,.2); --m-on:#efe1fd; }
:root[data-theme="dark"] .cal .m3 { --m-solid:#78d9ec; --m-soft:rgba(120,217,236,.18); --m-on:#cbf0f8; }
:root[data-theme="dark"] .cal .m4 { --m-solid:#ff8bcb; --m-soft:rgba(255,139,203,.2); --m-on:#fdd5ea; }
:root[data-theme="dark"] .cal .m5 { --m-solid:#bcaaa4; --m-soft:rgba(188,170,164,.2); --m-on:#efebe9; }

.cal, .cal * { box-sizing: border-box; }
.cal h1, .cal h2, .cal p, .cal ul, .cal ol { margin: 0; padding: 0; }
.cal ul, .cal ol { list-style: none; }
.cal button, .cal .cal-btn { font: inherit; }
.cal-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:14px; }
.cal-nav { display:flex; align-items:center; gap:6px; min-width:0; }
.cal-range { font-size:20px; font-weight:500; letter-spacing:-.01em; margin-left:8px !important; white-space:nowrap; }
.cal-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:34px; padding:0 14px; border-radius:999px;
  border:1px solid var(--gc-border); background:var(--gc-surface); color:var(--gc-text); font-size:14px; font-weight:500; cursor:pointer; text-decoration:none; white-space:nowrap; }
.cal-btn:hover { background:var(--cal-surface-2); }
.cal-btn:focus-visible, .cal-icon:focus-visible, .cal-best button:focus-visible { outline:2px solid var(--gc-accent); outline-offset:2px; }
.cal-btn.primary { background:var(--gc-accent); border-color:var(--gc-accent); color:var(--gc-on-accent, #fff); }
.cal-btn.primary:hover { filter:brightness(1.06); }
.cal-btn.quiet { border-color:transparent; background:transparent; color:var(--gc-muted); padding:0 10px; }
.cal-btn.quiet:hover { color:var(--gc-text); background:var(--cal-surface-2); }
.cal-btn[aria-disabled="true"], .cal-btn:disabled { opacity:.5; cursor:not-allowed; pointer-events:none; }
.cal-icon { width:34px; height:34px; border-radius:50%; border:0; background:transparent; color:var(--gc-text); font-size:20px; line-height:1; cursor:pointer; display:grid; place-items:center; }
.cal-icon:hover { background:var(--cal-surface-2); }
.cal-chip { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 12px; border-radius:999px; background:var(--gc-accent-soft); color:var(--gc-accent); font-size:12.5px; font-weight:500; white-space:nowrap; }
.cal-chip::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
.cal-notice { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; margin-bottom:14px; border-radius:var(--gc-radius-md, 12px); background:var(--gc-accent-soft); color:var(--gc-text); font-size:13.5px; }
.cal-notice[hidden] { display:none; }
.cal-notice.warn { background:color-mix(in srgb, var(--cal-warn) 14%, var(--gc-surface)); }
.cal-notice button { border:0; background:transparent; color:var(--gc-muted); font-size:18px; cursor:pointer; line-height:1; }

.cal-layout { display:grid; grid-template-columns:minmax(0,1fr) 290px; grid-template-rows:auto 1fr; grid-template-areas:"main best" "main people"; gap:16px 20px; align-items:start; }
.cal-main { grid-area:main; min-width:0; border:1px solid var(--gc-border); border-radius:var(--gc-radius-md, 12px); background:var(--gc-surface); overflow:hidden; }
#calBestPanel { grid-area:best; } #calPeoplePanel { grid-area:people; }
.cal-panel { border:1px solid var(--gc-border); border-radius:var(--gc-radius-md, 12px); background:var(--gc-surface); padding:16px; }
.cal-panel h2 { font-size:14px; font-weight:600; margin-bottom:12px !important; }
.cal-foot { color:var(--gc-muted); font-size:12px; margin-top:10px !important; }

.cal-people { display:grid; gap:12px; }
.cal-person { display:grid; grid-template-columns:32px minmax(0,1fr); gap:4px 10px; align-items:center; }
.cal-avatar { width:32px; height:32px; border-radius:50%; display:grid; place-items:center; background:var(--m-solid); color:var(--gc-surface); font-weight:600; font-size:13px; }
.cal-person-name { font-weight:500; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cal-status { display:flex; align-items:center; gap:6px; color:var(--gc-muted); font-size:12px; }
.cal-status::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--gc-border); flex:none; }
.cal-status.ok::before { background:var(--cal-free-edge); }
.cal-status.sample::before { background:var(--m-solid); }
.cal-status.warn { color:var(--cal-warn); } .cal-status.warn::before { background:var(--cal-warn); }
.cal-status.bad { color:var(--cal-danger); } .cal-status.bad::before { background:var(--cal-danger); }
.cal-person-actions { grid-column:2; display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; }
.cal-person-actions .cal-btn { height:30px; font-size:13px; padding:0 12px; }

.cal-best { display:grid; gap:4px; }
.cal-best button { width:100%; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 10px; align-items:center; text-align:left; padding:9px 10px; margin:0 -10px; width:calc(100% + 20px);
  border:0; border-radius:10px; background:transparent; color:inherit; cursor:pointer; }
.cal-best button:hover { background:var(--cal-surface-2); }
.cal-best-day { font-weight:500; font-size:13.5px; }
.cal-best-time { color:var(--gc-muted); font-size:12.5px; grid-column:1; }
.cal-best-len { grid-column:2; grid-row:1 / span 2; font-size:12px; font-weight:600; color:var(--cal-free-text); background:var(--cal-free-bg); border-radius:999px; padding:3px 9px; white-space:nowrap; }
.cal-empty { color:var(--gc-muted); font-size:13px; }

.cal-scroll { overflow:auto; max-height:min(760px, calc(100vh - 150px)); overscroll-behavior:contain; scroll-padding-left:var(--cal-gutter); }
.cal-grid { display:grid; grid-template-columns:var(--cal-gutter) repeat(7, minmax(var(--cal-col-min, 112px), 1fr)); min-width:min-content; position:relative; }
.cal-grid[aria-busy="true"] { opacity:.55; transition:opacity .2s; }
.cal-corner, .cal-head { position:sticky; top:0; z-index:6; background:var(--gc-surface); border-bottom:1px solid var(--cal-line); }
.cal-corner { left:0; z-index:8; display:flex; align-items:flex-end; justify-content:center; padding-bottom:6px; color:var(--gc-muted); font-size:10px; }
.cal-head { text-align:center; padding:10px 4px 8px; border-left:1px solid var(--cal-line-soft); }
.cal-head-dow { font-size:11px; font-weight:500; letter-spacing:.06em; text-transform:uppercase; color:var(--gc-muted); }
.cal-head-date { width:34px; height:34px; margin:2px auto 0; border-radius:50%; display:grid; place-items:center; font-size:20px; font-weight:400; }
.cal-head.today .cal-head-dow { color:var(--gc-accent); }
.cal-head.today .cal-head-date { background:var(--gc-accent); color:var(--gc-on-accent, #fff); font-weight:500; }
.cal-head-free { font-size:10.5px; color:var(--cal-free-text); margin-top:3px; min-height:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cal-gutter { position:sticky; left:0; z-index:5; background:var(--gc-surface); height:calc(var(--cal-hours) * var(--cal-hour-px)); }
.cal-gutter span { position:absolute; right:8px; transform:translateY(-50%); font-size:10.5px; color:var(--gc-muted); white-space:nowrap; }
.cal-day { position:relative; height:calc(var(--cal-hours) * var(--cal-hour-px)); border-left:1px solid var(--cal-line-soft);
  background-image:linear-gradient(to bottom, var(--cal-line-soft) 1px, transparent 1px); background-size:100% var(--cal-hour-px); }
.cal-day.weekend { background-color:color-mix(in srgb, var(--gc-text) 1.5%, transparent); }
.cal-day.past::after { content:""; position:absolute; left:0; right:0; top:0; height:var(--past-h, 0); background:color-mix(in srgb, var(--gc-surface) 38%, transparent); pointer-events:none; z-index:4; }
.cal-free { position:absolute; left:0; right:0; z-index:1; background:var(--cal-free-bg); border-left:3px solid var(--cal-free-edge); border-radius:0 6px 6px 0; }
.cal-free span { display:block; padding:3px 6px; font-size:10.5px; font-weight:600; color:var(--cal-free-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cal-free.flash { animation:cal-flash 1.4s ease 2; }
@keyframes cal-flash { 50% { box-shadow:inset 0 0 0 2px var(--cal-free-edge); } }
.cal-lane { position:absolute; top:0; bottom:0; z-index:2; }
.cal-busy { position:absolute; left:1px; right:1px; border-radius:5px; background:var(--m-soft); border-left:3px solid var(--m-solid); color:var(--m-on); overflow:hidden; }
.cal-busy span { display:block; padding:2px 4px; font-size:10.5px; font-weight:500; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cal-ovl { position:absolute; left:0; right:0; z-index:3; }
.cal-ovl.c2 { background:var(--cal-ovl-2); } .cal-ovl.c3 { background:var(--cal-ovl-3); } .cal-ovl.c4 { background:var(--cal-ovl-4); }
.cal-grid.narrow .cal-busy span { display:none; }
.cal-now { position:absolute; left:-1px; right:0; z-index:7; height:2px; background:var(--cal-now); pointer-events:none; }
.cal-now::before { content:""; position:absolute; left:-5px; top:-4px; width:10px; height:10px; border-radius:50%; background:var(--cal-now); }

.cal-key { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; padding:10px 14px; border-top:1px solid var(--gc-border); color:var(--gc-muted); font-size:12px; }
.cal-key i { display:inline-block; width:14px; height:12px; border-radius:3px; vertical-align:-2px; margin-right:6px; }
.cal-key .k-member { background:var(--m-soft); border-left:3px solid var(--m-solid); }
.cal-key .k-ovl2 { background:var(--cal-ovl-2); box-shadow:inset 0 0 0 1px var(--cal-line-soft); }
.cal-key .k-ovl3 { background:var(--cal-ovl-3); box-shadow:inset 0 0 0 1px var(--cal-line-soft); }
.cal-key .k-free { background:var(--cal-free-bg); border-left:3px solid var(--cal-free-edge); }

@media (max-width: 1060px) {
  .cal-layout { grid-template-columns:1fr; grid-template-rows:none; grid-template-areas:"best" "main" "people"; }
}
@media (max-width: 640px) {
  .cal { --cal-hour-px: 40px; --cal-gutter: 44px; }
  .cal-range { font-size:17px; margin-left:4px !important; }
  .cal-toolbar { margin-bottom:10px; }
  .cal-scroll { max-height:calc(100vh - 120px); }
}
@media (prefers-reduced-motion: reduce) { .cal-free.flash { animation:none; box-shadow:inset 0 0 0 2px var(--cal-free-edge); } }
`;

const body = String.raw`
<div class="cal" id="cal">
  <div class="cal-toolbar">
    <div class="cal-nav">
      <button class="cal-btn" id="calToday" type="button">Today</button>
      <button class="cal-icon" id="calPrev" type="button" aria-label="Previous week" title="Previous week (←)">&#8249;</button>
      <button class="cal-icon" id="calNext" type="button" aria-label="Next week" title="Next week (→)">&#8250;</button>
      <h1 class="cal-range" id="calRange" aria-live="polite">This week</h1>
    </div>
    <span class="cal-chip" id="calMode">Loading…</span>
  </div>
  <div class="cal-notice" id="calNotice" role="status" hidden><span id="calNoticeText"></span><button type="button" id="calNoticeClose" aria-label="Dismiss">&times;</button></div>
  <div class="cal-layout">
    <section class="cal-main" aria-label="Week view">
      <div class="cal-scroll" id="calScroll"><div class="cal-grid" id="calGrid" aria-busy="true"></div></div>
      <div class="cal-key" id="calKey"></div>
    </section>
    <section class="cal-panel" id="calBestPanel" aria-labelledby="calBestTitle">
      <h2 id="calBestTitle">Best times everyone is free</h2>
      <ol class="cal-best" id="calBest"><li class="cal-empty">Loading…</li></ol>
      <p class="cal-foot" id="calBestFoot"></p>
    </section>
    <section class="cal-panel" id="calPeoplePanel" aria-labelledby="calPeopleTitle">
      <h2 id="calPeopleTitle">Calendars</h2>
      <ul class="cal-people" id="calPeople"></ul>
      <p class="cal-foot" id="calPeopleFoot"></p>
    </section>
  </div>
</div>
`;

const script = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
  const params = new URLSearchParams(location.search);
  let week = /^\d{4}-\d{2}-\d{2}$/.test(params.get("week") || "") ? params.get("week") : "";
  let data = null;
  let loading = 0;
  let firstRender = true;
  const fmt = {};
  const formatter = (key, options) => fmt[key + data.timeZone] || (fmt[key + data.timeZone] = new Intl.DateTimeFormat(undefined, { timeZone: data.timeZone, ...options }));
  const partsFmt = () => formatter("parts", { hour: "numeric", minute: "numeric", hourCycle: "h23" });
  function minutesInDay(ms, day) {
    if (ms <= day.start) return 0;
    if (ms >= day.end) return 1440;
    let h = 0, m = 0;
    for (const p of partsFmt().formatToParts(new Date(ms))) { if (p.type === "hour") h = Number(p.value) % 24; if (p.type === "minute") m = Number(p.value); }
    return h * 60 + m;
  }
  const timeRange = (a, b) => formatter("range", { hour: "numeric", minute: "2-digit" }).formatRange(new Date(a), new Date(b));
  function shortTime(ms) {
    const parts = formatter("short", { hour: "numeric", minute: "2-digit" }).formatToParts(new Date(ms));
    const hour = (parts.find((p) => p.type === "hour") || {}).value || "";
    const minute = (parts.find((p) => p.type === "minute") || {}).value || "00";
    return minute === "00" ? hour : hour + ":" + minute;
  }
  function duration(ms) {
    const total = Math.round(ms / 60000), h = Math.floor(total / 60), m = total % 60;
    return h ? (m ? h + " h " + m + " m" : h + " h") : m + " min";
  }
  const utcHour = new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" });
  function compactDuration(ms) {
    const total = Math.round(ms / 60000), h = Math.floor(total / 60), m = total % 60;
    return h ? (m ? h + "h " + m + "m" : h + "h") : m + "m";
  }
  const hourLabel = (h) => utcHour.format(new Date(Date.UTC(2020, 0, 1, h))).replace(/\s/g, " ");
  const colorClass = (member) => "mx-" + String(member.id).replace(/[^a-zA-Z0-9_-]/g, "");
  // Member colors come from the shared shell (GC.memberColor) so they match every other page.
  function applyMemberColors(members) {
    const ids = members.map((m) => m.id);
    const fallback = ["#1a73e8", "#e37400", "#9334e6", "#12a4af", "#d01884", "#8d6e63"];
    const rules = members.map((m, i) => {
      const solid = window.GC && GC.memberColor ? GC.memberColor(m.id, ids).solid : fallback[i % fallback.length];
      return ".cal ." + colorClass(m) + " { --m-solid:" + solid + "; --m-soft:color-mix(in srgb, " + solid + " 16%, var(--gc-surface)); --m-on:color-mix(in srgb, " + solid + " 72%, var(--gc-text)); }";
    }).join("\n");
    let tag = document.getElementById("calMemberColors");
    if (!tag) { tag = document.createElement("style"); tag.id = "calMemberColors"; document.head.appendChild(tag); }
    tag.textContent = rules;
  }

  function showNotice(text, warn) {
    $("calNoticeText").textContent = text;
    $("calNotice").classList.toggle("warn", Boolean(warn));
    $("calNotice").hidden = false;
  }
  $("calNoticeClose").addEventListener("click", () => { $("calNotice").hidden = true; });

  async function load(nextWeek) {
    if (nextWeek !== undefined) week = nextWeek;
    const token = ++loading;
    $("calGrid").setAttribute("aria-busy", "true");
    const query = new URLSearchParams();
    if (week) query.set("week", week);
    if (tz) query.set("tz", tz);
    try {
      const response = await fetch("/api/calendar?" + query.toString(), { headers: { accept: "application/json" } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load the calendar.");
      if (token !== loading) return;
      data = body;
      applyMemberColors(data.members);
      week = data.weekStart;
      const url = new URL(location.href);
      url.searchParams.delete("connected"); url.searchParams.delete("disconnected");
      if (week && week !== mondayOfToday()) url.searchParams.set("week", week); else url.searchParams.delete("week");
      history.replaceState(null, "", url.pathname + (url.search ? url.search : ""));
      render();
    } catch (error) {
      if (token === loading) showNotice(error.message || "Could not load the calendar.", true);
    } finally {
      if (token === loading) $("calGrid").setAttribute("aria-busy", "false");
    }
  }
  function mondayOfToday() {
    if (!data) return "";
    const d = new Date(data.today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }

  function render() {
    const days = data.days;
    const first = new Date(days[0].start), last = new Date(days[6].start);
    $("calRange").textContent = formatter("range-date", { month: "short", day: "numeric", year: "numeric" }).formatRange(first, last);
    $("calMode").textContent = data.mode === "demo" ? "Sample schedules" : "Google Calendar · busy times only";
    renderPeople();
    renderBest();
    renderGrid();
    renderKey();
  }

  function renderPeople() {
    const demo = data.mode === "demo";
    $("calPeople").innerHTML = data.members.map((member) => {
      const statuses = {
        sample: ["sample", "Sample schedule"],
        connected: ["ok", "Connected"],
        not_connected: ["", "Not connected"],
        needs_reconnect: ["warn", "Reconnect needed"],
        error: ["bad", "Couldn’t load"],
      };
      const [cls, label] = statuses[member.status] || ["", member.status];
      const startUrl = "/api/google/oauth/start?memberId=" + encodeURIComponent(member.id);
      let actions = "";
      if (demo) actions = '<span class="cal-btn" aria-disabled="true" title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect">Connect Google Calendar</span>';
      else if (member.status === "not_connected") actions = '<a class="cal-btn primary" href="' + startUrl + '">Connect Google Calendar</a>';
      else if (member.status === "needs_reconnect") actions = '<a class="cal-btn primary" href="' + startUrl + '">Reconnect</a><button class="cal-btn quiet" type="button" data-disconnect="' + esc(member.id) + '">Disconnect</button>';
      else if (member.status === "error") actions = '<button class="cal-btn" type="button" data-retry>Retry</button><button class="cal-btn quiet" type="button" data-disconnect="' + esc(member.id) + '">Disconnect</button>';
      else actions = '<button class="cal-btn quiet" type="button" data-disconnect="' + esc(member.id) + '">Disconnect</button>';
      const detail = member.detail && (member.status === "needs_reconnect" || member.status === "error") ? ' title="' + esc(member.detail) + '"' : "";
      return '<li class="cal-person ' + colorClass(member) + '"><span class="cal-avatar" aria-hidden="true">' + esc(member.name.slice(0, 1).toUpperCase()) + '</span>'
        + '<div><div class="cal-person-name">' + esc(member.name) + '</div><div class="cal-status ' + cls + '"' + detail + '>' + esc(label) + '</div></div>'
        + '<div class="cal-person-actions">' + actions + '</div></li>';
    }).join("") || '<li class="cal-empty">No household members yet.</li>';
    $("calPeopleFoot").textContent = demo
      ? "Demo mode: schedules are generated samples. Add Google OAuth credentials to connect real calendars."
      : "Each person signs in with their own Google account. GroupCart sees only busy times, never event details.";
  }

  function renderBest() {
    const list = $("calBest");
    const total = data.members.length;
    if (!data.included) {
      list.innerHTML = '<li class="cal-empty">Connect at least one calendar to find shared free time.</li>';
    } else if (!data.bestTimes.length) {
      list.innerHTML = '<li class="cal-empty">No shared hour-long gaps left this week. Try next week.</li>';
    } else {
      list.innerHTML = data.bestTimes.map((slot) => '<li><button type="button" data-slot="' + slot.start + '">'
        + '<span class="cal-best-day">' + esc(formatter("best-day", { weekday: "long", month: "short", day: "numeric" }).format(new Date(slot.start))) + '</span>'
        + '<span class="cal-best-len">' + esc(duration(slot.end - slot.start)) + '</span>'
        + '<span class="cal-best-time">' + esc(timeRange(slot.start, slot.end)) + '</span></button></li>').join("");
    }
    const hours = hourLabel(data.freeHours.startMinutes / 60) + "–" + hourLabel(data.freeHours.endMinutes / 60);
    const basis = data.included && data.included < total ? " Based on " + data.included + " of " + total + " calendars." : "";
    $("calBestFoot").textContent = "Windows of 1 hour or more between " + hours + ", good for a pickup or delivery slot." + basis;
  }

  function renderGrid() {
    const days = data.days;
    const members = data.members;
    const lanes = Math.max(1, members.length);
    // Visible hours: 7 AM–10 PM, stretched to fit any busy block.
    let startHour = 7, endHour = 22;
    for (const member of members) for (const block of member.busy) for (const day of days) {
      if (block.end <= day.start || block.start >= day.end) continue;
      startHour = Math.min(startHour, Math.floor(minutesInDay(block.start, day) / 60));
      endHour = Math.max(endHour, Math.ceil(minutesInDay(block.end, day) / 60));
    }
    const hours = endHour - startHour;
    const pxPerMin = () => parseFloat(getComputedStyle($("cal")).getPropertyValue("--cal-hour-px")) / 60 || 44 / 60;
    const ppm = pxPerMin();
    const top = (minutes) => ((minutes - startHour * 60) * ppm).toFixed(1) + "px";
    const height = (a, b) => Math.max(2, (b - a) * ppm).toFixed(1) + "px";
    const grid = $("calGrid");
    grid.style.setProperty("--cal-hours", String(hours));
    grid.style.setProperty("--cal-col-min", Math.max(84, lanes * 24 + 12) + "px");
    const now = Date.now();
    const freeByDay = days.map((day) => data.everyoneFree.filter((w) => w.end > day.start && w.start < day.end));
    let html = '<div class="cal-corner">' + esc(shortZone()) + '</div>';
    days.forEach((day, index) => {
      const d = new Date(day.start + 1);
      const isToday = day.date === data.today;
      const freeMs = freeByDay[index].reduce((sum, w) => sum + Math.max(0, Math.min(w.end, day.end) - Math.max(w.start, day.start, now)), 0);
      const freeText = data.included && day.end > now && freeMs >= 30 * 60000 ? compactDuration(freeMs) + " free" : "";
      html += '<div class="cal-head' + (isToday ? " today" : "") + '"' + (isToday ? ' aria-current="date"' : "") + '>'
        + '<div class="cal-head-dow">' + esc(formatter("dow", { weekday: "short" }).format(d)) + '</div>'
        + '<div class="cal-head-date">' + esc(formatter("dnum", { day: "numeric" }).format(d)) + '</div>'
        + '<div class="cal-head-free">' + esc(freeText) + '</div></div>';
    });
    html += '<div class="cal-gutter" aria-hidden="true">';
    for (let h = startHour + 1; h < endHour; h += 1) html += '<span style="top:' + ((h - startHour) * 60 * ppm) + 'px">' + esc(hourLabel(h)) + '</span>';
    html += '</div>';
    days.forEach((day, index) => {
      const weekday = new Date(day.date + "T12:00:00Z").getUTCDay();
      const classes = ["cal-day"];
      if (weekday === 0 || weekday === 6) classes.push("weekend");
      let style = "";
      if (day.end <= now) { classes.push("past"); style = ' style="--past-h:100%"'; }
      else if (day.start <= now) { classes.push("past"); style = ' style="--past-h:' + Math.max(0, (minutesInDay(now, day) - startHour * 60) * ppm).toFixed(1) + 'px"'; }
      html += '<div class="' + classes.join(" ") + '" data-date="' + day.date + '"' + style + '>';
      for (const w of freeByDay[index]) {
        const a = minutesInDay(w.start, day), b = minutesInDay(w.end, day);
        const label = "Everyone free · " + timeRange(w.start, w.end);
        html += '<div class="cal-free" data-start="' + w.start + '" data-end="' + w.end + '" style="top:' + top(a) + ';height:' + height(a, b) + '" title="' + esc(label) + '">'
          + ((b - a) * ppm >= 22 ? '<span>All free</span>' : "") + '</div>';
      }
      members.forEach((member, lane) => {
        html += '<div class="cal-lane ' + colorClass(member) + '" style="left:' + (lane * 100 / lanes) + '%;width:' + (100 / lanes) + '%">';
        for (const block of member.busy) {
          if (block.end <= day.start || block.start >= day.end) continue;
          const a = Math.max(minutesInDay(block.start, day), startHour * 60), b = Math.min(minutesInDay(block.end, day), endHour * 60);
          if (b <= a) continue;
          const label = member.name + " busy · " + timeRange(Math.max(block.start, day.start), Math.min(block.end, day.end));
          const text = (b - a) * ppm >= 26 && lanes <= 4 ? '<span>' + esc(shortTime(Math.max(block.start, day.start)) + "–" + shortTime(Math.min(block.end, day.end))) + '</span>' : "";
          html += '<div class="cal-busy" style="top:' + top(a) + ';height:' + height(a, b) + '" title="' + esc(label) + '">' + text + '</div>';
        }
        html += '</div>';
      });
      for (const o of data.overlaps) {
        if (o.end <= day.start || o.start >= day.end) continue;
        const a = Math.max(minutesInDay(o.start, day), startHour * 60), b = Math.min(minutesInDay(o.end, day), endHour * 60);
        if (b <= a) continue;
        const names = o.memberIds.map((id) => (members.find((m) => m.id === id) || {}).name || "?").join(", ");
        const label = o.count + " busy at once (" + names + ") · " + timeRange(Math.max(o.start, day.start), Math.min(o.end, day.end));
        html += '<div class="cal-ovl c' + Math.min(o.count, 4) + '" style="top:' + top(a) + ';height:' + height(a, b) + '" title="' + esc(label) + '"></div>';
      }
      if (day.date === data.today && now >= day.start && now < day.end) {
        const m = minutesInDay(now, day);
        if (m >= startHour * 60 && m <= endHour * 60) html += '<div class="cal-now" id="calNow" style="top:' + top(m) + '"></div>';
      }
      html += '</div>';
    });
    grid.innerHTML = html;
    const firstDay = grid.querySelector(".cal-day");
    grid.classList.toggle("narrow", Boolean(firstDay) && firstDay.clientWidth / lanes < 44);
    if (firstRender) {
      firstRender = false;
      const scroll = $("calScroll");
      scroll.scrollTop = Math.max(0, (Math.max(startHour, 7) - startHour) * 60 * ppm);
      const today = grid.querySelector('.cal-day[data-date="' + data.today + '"]');
      if (today && scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = Math.max(0, today.offsetLeft - scroll.clientWidth / 2 + today.offsetWidth / 2);
    }
  }

  function shortZone() {
    try {
      const part = new Intl.DateTimeFormat(undefined, { timeZone: data.timeZone, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
      return part ? part.value : "";
    } catch { return ""; }
  }

  function renderKey() {
    const people = data.members.filter((m) => m.status === "sample" || m.status === "connected")
      .map((m) => '<span class="' + colorClass(m) + '"><i class="k-member"></i>' + esc(m.name) + '</span>').join("");
    $("calKey").innerHTML = people
      + '<span><i class="k-ovl2"></i>2 busy at once</span><span><i class="k-ovl3"></i>3+ busy</span><span><i class="k-free"></i>Everyone free</span>';
  }

  $("calPrev").addEventListener("click", () => data && load(data.prevWeek));
  $("calNext").addEventListener("click", () => data && load(data.nextWeek));
  $("calToday").addEventListener("click", () => { firstRender = true; load(""); });
  document.addEventListener("keydown", (event) => {
    if (event.target.closest && event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (event.metaKey || event.ctrlKey || event.altKey || !data) return;
    if (event.key === "ArrowLeft") load(data.prevWeek);
    else if (event.key === "ArrowRight") load(data.nextWeek);
    else if (event.key === "t") { firstRender = true; load(""); }
  });
  $("calBest").addEventListener("click", (event) => {
    const button = event.target.closest("[data-slot]");
    if (!button) return;
    const slot = Number(button.dataset.slot);
    const target = [...document.querySelectorAll(".cal-free")].find((el) => Number(el.dataset.start) <= slot && slot < Number(el.dataset.end));
    if (!target) return;
    target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center", inline: "center" });
    target.classList.remove("flash"); void target.offsetWidth; target.classList.add("flash");
  });
  $("calPeople").addEventListener("click", async (event) => {
    if (event.target.closest("[data-retry]")) return load();
    const button = event.target.closest("[data-disconnect]");
    if (!button) return;
    const member = data.members.find((m) => m.id === button.dataset.disconnect);
    if (!member || !confirm("Disconnect " + member.name + "’s Google Calendar? GroupCart will forget their sign-in.")) return;
    button.disabled = true;
    try {
      const response = await fetch("/api/google/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId: member.id }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not disconnect.");
      showNotice(member.name + "’s calendar was disconnected.");
      await load();
    } catch (error) { showNotice(error.message, true); button.disabled = false; }
  });

  const connected = params.get("connected");
  load().then(() => {
    if (connected && data) {
      const member = data.members.find((m) => m.id === connected);
      if (member) showNotice(member.name + "’s Google Calendar is connected. Only busy times are shared.");
    }
  });
  setInterval(() => { if (document.visibilityState === "visible") load(); }, 5 * 60000);
  setInterval(() => { if (data && document.visibilityState === "visible") renderGrid(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && data && Date.now() - data.now > 60000) load(); });
})();
`;

/** Page pieces for embedding in a shared app shell. */
export function renderCalendarBody(): { styles: string; body: string; script: string } {
  return { styles, body, script };
}

// Standalone document wrapper: slim app bar + default --gc-* tokens (light/dark).
const tokens = String.raw`
:root { color-scheme: light dark;
  --gc-bg:#f8faf9; --gc-surface:#ffffff; --gc-surface-2:#f3f5f4; --gc-border:#e2e7e4; --gc-text:#1d2420; --gc-muted:#5f6b65;
  --gc-accent:#0b6b50; --gc-accent-soft:#e6f3ec; --gc-on-accent:#ffffff; --gc-radius-md:12px; --gc-space-4:16px; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --gc-bg:#121513; --gc-surface:#1a1e1c; --gc-surface-2:#232825; --gc-border:#2e3531; --gc-text:#e6ebe8; --gc-muted:#9aa59f;
  --gc-accent:#6fcf9f; --gc-accent-soft:#1c3529; --gc-on-accent:#0d1f17; } }
:root[data-theme="dark"] { --gc-bg:#121513; --gc-surface:#1a1e1c; --gc-surface-2:#232825; --gc-border:#2e3531; --gc-text:#e6ebe8; --gc-muted:#9aa59f;
  --gc-accent:#6fcf9f; --gc-accent-soft:#1c3529; --gc-on-accent:#0d1f17; }
* { box-sizing:border-box; }
html, body { overflow-x:hidden; }
body { margin:0; background:var(--gc-bg); color:var(--gc-text); font:14px/1.45 "Google Sans Text","Google Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
.gc-bar { position:sticky; top:0; z-index:20; height:56px; display:flex; align-items:center; gap:16px; padding:0 20px; background:var(--gc-surface); border-bottom:1px solid var(--gc-border); }
.gc-brand { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:500; color:var(--gc-text); text-decoration:none; }
.gc-logo { width:30px; height:30px; border-radius:8px; display:grid; place-items:center; background:var(--gc-accent); color:var(--gc-on-accent); font-size:16px; }
.gc-tabs { display:flex; gap:4px; margin-left:auto; }
.gc-tabs a { padding:7px 14px; border-radius:999px; color:var(--gc-muted); text-decoration:none; font-weight:500; }
.gc-tabs a:hover { background:var(--gc-surface-2); color:var(--gc-text); }
.gc-tabs a[aria-current="page"] { background:var(--gc-accent-soft); color:var(--gc-accent); }
.gc-main { width:min(1320px, 100%); margin:0 auto; padding:20px 20px 40px; }
@media (max-width:640px) { .gc-bar { padding:0 16px; gap:10px; } .gc-brand span:last-child { display:none; } .gc-main { padding:14px 16px 32px; } }
`;

export function renderCalendarPage(): string {
  const page = renderCalendarBody();
  return renderPage({ title: "Calendar", active: "calendar", styles: page.styles, body: page.body, script: page.script });
}

/** Standalone document (no shared shell); kept for reference/testing. */
export function renderStandaloneCalendarPage(): string {
  const page = renderCalendarBody();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GroupCart · Calendar</title>
  <style>${tokens}${page.styles}</style>
</head>
<body>
  <header class="gc-bar">
    <a class="gc-brand" href="/"><span class="gc-logo" aria-hidden="true">🛒</span><span>GroupCart</span></a>
    <nav class="gc-tabs" aria-label="Pages"><a href="/">Cart</a><a href="/calendar" aria-current="page">Calendar</a></nav>
  </header>
  <main class="gc-main">${page.body}</main>
  <script>${page.script}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP routes

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function sendResultPage(response: ServerResponse, status: number, title: string, message: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  const success = status < 400;
  response.end(renderNotice({ title, message, tone: success ? "success" : "warning", active: "calendar", links: [{ href: "/calendar", label: "Back to calendar" }] }));
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 4_096) { reject(new Error("Request body is too large.")); request.destroy(); }
    });
    request.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) as Record<string, unknown> : {}); } catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}

/** Rejects cross-site browser POSTs: require JSON (forces a CORS preflight) and a same-host Origin when present. */
function isSameOriginJson(request: IncomingMessage): boolean {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

/** Handles /calendar, /api/calendar, and the Google OAuth routes. Returns false for any other path. */
export async function handleCalendarRequest(
  service: CalendarService,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const { pathname } = url;
  if (request.method === "GET" && (pathname === "/calendar" || pathname === "/calendar/")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderCalendarPage());
    return true;
  }
  if (request.method === "GET" && pathname === "/api/calendar") {
    try {
      sendJson(response, 200, await service.week({ week: url.searchParams.get("week"), timeZone: url.searchParams.get("tz") }));
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Could not build the calendar." });
    }
    return true;
  }
  if (request.method === "GET" && pathname === "/api/google/oauth/start") {
    const result = service.startAuthorization(url.searchParams.get("memberId") ?? "");
    if (!result.ok) {
      sendResultPage(response, result.status, "Can’t connect Google Calendar", result.message);
    } else {
      response.writeHead(302, { location: result.url, "cache-control": "no-store" });
      response.end();
    }
    return true;
  }
  if (request.method === "GET" && pathname === "/api/google/oauth/callback") {
    if (url.searchParams.has("error")) {
      sendResultPage(response, 200, "Google sign-in cancelled", "No calendar was connected. You can try again from the calendar page.");
      return true;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      sendResultPage(response, 400, "Google sign-in did not finish", "Google did not return a sign-in code. Press Connect again on the calendar page.");
      return true;
    }
    try {
      const member = await service.completeAuthorization(code, state);
      response.writeHead(302, { location: `/calendar?connected=${encodeURIComponent(member.id)}`, "cache-control": "no-store" });
      response.end();
    } catch (error) {
      const message = error instanceof GoogleCalendarError ? error.message : "Google sign-in failed. Please try again.";
      sendResultPage(response, 400, "Google sign-in did not finish", message);
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/google/disconnect") {
    if (!isSameOriginJson(request)) { sendJson(response, 403, { error: "Disconnect from the GroupCart calendar page." }); return true; }
    try {
      const body = await readJsonBody(request);
      if (typeof body.memberId !== "string") { sendJson(response, 400, { error: "Choose a member." }); return true; }
      const removed = await service.disconnect(body.memberId);
      sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "That member has no connected calendar." });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Request failed." });
    }
    return true;
  }
  return false;
}
