// The /calendar page and its HTTP routes. The page is split into separable
// pieces (renderCalendarBody -> { styles, body, script }) so it can be dropped
// into a shared app shell; renderCalendarPage() wraps it as a standalone document.
// Colors come from --gc-* custom properties (defined by the wrapper or a shell).
//
// Views (Google Calendar style): Week (7 day columns; members' entries packed side
// by side when they overlap) and Day (one column per member plus a House lane).
// Toolbar: Today, prev/next (a day in Day view, a week in Week view), Week | Day;
// keys ←/→, d, w, t; the URL keeps ?view=day&date=YYYY-MM-DD (src/calendarView.ts).
// Clicking an entry opens a small popover (title, who, time, place). After every
// grid render the page dispatches `gc:calendar-rendered` (see afterGrid below);
// src/ui/eventsPanel.ts uses it to draw household events and plans.
import { icon, renderNotice, renderPage } from "./ui/shell.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GoogleCalendarError, type CalendarService } from "./googleCalendar.js";
import { CALENDAR_STATE_SCRIPT } from "./calendarView.js"; // [calendar-detail] ?view=day&date=… helpers

const styles = String.raw`
.cal { --cal-hour-px: 44px; --cal-gutter: 52px; --cal-col-min: 96px; --cal-house-min: 96px;
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
.cal h1, .cal h2, .cal h3, .cal p, .cal ul, .cal ol { margin: 0; padding: 0; }
.cal ul, .cal ol { list-style: none; }
.cal button, .cal .cal-btn { font: inherit; }
.cal-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px 12px; flex-wrap:wrap; margin-bottom:14px; }
.cal-nav { display:flex; align-items:center; gap:6px; min-width:0; position:relative; }
.cal-range { font-size:20px; font-weight:500; letter-spacing:-.01em; margin-left:2px !important; white-space:nowrap; min-width:0; }
.cal-range-btn { display:inline-flex; align-items:center; gap:4px; max-width:100%; padding:4px 6px; margin:-4px 0; border:0; border-radius:8px; background:transparent; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cal-range-btn:hover { background:var(--cal-surface-2); }
.cal-range-btn > span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.cal-range-btn > .gc-icon { flex:none; opacity:.6; }
.cal-jump { position:absolute; left:120px; bottom:0; width:1px; height:1px; opacity:0; pointer-events:none; border:0; padding:0; }
.cal-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:34px; padding:0 14px; border-radius:999px;
  border:1px solid var(--gc-border); background:var(--gc-surface); color:var(--gc-text); font-size:14px; font-weight:500; cursor:pointer; text-decoration:none; white-space:nowrap; }
.cal-btn:hover { background:var(--cal-surface-2); }
.cal-btn:focus-visible, .cal-icon:focus-visible, .cal-best button:focus-visible, .cal-range-btn:focus-visible, .cal-head-btn:focus-visible, .cal-strip-day:focus-visible { outline:2px solid var(--gc-accent); outline-offset:2px; }
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
.cal-person-actions { grid-column:2; display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; margin-top:4px; }
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
.cal-grid { display:grid; grid-template-columns:var(--cal-gutter) repeat(7, minmax(var(--cal-col-min), 1fr)); min-width:min-content; position:relative; }
.cal-grid[aria-busy="true"] { opacity:.55; transition:opacity .2s; }
.cal-corner, .cal-head { position:sticky; top:0; z-index:9; background:var(--gc-surface); border-bottom:1px solid var(--cal-line); }
.cal-corner { left:0; z-index:10; display:flex; align-items:flex-end; justify-content:center; padding-bottom:6px; color:var(--gc-muted); font-size:10px; }
.cal-head { text-align:center; padding:10px 4px 8px; border-left:1px solid var(--cal-line-soft); min-width:0; }
.cal-head-dow { display:block; font-size:11px; font-weight:500; letter-spacing:.06em; text-transform:uppercase; color:var(--gc-muted); }
.cal-head-date { width:34px; height:34px; margin:2px auto 0; border-radius:50%; display:grid; place-items:center; font-size:20px; font-weight:400; }
.cal-head.today .cal-head-dow { color:var(--gc-accent); }
.cal-head.today .cal-head-date { background:var(--gc-accent); color:var(--gc-on-accent, #fff); font-weight:500; }
.cal-head-free { font-size:10.5px; color:var(--cal-free-text); margin-top:3px; min-height:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cal-gutter { position:sticky; left:0; z-index:8; background:var(--gc-surface); height:calc(var(--cal-hours) * var(--cal-hour-px)); }
.cal-gutter span { position:absolute; right:8px; transform:translateY(-50%); font-size:10.5px; color:var(--gc-muted); white-space:nowrap; }
.cal-day, .cal-col { position:relative; height:calc(var(--cal-hours) * var(--cal-hour-px)); border-left:1px solid var(--cal-line-soft);
  background-image:linear-gradient(to bottom, var(--cal-line-soft) 1px, transparent 1px); background-size:100% var(--cal-hour-px); }
.cal-day.weekend { background-color:color-mix(in srgb, var(--gc-text) 1.5%, transparent); }
.cal-day.past::after { content:""; position:absolute; left:0; right:0; top:0; height:var(--past-h, 0); background:color-mix(in srgb, var(--gc-surface) 38%, transparent); pointer-events:none; z-index:4; }
.cal-free { position:absolute; left:0; right:0; z-index:1; background:var(--cal-free-bg); border-left:3px solid var(--cal-free-edge); border-radius:0 6px 6px 0; }
.cal-free span { display:block; padding:3px 6px; font-size:10.5px; font-weight:600; color:var(--cal-free-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cal-free.flash { animation:cal-flash 1.4s ease 2; }
@keyframes cal-flash { 50% { box-shadow:inset 0 0 0 2px var(--cal-free-edge); } }
.cal-busy { position:absolute; left:1px; right:1px; border-radius:5px; background:var(--m-soft); border-left:3px solid var(--m-solid); color:var(--m-on); overflow:hidden; }
.cal-ovl { position:absolute; left:0; right:0; z-index:1; pointer-events:none; }
.cal-ovl.c2 { background:var(--cal-ovl-2); } .cal-ovl.c3 { background:var(--cal-ovl-3); } .cal-ovl.c4 { background:var(--cal-ovl-4); }
.cal-now { position:absolute; left:-1px; right:0; z-index:7; height:2px; background:var(--cal-now); pointer-events:none; }
.cal-now::before { content:""; position:absolute; left:-5px; top:-4px; width:10px; height:10px; border-radius:50%; background:var(--cal-now); }

.cal-key { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; padding:10px 14px; border-top:1px solid var(--gc-border); color:var(--gc-muted); font-size:12px; }
.cal-key i { display:inline-block; width:14px; height:12px; border-radius:3px; vertical-align:-2px; margin-right:6px; }
.cal-key .k-member { background:var(--m-soft); border-left:3px solid var(--m-solid); }
.cal-key .k-avail { border:1px dashed var(--gc-muted); }
.cal-key .k-ovl2 { background:var(--cal-ovl-2); box-shadow:inset 0 0 0 1px var(--cal-line-soft); }
.cal-key .k-ovl3 { background:var(--cal-ovl-3); box-shadow:inset 0 0 0 1px var(--cal-line-soft); }
.cal-key .k-free { background:var(--cal-free-bg); border-left:3px solid var(--cal-free-edge); }
.cal-key-member { display:inline-flex; align-items:center; padding:2px 6px; margin:-2px -6px; border:0; border-radius:6px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
.cal-key-member:hover { background:var(--cal-surface-2); color:var(--gc-text); }
.cal-key-member:focus-visible { outline:2px solid var(--gc-accent); outline-offset:1px; }
.cal-key-member[aria-pressed="false"] { opacity:.5; text-decoration:line-through; }
.cal-key-member[aria-pressed="false"] .k-member { background:transparent; }

/* --- [calendar-detail] Week | Day toggle, titled events, Day view, popover --- */
.cal-tools { display:flex; align-items:center; gap:10px; }
.cal-seg { display:inline-flex; }
.cal-seg .cal-btn { min-width:64px; }
.cal-seg .cal-btn:first-child { border-top-right-radius:0; border-bottom-right-radius:0; }
.cal-seg .cal-btn + .cal-btn { margin-left:-1px; border-top-left-radius:0; border-bottom-left-radius:0; }
.cal-seg .cal-btn:not(.primary) { color:var(--gc-muted); }
.cal-titles { font-size:13px; gap:8px; }
.cal-head-btn { display:block; width:100%; padding:0; border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; border-radius:10px; }
.cal-head-btn:hover .cal-head-date { background:var(--cal-surface-2); }
.cal-head.today .cal-head-btn:hover .cal-head-date { background:var(--gc-accent); filter:brightness(1.08); }
.cal-allday { display:grid; gap:2px; margin-top:4px; }
.cal-adchip { display:block; flex:none; width:100%; height:20px; padding:0 6px; border:0; border-radius:4px; background:var(--m-solid); color:#fff; font:500 11px/20px var(--gc-font, inherit); text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.cal-adchip.is-free { background:transparent; color:var(--gc-text-2, var(--gc-text)); box-shadow:inset 0 0 0 1px var(--m-solid); }
.cal-adchip.is-more { background:transparent; color:var(--gc-muted); padding:0 4px; }
.cal-ev { z-index:2; display:flex; flex-direction:column; justify-content:flex-start; align-items:stretch; margin:0; padding:2px 6px; border-top:0; border-right:0; border-bottom:0; box-shadow:0 0 0 1px var(--gc-surface); font:500 11.5px/1.3 var(--gc-font, inherit); text-align:left; cursor:pointer; }
.cal-ev:hover { filter:brightness(.97) saturate(1.1); }
.cal-ev:focus-visible { z-index:6; outline:2px solid var(--gc-accent); outline-offset:1px; }
.cal-ev > span { display:block; flex:none; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cal-ev .cal-ev-title { font-weight:600; }
.cal-ev .cal-ev-time, .cal-ev .cal-ev-loc, .cal-ev .cal-ev-at { font-weight:400; font-size:10.5px; opacity:.88; }
.cal-ev .cal-ev-at, .cal-ev .cal-ev-loc { display:none; }
.cal-ev.is-anon .cal-ev-title { font-weight:500; }
.cal-ev.is-short { flex-direction:row; align-items:baseline; gap:4px; padding-top:1px; padding-bottom:0; line-height:1.25; }
.cal-ev.is-short .cal-ev-title { flex:0 1 auto; min-width:0; }
.cal-ev.is-short .cal-ev-at { display:block; flex:none; }
.cal-ev.is-short .cal-ev-time { display:none; }
.cal-ev.is-roomy .cal-ev-title { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.cal-ev.is-roomy .cal-ev-loc { display:block; }
.cal-ev.is-narrow .cal-ev-at, .cal-ev.is-narrow .cal-ev-time, .cal-ev.is-narrow .cal-ev-loc { display:none; }
.cal-ev.is-narrow .cal-ev-title { display:block; white-space:nowrap; }
.cal-ev.is-tiny { padding:0; } .cal-ev.is-tiny > span { display:none !important; }
.cal .cal-ev.cal-busy.is-free { flex-direction:row; align-items:center; gap:4px; height:20px; padding:0 7px; border:1px dashed color-mix(in srgb, var(--m-solid) 75%, transparent); border-radius:999px;
  background:color-mix(in srgb, var(--gc-surface) 88%, transparent); color:var(--gc-text-2, var(--gc-text)); box-shadow:none; line-height:1; }
.cal .cal-ev.is-free .cal-ev-title { font-weight:500; flex:0 1 auto; min-width:0; }
.cal .cal-ev.is-free .cal-ev-at { display:block; flex:none; }
.cal .cal-ev.is-free .cal-ev-time, .cal .cal-ev.is-free .cal-ev-loc { display:none; }

.cal-strip { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); gap:2px; padding:6px 8px; border-bottom:1px solid var(--gc-border); }
.cal-strip[hidden] { display:none; }
.cal-strip-day { display:grid; justify-items:center; gap:2px; padding:4px 0 5px; border:0; border-radius:12px; background:transparent; color:var(--gc-muted); font:500 10.5px/1 var(--gc-font, inherit); letter-spacing:.06em; text-transform:uppercase; cursor:pointer; }
.cal-strip-day:hover { background:var(--cal-surface-2); }
.cal-strip-num { width:30px; height:30px; display:grid; place-items:center; border-radius:50%; color:var(--gc-text); font-size:15px; font-weight:500; letter-spacing:0; }
.cal-strip-day.is-today { color:var(--gc-accent); }
.cal-strip-day.is-today .cal-strip-num { color:var(--gc-accent); box-shadow:inset 0 0 0 1.5px var(--gc-accent); }
.cal-strip-day[aria-pressed="true"] .cal-strip-num { background:var(--gc-accent); color:var(--gc-on-accent, #fff); box-shadow:none; }
.cal-strip-dot { width:4px; height:4px; border-radius:50%; background:var(--cal-free-edge); opacity:0; }
.cal-strip-dot.on { opacity:1; }

.cal-grid.is-day { grid-template-columns:var(--cal-gutter) repeat(var(--cal-cols, 1), minmax(var(--cal-col-min), 1fr)) minmax(var(--cal-house-min), .7fr); }
.cal-dayrow { grid-column:2 / -1; position:relative; display:grid; grid-template-columns:repeat(var(--cal-cols, 1), minmax(var(--cal-col-min), 1fr)) minmax(var(--cal-house-min), .7fr); grid-template-columns:subgrid; }
.cal-col.is-off { background-color:color-mix(in srgb, var(--gc-text) 2.5%, transparent); }
.cal-col-house { background-color:color-mix(in srgb, var(--gc-accent) 3%, transparent); }
.cal-bands { position:absolute; inset:0; z-index:1; pointer-events:none; }
.cal-bands .cal-ovl { opacity:.7; }
.cal-bands .cal-free span { padding-left:8px; }
.cal-pastshade { position:absolute; left:0; right:0; top:0; z-index:4; background:color-mix(in srgb, var(--gc-surface) 38%, transparent); pointer-events:none; }
.cal-head-member { display:grid; justify-items:center; gap:3px; padding:10px 6px 8px; }
.cal-who { display:flex; align-items:center; justify-content:center; gap:8px; max-width:100%; min-width:0; }
.cal-who-name { min-width:0; font-size:13.5px; font-weight:600; color:var(--gc-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cal-who-sub { max-width:100%; font-size:11px; color:var(--gc-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cal-head-member .cal-allday { width:100%; }
.cal-head-member.is-off .cal-who { opacity:.6; }
.cal-house-badge { width:26px; height:26px; flex:none; display:grid; place-items:center; border-radius:50%; background:var(--gc-accent-soft); color:var(--gc-accent); }
.cal-head-member::after { content:""; position:absolute; left:0; right:0; bottom:-1px; height:3px; background:var(--m-solid, transparent); opacity:.85; }
.cal-head-house::after { background:var(--gc-accent); opacity:.35; }

.cal-pop { position:fixed; z-index:45; width:min(340px, calc(100vw - 24px)); padding:16px 16px 14px; box-shadow:0 10px 30px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08); outline:none; }
.cal-pop[hidden], .cal-pop-scrim[hidden] { display:none; }
.cal-pop.is-open { animation:cal-pop-in .14s ease-out; }
@keyframes cal-pop-in { from { opacity:0; transform:translateY(4px) scale(.98); } }
.cal-pop-close { position:absolute; top:6px; right:6px; width:32px; height:32px; font-size:22px; color:var(--gc-muted); }
.cal-pop-title { display:flex; align-items:flex-start; gap:12px; margin:2px 30px 12px 0 !important; font-size:18px; font-weight:400; line-height:1.3; overflow-wrap:anywhere; }
.cal-pop-swatch { flex:none; width:14px; height:14px; margin-top:4px; border-radius:4px; background:var(--m-solid); }
.cal-pop-swatch.is-free { background:transparent; box-shadow:inset 0 0 0 2px var(--m-solid); }
.cal-pop-rows { display:grid; gap:9px; }
.cal-pop-row { display:grid; grid-template-columns:20px minmax(0,1fr); gap:12px; align-items:center; font-size:13.5px; color:var(--gc-text-2, var(--gc-text)); overflow-wrap:anywhere; }
.cal-pop-row > :first-child { justify-self:center; color:var(--gc-muted); }
.cal-pop-row .gc-avatar { --gc-avatar-size:22px; }
.cal-pop-note { margin-top:12px !important; color:var(--gc-muted); font-size:12px; }
.cal-pop-scrim { position:fixed; inset:0; z-index:44; background:rgba(0,0,0,.28); }

@media (max-width: 1060px) {
  .cal-layout { grid-template-columns:1fr; grid-template-rows:none; grid-template-areas:"best" "main" "people"; }
}
@media (max-width: 640px) {
  .cal { --cal-hour-px: 40px; --cal-gutter: 44px; --cal-col-min: 88px; --cal-house-min: 84px; }
  .cal.is-day { --cal-col-min: 112px; }
  .cal-range { font-size:17px; margin-left:0 !important; }
  .cal-toolbar { margin-bottom:10px; }
  .cal-tools { width:100%; justify-content:space-between; }
  .cal-layout { grid-template-areas:"main" "best" "people"; }
  #calMode { display:none; }
  .cal-scroll { max-height:max(360px, calc(100vh - 340px)); max-height:max(360px, calc(100dvh - 340px)); }
  .cal-pop { left:0 !important; right:0; top:auto !important; bottom:0; width:100%; max-height:70vh; overflow:auto; border-radius:18px 18px 0 0; padding:18px 18px calc(18px + env(safe-area-inset-bottom)); }
  .cal-pop.is-open { animation-name:cal-sheet-in; animation-duration:.18s; }
  @keyframes cal-sheet-in { from { transform:translateY(24px); opacity:.4; } }
}
@media (min-width: 641px) { .cal-pop-scrim { display:none; } }
@media (prefers-reduced-motion: reduce) {
  .cal-free.flash { animation:none; box-shadow:inset 0 0 0 2px var(--cal-free-edge); }
  .cal-pop.is-open { animation:none; }
}
/* --- end [calendar-detail] --- */
`;

const body = String.raw`
<div class="cal" id="cal">
  <div class="cal-toolbar">
    <div class="cal-nav">
      <button class="cal-btn" id="calToday" type="button" title="Today (T)">Today</button>
      <button class="cal-icon" id="calPrev" type="button" aria-label="Previous week" title="Previous week (←)">&#8249;</button>
      <button class="cal-icon" id="calNext" type="button" aria-label="Next week" title="Next week (→)">&#8250;</button>
      <h1 class="cal-range" aria-live="polite"><button type="button" class="cal-range-btn" id="calRange" title="Go to a date"><span id="calRangeText">This week</span>${icon("chevronDown", { size: 18 })}</button></h1>
      <input class="cal-jump" id="calJump" type="date" tabindex="-1" aria-hidden="true" />
    </div>
    <div class="cal-tools">
      <div class="cal-seg" role="group" aria-label="View">
        <button class="cal-btn" type="button" data-view="week" aria-pressed="true" title="Week view (W)">Week</button>
        <button class="cal-btn" type="button" data-view="day" aria-pressed="false" title="Day view (D)">Day</button>
      </div>
      <span class="cal-chip" id="calMode">Loading…</span>
    </div>
  </div>
  <div class="cal-notice" id="calNotice" role="status" hidden><span id="calNoticeText"></span><button type="button" id="calNoticeClose" aria-label="Dismiss">&times;</button></div>
  <div class="cal-layout">
    <section class="cal-main" aria-label="Calendar">
      <div class="cal-strip" id="calStrip" role="group" aria-label="Days of this week" hidden></div>
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
  <div class="cal-pop-scrim" id="calPopScrim" hidden></div>
  <div class="cal-pop cal-panel" id="calPop" role="dialog" aria-modal="false" aria-labelledby="calPopTitle" tabindex="-1" hidden>
    <button type="button" class="cal-icon cal-pop-close" id="calPopClose" aria-label="Close">&times;</button>
    <h3 class="cal-pop-title" id="calPopTitle"></h3>
    <div class="cal-pop-rows" id="calPopRows"></div>
    <p class="cal-pop-note" id="calPopNote" hidden></p>
  </div>
</div>
`;

const script = String.raw`
(() => {
  // --- [calendar-detail] URL state helpers (src/calendarView.ts) ---
  ${CALENDAR_STATE_SCRIPT}
  // --- end URL state helpers ---
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
  const phoneQuery = window.matchMedia("(max-width: 640px)");
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const isPhone = () => phoneQuery.matches;
  const startParams = new URLSearchParams(location.search);
  const PIN = '<svg class="gc-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>';
  const CLOCK = '<svg class="gc-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
  const HOUSE = (window.GC && GC.icon && GC.icon("home")) || "";

  let state = CalendarState.parse(location.search, isPhone());
  let data = null;               // /api/calendar payload for the week around the selected date
  let loading = 0;
  let scrollPending = true;      // scroll to a useful hour on the next render
  let flashSlot = null;          // best-time slot to highlight after the next render
  let popTrigger = null;
  const cache = new Map();       // weekStart -> { at, data }
  // Calendars hidden from the grid with the legend toggles (this browser only); free time still counts everyone.
  const hidden = new Set((() => { try { return JSON.parse(localStorage.getItem("gc-cal-hidden") || "[]"); } catch { return []; } })());
  const shown = (member) => !hidden.has(member.id);
  const inflight = new Map();    // weekStart -> Promise
  const FRESH_MS = 60000;

  // ---- Formatting ---------------------------------------------------------
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
  function clockParts(ms) {
    const parts = formatter("clock", { hour: "numeric", minute: "2-digit" }).formatToParts(new Date(ms));
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
    return { hour: get("hour"), minute: get("minute") || "00", period: get("dayPeriod").replace(/[.\s]/g, "").toLowerCase() };
  }
  // "9am", "9:30am" (or "09:00" in 24-hour locales)
  function compactTime(ms, withPeriod) {
    const c = clockParts(ms);
    if (!c.period) return c.hour + ":" + c.minute;
    return c.hour + (c.minute === "00" ? "" : ":" + c.minute) + (withPeriod === false ? "" : c.period);
  }
  // "9 – 10:30am", "11am – 1pm"
  function compactRange(a, b) {
    const pa = clockParts(a), pb = clockParts(b);
    return compactTime(a, !pa.period || pa.period !== pb.period ? undefined : false) + " – " + compactTime(b);
  }
  function duration(ms) {
    const total = Math.round(ms / 60000), h = Math.floor(total / 60), m = total % 60;
    return h ? (m ? h + " h " + m + " m" : h + " h") : m + " min";
  }
  function compactDuration(ms) {
    const total = Math.round(ms / 60000), h = Math.floor(total / 60), m = total % 60;
    return h ? (m ? h + "h " + m + "m" : h + "h") : m + "m";
  }
  const utcHour = new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" });
  const hourLabel = (h) => utcHour.format(new Date(Date.UTC(2020, 0, 1, h))).replace(/\s/g, " ");
  function dateOf(ms) {
    const parts = formatter("ymd", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
    return get("year") + "-" + get("month") + "-" + get("day");
  }
  const noon = (date) => new Date(date + "T12:00:00Z");
  const utcCache = {};
  const utcFmt = (options) => { const key = JSON.stringify(options); return utcCache[key] || (utcCache[key] = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options })); };
  const colorClass = (member) => "mx-" + String(member.id).replace(/[^a-zA-Z0-9_-]/g, "");
  const included = (member) => member.status === "sample" || member.status === "connected";
  const selectedDate = () => state.date || (data && data.today) || "";
  const dayFor = (date) => (data && data.days.find((d) => d.date === date)) || null;
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
    if (tag.textContent !== rules) tag.textContent = rules;
  }
  function avatar(member, size) {
    if (window.GC && GC.avatar) return GC.avatar(member, data.members.map((m) => m.id), size);
    return '<span class="cal-avatar" style="width:' + size + 'px;height:' + size + 'px" aria-hidden="true">' + esc(member.name.slice(0, 1).toUpperCase()) + '</span>';
  }

  function showNotice(text, warn) {
    $("calNoticeText").textContent = text;
    $("calNotice").classList.toggle("warn", Boolean(warn));
    $("calNotice").hidden = false;
  }
  $("calNoticeClose").addEventListener("click", () => { $("calNotice").hidden = true; });

  // ---- Data ---------------------------------------------------------------
  // One request per week; Day view reuses the week it belongs to, so stepping days is instant.
  function fetchWeek(week) {
    const key = week || "current";
    if (inflight.has(key)) return inflight.get(key);
    const query = new URLSearchParams();
    if (week) query.set("week", week);
    if (tz) query.set("tz", tz);
    const request = fetch("/api/calendar?" + query.toString(), { headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not load the calendar.");
        cache.set(body.weekStart, { at: Date.now(), data: body });
        if (cache.size > 10) cache.delete(cache.keys().next().value);
        return body;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  }
  function wantedWeek() {
    if (state.date) return CalendarState.mondayOf(state.date);
    return data ? CalendarState.mondayOf(data.today) : "";
  }
  async function load(options) {
    options = options || {};
    const week = wantedWeek();
    const token = ++loading;
    const cached = week ? cache.get(week) : null;
    if (cached && !options.force) {
      data = cached.data;
      render(options.motion);
      syncUrl(options.push);
      if (Date.now() - cached.at < FRESH_MS) { prefetch(); return; }
      options = { quiet: true };
    }
    if (!options.quiet) $("calGrid").setAttribute("aria-busy", "true");
    try {
      const body = await fetchWeek(week);
      if (token !== loading) return;
      data = body;
      render(options.quiet ? 0 : options.motion);
      if (!options.quiet) syncUrl(options.push);
      prefetch();
    } catch (error) {
      if (token === loading) showNotice(error.message || "Could not load the calendar.", true);
    } finally {
      if (token === loading) $("calGrid").setAttribute("aria-busy", "false");
    }
  }
  // Day view at the edge of a week: fetch the neighbouring week in the background.
  function prefetch() {
    if (!data || state.view !== "day") return;
    const date = selectedDate();
    const next = date === data.days[0].date ? data.prevWeek : date === data.days[6].date ? data.nextWeek : "";
    const cached = next && cache.get(next);
    if (next && !(cached && Date.now() - cached.at < FRESH_MS)) fetchWeek(next).catch(() => {});
  }
  function syncUrl(push) {
    if (!data) return;
    const url = new URL(location.href);
    ["connected", "disconnected", "titles"].forEach((key) => url.searchParams.delete(key));
    const next = url.pathname + CalendarState.search(state, data.today, isPhone(), url.search) + url.hash;
    if (next === location.pathname + location.search + location.hash) return;
    history[push ? "pushState" : "replaceState"](null, "", next);
  }

  // ---- Navigation ---------------------------------------------------------
  function navigate(next, how) {
    how = how || {};
    closePop(false);
    state = data ? CalendarState.normalize(next, data.today) : next;
    if (how.scroll) scrollPending = true;
    load({ motion: how.motion || 0, push: Boolean(how.push) });
  }
  const step = (direction) => data && navigate(CalendarState.step(state, direction, data.today), { motion: direction });
  function setView(view) {
    if (!data || view === state.view) return;
    navigate(CalendarState.withView(state, view, data.today), { motion: "fade", push: true, scroll: true });
  }
  function goToday() {
    if (!data) return;
    const from = selectedDate();
    navigate({ view: state.view, date: null }, { motion: from < data.today ? 1 : from > data.today ? -1 : 0, scroll: true });
  }
  function openDay(date) {
    if (!data || !CalendarState.isDate(date)) return;
    const from = selectedDate();
    navigate(CalendarState.withDate(state, date, "day", data.today), { motion: state.view === "day" ? (date > from ? 1 : date < from ? -1 : 0) : "fade", push: state.view !== "day" });
  }
  function animateGrid(motion) {
    const grid = $("calGrid");
    if (!motion || motionQuery.matches || !grid.animate) return;
    const frames = motion === "fade"
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0.2, transform: "translateX(" + (motion > 0 ? 28 : -28) + "px)" }, { opacity: 1, transform: "none" }];
    grid.animate(frames, { duration: motion === "fade" ? 150 : 210, easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  // ---- Render -------------------------------------------------------------
  function render(motion) {
    applyMemberColors(data.members);
    const date = dayFor(selectedDate()) ? selectedDate() : data.days[0].date;
    const isDay = state.view === "day";
    $("cal").classList.toggle("is-day", isDay);
    renderToolbar(date, isDay);
    renderStrip(date, isDay);
    renderPeople();
    renderBest();
    renderGrid();
    renderKey();
    animateGrid(motion);
  }
  function renderGrid() {
    if (state.view === "day") renderDay(dayFor(selectedDate()) || data.days[0]); else renderWeek();
  }

  function renderToolbar(date, isDay) {
    const days = data.days;
    let label;
    if (isDay) label = utcFmt(isPhone() ? { weekday: "short", month: "short", day: "numeric" } : { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(noon(date));
    else label = utcFmt({ month: "short", day: "numeric", year: "numeric" }).formatRange(noon(days[0].date), noon(days[6].date));
    $("calRangeText").textContent = label;
    $("calJump").value = date;
    const unit = isDay ? "day" : "week";
    $("calPrev").setAttribute("aria-label", "Previous " + unit); $("calPrev").title = "Previous " + unit + " (←)";
    $("calNext").setAttribute("aria-label", "Next " + unit); $("calNext").title = "Next " + unit + " (→)";
    document.querySelectorAll(".cal-seg [data-view]").forEach((button) => {
      const on = button.dataset.view === state.view;
      button.setAttribute("aria-pressed", String(on));
      button.classList.toggle("primary", on);
    });
    const titled = data.members.some((m) => m.status === "connected" && m.titles);
    $("calMode").textContent = data.mode === "demo" ? "Sample schedules" : titled ? "Google Calendar" : "Google Calendar · busy times only";
  }

  // Day view: a row of the week's days to jump between (dot = time when everyone is free).
  function renderStrip(date, isDay) {
    const strip = $("calStrip");
    strip.hidden = !isDay;
    if (!isDay) return;
    const now = data.now;
    strip.innerHTML = data.days.map((day) => {
      const free = data.included && day.end > now && data.everyoneFree.some((w) => w.end > Math.max(day.start, now) && w.start < day.end);
      const label = utcFmt({ weekday: "long", month: "long", day: "numeric" }).format(noon(day.date));
      return '<button type="button" class="cal-strip-day' + (day.date === data.today ? " is-today" : "") + '" data-goto-day="' + day.date + '" aria-pressed="' + (day.date === date) + '"'
        + (day.date === data.today ? ' aria-current="date"' : "") + ' aria-label="' + esc(label) + '">'
        + '<span>' + esc(utcFmt({ weekday: "short" }).format(noon(day.date))) + '</span>'
        + '<span class="cal-strip-num">' + esc(utcFmt({ day: "numeric" }).format(noon(day.date))) + '</span>'
        + '<span class="cal-strip-dot' + (free ? " on" : "") + '" title="' + (free ? "Everyone has free time" : "") + '"></span></button>';
    }).join("");
  }

  function renderPeople() {
    const demo = data.mode === "demo";
    const statuses = {
      sample: ["sample", "Sample schedule"],
      connected: ["ok", "Connected"],
      not_connected: ["", "Not connected"],
      needs_reconnect: ["warn", "Reconnect needed"],
      error: ["bad", "Couldn’t load"],
    };
    $("calPeople").innerHTML = data.members.map((member) => {
      let [cls, label] = statuses[member.status] || ["", member.status];
      if (member.status === "sample" && member.source === "file") label = "Demo calendar";
      if (member.status === "connected") {
        if (member.detail) { cls = "warn"; label = "Connected · busy times only"; }
        else label = member.titles ? "Connected · event titles" : "Connected · busy times only";
      }
      const startUrl = "/api/google/oauth/start?memberId=" + encodeURIComponent(member.id);
      let actions = "";
      if (demo) actions = '<span class="cal-btn" aria-disabled="true" title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect">Connect Google Calendar</span>';
      else if (member.status === "not_connected") actions = '<a class="cal-btn primary" href="' + startUrl + '">Connect Google Calendar</a>';
      else if (member.status === "needs_reconnect") actions = '<a class="cal-btn primary" href="' + startUrl + (member.titlesGranted ? "&titles=1" : "") + '">Reconnect</a><button class="cal-btn quiet" type="button" data-disconnect="' + esc(member.id) + '">Disconnect</button>';
      else if (member.status === "error") actions = '<button class="cal-btn" type="button" data-retry>Retry</button><button class="cal-btn quiet" type="button" data-disconnect="' + esc(member.id) + '">Disconnect</button>';
      else actions = '<button class="cal-btn quiet" type="button" data-disconnect="' + esc(member.id) + '">Disconnect</button>';
      // [calendar-detail] per-member opt-in to event titles (Google only).
      if (!demo && (member.status === "connected" || member.status === "error")) {
        actions = '<label class="hv-switch cal-titles"><input type="checkbox" role="switch" data-titles="' + esc(member.id) + '"' + (member.titlesGranted ? " checked" : "") + ' /><span class="hv-track" aria-hidden="true"></span>Show event titles</label>' + actions;
      }
      const detail = member.detail && member.status !== "sample" ? ' title="' + esc(member.detail) + '"' : "";
      return '<li class="cal-person ' + colorClass(member) + '"><span class="cal-avatar" aria-hidden="true">' + esc(member.name.slice(0, 1).toUpperCase()) + '</span>'
        + '<div><div class="cal-person-name">' + esc(member.name) + '</div><div class="cal-status ' + cls + '"' + detail + '>' + esc(label) + '</div></div>'
        + '<div class="cal-person-actions">' + actions + '</div></li>';
    }).join("") || '<li class="cal-empty">No household members yet.</li>';
    $("calPeopleFoot").textContent = demo
      ? "Demo mode: calendars are samples. Add Google OAuth credentials to connect real ones."
      : "Each person signs in with their own Google account. Only busy times are shared unless someone turns on event titles (title, time, and place; never descriptions or guests).";
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

  // ---- Grid helpers ---------------------------------------------------------
  // Visible hours: 7 AM–10 PM, stretched to fit any timed entry this week (stable while stepping days).
  function makeGeometry() {
    let startHour = 7, endHour = 22;
    for (const member of data.members) for (const item of member.events) {
      if (item.allDay) continue;
      for (const day of data.days) {
        if (item.end <= day.start || item.start >= day.end) continue;
        startHour = Math.min(startHour, Math.floor(minutesInDay(item.start, day) / 60));
        endHour = Math.max(endHour, Math.ceil(minutesInDay(item.end, day) / 60));
      }
    }
    const ppm = parseFloat(getComputedStyle($("cal")).getPropertyValue("--cal-hour-px")) / 60 || 44 / 60;
    return { startHour, endHour, ppm };
  }
  const topPx = (geo, minutes) => ((minutes - geo.startHour * 60) * geo.ppm).toFixed(1) + "px";
  const heightPx = (geo, a, b) => Math.max(2, (b - a) * geo.ppm).toFixed(1) + "px";
  function gutterHtml(geo) {
    let html = '<div class="cal-gutter" aria-hidden="true">';
    for (let h = geo.startHour + 1; h < geo.endHour; h += 1) html += '<span style="top:' + ((h - geo.startHour) * 60 * geo.ppm) + 'px">' + esc(hourLabel(h)) + '</span>';
    return html + '</div>';
  }
  // Timed entries of one member on one day, in visible minutes [a, b) (vb = drawn bottom for packing).
  function placed(member, memberIndex, day, geo) {
    const out = [];
    member.events.forEach((item, itemIndex) => {
      if (item.allDay || item.end <= day.start || item.start >= day.end) return;
      const a = Math.max(minutesInDay(item.start, day), geo.startHour * 60);
      const b = Math.min(minutesInDay(item.end, day), geo.endHour * 60);
      if (b <= a) return;
      const minPx = item.free ? 21 : 15;
      out.push({ member, memberIndex, item, itemIndex, a, b, vb: Math.max(item.free ? a : b, a + minPx / geo.ppm) });
    });
    return out;
  }
  // Google Calendar style layout. Entries whose titles would collide (they overlap and start
  // within ~30px of each other) sit side by side; an entry that starts well after one it
  // overlaps is drawn on top of it, slightly indented, so both titles stay readable.
  function pack(list, geo) {
    const near = 30 / geo.ppm;
    const overlaps = (p, q) => p.a < q.vb && q.a < p.vb;
    const sorted = list.slice().sort((x, y) => x.a - y.a || (y.vb - y.a) - (x.vb - x.a));
    let cluster = [], clusterEnd = -Infinity;
    const flush = () => {
      const cols = [];
      for (const p of cluster) {
        let col = cols.findIndex((items) => !items.some((q) => overlaps(p, q) && p.a - q.a < near));
        if (col < 0) { col = cols.length; cols.push([]); }
        p.col = col;
        p.depth = cols[col].reduce((depth, q) => (overlaps(p, q) ? Math.max(depth, q.depth + 1) : depth), 0);
        cols[col].push(p);
      }
      for (const p of cluster) {
        p.cols = cols.length; p.span = 1;
        for (let c = p.col + 1; c < cols.length && !cols[c].some((q) => overlaps(p, q)); c += 1) p.span += 1;
      }
      cluster = []; clusterEnd = -Infinity;
    };
    for (const p of sorted) {
      if (cluster.length && p.a >= clusterEnd) flush();
      cluster.push(p); clusterEnd = Math.max(clusterEnd, p.vb);
    }
    if (cluster.length) flush();
    return sorted;
  }
  // right: px kept free on the column's right edge; indent: px per nesting level.
  function blockHtml(p, geo, right, indent) {
    const { item, member } = p;
    const title = item.title == null ? "Busy" : item.title;
    const height = item.free ? 20 : Math.max(15, (p.b - p.a) * geo.ppm - 1);
    const area = "(100% - " + right + "px)";
    const shift = p.depth ? "min(" + (p.depth * indent) + "px, " + area + " * " + (p.span / p.cols / 2).toFixed(4) + ")" : "0px";
    const left = "calc(" + area + " * " + (p.col / p.cols).toFixed(4) + " + " + shift + ")";
    const width = "calc(" + area + " * " + (p.span / p.cols).toFixed(4) + " - " + shift + " - 1px)";
    const label = title + ", " + timeRange(item.start, item.end) + ", " + member.name + (item.location ? ", " + item.location : "") + (item.free ? ", shown as available" : "");
    return '<button type="button" class="cal-busy cal-ev ' + colorClass(member) + (item.free ? " is-free" : "") + (item.title == null ? " is-anon" : "") + '" data-ev="' + p.memberIndex + ':' + p.itemIndex + '"'
      + ' style="top:' + topPx(geo, p.a) + ';height:' + height.toFixed(1) + 'px;left:' + left + ';width:' + width + '" aria-label="' + esc(label) + '">'
      + '<span class="cal-ev-title">' + esc(title) + '</span>'
      + '<span class="cal-ev-at">' + esc(compactTime(item.start)) + '</span>'
      + '<span class="cal-ev-time">' + esc(compactRange(item.start, item.end)) + '</span>'
      + (item.location ? '<span class="cal-ev-loc">' + esc(item.location) + '</span>' : "") + '</button>';
  }
  // Show as much text as fits: color only, one line, title + time, or title + time + place.
  function fitBlocks(root) {
    const blocks = [...root.querySelectorAll(".cal-ev")];
    const sizes = blocks.map((el) => [el.offsetWidth, el.offsetHeight]);
    blocks.forEach((el, index) => {
      const [w, h] = sizes[index];
      el.classList.toggle("is-tiny", w < 40 || h < 12);
      el.classList.toggle("is-narrow", w < 64);
      el.classList.toggle("is-short", h < 30);
      el.classList.toggle("is-roomy", h >= 56);
    });
  }
  function allDayFor(day) {
    const out = [];
    data.members.forEach((member, memberIndex) => member.events.forEach((item, itemIndex) => {
      if (item.allDay && shown(member) && item.end > day.start && item.start < day.end) out.push({ member, memberIndex, item, itemIndex });
    }));
    return out;
  }
  function allDayHtml(entries, limit, date) {
    if (!entries.length) return "";
    const shown = entries.slice(0, limit);
    const more = entries.length - shown.length;
    return '<div class="cal-allday">' + shown.map((e) => {
      const title = e.item.title == null ? "Busy" : e.item.title;
      return '<button type="button" class="cal-adchip ' + colorClass(e.member) + (e.item.free ? " is-free" : "") + '" data-ev="' + e.memberIndex + ':' + e.itemIndex + '" aria-label="' + esc(title + ", all day, " + e.member.name) + '">' + esc(title) + '</button>';
    }).join("") + (more > 0 ? '<button type="button" class="cal-adchip is-more" data-goto-day="' + date + '">+' + more + ' more</button>' : "") + '</div>';
  }
  function freeLabel(w) { return "Everyone free · " + compactRange(w.start, w.end); }
  function shortZone() {
    try {
      const part = new Intl.DateTimeFormat(undefined, { timeZone: data.timeZone, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
      return part ? part.value : "";
    } catch { return ""; }
  }

  // ---- Week view ----------------------------------------------------------
  function renderWeek() {
    const days = data.days;
    const members = data.members;
    const geo = makeGeometry();
    const grid = $("calGrid");
    grid.className = "cal-grid is-week";
    grid.style.setProperty("--cal-hours", String(geo.endHour - geo.startHour));
    grid.style.removeProperty("--cal-cols");
    const now = Date.now();
    const freeByDay = days.map((day) => data.everyoneFree.filter((w) => w.end > day.start && w.start < day.end));
    let html = '<div class="cal-corner">' + esc(shortZone()) + '</div>';
    days.forEach((day, index) => {
      const isToday = day.date === data.today;
      const freeMs = freeByDay[index].reduce((sum, w) => sum + Math.max(0, Math.min(w.end, day.end) - Math.max(w.start, day.start, now)), 0);
      const freeText = data.included && day.end > now && freeMs >= 30 * 60000 ? compactDuration(freeMs) + " free" : "";
      const long = utcFmt({ weekday: "long", month: "long", day: "numeric" }).format(noon(day.date));
      html += '<div class="cal-head' + (isToday ? " today" : "") + '"' + (isToday ? ' aria-current="date"' : "") + '>'
        + '<button type="button" class="cal-head-btn" data-goto-day="' + day.date + '" title="Open ' + esc(long) + '" aria-label="' + esc(long) + ', open Day view">'
        + '<span class="cal-head-dow">' + esc(utcFmt({ weekday: "short" }).format(noon(day.date))) + '</span>'
        + '<span class="cal-head-date">' + esc(utcFmt({ day: "numeric" }).format(noon(day.date))) + '</span></button>'
        + '<div class="cal-head-free">' + esc(freeText) + '</div>' + allDayHtml(allDayFor(day), 2, day.date) + '</div>';
    });
    html += gutterHtml(geo);
    days.forEach((day, index) => {
      const weekday = noon(day.date).getUTCDay();
      const classes = ["cal-day"];
      if (weekday === 0 || weekday === 6) classes.push("weekend");
      let style = "";
      if (day.end <= now) { classes.push("past"); style = ' style="--past-h:100%"'; }
      else if (day.start <= now) { classes.push("past"); style = ' style="--past-h:' + Math.max(0, (minutesInDay(now, day) - geo.startHour * 60) * geo.ppm).toFixed(1) + 'px"'; }
      html += '<div class="' + classes.join(" ") + '" data-date="' + day.date + '"' + style + '>';
      for (const w of freeByDay[index]) {
        const a = minutesInDay(w.start, day), b = minutesInDay(w.end, day);
        html += '<div class="cal-free" data-start="' + w.start + '" data-end="' + w.end + '" style="top:' + topPx(geo, a) + ';height:' + heightPx(geo, a, b) + '" title="' + esc(freeLabel(w)) + '">'
          + ((b - a) * geo.ppm >= 22 ? '<span>All free</span>' : "") + '</div>';
      }
      html += overlapHtml(day, geo);
      const items = pack(members.flatMap((member, memberIndex) => shown(member) ? placed(member, memberIndex, day, geo) : []), geo);
      for (const p of items) html += blockHtml(p, geo, 8, 12);
      html += nowHtml(day, geo, now);
      html += '</div>';
    });
    grid.innerHTML = html;
    fitBlocks(grid);
    afterGrid(geo, days);
    if (scrollPending) {
      scrollPending = false;
      const scroll = $("calScroll");
      scroll.scrollTop = scrollTarget(geo, days);
      const today = grid.querySelector('.cal-day[data-date="' + data.today + '"]');
      scroll.scrollLeft = today && scroll.scrollWidth > scroll.clientWidth ? Math.max(0, today.offsetLeft - scroll.clientWidth / 2 + today.offsetWidth / 2) : 0;
    }
  }
  function overlapHtml(day, geo) {
    let html = "";
    for (const o of data.overlaps) {
      if (o.end <= day.start || o.start >= day.end) continue;
      const a = Math.max(minutesInDay(o.start, day), geo.startHour * 60), b = Math.min(minutesInDay(o.end, day), geo.endHour * 60);
      if (b <= a) continue;
      const names = o.memberIds.map((id) => (data.members.find((m) => m.id === id) || {}).name || "?").join(", ");
      html += '<div class="cal-ovl c' + Math.min(o.count, 4) + '" style="top:' + topPx(geo, a) + ';height:' + heightPx(geo, a, b) + '" title="' + esc(o.count + " busy at once (" + names + ") · " + timeRange(Math.max(o.start, day.start), Math.min(o.end, day.end))) + '"></div>';
    }
    return html;
  }
  function nowHtml(day, geo, now) {
    if (day.date !== data.today || now < day.start || now >= day.end) return "";
    const m = minutesInDay(now, day);
    return m >= geo.startHour * 60 && m <= geo.endHour * 60 ? '<div class="cal-now" id="calNow" style="top:' + topPx(geo, m) + '"></div>' : "";
  }
  // Today: a little above the current time; otherwise 7 AM (or the first hour shown).
  function scrollTarget(geo, days) {
    const now = Date.now();
    const today = days.find((d) => d.date === data.today && now >= d.start && now < d.end);
    if (today) {
      const m = minutesInDay(now, today);
      if (m >= geo.startHour * 60 && m <= geo.endHour * 60) return Math.max(0, (m - geo.startHour * 60) * geo.ppm - $("calScroll").clientHeight * 0.3);
    }
    return Math.max(0, (Math.max(geo.startHour, 7) - geo.startHour) * 60 * geo.ppm);
  }

  // ---- Day view -----------------------------------------------------------
  // One column per member (avatar + name), then a House lane for household events and plans.
  function renderDay(day) {
    const members = data.members.filter(shown);
    const geo = makeGeometry();
    const grid = $("calGrid");
    grid.className = "cal-grid is-day";
    grid.style.setProperty("--cal-hours", String(geo.endHour - geo.startHour));
    grid.style.setProperty("--cal-cols", String(Math.max(1, members.length)));
    const now = Date.now();
    const subs = { not_connected: "Not connected", needs_reconnect: "Reconnect needed", error: "Couldn’t load" };
    let html = '<div class="cal-corner">' + esc(shortZone()) + '</div>';
    members.forEach((member) => {
      const sub = !included(member) ? subs[member.status] || "" : member.titles ? "" : "Busy times only";
      html += '<div class="cal-head cal-head-member ' + colorClass(member) + (included(member) ? "" : " is-off") + '">'
        + '<div class="cal-who">' + avatar(member, 26) + '<span class="cal-who-name">' + esc(member.name) + '</span></div>'
        + (sub ? '<div class="cal-who-sub">' + esc(sub) + '</div>' : "")
        + allDayHtml(allDayFor(day).filter((e) => e.member.id === member.id), 3, day.date) + '</div>';
    });
    html += '<div class="cal-head cal-head-member cal-head-house"><div class="cal-who"><span class="cal-house-badge" aria-hidden="true">' + HOUSE + '</span><span class="cal-who-name">House</span></div></div>';
    html += gutterHtml(geo);
    html += '<div class="cal-dayrow" data-day="' + day.date + '">';
    members.forEach((member) => {
      const memberIndex = data.members.indexOf(member);
      html += '<div class="cal-col ' + colorClass(member) + (included(member) ? "" : " is-off") + '" data-member="' + esc(member.id) + '">';
      for (const p of pack(placed(member, memberIndex, day, geo), geo)) html += blockHtml(p, geo, 4, 18);
      html += '</div>';
    });
    // The House lane is a .cal-day column, so src/ui/eventsPanel.ts draws household events and plans into it.
    html += '<div class="cal-day cal-col-house" data-date="' + day.date + '"></div>';
    html += '<div class="cal-bands" aria-hidden="true">';
    for (const w of data.everyoneFree) {
      if (w.end <= day.start || w.start >= day.end) continue;
      const a = minutesInDay(w.start, day), b = minutesInDay(w.end, day);
      html += '<div class="cal-free" data-start="' + w.start + '" data-end="' + w.end + '" style="top:' + topPx(geo, a) + ';height:' + heightPx(geo, a, b) + '">'
        + ((b - a) * geo.ppm >= 22 ? '<span>' + esc(freeLabel(w)) + '</span>' : "") + '</div>';
    }
    html += overlapHtml(day, geo) + '</div>';
    if (day.end <= now) html += '<div class="cal-pastshade" style="height:100%"></div>';
    else if (day.start <= now) html += '<div class="cal-pastshade" style="height:' + Math.max(0, (minutesInDay(now, day) - geo.startHour * 60) * geo.ppm).toFixed(1) + 'px"></div>';
    html += nowHtml(day, geo, now) + '</div>';
    grid.innerHTML = html;
    fitBlocks(grid);
    afterGrid(geo, [day]);
    if (scrollPending) {
      scrollPending = false;
      const scroll = $("calScroll");
      scroll.scrollTop = scrollTarget(geo, [day]);
      scroll.scrollLeft = 0;
    }
  }

  function afterGrid(geo, shownDays) {
    // --- Household events hook (src/ui/eventsPanel.ts draws events after each render) ---
    // Week view: one .cal-day[data-date] column per day. Day view: the House lane is the only .cal-day.
    document.dispatchEvent(new CustomEvent("gc:calendar-rendered", { detail: { data, startHour: geo.startHour, endHour: geo.endHour, ppm: geo.ppm, view: state.view, date: shownDays.length === 1 ? shownDays[0].date : selectedDate(), days: shownDays } }));
    // --- end Household events hook ---
    flashBest();
  }

  function renderKey() {
    const people = data.members.filter(included).map((m) => '<button type="button" class="cal-key-member ' + colorClass(m) + '" data-toggle-member="' + esc(m.id) + '" aria-pressed="' + shown(m) + '" title="' + (shown(m) ? "Hide " : "Show ") + esc(m.name) + '’s calendar"><i class="k-member"></i>' + esc(m.name) + '</button>').join("");
    const avail = data.members.some((m) => m.events.some((item) => item.free)) ? '<span><i class="k-avail"></i>Available (not busy)</span>' : "";
    $("calKey").innerHTML = people + avail
      + '<span><i class="k-ovl2"></i>2 busy at once</span><span><i class="k-ovl3"></i>3+ busy</span><span><i class="k-free"></i>Everyone free</span>';
  }

  // ---- Event popover --------------------------------------------------------
  const pop = $("calPop");
  function openPop(trigger) {
    const [memberIndex, itemIndex] = String(trigger.dataset.ev).split(":").map(Number);
    const member = data && data.members[memberIndex];
    const item = member && member.events[itemIndex];
    if (!item) return;
    popTrigger = trigger;
    const title = item.title == null ? "Busy" : item.title;
    pop.className = "cal-pop cal-panel " + colorClass(member);
    $("calPopTitle").innerHTML = '<span class="cal-pop-swatch' + (item.free ? " is-free" : "") + '" aria-hidden="true"></span><span>' + esc(title) + '</span>';
    const startDate = dateOf(item.start);
    const lastDate = dateOf(item.end - 1);
    const dayLabel = (date) => utcFmt({ weekday: "long", month: "long", day: "numeric" }).format(noon(date));
    let when;
    if (item.allDay) when = startDate === lastDate ? dayLabel(startDate) + " · All day" : utcFmt({ month: "long", day: "numeric" }).formatRange(noon(startDate), noon(lastDate)) + " · All day";
    else if (startDate === lastDate) when = dayLabel(startDate) + " · " + timeRange(item.start, item.end);
    else when = formatter("pop-span", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).formatRange(new Date(item.start), new Date(item.end));
    let rows = '<div class="cal-pop-row">' + CLOCK + '<span>' + esc(when) + '</span></div>';
    if (item.location) rows += '<div class="cal-pop-row">' + PIN + '<span>' + esc(item.location) + '</span></div>';
    rows += '<div class="cal-pop-row">' + avatar(member, 22) + '<span>' + esc(member.name) + '</span></div>';
    $("calPopRows").innerHTML = rows;
    const note = item.free ? "Shown as available, so it doesn’t count as busy." : item.title == null ? member.name + " shares busy times only." : "";
    $("calPopNote").textContent = note;
    $("calPopNote").hidden = !note;
    pop.hidden = false;
    $("calPopScrim").hidden = !isPhone();
    pop.classList.remove("is-open"); void pop.offsetWidth; pop.classList.add("is-open");
    placePop(trigger);
    pop.focus({ preventScroll: true });
  }
  function placePop(trigger) {
    if (isPhone()) { pop.style.left = ""; pop.style.top = ""; return; }
    const r = trigger.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, margin = 12;
    let left = r.right + 10;
    if (left + w > innerWidth - margin) left = r.left - w - 10;
    if (left < margin) left = Math.min(Math.max(margin, r.left), innerWidth - w - margin);
    let top = Math.min(Math.max(margin, r.top), innerHeight - h - margin);
    if (left < r.right && left + w > r.left && top < r.bottom && top + h > r.top) top = r.bottom + 8 + h < innerHeight ? r.bottom + 8 : Math.max(margin, r.top - h - 8);
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  }
  function closePop(restoreFocus) {
    if (pop.hidden) return;
    pop.hidden = true;
    $("calPopScrim").hidden = true;
    const trigger = popTrigger;
    popTrigger = null;
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  $("calPopClose").addEventListener("click", () => closePop(true));
  $("calPopScrim").addEventListener("click", () => closePop(true));
  document.addEventListener("pointerdown", (event) => {
    if (pop.hidden || !(event.target instanceof Element)) return;
    if (!event.target.closest("#calPop, [data-ev]")) closePop(false);
  });
  $("calScroll").addEventListener("scroll", () => { if (!pop.hidden && !isPhone()) closePop(false); }, { passive: true });
  window.addEventListener("resize", () => { if (!pop.hidden) closePop(false); });

  // ---- Wiring ---------------------------------------------------------------
  // Clicks on events and day headers are handled here (and kept from the events panel's click-to-create).
  function onCalendarClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const ev = target.closest("[data-ev]");
    if (ev) { event.stopPropagation(); if (popTrigger === ev && !pop.hidden) closePop(true); else openPop(ev); return; }
    const day = target.closest("[data-goto-day]");
    if (day) { event.stopPropagation(); openDay(day.dataset.gotoDay); }
  }
  $("calGrid").addEventListener("click", onCalendarClick);
  $("calStrip").addEventListener("click", onCalendarClick);
  $("calKey").addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle-member]");
    if (!button || !data) return;
    const id = button.dataset.toggleMember;
    if (hidden.has(id)) hidden.delete(id);
    else if (data.members.some((m) => m.id !== id && shown(m))) hidden.add(id); // keep at least one calendar on screen
    try { localStorage.setItem("gc-cal-hidden", JSON.stringify([...hidden])); } catch {}
    renderGrid(); renderKey();
    const again = $("calKey").querySelector('[data-toggle-member="' + CSS.escape(id) + '"]');
    if (again) again.focus();
  });
  $("calPrev").addEventListener("click", () => step(-1));
  $("calNext").addEventListener("click", () => step(1));
  $("calToday").addEventListener("click", goToday);
  document.querySelectorAll(".cal-seg [data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("calRange").addEventListener("click", () => {
    const input = $("calJump");
    try { if (input.showPicker) { input.showPicker(); return; } } catch {}
    input.focus(); input.click();
  });
  $("calJump").addEventListener("change", () => {
    const value = $("calJump").value;
    if (!data || !CalendarState.isDate(value) || value === selectedDate()) return;
    navigate(CalendarState.withDate(state, value, null, data.today), { motion: value > selectedDate() ? 1 : -1, scroll: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pop.hidden) { closePop(true); return; }
    const target = event.target;
    if (target && target.closest && target.closest("input, textarea, select, [contenteditable], dialog")) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || !data) return;
    if (document.querySelector("dialog[open]")) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === "ArrowLeft") { event.preventDefault(); step(-1); }
    else if (key === "ArrowRight") { event.preventDefault(); step(1); }
    else if (key === "d") setView("day");
    else if (key === "w") setView("week");
    else if (key === "t") goToday();
  });
  window.addEventListener("popstate", () => {
    state = CalendarState.parse(location.search, isPhone());
    closePop(false);
    load({ motion: "fade" });
  });
  phoneQuery.addEventListener("change", () => {
    if (new URLSearchParams(location.search).has("view") || !data) return;
    state = CalendarState.withView(state, CalendarState.defaultView(isPhone()), data.today);
    scrollPending = true;
    render(0);
  });
  $("calBest").addEventListener("click", (event) => {
    const button = event.target.closest("[data-slot]");
    if (!button || !data) return;
    const slot = Number(button.dataset.slot);
    flashSlot = slot;
    const date = dateOf(slot);
    if (state.view === "day" && date !== selectedDate()) { openDay(date); return; }
    flashBest();
  });
  // Scroll to and pulse the everyone-free band of the chosen best time.
  function flashBest() {
    const slot = flashSlot;
    if (slot === null) return;
    flashSlot = null;
    const target = [...document.querySelectorAll(".cal-free")].find((el) => Number(el.dataset.start) <= slot && slot < Number(el.dataset.end));
    if (!target) return;
    target.scrollIntoView({ behavior: motionQuery.matches ? "auto" : "smooth", block: "center", inline: state.view === "day" ? "nearest" : "center" });
    target.classList.remove("flash"); void target.offsetWidth; target.classList.add("flash");
  }
  $("calPeople").addEventListener("click", async (event) => {
    if (event.target.closest("[data-retry]")) return load({ force: true });
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
      cache.clear();
      await load({ force: true });
    } catch (error) { showNotice(error.message, true); button.disabled = false; }
  });
  // [calendar-detail] "Show event titles": sign in with Google again to add (or drop) event access.
  $("calPeople").addEventListener("change", async (event) => {
    const input = event.target.closest("[data-titles]");
    if (!input || !data) return;
    const member = data.members.find((m) => m.id === input.dataset.titles);
    const enabled = input.checked;
    if (!member) return;
    const question = enabled
      ? "Show " + member.name + "’s event titles to the household?\n\n" + member.name + " signs in with Google again to allow read-only access. Housemates see titles, times, and places, never descriptions or guests. Events marked private stay “Busy”."
      : "Go back to busy times only for " + member.name + "?\n\nGroupCart drops its event access, and " + member.name + " signs in with Google again to keep sharing busy times.";
    if (!confirm(question)) { input.checked = !enabled; return; }
    input.disabled = true;
    try {
      const response = await fetch("/api/google/titles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId: member.id, enabled }) });
      const body = await response.json();
      if (!response.ok || !body.url) throw new Error(body.error || "Could not change event titles.");
      location.href = body.url;
    } catch (error) { showNotice(error.message, true); input.checked = !enabled; input.disabled = false; }
  });

  const connected = startParams.get("connected");
  const titles = startParams.get("titles");
  load({}).then(() => {
    if (!connected || !data) return;
    const member = data.members.find((m) => m.id === connected);
    if (!member) return;
    if (titles === "on") showNotice(member.name + "’s event titles are on. Housemates see titles, times, and places, never descriptions or guests.");
    else if (titles === "denied") showNotice("Google didn’t allow event access, so " + member.name + "’s calendar still shows busy times only.", true);
    else showNotice(member.name + "’s Google Calendar is connected. Only busy times are shared.");
  });
  setInterval(() => { if (document.visibilityState === "visible") load({ force: true }); }, 5 * 60000);
  setInterval(() => { if (data && document.visibilityState === "visible" && pop.hidden) renderGrid(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && data && Date.now() - data.now > 60000) load({ force: true }); });
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

// --- Household events on the calendar (src/ui/eventsPanel.ts) ---
import { withHouseEvents } from "./ui/eventsPanel.js";
// --- end Household events ---
import { withQuietHours } from "./ui/housePage.js"; // House: quiet-hours band

export function renderCalendarPage(): string {
  const page = renderCalendarBody();
  return renderPage(withQuietHours(withHouseEvents({ title: "Calendar", active: "calendar", styles: page.styles, body: page.body, script: page.script })));
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

/** Handles /calendar, /api/calendar, the Google OAuth routes, and /api/google/titles. Returns false for any other path. */
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
    // [calendar-detail] titles=1: the member's "Show event titles" opt-in (adds read-only event access).
    const result = service.startAuthorization(url.searchParams.get("memberId") ?? "", { titles: url.searchParams.get("titles") === "1" });
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
      const { member, titles } = await service.completeAuthorization(code, state);
      response.writeHead(302, { location: `/calendar?connected=${encodeURIComponent(member.id)}${titles ? `&titles=${titles}` : ""}`, "cache-control": "no-store" });
      response.end();
    } catch (error) {
      const message = error instanceof GoogleCalendarError ? error.message : "Google sign-in failed. Please try again.";
      sendResultPage(response, 400, "Google sign-in did not finish", message);
    }
    return true;
  }
  // --- [calendar-detail] "Show event titles" switch: returns the Google sign-in URL to follow ---
  if (request.method === "POST" && pathname === "/api/google/titles") {
    if (!isSameOriginJson(request)) { sendJson(response, 403, { error: "Change event titles from the GroupCart calendar page." }); return true; }
    try {
      const body = await readJsonBody(request);
      if (typeof body.memberId !== "string" || typeof body.enabled !== "boolean") { sendJson(response, 400, { error: "Choose a member and whether to show titles." }); return true; }
      const result = await service.setEventTitles(body.memberId, body.enabled);
      sendJson(response, result.ok ? 200 : result.status, result.ok ? { ok: true, url: result.url } : { error: result.message });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Request failed." });
    }
    return true;
  }
  // --- end [calendar-detail] ---
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
