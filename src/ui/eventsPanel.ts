import { ACTIVITIES } from "../eventsParse.js";
import { button, card, dialog, icon, type PageOptions } from "./shell.js";
import { digestHomeLine } from "./pointsUi.js"; // money & points: "Next digest" line in the Home Upcoming card

/**
 * Household events on /calendar and Home.
 *
 * withHouseEvents(page) adds to the calendar page: a "House" all-day row and event
 * blocks across the day columns, tentative blocks for open time polls, a voting
 * strip, a Create button (app bar) with suggested everyone-free times, and the
 * event / poll dialogs. It draws after each calendar render: calendarPage.ts
 * dispatches `gc:calendar-rendered` with { data, startHour, endHour, ppm, view,
 * date, days, place }; place(date, [{start, end}]) positions timed blocks beside the
 * members' entries. Week view: one .cal-day[data-date] column per day. Day view: the
 * House lane is the only .cal-day, and the all-day row (only when there is an
 * all-day event that day) spans every column.
 *
 * homeUpcomingCard() is the Home "Upcoming" card (id homeUpcoming): open plans,
 * the next events with RSVPs, and the next time everyone is free.
 */

const EMOJIS = ["📅", "🏠", "🧹", "💸", "🧳", "🎬", "🎲", "🍝", "🥾", "🎉", "🛋️", "🎂", "🗑️", "🧺", "🔧", "🏃", "☕", "🎵"];
const ACTIVITY_CHIPS = [
  { key: "house", label: "Event", emoji: "📅", minutes: 60 },
  ...ACTIVITIES.map((activity) => ({ key: activity.key, label: activity.key === "game" ? "Games" : activity.key === "movie" ? "Movie" : activity.key === "outing" ? "Outing" : activity.key === "party" ? "Party" : activity.key === "dinner" ? "Dinner" : "Hangout", emoji: activity.emoji, minutes: activity.minutes, title: activity.label })),
];

const createDialog = dialog({
  id: "hvCreateDialog",
  title: "New event",
  body: `
  <div class="hv-form">
    <div class="hv-kinds" id="hvKinds" role="radiogroup" aria-label="Kind">${ACTIVITY_CHIPS.map((chip, index) => `<button type="button" role="radio" class="hv-kind" aria-checked="${index === 0}" data-kind="${chip.key}" data-emoji="${chip.emoji}" data-minutes="${chip.minutes}" data-title="${"title" in chip ? chip.title : ""}"><span aria-hidden="true">${chip.emoji}</span>${chip.label}</button>`).join("")}</div>
    <div class="hv-title-row">
      <label class="hv-emoji" title="Emoji"><span class="gc-sr">Emoji</span><select id="hvEmoji">${EMOJIS.map((emoji) => `<option>${emoji}</option>`).join("")}</select></label>
      <input class="gc-input hv-title-input" id="hvTitle" placeholder="Add title" maxlength="60" autocomplete="off" aria-label="Title" />
    </div>
    <div class="hv-when">
      <input class="gc-input" id="hvDate" type="date" aria-label="Date" />
      <input class="gc-input" id="hvTime" type="time" step="900" aria-label="Start time" />
      <select class="gc-select" id="hvDuration" aria-label="Length">${[30, 60, 90, 120, 150, 180, 240].map((minutes) => `<option value="${minutes}">${minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}</option>`).join("")}</select>
      <input class="gc-input" id="hvEndDate" type="date" aria-label="End date" hidden />
    </div>
    <div class="hv-toggles">
      <label class="hv-switch"><input type="checkbox" id="hvAllDay" /><span class="hv-track" aria-hidden="true"></span>All day</label>
      <select class="gc-select hv-repeat" id="hvRepeat" aria-label="Repeat"><option value="none">Does not repeat</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
    </div>
    <div class="hv-suggest" id="hvSuggestBox">
      <span class="hv-label">${icon("users", { size: 16 })}Everyone’s free</span>
      <div class="hv-slots" id="hvSlots"></div>
    </div>
    <div class="hv-who" id="hvWho" role="group" aria-label="Who"></div>
    <textarea class="gc-input hv-notes" id="hvNotes" rows="2" maxlength="500" placeholder="Notes" aria-label="Notes"></textarea>
    <p class="gc-status" id="hvCreateStatus" role="status" aria-live="polite"></p>
  </div>`,
  actions: `${button({ label: "Poll the group", variant: "outline", icon: "users", id: "hvPollBtn" })}<span class="gc-spacer"></span>${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Save", id: "hvSave" })}`,
});

const eventDialog = dialog({
  id: "hvEventDialog",
  title: "Event",
  body: `<div id="hvEventBody" class="hv-detail"></div>`,
  actions: `${button({ label: "Delete", variant: "text", id: "hvDelete" })}<span class="gc-spacer"></span>${button({ label: "Done", variant: "tonal", attrs: "data-gc-close" })}`,
});

const pollDialog = dialog({
  id: "hvPollDialog",
  title: "Plan",
  body: `<div id="hvPollBody" class="hv-detail"></div>`,
  actions: `${button({ label: "Cancel plan", variant: "text", id: "hvPollCancel" })}<span class="gc-spacer"></span>${button({ label: "Done", variant: "tonal", attrs: "data-gc-close" })}`,
});

const calendarStyles = `
:root { --hv-house:#0b57d0; --hv-house-on:#ffffff; --hv-social:#8e24aa; --hv-social-on:#ffffff; --hv-free-bg:rgba(24,128,56,.09); --hv-free-edge:#1e8e3e; --hv-free-text:#137333; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --hv-house:#a8c7fa; --hv-house-on:#062e6f; --hv-social:#e1b5ff; --hv-social-on:#3b0a57; --hv-free-bg:rgba(129,201,149,.13); --hv-free-edge:#81c995; --hv-free-text:#a8dab5; } }
:root[data-theme="dark"] { --hv-house:#a8c7fa; --hv-house-on:#062e6f; --hv-social:#e1b5ff; --hv-social-on:#3b0a57; --hv-free-bg:rgba(129,201,149,.13); --hv-free-edge:#81c995; --hv-free-text:#a8dab5; }
.hv-row-label { position:sticky; left:0; z-index:5; display:flex; align-items:center; justify-content:flex-end; padding:0 8px 0 0; background:var(--gc-surface); border-bottom:1px solid var(--cal-line); color:var(--gc-muted); font-size:10.5px; font-weight:500; }
.hv-row { grid-column:2 / -1; display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); grid-auto-rows:24px; row-gap:2px; align-content:start; min-height:30px; padding:3px 0; background:var(--gc-surface); border-bottom:1px solid var(--cal-line); }
.hv-row.is-day { grid-template-columns:minmax(0, 1fr); }
.hv-chip { min-width:0; margin:0 2px; padding:0 8px; border:0; border-radius:5px; background:var(--hv-house); color:var(--hv-house-on); font:500 11.5px/24px var(--gc-font); text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.hv-chip.is-social, .hv-block.is-social { background:var(--hv-social); color:var(--hv-social-on); }
.hv-chip:hover, .hv-block:hover { filter:brightness(1.08); }
.hv-block { position:absolute; z-index:5; display:flex; flex-direction:column; justify-content:flex-start; align-items:stretch; overflow:hidden; padding:3px 6px; border:0; border-radius:6px; background:var(--hv-house); color:var(--hv-house-on); font:500 11.5px/1.25 var(--gc-font); text-align:left; cursor:pointer; box-shadow:0 0 0 1.5px var(--gc-surface); }
.hv-block span { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hv-block .hv-time { font-weight:400; opacity:.9; font-size:10.5px; }
.hv-block .hv-emo { font-style:normal; }
.hv-block.is-narrow { padding:2px 4px; }
.hv-block.is-narrow .hv-emo { display:none; }
.hv-block.is-past { opacity:.55; }
.hv-block.is-tentative { background:color-mix(in srgb, var(--hv-social) 12%, var(--gc-surface)); color:var(--gc-text); border:1.5px dashed var(--hv-social); box-shadow:none; }
.hv-block.is-tentative .hv-time { color:var(--gc-muted); opacity:1; }
.cal-day { cursor:pointer; }
@media (max-width: 760px) { #hvCreate { width:36px; padding:0; gap:0; font-size:0; } } /* icon-only Create, so the app-bar title fits */
.hv-strip { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
.hv-strip[hidden] { display:none; }
.hv-strip-label { display:inline-flex; align-items:center; gap:6px; color:var(--gc-muted); font-size:var(--gc-fs-sm); font-weight:500; }
.hv-strip-chip { display:inline-flex; align-items:center; gap:8px; height:32px; padding:0 12px; border:1.5px dashed var(--hv-social); border-radius:var(--gc-radius-pill); background:color-mix(in srgb, var(--hv-social) 10%, var(--gc-surface)); color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.hv-strip-chip:hover { background:color-mix(in srgb, var(--hv-social) 18%, var(--gc-surface)); }
.hv-strip-chip .gc-meta { font-weight:400; }

.hv-form { display:grid; gap:var(--gc-space-3); }
.hv-kinds { display:flex; gap:6px; overflow-x:auto; padding-bottom:2px; scrollbar-width:none; }
.hv-kinds::-webkit-scrollbar { display:none; }
.hv-kind { flex:none; display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); background:transparent; color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.hv-kind[aria-checked="true"] { background:var(--gc-accent-soft); border-color:transparent; color:var(--gc-on-accent-soft); }
.hv-title-row { display:flex; align-items:center; gap:var(--gc-space-2); }
.hv-emoji { position:relative; width:44px; height:44px; flex:none; display:grid; place-items:center; border-radius:12px; background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:22px; }
.hv-emoji select { position:absolute; inset:0; opacity:0; cursor:pointer; font-size:16px; }
.hv-emoji::after { content:attr(data-emoji); pointer-events:none; }
.hv-title-input { height:44px; font-size:var(--gc-fs-lg); border-width:0 0 2px; border-radius:0; padding:0 4px; background:transparent; }
.hv-title-input:focus { outline:none; border-color:var(--gc-accent); }
.hv-when { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr); gap:var(--gc-space-2); }
.hv-when.is-all-day { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
.hv-toggles { display:flex; align-items:center; justify-content:space-between; gap:var(--gc-space-3); flex-wrap:wrap; }
.hv-repeat { min-width:160px; }
.hv-switch { display:inline-flex; align-items:center; gap:10px; color:var(--gc-text-2); font-weight:500; cursor:pointer; }
.hv-switch input { position:absolute; opacity:0; width:1px; height:1px; }
.hv-track { position:relative; width:36px; height:20px; border-radius:10px; background:var(--gc-border-strong); transition:background-color .15s ease; }
.hv-track::after { content:""; position:absolute; top:3px; left:3px; width:14px; height:14px; border-radius:50%; background:var(--gc-surface); transition:transform .15s ease; }
.hv-switch input:checked + .hv-track { background:var(--gc-accent); }
.hv-switch input:checked + .hv-track::after { transform:translateX(16px); }
.hv-switch input:focus-visible + .hv-track { outline:2px solid var(--gc-focus); outline-offset:2px; }
.hv-suggest { display:grid; gap:6px; padding:var(--gc-space-3); border-radius:var(--gc-radius-md); background:var(--hv-free-bg); }
.hv-label { display:inline-flex; align-items:center; gap:6px; font-size:var(--gc-fs-xs); font-weight:600; color:var(--hv-free-text); }
.hv-slots { display:flex; flex-wrap:wrap; gap:6px; min-height:32px; }
.hv-slot { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px; border:1px solid color-mix(in srgb, var(--hv-free-edge) 45%, transparent); border-radius:var(--gc-radius-pill); background:var(--gc-surface); color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.hv-slot[aria-pressed="true"] { background:var(--hv-free-edge); border-color:transparent; color:var(--gc-surface); }
.hv-slot small { font-weight:400; color:var(--gc-muted); }
.hv-slot[aria-pressed="true"] small { color:inherit; opacity:.85; }
.hv-slots .hv-none { color:var(--gc-muted); font-size:var(--gc-fs-sm); align-self:center; }
.hv-who { display:flex; flex-wrap:wrap; gap:6px; }
.hv-who-chip { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px 0 4px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); background:transparent; color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.hv-who-chip[aria-pressed="true"] { background:var(--gc-accent-soft); border-color:transparent; color:var(--gc-on-accent-soft); }
.hv-everyone { width:24px; height:24px; display:grid; place-items:center; border-radius:50%; background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.hv-who-chip[aria-pressed="true"] .hv-everyone { background:var(--gc-surface); }
.hv-notes { height:auto; min-height:44px; padding:10px 12px; resize:vertical; font:var(--gc-fs-md)/1.4 var(--gc-font); }
#hvCreateDialog .gc-dialog-actions { align-items:center; }
#hvDelete { color:var(--gc-danger); }

.hv-detail { display:grid; gap:var(--gc-space-4); }
.hv-hero { display:flex; align-items:center; gap:var(--gc-space-3); }
.hv-hero-emoji { width:52px; height:52px; flex:none; display:grid; place-items:center; border-radius:14px; background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:28px; }
.hv-hero-title { font-size:var(--gc-fs-xl); font-weight:400; line-height:1.2; }
.hv-hero-sub { color:var(--gc-text-2); font-size:var(--gc-fs-sm); margin-top:2px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.hv-section { display:grid; gap:var(--gc-space-2); }
.hv-section-title { display:flex; align-items:center; gap:6px; color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
.hv-people { display:flex; flex-wrap:wrap; gap:var(--gc-space-3); }
.hv-person { position:relative; display:grid; justify-items:center; gap:4px; min-width:56px; padding:4px; border:0; border-radius:var(--gc-radius-md); background:transparent; color:var(--gc-text-2); font:500 var(--gc-fs-xs) var(--gc-font); }
button.hv-person { cursor:pointer; }
button.hv-person:hover { background:var(--gc-hover); }
.hv-person.is-none .gc-avatar { opacity:.45; }
.hv-person.is-no .gc-avatar { opacity:.45; }
.hv-badge { position:absolute; top:26px; left:calc(50% + 8px); width:18px; height:18px; display:grid; place-items:center; border-radius:50%; border:2px solid var(--gc-surface); background:var(--gc-border-strong); color:#fff; font-size:10px; font-weight:700; line-height:1; }
.hv-badge.going { background:#188038; }
.hv-badge.maybe { background:#e37400; }
.hv-badge.no { background:#c5221f; }
.hv-tasks { list-style:none; margin:0; padding:0; }
.hv-task { display:flex; align-items:center; gap:var(--gc-space-3); min-height:40px; border-top:1px solid var(--gc-border); }
.hv-task:first-child { border-top:0; }
.hv-task-label { flex:1; min-width:0; }
.hv-task.is-done .hv-task-label { color:var(--gc-muted); text-decoration:line-through; }
.hv-check { width:22px; height:22px; flex:none; display:grid; place-items:center; padding:0; border-radius:50%; border:2px solid var(--gc-border-strong); background:transparent; color:transparent; cursor:pointer; }
.hv-check[aria-checked="true"] { background:var(--gc-accent); border-color:var(--gc-accent); color:var(--gc-on-accent); }
.hv-snacks { display:flex; align-items:center; gap:var(--gc-space-2); flex-wrap:wrap; }
.hv-pill { display:inline-flex; align-items:center; height:28px; padding:0 10px; border-radius:var(--gc-radius-pill); background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:var(--gc-fs-sm); }
.hv-pill.is-done { color:var(--gc-muted); text-decoration:line-through; }
.hv-ideas { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
.hv-idea { display:flex; align-items:center; gap:var(--gc-space-2); font-size:var(--gc-fs-md); }
.hv-idea .gc-meta { margin-left:auto; }
.hv-notes-text { color:var(--gc-text-2); white-space:pre-line; }
.hv-opts { list-style:none; margin:0; padding:0; display:grid; gap:var(--gc-space-2); }
.hv-opt { display:grid; grid-template-columns:28px minmax(0,1fr) auto; gap:4px var(--gc-space-3); align-items:center; padding:var(--gc-space-3); border:1px solid var(--gc-border); border-radius:var(--gc-radius-md); }
.hv-opt-num { width:28px; height:28px; display:grid; place-items:center; border-radius:50%; background:var(--gc-surface-2); font-weight:600; font-size:var(--gc-fs-sm); }
.hv-opt.is-leading { border-color:var(--hv-social); }
.hv-opt.is-leading .hv-opt-num { background:var(--hv-social); color:var(--hv-social-on); }
.hv-opt-time { font-weight:500; }
.hv-opt-busy { color:var(--gc-warning); font-size:var(--gc-fs-xs); }
.hv-opt-voters { grid-column:2 / -1; display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.hv-vote { position:relative; padding:0; border:0; background:transparent; cursor:default; }
button.hv-vote { cursor:pointer; }
.hv-vote.is-none .gc-avatar { opacity:.3; }
.hv-vote.is-no .gc-avatar { opacity:.3; }
.hv-vote.is-no::after { content:""; position:absolute; left:3px; right:3px; top:50%; height:2px; background:var(--gc-danger); transform:rotate(-35deg); }
.hv-bar { flex:1; min-width:60px; height:6px; border-radius:3px; background:var(--gc-track); overflow:hidden; }
.hv-bar span { display:block; height:100%; background:var(--hv-social); border-radius:inherit; }
.hv-foot { color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.hv-toast { position:fixed; left:50%; bottom:24px; z-index:40; transform:translateX(-50%); max-width:min(560px, calc(100vw - 32px)); padding:12px 16px; border-radius:var(--gc-radius-sm); background:var(--gc-tooltip-bg); color:var(--gc-tooltip-text); font-size:var(--gc-fs-sm); box-shadow:0 2px 8px rgba(0,0,0,.2); white-space:pre-line; }
@media (max-width: 760px) {
  .hv-toast { bottom:calc(var(--gc-bottomnav-h) + 24px + env(safe-area-inset-bottom)); }
  .hv-when { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
  .hv-when #hvDate { grid-column:1 / -1; }
  .hv-when.is-all-day #hvDate { grid-column:auto; }
  #hvCreateDialog .gc-dialog-actions { flex-wrap:wrap; }
  #hvPollBtn { order:3; width:100%; }
}`;

const calendarScript = String.raw`
(() => {
  const GC = window.GC;
  const $ = (id) => document.getElementById(id);
  const esc = GC.esc;
  let view = null;          // last calendar render: { data, startHour, endHour, ppm }
  let ev = null;            // /api/events for the shown week
  let evKey = "";
  let evAt = 0;
  let loading = false;
  let allIds = [];
  let currentEvent = null;
  let currentPoll = null;
  let emojiTouched = false;
  const params = new URLSearchParams(location.search);
  const deepLink = { event: params.get("event"), poll: params.get("poll"), create: params.get("create") };

  const strip = document.createElement("div");
  strip.className = "hv-strip";
  strip.id = "hvStrip";
  strip.hidden = true;
  const layout = document.querySelector(".cal-layout");
  if (layout) layout.before(strip);
  const toastNode = document.createElement("div");
  toastNode.className = "hv-toast";
  toastNode.setAttribute("role", "status");
  toastNode.hidden = true;
  document.body.appendChild(toastNode);
  let toastTimer = 0;
  function toast(text) { toastNode.textContent = text; toastNode.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastNode.hidden = true; }, 4200); }

  async function post(path, body) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || "Something went wrong.");
    return result;
  }

  const fmtCache = {};
  const fmt = (tz, key, options) => fmtCache[tz + key] || (fmtCache[tz + key] = new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: tz }, options)));
  const houseTz = () => (ev && ev.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  function clock(ms, tz) {
    const parts = fmt(tz, "clock", { hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(ms));
    const h = (parts.find((p) => p.type === "hour") || {}).value || "";
    const m = (parts.find((p) => p.type === "minute") || {}).value || "00";
    const ap = ((parts.find((p) => p.type === "dayPeriod") || {}).value || "").toLowerCase();
    return h + (m === "00" ? "" : ":" + m) + ap;
  }
  function minutesOf(ms, tz) {
    let h = 0, m = 0;
    for (const p of fmt(tz, "hm", { hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms))) { if (p.type === "hour") h = Number(p.value) % 24; if (p.type === "minute") m = Number(p.value); }
    return h * 60 + m;
  }
  const dateOf = (ms, tz) => fmt(tz, "date", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
  const longDay = (date) => { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); };
  const member = (id) => (ev && ev.members.find((m) => m.id === id)) || { id, name: "?" };

  // ---- Data -------------------------------------------------------------
  document.addEventListener("gc:calendar-rendered", (event) => {
    view = event.detail;
    draw();
    load(false);
  });

  async function load(force) {
    if (!view || loading) return;
    const days = view.data.days;
    const key = days[0].start + ":" + days[6].end;
    if (!force && key === evKey && Date.now() - evAt < 30000) return;
    loading = true;
    try {
      const response = await fetch("/api/events?from=" + days[0].start + "&to=" + days[6].end);
      if (!response.ok) return;
      const body = await response.json();
      const currentKey = view.data.days[0].start + ":" + view.data.days[6].end;
      if (currentKey !== key) { loading = false; return load(true); }
      ev = body; evKey = key; evAt = Date.now();
      allIds = ev.members.map((m) => m.id);
      draw();
      handleDeepLinks();
    } catch (error) { /* keep the last drawing */ } finally { loading = false; }
  }

  // ---- Drawing ------------------------------------------------------------
  function draw() {
    const grid = $("calGrid");
    if (!grid || !view) return;
    grid.querySelectorAll(".hv-row, .hv-row-label, .hv-block").forEach((node) => node.remove());
    renderStrip();
    if (!ev || ev.occurrences === undefined) return;
    const days = view.data.days;
    const key = days[0].start + ":" + days[6].end;
    if (key !== evKey) return;
    const tz = view.data.timeZone;
    const heads = grid.querySelectorAll(".cal-head");
    const lastHead = heads[heads.length - 1];
    if (!lastHead) return;
    const dayView = view.view === "day"; // [calendar-detail] Day view: one day, full-width all-day row

    // House row: all-day events spanning day columns (Day view: full-width chips, only when there are some).
    const label = document.createElement("div");
    label.className = "hv-row-label";
    label.textContent = "House";
    const row = document.createElement("div");
    row.className = "hv-row" + (dayView ? " is-day" : "");
    const lanes = [];
    const allDay = ev.occurrences.filter((o) => o.allDay);
    for (const o of allDay) {
      let first, last;
      if (dayView) {
        if (!(o.date <= view.date && o.endDate >= view.date)) continue;
        first = last = 0;
      } else {
        first = days.findIndex((d) => d.date === o.date);
        last = days.findIndex((d) => d.date === o.endDate);
        if (first < 0 && o.date < days[0].date) first = 0;
        if (last < 0 && o.endDate > days[6].date) last = 6;
        if (first < 0 || last < 0 || last < first) continue;
      }
      let lane = lanes.findIndex((end) => end < first);
      if (lane < 0) { lane = lanes.length; lanes.push(-1); }
      lanes[lane] = last;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "hv-chip" + (o.kind !== "house" ? " is-social" : "");
      chip.style.gridColumn = dayView ? "1 / -1" : (first + 1) + " / " + (last + 2);
      chip.style.gridRow = String(lane + 1);
      chip.dataset.hvEvent = o.eventId;
      chip.title = o.title + " · " + o.label;
      chip.textContent = o.emoji + " " + o.title;
      row.appendChild(chip);
    }
    if (!dayView || row.childElementCount) lastHead.after(label, row);

    // Timed events and poll options as blocks in the day columns.
    const items = ev.occurrences.filter((o) => !o.allDay).map((o) => ({ kind: "event", o, start: o.start, end: o.end }));
    for (const poll of ev.polls) for (const option of poll.options) items.push({ kind: "poll", poll, option, start: option.start, end: option.end });
    const now = Date.now();
    days.forEach((day) => {
      const column = grid.querySelector('.cal-day[data-date="' + day.date + '"]');
      if (!column) return;
      const inDay = items.filter((item) => item.end > day.start && item.start < day.end);
      // The calendar lays these out beside members' entries (side by side when they overlap).
      const boxes = view.place(day.date, inDay.map((item) => ({ start: item.start, end: item.end })));
      inDay.forEach((item, index) => {
        const box = boxes[index];
        if (!box) return;
        const block = document.createElement("button");
        block.type = "button";
        const height = parseFloat(box.height);
        Object.assign(block.style, box);
        const time = clock(item.start, tz) + "–" + clock(item.end, tz);
        if (item.kind === "event") {
          const o = item.o;
          block.className = "hv-block" + (o.kind !== "house" ? " is-social" : "") + (o.end < now ? " is-past" : "");
          block.dataset.hvEvent = o.eventId;
          block.title = o.emoji + " " + o.title + " · " + time;
          block.innerHTML = '<span class="hv-title"><i class="hv-emo">' + esc(o.emoji) + ' </i>' + esc(o.title) + '</span>' + (height > 30 ? '<span class="hv-time">' + esc(time) + '</span>' : "");
        } else {
          const votes = item.option.yes.length;
          block.className = "hv-block is-tentative";
          block.dataset.hvPoll = item.poll.id;
          block.title = item.poll.title + " option " + item.option.index + " · " + votes + " yes";
          block.innerHTML = '<span class="hv-title"><i class="hv-emo">' + esc(item.poll.emoji) + ' </i>Option ' + item.option.index + '</span>' + (height > 30 ? '<span class="hv-time">' + esc(votes + (votes === 1 ? " vote" : " votes")) + '</span>' : "");
        }
        column.appendChild(block);
        // Narrow (side by side with members' entries): drop the emoji and padding so the title fits.
        block.classList.toggle("is-narrow", block.offsetWidth < 72);
      });
    });
  }

  function renderStrip() {
    if (!ev || !ev.polls || !ev.polls.length) { strip.hidden = true; strip.innerHTML = ""; return; }
    strip.hidden = false;
    strip.innerHTML = '<span class="hv-strip-label">' + GC.icon("users") + 'Voting</span>' + ev.polls.map((poll) => '<button type="button" class="hv-strip-chip" data-hv-poll="' + esc(poll.id) + '">' + esc(poll.emoji + " " + poll.title) + '<span class="gc-meta">' + poll.responded.length + "/" + poll.attendeeIds.length + ' voted</span></button>').join("");
  }

  // ---- Clicks on the grid -----------------------------------------------
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const eventEl = target.closest("[data-hv-event]");
    if (eventEl) { openEvent(eventEl.dataset.hvEvent); return; }
    const pollEl = target.closest("[data-hv-poll]");
    if (pollEl) { openPoll(pollEl.dataset.hvPoll); return; }
    if (target.closest("[data-ev], [data-goto-day]")) return; // member entries and day headers (calendarPage.ts)
    const day = target.closest(".cal-day");
    if (day && view && !target.closest(".cal-free span")) {
      const rect = day.getBoundingClientRect();
      const minutes = view.startHour * 60 + (event.clientY - rect.top) / view.ppm;
      const rounded = Math.max(0, Math.min(23 * 60 + 30, Math.floor(minutes / 30) * 30));
      openCreate({ date: day.dataset.date, minutes: rounded });
    }
  });

  // ---- Create -------------------------------------------------------------
  const nextHour = () => { const m = minutesOf(Date.now(), houseTz()); return Math.min(23 * 60, (Math.floor(m / 60) + 1) * 60); };
  const hhmm = (minutes) => String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
  function setEmoji(emoji) {
    const select = $("hvEmoji");
    if (![...select.options].some((o) => o.value === emoji)) select.add(new Option(emoji, emoji), 0);
    select.value = emoji;
    select.parentElement.dataset.emoji = emoji;
  }
  function selectedKind() { return $("hvKinds").querySelector('[aria-checked="true"]'); }
  function renderWho() {
    const members = (ev && ev.members) || [];
    $("hvWho").innerHTML = '<button type="button" class="hv-who-chip" data-who="*" aria-pressed="true"><span class="hv-everyone">' + GC.icon("users") + '</span>Everyone</button>'
      + members.map((m) => '<button type="button" class="hv-who-chip" data-who="' + esc(m.id) + '" aria-pressed="false">' + GC.avatar(m, allIds, 24) + esc(m.name) + '</button>').join("");
  }
  $("hvWho").addEventListener("click", (event) => {
    const chip = event.target.closest(".hv-who-chip");
    if (!chip) return;
    if (chip.dataset.who === "*") $("hvWho").querySelectorAll("[data-who]").forEach((b) => b.setAttribute("aria-pressed", String(b === chip)));
    else {
      chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
      $("hvWho").querySelector('[data-who="*"]').setAttribute("aria-pressed", String(!$("hvWho").querySelector('[data-who]:not([data-who="*"])[aria-pressed="true"]')));
    }
  });
  function syncAllDay() {
    const allDay = $("hvAllDay").checked;
    $("hvTime").hidden = allDay;
    $("hvDuration").hidden = allDay;
    $("hvEndDate").hidden = !allDay;
    document.querySelector(".hv-when").classList.toggle("is-all-day", allDay);
    $("hvSuggestBox").hidden = allDay;
    if (allDay && (!$("hvEndDate").value || $("hvEndDate").value < $("hvDate").value)) $("hvEndDate").value = $("hvDate").value;
  }
  $("hvAllDay").addEventListener("change", syncAllDay);
  $("hvDate").addEventListener("change", () => { if ($("hvEndDate").value < $("hvDate").value) $("hvEndDate").value = $("hvDate").value; markSlots(); });
  $("hvTime").addEventListener("change", markSlots);
  $("hvEmoji").addEventListener("change", () => { emojiTouched = true; $("hvEmoji").parentElement.dataset.emoji = $("hvEmoji").value; });
  $("hvKinds").addEventListener("click", (event) => {
    const chip = event.target.closest(".hv-kind");
    if (!chip) return;
    $("hvKinds").querySelectorAll(".hv-kind").forEach((b) => b.setAttribute("aria-checked", String(b === chip)));
    if (!emojiTouched) setEmoji(chip.dataset.emoji);
    const title = $("hvTitle");
    const known = [...$("hvKinds").querySelectorAll(".hv-kind")].map((b) => b.dataset.title).filter(Boolean);
    if (!title.value.trim() || known.includes(title.value.trim())) title.value = chip.dataset.title || "";
    $("hvDuration").value = chip.dataset.minutes;
    if (!$("hvDuration").value) $("hvDuration").value = "60";
    suggest();
  });
  let titleTimer = 0;
  $("hvTitle").addEventListener("input", () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      if (emojiTouched) return;
      const t = $("hvTitle").value.toLowerCase();
      const guess = [[/movie|film/, "🎬"], [/game|poker|trivia/, "🎲"], [/dinner|potluck|bbq/, "🍝"], [/hike/, "🥾"], [/party/, "🎉"], [/birthday/, "🎂"], [/clean|chore|tidy/, "🧹"], [/rent|bill|pay/, "💸"], [/repair|plumb|landlord|fix|electric/, "🔧"], [/guest|visiting|parents/, "🧳"], [/meeting|check-in/, "🏠"], [/trash|recycl/, "🗑️"], [/laundry/, "🧺"], [/hang|chill/, "🛋️"]].find(([re]) => re.test(t));
      setEmoji(guess ? guess[1] : selectedKind().dataset.emoji);
    }, 200);
  });
  $("hvDuration").addEventListener("change", () => suggest());

  let slots = [];
  let suggestToken = 0;
  async function suggest() {
    if ($("hvAllDay").checked) return;
    const token = ++suggestToken;
    $("hvSlots").innerHTML = '<span class="hv-none">Finding times…</span>';
    try {
      const response = await fetch("/api/events/suggest?count=4&minutes=" + encodeURIComponent($("hvDuration").value) + "&activity=" + encodeURIComponent(selectedKind().dataset.kind));
      const body = await response.json();
      if (token !== suggestToken) return;
      slots = body.slots || [];
      $("hvSlots").innerHTML = slots.length ? slots.map((slot, index) => '<button type="button" class="hv-slot" data-slot="' + index + '" aria-pressed="false">' + esc(slot.label) + (slot.busy && slot.busy.length ? ' <small>' + esc(slot.busy.map((id) => member(id).name).join(", ") + " busy") + '</small>' : "") + '</button>').join("")
        : '<span class="hv-none">No shared free time in the next week.</span>';
      markSlots();
    } catch (error) { $("hvSlots").innerHTML = '<span class="hv-none">Couldn’t load free times.</span>'; }
  }
  function markSlots() {
    const tz = houseTz();
    $("hvSlots").querySelectorAll("[data-slot]").forEach((button) => {
      const slot = slots[Number(button.dataset.slot)];
      button.setAttribute("aria-pressed", String(Boolean(slot) && slot.date === $("hvDate").value && hhmm(minutesOf(slot.start, tz)) === $("hvTime").value));
    });
  }
  $("hvSlots").addEventListener("click", (event) => {
    const button = event.target.closest("[data-slot]");
    if (!button) return;
    const slot = slots[Number(button.dataset.slot)];
    $("hvDate").value = slot.date;
    $("hvTime").value = hhmm(minutesOf(slot.start, houseTz()));
    const minutes = Math.round((slot.end - slot.start) / 60000);
    if ([...$("hvDuration").options].some((o) => Number(o.value) === minutes)) $("hvDuration").value = String(minutes);
    markSlots();
  });

  function openCreate(prefill) {
    prefill = prefill || {};
    emojiTouched = false;
    $("hvKinds").querySelectorAll(".hv-kind").forEach((b, i) => b.setAttribute("aria-checked", String(i === 0)));
    setEmoji("📅");
    $("hvTitle").value = "";
    $("hvNotes").value = "";
    $("hvCreateStatus").textContent = "";
    $("hvAllDay").checked = false;
    $("hvRepeat").value = "none";
    $("hvDuration").value = "60";
    const today = dateOf(Date.now(), houseTz());
    $("hvDate").value = prefill.date || today;
    $("hvDate").min = today;
    $("hvEndDate").value = $("hvDate").value;
    $("hvTime").value = hhmm(prefill.minutes !== undefined ? prefill.minutes : nextHour());
    renderWho();
    syncAllDay();
    GC.openDialog("hvCreateDialog");
    setTimeout(() => $("hvTitle").focus(), 30);
    suggest();
  }
  const createButton = $("hvCreate");
  if (createButton) createButton.addEventListener("click", () => openCreate());

  function whoBody() {
    const chosen = [...$("hvWho").querySelectorAll('[data-who][aria-pressed="true"]')].map((b) => b.dataset.who).filter((id) => id !== "*");
    return chosen.length ? { everyone: false, memberIds: chosen } : { everyone: true, memberIds: [] };
  }
  $("hvSave").addEventListener("click", async () => {
    const allDay = $("hvAllDay").checked;
    const body = Object.assign({
      title: $("hvTitle").value.trim(),
      emoji: $("hvEmoji").value,
      kind: selectedKind().dataset.kind,
      date: $("hvDate").value,
      endDate: allDay ? $("hvEndDate").value : null,
      allDay,
      time: allDay ? null : $("hvTime").value,
      durationMin: Number($("hvDuration").value),
      recurrence: $("hvRepeat").value,
      notes: $("hvNotes").value.trim() || null,
    }, whoBody());
    if (!body.title) { $("hvCreateStatus").textContent = "Add a title."; $("hvTitle").focus(); return; }
    if (!body.date || (!allDay && !body.time)) { $("hvCreateStatus").textContent = "Pick a day and time."; return; }
    $("hvSave").disabled = true;
    try {
      await post("/api/events", body);
      GC.closeDialog("hvCreateDialog");
      toast(body.emoji + " " + body.title + " added");
      await load(true);
    } catch (error) { $("hvCreateStatus").textContent = error.message; }
    finally { $("hvSave").disabled = false; }
  });
  $("hvTitle").addEventListener("keydown", (event) => { if (event.key === "Enter") $("hvSave").click(); });
  $("hvPollBtn").addEventListener("click", async () => {
    const kind = selectedKind();
    $("hvPollBtn").disabled = true;
    try {
      const result = await post("/api/events/polls", { kind: kind.dataset.kind, title: $("hvTitle").value.trim() || kind.dataset.title || "House meeting", emoji: $("hvEmoji").value, durationMin: Number($("hvDuration").value) });
      GC.closeDialog("hvCreateDialog");
      toast("Vote sent to the group: " + result.poll.options.map((o) => o.index + ") " + o.label).join("  "));
      await load(true);
    } catch (error) { $("hvCreateStatus").textContent = error.message; }
    finally { $("hvPollBtn").disabled = false; }
  });

  // ---- Event detail -------------------------------------------------------
  const marks = { going: "✓", maybe: "?", no: "✕" };
  async function openEvent(id) {
    try {
      const response = await fetch("/api/events/detail?id=" + encodeURIComponent(id));
      const detail = await response.json();
      if (!response.ok) throw new Error(detail.error || "Couldn’t open that event.");
      currentEvent = detail;
      if (!allIds.length) allIds = detail.members.map((m) => m.id);
      renderEvent();
      GC.openDialog("hvEventDialog");
    } catch (error) { toast(error.message); }
  }
  function renderEvent() {
    const d = currentEvent;
    const e = d.event;
    $("hvEventDialog-title").textContent = e.title;
    const repeat = e.recurrence !== "none" ? GC.chip(e.recurrence === "weekly" ? "Weekly" : "Monthly", "accent", "sync") : "";
    const when = d.range ? (e.allDay ? d.range + " · All day" : d.range) : "Past";
    const attendees = d.members.filter((m) => e.attendeeIds.includes(m.id));
    const people = attendees.map((m) => {
      const status = d.rsvps[m.id] || "none";
      const tag = d.demoMode ? "button" : "div";
      return '<' + tag + (tag === "button" ? ' type="button" data-rsvp="' + esc(m.id) + '" title="Change RSVP"' : "") + ' class="hv-person is-' + status + '">' + GC.avatar(m, allIds, 36)
        + (status !== "none" ? '<span class="hv-badge ' + status + '">' + marks[status] + '</span>' : "") + '<span>' + esc(m.name) + '</span></' + tag + '>';
    }).join("");
    const tasks = d.tasks.length ? '<div class="hv-section"><div class="hv-section-title">' + GC.icon("chores") + 'Tasks</div><ul class="hv-tasks">' + d.tasks.map((t) => '<li class="hv-task' + (t.done ? " is-done" : "") + '">'
      + GC.avatar(d.members.find((m) => m.id === t.memberId) || { id: t.memberId || "?", name: "?" }, allIds, 28)
      + '<span class="hv-task-label">' + esc(t.label) + ' <span class="gc-meta">' + esc((d.members.find((m) => m.id === t.memberId) || {}).name || "") + '</span></span>'
      + '<button type="button" class="hv-check" role="checkbox" aria-checked="' + t.done + '" data-task="' + esc(t.id) + '" aria-label="' + esc(t.label) + ' done">' + GC.icon("check") + '</button></li>').join("") + '</ul></div>' : "";
    const list = d.list ? '<div class="hv-section"><div class="hv-section-title">' + GC.icon("cart") + esc(d.list.name) + '</div><div class="hv-snacks">'
      + d.list.items.map((i) => '<span class="hv-pill' + (i.checked ? " is-done" : "") + '">' + esc(i.name) + '</span>').join("")
      + (d.demoMode && d.list.remaining ? '<button type="button" class="gc-btn gc-btn-tonal gc-btn-sm" data-list-cart="' + esc(d.list.id) + '">' + GC.icon("cart") + 'To cart</button>' : "")
      + '<a class="gc-btn gc-btn-text gc-btn-sm" href="/groceries#lists">Open</a></div></div>' : "";
    const ideas = d.ideas && d.ideas.length ? '<div class="hv-section"><div class="hv-section-title">🍿 Movie ideas</div><ul class="hv-ideas">' + d.ideas.slice(0, 4).map((i) => '<li class="hv-idea">' + esc(i.title)
      + '<span class="gc-avatars">' + i.votes.map((id) => GC.avatar(d.members.find((m) => m.id === id) || { id, name: "?" }, allIds, 20)).join("") + '</span><span class="gc-meta">' + i.votes.length + (i.votes.length === 1 ? " vote" : " votes") + '</span></li>').join("") + '</ul><div class="hv-foot">Text “add movie &lt;title&gt;” or “vote &lt;title&gt;”.</div></div>' : "";
    const notes = e.notes ? '<div class="hv-section"><div class="hv-section-title">' + GC.icon("message") + 'Notes</div><div class="hv-notes-text">' + esc(e.notes) + '</div></div>' : "";
    $("hvEventBody").innerHTML = '<div class="hv-hero"><span class="hv-hero-emoji">' + esc(e.emoji) + '</span><div><div class="hv-hero-sub">' + GC.icon("clock") + esc(when) + repeat + '</div></div></div>'
      + '<div class="hv-section"><div class="hv-section-title">' + GC.icon("users") + (e.kind !== "house" ? "Who’s in" : "Who") + '</div><div class="hv-people">' + people + '</div>'
      + (e.kind !== "house" && !d.demoMode ? '<div class="hv-foot">RSVP in the group: “I’m in” or “can’t make it”.</div>' : "") + '</div>'
      + tasks + list + ideas + notes;
  }
  $("hvEventBody").addEventListener("click", async (event) => {
    const rsvp = event.target.closest("[data-rsvp]");
    if (rsvp && currentEvent) {
      const order = ["going", "maybe", "no"];
      const now = currentEvent.rsvps[rsvp.dataset.rsvp];
      const next = order[(order.indexOf(now) + 1) % order.length];
      try { const result = await post("/api/events/rsvp", { eventId: currentEvent.event.id, memberId: rsvp.dataset.rsvp, status: next }); currentEvent.rsvps = result.rsvps; renderEvent(); load(true); } catch (error) { toast(error.message); }
      return;
    }
    const task = event.target.closest("[data-task]");
    if (task && currentEvent) {
      const done = task.getAttribute("aria-checked") !== "true";
      try { await post("/api/events/tasks/toggle", { taskId: task.dataset.task, done }); const t = currentEvent.tasks.find((x) => x.id === task.dataset.task); if (t) t.done = done; renderEvent(); } catch (error) { toast(error.message); }
      return;
    }
    const cart = event.target.closest("[data-list-cart]");
    if (cart) {
      cart.disabled = true;
      try { const result = await post("/api/named-lists/to-cart", { listId: cart.dataset.listCart }); toast(result.message); openEvent(currentEvent.event.id); } catch (error) { toast(error.message); cart.disabled = false; }
    }
  });
  $("hvDelete").addEventListener("click", async () => {
    if (!currentEvent) return;
    const e = currentEvent.event;
    if (!confirm("Delete " + e.title + (e.recurrence !== "none" ? " (every " + (e.recurrence === "weekly" ? "week" : "month") + ")" : "") + "?")) return;
    try { await post("/api/events/cancel", { id: e.id }); GC.closeDialog("hvEventDialog"); toast(e.title + " deleted"); await load(true); } catch (error) { toast(error.message); }
  });

  // ---- Poll detail --------------------------------------------------------
  function openPoll(id) {
    const poll = ev && ev.polls.find((p) => p.id === id);
    if (!poll) { toast("That plan is closed."); return; }
    currentPoll = poll;
    renderPoll();
    GC.openDialog("hvPollDialog");
  }
  function renderPoll() {
    const p = currentPoll;
    $("hvPollDialog-title").textContent = p.emoji + " " + p.title;
    const best = Math.max(0, ...p.options.map((o) => o.yes.length));
    const people = ev.members.filter((m) => p.attendeeIds.includes(m.id));
    $("hvPollBody").innerHTML = '<div class="hv-hero-sub">' + GC.chip("Voting", "warning", "users") + '<span>' + p.responded.length + " of " + p.attendeeIds.length + ' voted · books at ' + p.majority + ' yes</span>' + (p.organizerId ? '<span>· by ' + esc(member(p.organizerId).name) + '</span>' : "") + '</div>'
      + '<ol class="hv-opts">' + p.options.map((o) => {
        const voters = people.map((m) => {
          const state = o.yes.includes(m.id) ? "yes" : o.no.includes(m.id) ? "no" : "none";
          const tag = ev.demoMode ? "button" : "span";
          return '<' + tag + (tag === "button" ? ' type="button" data-vote="' + esc(m.id) + '" data-option="' + o.index + '" title="' + esc(m.name) + ': ' + (state === "yes" ? "yes" : state === "no" ? "no" : "no answer") + '"' : ' title="' + esc(m.name) + '"') + ' class="hv-vote is-' + state + '">' + GC.avatar(m, allIds, 26) + '</' + tag + '>';
        }).join("");
        return '<li class="hv-opt' + (best && o.yes.length === best ? " is-leading" : "") + '"><span class="hv-opt-num">' + o.index + '</span><div><div class="hv-opt-time">' + esc(o.range || o.label) + '</div>'
          + (o.busy && o.busy.length ? '<div class="hv-opt-busy">' + esc(o.busy.map((id) => member(id).name).join(", ") + " busy") + '</div>' : "") + '</div>'
          + '<button type="button" class="gc-btn gc-btn-outline gc-btn-sm" data-book="' + o.index + '">Book</button>'
          + '<div class="hv-opt-voters">' + voters + '<span class="hv-bar"><span style="width:' + Math.round(o.yes.length / Math.max(1, p.attendeeIds.length) * 100) + '%"></span></span><span class="gc-meta">' + o.yes.length + '</span></div></li>';
      }).join("") + '</ol>'
      + '<div class="hv-foot">' + (ev.demoMode ? "Tap a face to vote as them." : "Everyone votes in the group: reply 1, 2, or 3.") + '</div>';
  }
  $("hvPollBody").addEventListener("click", async (event) => {
    const vote = event.target.closest("[data-vote]");
    if (vote && currentPoll) {
      const option = currentPoll.options.find((o) => o.index === Number(vote.dataset.option));
      const yes = !option.yes.includes(vote.dataset.vote);
      try {
        const result = await post("/api/events/polls/vote", { pollId: currentPoll.id, memberId: vote.dataset.vote, option: option.index, yes });
        if (result.booked) { GC.closeDialog("hvPollDialog"); toast(result.booked.emoji + " " + result.booked.title + " is booked"); }
        else { currentPoll = result.poll; renderPoll(); }
        await load(true);
      } catch (error) { toast(error.message); }
      return;
    }
    const book = event.target.closest("[data-book]");
    if (book && currentPoll) {
      book.disabled = true;
      try { const result = await post("/api/events/polls/book", { pollId: currentPoll.id, option: Number(book.dataset.book) }); GC.closeDialog("hvPollDialog"); toast(result.event.emoji + " " + result.event.title + " is booked"); await load(true); }
      catch (error) { toast(error.message); book.disabled = false; }
    }
  });
  $("hvPollCancel").addEventListener("click", async () => {
    if (!currentPoll || !confirm("Cancel the " + currentPoll.title + " plan?")) return;
    try { await post("/api/events/polls/cancel", { pollId: currentPoll.id }); GC.closeDialog("hvPollDialog"); toast("Plan cancelled"); await load(true); } catch (error) { toast(error.message); }
  });

  function handleDeepLinks() {
    if (!deepLink.event && !deepLink.poll && !deepLink.create) return;
    const link = Object.assign({}, deepLink);
    deepLink.event = deepLink.poll = deepLink.create = null;
    const url = new URL(location.href);
    ["event", "poll", "create"].forEach((key) => url.searchParams.delete(key));
    history.replaceState(null, "", url.pathname + url.search);
    if (link.event) openEvent(link.event);
    else if (link.poll) openPoll(link.poll);
    else if (link.create) openCreate();
  }
  setInterval(() => { if (document.visibilityState === "visible" && view) load(true); }, 30000);
})();
`;

/** Adds household events, plans, and the Create button to the calendar page. */
export function withHouseEvents(page: PageOptions): PageOptions {
  return {
    ...page,
    body: `${page.body}${createDialog}${eventDialog}${pollDialog}`,
    styles: `${page.styles ?? ""}${calendarStyles}`,
    script: `${page.script ?? ""}\n${calendarScript}`,
    actions: `${page.actions ?? ""}${button({ label: "Create", icon: "plus", id: "hvCreate" })}`,
  };
}

// ---------------------------------------------------------------------------
// Home "Upcoming" card

const homeStyles = `
:root { --hv-social:#8e24aa; --hv-social-on:#ffffff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --hv-social:#e1b5ff; --hv-social-on:#3b0a57; } }
:root[data-theme="dark"] { --hv-social:#e1b5ff; --hv-social-on:#3b0a57; }
.hu-list .gc-list-item { padding:var(--gc-space-2) 0; text-decoration:none; color:inherit; }
.hu-row { display:flex; align-items:center; gap:var(--gc-space-3); width:100%; color:inherit; text-decoration:none; border-radius:var(--gc-radius-sm); }
.hu-row:hover .gc-list-title { text-decoration:underline; }
.hu-tile { width:40px; height:40px; flex:none; display:grid; place-items:center; border-radius:12px; background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:20px; line-height:1; }
.hu-tile.is-vote { border:1.5px dashed var(--hv-social); background:color-mix(in srgb, var(--hv-social) 12%, var(--gc-surface)); }
.hu-tile.is-free { background:var(--gc-success-soft); border-color:transparent; color:var(--gc-success); }
.hu-opts { display:flex; gap:4px; }
.hu-opt { min-width:22px; height:22px; padding:0 6px; display:grid; place-items:center; border-radius:11px; background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:11px; font-weight:600; color:var(--gc-text-2); }
.hu-opt.is-lead { background:var(--hv-social); border-color:transparent; color:var(--hv-social-on); }
`;

const homeScript = `
document.addEventListener("DOMContentLoaded", () => {
  const GC = window.GC;
  const list = document.getElementById("homeUpcomingList");
  if (!GC || !list) return;
  const esc = GC.esc;
  async function refresh() {
    try {
      const response = await fetch("/api/events/upcoming");
      if (!response.ok) return;
      const d = await response.json();
      const allIds = d.members.map((m) => m.id);
      const byId = (id) => d.members.find((m) => m.id === id) || { id, name: "?" };
      const rows = [];
      for (const poll of d.polls.slice(0, 2)) {
        const best = Math.max(0, ...poll.options.map((o) => o.yes.length));
        rows.push('<li class="gc-list-item"><a class="hu-row" href="/calendar?poll=' + encodeURIComponent(poll.id) + '&week=' + (poll.options[0] ? new Date(poll.options[0].start).toISOString().slice(0, 10) : "") + '"><span class="hu-tile is-vote">' + esc(poll.emoji) + '</span>'
          + '<div class="gc-list-main"><div class="gc-list-title">' + esc(poll.title) + '</div><div class="gc-list-sub">' + GC.chip("Voting", "warning") + '<span>' + poll.responded.length + ' of ' + poll.attendeeIds.length + ' voted</span></div></div>'
          + '<span class="hu-opts">' + poll.options.map((o) => '<span class="hu-opt' + (best && o.yes.length === best ? " is-lead" : "") + '" title="' + esc(o.label) + '">' + o.yes.length + '</span>').join("") + '</span></a></li>');
      }
      for (const o of d.events) {
        const going = Object.keys(o.rsvps).filter((id) => o.rsvps[id] === "going").map(byId);
        rows.push('<li class="gc-list-item"><a class="hu-row" href="/calendar?event=' + encodeURIComponent(o.eventId) + '&week=' + o.date + '"><span class="hu-tile">' + esc(o.emoji) + '</span>'
          + '<div class="gc-list-main"><div class="gc-list-title">' + esc(o.title) + '</div><div class="gc-list-sub"><span>' + esc(o.label) + '</span>'
          + (o.recurrence !== "none" ? GC.chip(o.recurrence === "weekly" ? "Weekly" : "Monthly", "neutral") : "") + '</div></div>'
          + (going.length ? '<span class="gc-avatars">' + going.map((m) => GC.avatar(m, allIds, 24)).join("") + '</span>' : "") + '</a></li>');
      }
      if (d.nextFree) {
        rows.push('<li class="gc-list-item"><a class="hu-row" href="/calendar"><span class="hu-tile is-free">' + GC.icon("checkCircle") + '</span>'
          + '<div class="gc-list-main"><div class="gc-list-title">Everyone free</div><div class="gc-list-sub"><span>' + esc(d.nextFree.label) + '</span></div></div></a></li>');
      }
      list.innerHTML = rows.length ? rows.join("") : '<li class="gc-empty">' + GC.icon("calendar") + '<p class="gc-empty-title">Nothing planned</p><p class="gc-empty-text">Try “game night this week?” in the group.</p><a class="gc-btn gc-btn-tonal gc-btn-sm" href="/calendar?create=1">Plan something</a></li>';
    } catch (error) { /* keep the last view */ }
  }
  refresh();
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 15000);
});
`;

/** Home "Upcoming" card (id homeUpcoming): open plans, next events with RSVPs, next everyone-free time. */
export function homeUpcomingCard(): string {
  return card({
    id: "homeUpcoming",
    title: "Upcoming",
    icon: "calendar",
    flavor: "home.upcoming", // [themes]
    actions: button({ label: "Open", variant: "text", size: "sm", href: "/calendar" }),
    body: `<ul class="gc-list hu-list" id="homeUpcomingList"><li class="gc-empty"><p class="gc-empty-text">Loading…</p></li></ul>${digestHomeLine() /* money & points: "Next digest: Sun 6pm" */}<style>${homeStyles}</style><script>${homeScript}</script>`,
  });
}
