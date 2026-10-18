import { EMOJI_RULES } from "../choresLogic.js";
import { button, card, dialog, emptyState, icon, renderPage } from "./shell.js";
import { POINTS_CLIENT_JS } from "./pointsUi.js"; // money & points

/**
 * Chores (route "/chores") and the Home "Chores due" card. Data comes from
 * GET /api/chores (see src/chores.ts); changes are JSON POSTs to /api/chores/*.
 * Week strip (Mon–Sun, Google Calendar style) on top; Up next, People (30-day
 * fairness bars + away toggles), and Recent below. Phones get an agenda list and
 * a floating Add button.
 */

const svg = (paths: string, size = 18) => `<svg class="gc-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICONS = {
  more: svg('<circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/>', 20),
  plane: svg('<path d="M10.2 13.8L3.5 11.2l1.6-1.6 7 .9 4.4-4.4a1.9 1.9 0 0 1 2.7 2.7l-4.4 4.4.9 7-1.6 1.6-2.6-6.7-3 3 .2 2.2-1.2 1.2-1.4-3.1-3.1-1.4 1.2-1.2 2.2.2z"/>', 18),
  skip: svg('<path d="M6 6.5l8.5 5.5L6 17.5z"/><path d="M18.5 6v12"/>'),
  give: svg('<path d="M4 8h13.5M14 4.5L17.5 8 14 11.5"/><path d="M20 16H6.5M10 12.5L6.5 16l3.5 3.5"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l1 12.2h9L17.5 7"/>'),
  chevronLeft: svg('<path d="M14.5 6.5L9 12l5.5 5.5"/>', 22),
};

const EMOJI_CHOICES = ["🍽️", "🗑️", "🧹", "🧽", "🛁", "🪴", "🧺", "🧊", "🍳", "♻️", "🐾", "🪟", "🛏️", "🔧", "🛒", "✨"];

/** Bits shared by the page and the Home card. */
const CHORE_BITS_CSS = `
.ch-badge { width:40px; height:40px; flex:none; display:grid; place-items:center; border:0; padding:0; border-radius:12px; background:color-mix(in srgb, var(--m, #80868b) 16%, transparent); font-size:20px; line-height:1; cursor:pointer; }
.ch-badge:hover { background:color-mix(in srgb, var(--m, #80868b) 26%, transparent); }
.ch-due { white-space:nowrap; }
.ch-due.is-late { color:var(--gc-danger); font-weight:500; }
.ch-due.is-today { color:var(--gc-accent); font-weight:500; }
.ch-check { width:36px; height:36px; flex:none; display:grid; place-items:center; padding:0; border-radius:50%; border:2px solid var(--gc-border-strong); background:transparent; color:transparent; cursor:pointer; transition:background-color .15s ease, border-color .15s ease, color .15s ease; }
.ch-check:not(:disabled):hover, .ch-check:not(:disabled):focus-visible { border-color:var(--gc-success); color:var(--gc-success); background:var(--gc-success-soft); }
.ch-check:disabled:not(.is-done) { opacity:.35; cursor:default; }
.ch-check.is-done { border-color:var(--gc-success); background:var(--gc-success); color:var(--gc-surface); }
.ch-nobody { --gc-avatar-bg:#80868b; }
`;

const styles = `${CHORE_BITS_CSS}
.ch-toolbar { display:flex; align-items:center; gap:var(--gc-space-2); margin-bottom:var(--gc-space-4); min-height:40px; }
.ch-range { font-size:var(--gc-fs-xl); font-weight:400; margin-left:var(--gc-space-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.ch-nav { display:contents; }
.ch.is-empty .ch-toolbar, .ch.is-empty .ch-lower { display:none; }
.ch-emptycard { padding:var(--gc-space-6) var(--gc-space-4); }
.ch-emptycard .gc-btn { margin-top:var(--gc-space-3); }
.ch-add .gc-icon { margin-left:-4px; }

.ch-weekcard { padding:0; overflow:hidden; margin-bottom:var(--gc-space-5); }
.ch-week { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); }
.ch-day { min-height:196px; min-width:0; display:flex; flex-direction:column; gap:6px; padding:var(--gc-space-2) 6px var(--gc-space-3); border-left:1px solid var(--gc-border); }
.ch-day:first-child { border-left:0; }
.ch-dayhead { display:flex; flex-direction:column; align-items:center; gap:2px; padding-bottom:4px; }
.ch-dow { font-size:11px; font-weight:500; letter-spacing:.08em; text-transform:uppercase; color:var(--gc-muted); }
.ch-date { width:40px; height:40px; display:grid; place-items:center; border-radius:50%; font-size:22px; line-height:1; color:var(--gc-text); }
.ch-day.is-today .ch-dow { color:var(--gc-accent); }
.ch-day.is-today .ch-date { background:var(--gc-accent); color:var(--gc-on-accent); font-weight:500; }
.ch-day.is-past:not(.is-today) .ch-date { color:var(--gc-muted); }
.ch-items { display:flex; flex-direction:column; gap:4px; min-width:0; }
.ch-quiet { color:var(--gc-muted); font-size:var(--gc-fs-xs); text-align:center; padding-top:var(--gc-space-2); }
.ch-week-quiet { display:none; }
.ch-ev { position:relative; display:grid; gap:1px; width:100%; min-width:0; margin:0; padding:5px 8px 6px; border:0; border-radius:6px; background:var(--m); color:#fff; font:inherit; text-align:left; cursor:pointer; transition:filter .15s ease, box-shadow .15s ease; }
.ch-ev:hover { filter:brightness(1.08); }
.ch-ev-title { display:flex; align-items:center; gap:5px; min-width:0; font-size:12px; font-weight:600; line-height:1.35; }
.ch-ev-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ch-ev-who { display:flex; align-items:center; gap:3px; min-width:0; font-size:11px; line-height:1.3; opacity:.92; }
.ch-ev-who > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ch-ev-who .gc-icon { width:12px; height:12px; }
.ch-ev.is-late::after { content:""; position:absolute; top:6px; right:6px; width:8px; height:8px; border-radius:50%; background:#ff6d5e; box-shadow:0 0 0 1.5px #fff; }
.ch-ev.is-late .ch-ev-name { padding-right:10px; }
.ch-ev.is-planned { background:color-mix(in srgb, var(--m) 13%, var(--gc-surface)); color:var(--gc-text); box-shadow:inset 3px 0 0 var(--m); }
.ch-ev.is-planned .ch-ev-who { color:var(--gc-text-2); opacity:1; }
.ch-ev.is-done { background:transparent; color:var(--gc-muted); box-shadow:inset 0 0 0 1px var(--gc-border); }
.ch-ev.is-done:hover { filter:none; background:var(--gc-hover); }
.ch-ev.is-done .ch-ev-name { text-decoration:line-through; }

.ch-lower .gc-card-head { margin-bottom:var(--gc-space-1); }
.ch-row .gc-list-main { min-width:0; }
.ch-title { display:block; max-width:100%; padding:0; border:0; background:none; color:inherit; font:inherit; font-weight:500; text-align:left; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ch-title:hover { text-decoration:underline; }
.ch-row .gc-list-sub { flex-wrap:nowrap; min-width:0; }
.ch-row .gc-list-sub > span:not(.gc-avatar) { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ch-more { width:32px; height:32px; margin-left:-4px; }

.ch-people { list-style:none; margin:0; padding:var(--gc-space-1) 0 0; display:grid; gap:var(--gc-space-4); }
.ch-person { display:flex; align-items:center; gap:var(--gc-space-3); min-width:0; }
.ch-person-main { flex:1; min-width:0; }
.ch-person-top { display:flex; align-items:center; gap:var(--gc-space-2); min-width:0; font-weight:500; }
.ch-person-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ch-away-chip { font-size:var(--gc-fs-xs); font-weight:500; color:var(--gc-warning); white-space:nowrap; }
.ch-count { margin-left:auto; color:var(--gc-text-2); font-size:var(--gc-fs-sm); font-variant-numeric:tabular-nums; }
.ch-bar { height:8px; margin-top:6px; border-radius:var(--gc-radius-pill); background:var(--gc-track); overflow:hidden; }
.ch-bar > span { display:block; height:100%; border-radius:inherit; transition:width .3s ease; }
.ch-person.is-away > .gc-avatar, .ch-person.is-away .ch-bar { opacity:.4; }
.ch-away { width:36px; height:36px; flex:none; display:grid; place-items:center; padding:0; border:0; border-radius:50%; background:transparent; color:var(--gc-muted); cursor:pointer; }
.ch-away:hover { background:var(--gc-hover); color:var(--gc-text); }
.ch-away[aria-pressed="true"] { background:var(--gc-warning-soft); color:var(--gc-warning); }
.ch-recent { padding:var(--gc-space-2) 0; }
.ch-recent-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.ch-form { display:grid; gap:var(--gc-space-4); }
.ch-name-row { display:flex; align-items:center; gap:var(--gc-space-3); }
.ch-emoji-big { width:48px; height:48px; flex:none; display:grid; place-items:center; border-radius:14px; background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:26px; line-height:1; }
.ch-name-input { height:48px; font-size:var(--gc-fs-lg); }
.ch-emojis { display:flex; flex-wrap:wrap; gap:2px; margin-top:calc(var(--gc-space-2) * -1); }
.ch-emojis button { width:36px; height:36px; padding:0; border:1px solid transparent; border-radius:10px; background:transparent; font-size:19px; line-height:1; cursor:pointer; }
.ch-emojis button:hover { background:var(--gc-hover); }
.ch-emojis button[aria-checked="true"] { background:var(--gc-accent-soft); border-color:var(--gc-accent); }
.ch-label { display:block; margin-bottom:6px; color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; }
.ch-seg { display:flex; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); overflow:hidden; }
.ch-seg button { flex:1; min-width:0; height:36px; display:inline-flex; align-items:center; justify-content:center; gap:4px; padding:0 8px; border:0; background:transparent; color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.ch-seg button + button { border-left:1px solid var(--gc-border-strong); }
.ch-seg button:hover { background:var(--gc-hover); }
.ch-seg button[aria-checked="true"] { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.ch-seg .gc-icon { display:none; }
.ch-seg button[aria-checked="true"] .gc-icon { display:block; }
.ch-pane { display:grid; gap:var(--gc-space-3); }
.ch-days { display:flex; gap:6px; flex-wrap:wrap; }
.ch-days button { width:36px; height:36px; padding:0; border:1px solid var(--gc-border-strong); border-radius:50%; background:transparent; color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.ch-days button:hover { background:var(--gc-hover); }
.ch-days button[aria-checked="true"] { background:var(--gc-accent); border-color:var(--gc-accent); color:var(--gc-on-accent); }
.ch-select { width:100%; }
.ch-pool { display:flex; flex-wrap:wrap; gap:6px; }
.ch-pool button { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px 0 3px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); background:transparent; color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.ch-pool button[aria-pressed="true"] { background:var(--gc-accent-soft); border-color:transparent; color:var(--gc-on-accent-soft); }
.ch-pool button[aria-pressed="false"] .gc-avatar { filter:grayscale(1); opacity:.45; }

.ch-detail { display:grid; gap:var(--gc-space-3); padding-top:var(--gc-space-1); }
.ch-detail-who { display:flex; align-items:center; gap:var(--gc-space-3); margin-bottom:var(--gc-space-1); }
.ch-detail-name { font-size:var(--gc-fs-lg); font-weight:500; }
.ch-detail-line { display:flex; align-items:center; gap:var(--gc-space-3); color:var(--gc-text-2); font-size:var(--gc-fs-sm); min-height:24px; }
.ch-detail-line > .gc-icon { color:var(--gc-muted); width:20px; height:20px; }
.ch-give { display:flex; flex-wrap:wrap; gap:6px; }
.ch-give button { display:inline-flex; align-items:center; gap:6px; height:36px; padding:0 12px 0 3px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); background:transparent; color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.ch-give button:hover { background:var(--gc-hover); }
.ch-danger { color:var(--gc-danger); }
.ch-danger:not(:disabled):hover { background:var(--gc-danger-soft); }
.ch-quick { display:flex; gap:6px; flex-wrap:wrap; }

.ch-menu { position:fixed; z-index:40; min-width:208px; max-width:calc(100vw - 16px); padding:6px 0; border:1px solid var(--gc-border); border-radius:var(--gc-radius-sm); background:var(--gc-surface); box-shadow:0 2px 6px rgba(0,0,0,.14), 0 8px 24px rgba(0,0,0,.12); }
.ch-mi { display:flex; align-items:center; gap:12px; width:100%; min-height:40px; padding:0 16px; border:0; background:transparent; color:var(--gc-text); font:var(--gc-fs-md) var(--gc-font); text-align:left; cursor:pointer; }
.ch-mi:hover:not(:disabled), .ch-mi:focus-visible { background:var(--gc-hover); outline:none; }
.ch-mi:disabled { color:var(--gc-muted); cursor:default; }
.ch-mi > .gc-icon { color:var(--gc-muted); }
.ch-mi.is-danger, .ch-mi.is-danger > .gc-icon { color:var(--gc-danger); }
.ch-menu-sep { height:1px; margin:6px 0; background:var(--gc-border); }

.ch-snack { position:fixed; left:50%; bottom:24px; z-index:50; transform:translateX(-50%); display:flex; align-items:center; gap:var(--gc-space-3); min-height:48px; max-width:calc(100vw - 32px); padding:6px 8px 6px 16px; border-radius:var(--gc-radius-sm); background:var(--gc-tooltip-bg); color:var(--gc-tooltip-text); box-shadow:0 3px 10px rgba(0,0,0,.22); font-size:var(--gc-fs-sm); }
.ch-snack-btn { flex:none; padding:8px 12px; border:0; border-radius:6px; background:transparent; color:#a8c7fa; font:600 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.ch-snack-btn:hover { background:rgba(255,255,255,.08); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ch-snack-btn { color:#0b57d0; } }
:root[data-theme="dark"] .ch-snack-btn { color:#0b57d0; }

@media (max-width: 760px) {
  .ch-toolbar { margin-bottom:var(--gc-space-3); }
  .ch-range { font-size:var(--gc-fs-lg); }
  .ch-add { position:fixed; right:16px; bottom:calc(var(--gc-bottomnav-h) + 16px + env(safe-area-inset-bottom)); z-index:25; height:56px; padding:0 20px; border-radius:16px; box-shadow:0 2px 6px rgba(0,0,0,.18), 0 6px 16px rgba(0,0,0,.14); }
  .ch-weekcard { margin-bottom:var(--gc-space-4); }
  .ch-week { grid-template-columns:minmax(0, 1fr); }
  .ch-day { flex-direction:row; align-items:flex-start; min-height:0; gap:var(--gc-space-3); padding:10px 12px; border-left:0; border-top:1px solid var(--gc-border); }
  .ch-day:first-child { border-top:0; }
  .ch-day.is-empty:not(.is-today) { display:none; }
  .ch-day.is-today { border-top:0; }
  .ch-week > .ch-day.is-today ~ .ch-day:not(.is-empty) { border-top:1px solid var(--gc-border); }
  .ch-dayhead { width:44px; flex:none; padding:0; }
  .ch-items { flex:1; padding-top:2px; gap:6px; }
  .ch-quiet { text-align:left; padding-top:12px; }
  .ch-week-quiet { display:block; padding:var(--gc-space-5) var(--gc-space-4); color:var(--gc-muted); text-align:center; font-size:var(--gc-fs-sm); }
  .ch-ev { padding:8px 10px; }
  .ch-ev-title { font-size:13px; }
  .ch-ev-who { font-size:12px; }
  .ch-snack { bottom:calc(var(--gc-bottomnav-h) + 84px + env(safe-area-inset-bottom)); }
  .ch { padding-bottom:56px; }
}
`;

const weekdayButtons = ["S", "M", "T", "W", "T", "F", "S"]
  .map((letter, index) => ({ letter, index, name: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][index]! }))
  .sort((a, b) => ((a.index + 6) % 7) - ((b.index + 6) % 7))
  .map((day) => `<button type="button" role="radio" data-weekday="${day.index}" aria-checked="false" aria-label="${day.name}">${day.letter}</button>`)
  .join("");

const ordinal = (day: number) => `${day}${[11, 12, 13].includes(day) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`;
const monthDayOptions = Array.from({ length: 28 }, (_, index) => `<option value="${index + 1}">${ordinal(index + 1)} of the month</option>`).join("")
  + `<option value="31" selected>Last day of the month</option>`;

const addDialog = dialog({
  id: "chAdd",
  title: "Add chore",
  body: `<form class="ch-form" id="chAddForm" novalidate autocomplete="off">
  <div>
    <div class="ch-name-row">
      <span class="ch-emoji-big" id="chEmojiPreview" aria-hidden="true">✨</span>
      <label class="gc-sr" for="chName">Name</label>
      <input class="gc-input ch-name-input" id="chName" maxlength="60" placeholder="Chore name" required />
    </div>
  </div>
  <div class="ch-emojis" id="chEmojis" role="radiogroup" aria-label="Icon">${EMOJI_CHOICES.map((emoji) => `<button type="button" role="radio" aria-checked="false" data-emoji="${emoji}" aria-label="${emoji}">${emoji}</button>`).join("")}</div>
  <div>
    <span class="ch-label" id="chRepeatLabel">Repeats</span>
    <div class="ch-seg" role="radiogroup" aria-labelledby="chRepeatLabel">
      <button type="button" role="radio" data-kind="once" aria-checked="false">${icon("check", { size: 16 })}One-off</button>
      <button type="button" role="radio" data-kind="weekly" aria-checked="true">${icon("check", { size: 16 })}Weekly</button>
      <button type="button" role="radio" data-kind="monthly" aria-checked="false">${icon("check", { size: 16 })}Monthly</button>
    </div>
  </div>
  <div class="ch-pane" data-pane="once" hidden>
    <div><label class="ch-label" for="chDate">Due</label><input class="gc-input" type="date" id="chDate" /></div>
  </div>
  <div class="ch-pane" data-pane="weekly">
    <div class="ch-days" id="chDays" role="radiogroup" aria-label="Day of the week">${weekdayButtons}</div>
    <div><label class="gc-sr" for="chEvery">How often</label><select class="gc-select ch-select" id="chEvery">
      <option value="1">Every week</option><option value="2">Every 2 weeks</option><option value="3">Every 3 weeks</option><option value="4">Every 4 weeks</option>
    </select></div>
  </div>
  <div class="ch-pane" data-pane="monthly" hidden>
    <div><label class="gc-sr" for="chDay">Day of the month</label><select class="gc-select ch-select" id="chDay">${monthDayOptions}</select></div>
  </div>
  <div>
    <span class="ch-label" id="chWhoLabel">Who</span>
    <div class="ch-pool" id="chPool" role="group" aria-labelledby="chWhoLabel"></div>
  </div>
  <p class="gc-status" id="chAddStatus" role="status"></p>
</form>`,
  actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}<button class="gc-btn" type="submit" form="chAddForm" id="chAddSubmit">Add</button>`,
});

const detailDialog = dialog({
  id: "chDetail",
  title: "Chore",
  body: `<div class="ch-detail" id="chDetailBody"></div>`,
  actions: `<button type="button" class="gc-btn gc-btn-text ch-danger" id="chDetailDelete">${ICONS.trash}Delete</button><span class="gc-spacer"></span>`
    + `<button type="button" class="gc-btn gc-btn-outline" id="chDetailSkip">Skip turn</button>`
    + `<button type="button" class="gc-btn" id="chDetailDone">${icon("check", { size: 18 })}Done</button>`,
});

const awayDialog = dialog({
  id: "chAway",
  title: "Away",
  body: `<form class="ch-form" id="chAwayForm" novalidate>
  <div><label class="ch-label" for="chAwayDate">Back on</label><input class="gc-input" type="date" id="chAwayDate" required /></div>
  <div class="ch-quick">
    <button type="button" class="gc-btn gc-btn-outline gc-btn-sm" data-away-days="3">3 days</button>
    <button type="button" class="gc-btn gc-btn-outline gc-btn-sm" data-away-days="7">1 week</button>
    <button type="button" class="gc-btn gc-btn-outline gc-btn-sm" data-away-days="14">2 weeks</button>
  </div>
  <p class="gc-status" id="chAwayStatus" role="status"></p>
</form>`,
  actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}<button class="gc-btn" type="submit" form="chAwayForm">Save</button>`,
});

const body = `
<div class="ch" id="chRoot">
  <div class="ch-toolbar">
    <div class="ch-nav">
      <button type="button" class="gc-btn gc-btn-outline gc-btn-sm" id="chToday">Today</button>
      <button type="button" class="gc-icon-btn" id="chPrev" aria-label="Previous week">${ICONS.chevronLeft}</button>
      <button type="button" class="gc-icon-btn" id="chNext" aria-label="Next week">${icon("chevronRight", { size: 22 })}</button>
      <h2 class="ch-range" id="chRange" aria-live="polite"></h2>
    </div>
    <span class="gc-spacer"></span>
    <button type="button" class="gc-btn ch-add" id="chAddBtn">${icon("plus", { size: 20 })}Add chore</button>
  </div>
  <section class="gc-card ch-weekcard" id="chWeekCard" aria-label="Week">
    <div class="ch-week" id="chWeek"></div>
  </section>
  <section class="gc-card ch-emptycard" id="chEmpty" hidden>${emptyState({
    icon: "chores",
    title: "No chores yet",
    text: "Add one, or text “add chore vacuum every Sunday”.",
    action: button({ label: "Add chore", icon: "plus", attrs: 'data-ch-add' }),
  })}</section>
  <div class="gc-grid ch-lower">
    <div class="gc-stack ch-main-stack">
      ${card({ id: "chUpNextCard", title: "Up next", icon: "clock", body: `<ul class="gc-list" id="chUpNext"></ul>` })}
    </div>
    <div class="gc-stack">
      ${card({ title: "People", icon: "users", meta: "Done, last 30 days", body: `<ul class="ch-people" id="chPeople"></ul>` })}
      ${card({ id: "chRecentCard", title: "Recent", icon: "checkCircle", body: `<ul class="gc-list" id="chRecent"></ul>` })}
    </div>
  </div>
</div>
${addDialog}
${detailDialog}
${awayDialog}
<div class="ch-menu" id="chMenu" role="menu" hidden></div>
<div class="ch-snack" id="chSnack" role="status" aria-live="polite" hidden><span id="chSnackText"></span><button type="button" class="ch-snack-btn" id="chSnackUndo" hidden>Undo</button></div>`;

const script = String.raw`
const GC = window.GC;
const $ = (id) => document.getElementById(id);
const ICONS = ${JSON.stringify(ICONS)};
const EMOJI_RULES = ${JSON.stringify(EMOJI_RULES.map(([pattern, emoji]) => [pattern.source, emoji]))}.map((rule) => [new RegExp(rule[0]), rule[1]]);
let data = null;
let week = null;
let menuFor = null;
let detailFor = null;
let awayFor = null;
let snackTimer = 0;
let undoAction = null;
let offline = false;
const form = { kind: "weekly", weekday: 0, emoji: "", emojiTouched: false, pool: [] };

const ids = () => (data ? data.members.map((member) => member.id) : []);
const person = (id) => (data && id ? data.members.find((member) => member.id === id) || null : null);
const nameOf = (id) => { const member = person(id); return member ? member.name : "No one free"; };
const colorOf = (id) => (id && person(id) ? GC.memberColor(id, ids()).solid : "#80868b");
const face = (id, size) => { const member = person(id); return member ? GC.avatar(member, ids(), size) : '<span class="gc-avatar ch-nobody" style="--gc-avatar-size:' + size + 'px" aria-hidden="true">?</span>'; };
const choreById = (id) => (data ? data.upNext.find((chore) => chore.id === id) || null : null);
const addDays = (date, days) => { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const guessEmoji = (name) => { const text = name.toLowerCase(); const rule = EMOJI_RULES.find((entry) => entry[0].test(text)); return rule ? rule[1] : "✨"; };
const shortDate = (date) => new Date(date + "T12:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

async function load() {
  const response = await fetch("/api/chores" + (week ? "?week=" + encodeURIComponent(week) : ""));
  if (!response.ok) throw new Error("Couldn’t load chores");
  data = await response.json();
  if (offline) { offline = false; hideSnack(); }
  render();
}
function refresh() {
  return load().catch((error) => { if (!offline) { offline = true; snack(error.message || "Couldn’t reach GroupCart"); } });
}
async function post(path, payload) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(json.error || "Something went wrong");
  return json;
}

function render() {
  const empty = data.choreCount === 0;
  $("chRoot").classList.toggle("is-empty", empty);
  $("chRange").textContent = data.weekLabel;
  $("chToday").disabled = data.isCurrentWeek;
  $("chEmpty").hidden = !empty;
  $("chWeekCard").hidden = empty;
  $("chUpNextCard").hidden = empty;
  $("chRecentCard").hidden = !data.recent.length;
  renderWeek();
  renderUpNext();
  renderPeople();
  renderRecent();
  if (detailFor && $("chDetail").open) renderDetail(detailFor);
}

function eventHtml(item) {
  const who = item.memberId ? nameOf(item.memberId) : "No one free";
  const line = item.status === "late" ? who + " · " + item.note : who;
  const label = item.name + ", " + (item.status === "done" ? "done by " + who : item.status === "planned" ? who + " (planned)" : line);
  return '<button type="button" class="ch-ev is-' + item.status + '" style="--m:' + colorOf(item.memberId) + '" data-detail="' + GC.esc(item.choreId) + '" aria-label="' + GC.esc(label) + '">'
    + '<span class="ch-ev-title"><span aria-hidden="true">' + GC.esc(item.emoji) + '</span><span class="ch-ev-name">' + GC.esc(item.name) + '</span></span>'
    + '<span class="ch-ev-who" aria-hidden="true">' + (item.status === "done" ? GC.icon("check") : "") + '<span>' + GC.esc(line) + '</span></span></button>';
}

function renderWeek() {
  const any = data.days.some((day) => day.items.length);
  $("chWeek").innerHTML = data.days.map((day) => {
    const items = day.items.map(eventHtml).join("");
    const cls = "ch-day" + (day.isToday ? " is-today" : "") + (day.isPast ? " is-past" : "") + (day.items.length ? "" : " is-empty");
    return '<div class="' + cls + '" role="group" aria-label="' + GC.esc(day.dow + " " + day.day) + '">'
      + '<div class="ch-dayhead" aria-hidden="true"><span class="ch-dow">' + GC.esc(day.dow) + '</span><span class="ch-date">' + day.day + '</span></div>'
      + '<div class="ch-items">' + (items || (day.isToday ? '<p class="ch-quiet">Nothing due</p>' : "")) + '</div></div>';
  }).join("") + (any || data.isCurrentWeek ? "" : '<p class="ch-week-quiet">Nothing this week</p>');
}

function renderUpNext() {
  $("chUpNext").innerHTML = data.upNext.map((chore) => '<li class="gc-list-item ch-row">'
    + '<button type="button" class="ch-badge" style="--m:' + colorOf(chore.assigneeId) + '" data-detail="' + GC.esc(chore.id) + '" aria-label="' + GC.esc(chore.name + " details") + '">' + GC.esc(chore.emoji) + '</button>'
    + '<div class="gc-list-main"><button type="button" class="ch-title" data-detail="' + GC.esc(chore.id) + '">' + GC.esc(chore.name) + '</button>'
    + '<div class="gc-list-sub">' + face(chore.assigneeId, 18) + '<span>' + GC.esc(nameOf(chore.assigneeId)) + '</span><span aria-hidden="true">·</span><span class="ch-due is-' + chore.status + '">' + GC.esc(chore.dueText) + '</span></div></div>'
    + '<button type="button" class="ch-check" data-done="' + GC.esc(chore.id) + '"' + (chore.canComplete ? ' title="Done"' : ' disabled title="' + GC.esc("Opens " + shortDate(chore.opensOn)) + '"') + ' aria-label="' + GC.esc("Mark " + chore.name + " done") + '">' + GC.icon("check") + '</button>'
    + '<button type="button" class="gc-icon-btn ch-more" data-menu="' + GC.esc(chore.id) + '" aria-label="' + GC.esc("More for " + chore.name) + '" aria-haspopup="menu">' + ICONS.more + '</button></li>').join("")
    || '<li class="gc-empty"><p class="gc-empty-text">Nothing open.</p></li>';
}

function renderPeople() {
  const max = Math.max(1, ...data.members.map((member) => member.done30));
  $("chPeople").innerHTML = data.members.map((member) => {
    const away = Boolean(member.awayUntil);
    return '<li class="ch-person' + (away ? " is-away" : "") + '">' + GC.avatar(member, ids(), 32)
      + '<div class="ch-person-main"><div class="ch-person-top"><span class="ch-person-name">' + GC.esc(member.name) + '</span>'
      + (away ? '<span class="ch-away-chip">Back ' + GC.esc(member.awayLabel) + '</span>' : "")
      + '<span class="ch-count" title="Done in the last 30 days">' + member.done30 + '</span></div>'
      + '<div class="ch-bar" role="img" aria-label="' + GC.esc(member.name + ": " + member.done30 + " done in the last 30 days") + '"><span style="width:' + Math.round(member.done30 / max * 100) + '%;background:' + colorOf(member.id) + '"></span></div></div>'
      + '<button type="button" class="ch-away" data-away="' + GC.esc(member.id) + '" aria-pressed="' + away + '" aria-label="' + GC.esc(away ? member.name + " is away; mark back" : "Mark " + member.name + " away") + '" title="' + (away ? "Mark back" : "Away") + '">' + ICONS.plane + '</button></li>';
  }).join("") || '<li class="gc-empty"><p class="gc-empty-text">No members yet.</p></li>';
}

function renderRecent() {
  $("chRecent").innerHTML = data.recent.map((entry) => '<li class="gc-list-item ch-recent">' + face(entry.memberId, 28)
    + '<div class="gc-list-main"><div class="ch-recent-title"><span aria-hidden="true">' + GC.esc(entry.emoji) + '</span> ' + GC.esc(entry.name) + '</div><div class="gc-list-sub">' + GC.esc(nameOf(entry.memberId)) + '</div></div>'
    + '<span class="gc-meta">' + GC.esc(entry.when) + '</span></li>').join("");
}

// --- Detail dialog ---
function openDetail(id) {
  detailFor = id;
  renderDetail(id);
  GC.openDialog("chDetail");
}
function renderDetail(id) {
  const chore = choreById(id);
  const title = $("chDetail-title");
  $("chDetailDone").hidden = $("chDetailSkip").hidden = $("chDetailDelete").hidden = !chore;
  if (!chore) {
    const item = data.days.flatMap((day) => day.items).find((entry) => entry.choreId === id);
    title.textContent = item ? item.emoji + " " + item.name : "Chore";
    $("chDetailBody").innerHTML = '<div class="ch-detail-line">' + GC.icon("checkCircle") + '<span>All done</span></div>';
    return;
  }
  title.textContent = chore.emoji + " " + chore.name;
  const give = chore.available.filter((memberId) => memberId !== chore.assigneeId);
  $("chDetailSkip").disabled = !give.length || !chore.assigneeId;
  $("chDetailDone").disabled = !chore.canComplete;
  $("chDetailBody").innerHTML = '<div class="ch-detail-who">' + face(chore.assigneeId, 44)
    + '<div><div class="ch-detail-name">' + GC.esc(chore.assigneeId ? nameOf(chore.assigneeId) + "’s turn" : "No one free") + '</div><div class="ch-due is-' + chore.status + '">' + GC.esc(chore.dueText + (chore.status === "late" || chore.status === "today" ? "" : " · " + shortDate(chore.dueDate))) + '</div></div></div>'
    + '<div class="ch-detail-line">' + GC.icon("sync") + '<span>' + GC.esc(chore.scheduleLabel) + '</span></div>'
    + '<div class="ch-detail-line">' + GC.icon("users") + '<span class="gc-avatars">' + chore.pool.map((memberId) => face(memberId, 24)).join("") + '</span><span>' + (chore.everyone ? "Everyone" : GC.esc(chore.pool.map(nameOf).join(", "))) + '</span></div>'
    + (chore.lastDone ? '<div class="ch-detail-line">' + GC.icon("checkCircle") + '<span>' + GC.esc("Last: " + nameOf(chore.lastDone.memberId) + ", " + (/^(Today|Yesterday)$/.test(chore.lastDone.when) ? chore.lastDone.when.toLowerCase() : chore.lastDone.when)) + '</span></div>' : "")
    + (give.length ? '<div><span class="ch-label">Give this turn to</span><div class="ch-give">' + give.map((memberId) => '<button type="button" data-give="' + GC.esc(memberId) + '" data-chore="' + GC.esc(chore.id) + '">' + face(memberId, 28) + GC.esc(nameOf(memberId)) + '</button>').join("") + '</div></div>' : "");
}
$("chDetailDone").addEventListener("click", () => { const id = detailFor; GC.closeDialog("chDetail"); complete(id); });
$("chDetailSkip").addEventListener("click", () => { const id = detailFor; GC.closeDialog("chDetail"); skip(id); });
$("chDetailDelete").addEventListener("click", () => { const id = detailFor; GC.closeDialog("chDetail"); remove(id); });

// --- Overflow menu ---
function openMenu(id, anchor) {
  const chore = choreById(id);
  if (!chore) return;
  menuFor = id;
  const give = chore.available.filter((memberId) => memberId !== chore.assigneeId);
  const menu = $("chMenu");
  menu.innerHTML = '<button type="button" class="ch-mi" role="menuitem" data-act="skip"' + (give.length && chore.assigneeId ? "" : " disabled") + '>' + ICONS.skip + 'Skip turn</button>'
    + (give.length ? '<div class="ch-menu-sep"></div>' + give.map((memberId) => '<button type="button" class="ch-mi" role="menuitem" data-give="' + GC.esc(memberId) + '" data-chore="' + GC.esc(id) + '">' + face(memberId, 24) + GC.esc("Give to " + nameOf(memberId)) + '</button>').join("") : "")
    + '<div class="ch-menu-sep"></div><button type="button" class="ch-mi is-danger" role="menuitem" data-act="delete">' + ICONS.trash + 'Delete chore</button>';
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 4);
  menu.style.top = top + "px";
  menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth)) + "px";
  const first = menu.querySelector("button:not([disabled])");
  if (first) first.focus();
}
function closeMenu() { $("chMenu").hidden = true; menuFor = null; }

// --- Actions ---
async function complete(id, buttonEl) {
  const chore = choreById(id);
  if (!chore) return;
  if (buttonEl) buttonEl.classList.add("is-done");
  try {
    const result = await post("/api/chores/done", { choreId: id });
    const next = result.next && result.next.assigneeId ? " · " + nameOf(result.next.assigneeId) + " next" : "";
    snack(chore.emoji + " " + chore.name + " done" + next, () => post("/api/chores/undo", { logId: result.logId }));
    if (GC.celebrate) GC.celebrate(chore.name + " done"); // [themes] completion flourish (no-op in Classic)
    if (window.GCPoints) setTimeout(window.GCPoints.check, 1200); // money & points: a level-up replaces the flourish
  } catch (error) { snack(error.message); }
  refresh();
}
async function skip(id) {
  const chore = choreById(id);
  if (!chore) return;
  try { const result = await post("/api/chores/skip", { choreId: id }); snack(nameOf(result.to) + " is up for " + chore.name); } catch (error) { snack(error.message); }
  refresh();
}
async function give(choreId, memberId) {
  const chore = choreById(choreId);
  if (!chore) return;
  try { await post("/api/chores/assign", { choreId, memberId }); snack(nameOf(memberId) + " has " + chore.name); } catch (error) { snack(error.message); }
  refresh();
}
async function remove(id) {
  const chore = choreById(id);
  if (!chore) return;
  try { await post("/api/chores/delete", { choreId: id }); snack("Deleted " + chore.name, () => post("/api/chores/restore", { choreId: id })); } catch (error) { snack(error.message); }
  refresh();
}
async function toggleAway(memberId) {
  const member = person(memberId);
  if (!member) return;
  if (!member.awayUntil) return openAway(member);
  try { await post("/api/chores/away", { memberId, until: null }); snack(member.name + " is back"); } catch (error) { snack(error.message); }
  refresh();
}

// --- Snackbar ---
function snack(text, undo) {
  clearTimeout(snackTimer);
  $("chSnackText").textContent = text;
  undoAction = undo || null;
  $("chSnackUndo").hidden = !undo;
  $("chSnack").hidden = false;
  snackTimer = setTimeout(hideSnack, 6000);
}
function hideSnack() { $("chSnack").hidden = true; undoAction = null; }
$("chSnackUndo").addEventListener("click", async () => {
  const action = undoAction;
  hideSnack();
  if (!action) return;
  try { await action(); } catch (error) { snack(error.message); }
  refresh();
});

// --- Add dialog ---
function renderForm() {
  document.querySelectorAll("#chAdd [data-kind]").forEach((el) => el.setAttribute("aria-checked", String(el.dataset.kind === form.kind)));
  document.querySelectorAll("#chAdd [data-pane]").forEach((el) => { el.hidden = el.dataset.pane !== form.kind; });
  document.querySelectorAll("#chDays [data-weekday]").forEach((el) => el.setAttribute("aria-checked", String(Number(el.dataset.weekday) === form.weekday)));
  const emoji = form.emoji || guessEmoji($("chName").value);
  $("chEmojiPreview").textContent = emoji;
  document.querySelectorAll("#chEmojis [data-emoji]").forEach((el) => el.setAttribute("aria-checked", String(el.dataset.emoji === emoji)));
  $("chPool").innerHTML = data.members.map((member) => '<button type="button" data-pool="' + GC.esc(member.id) + '" aria-pressed="' + form.pool.includes(member.id) + '">' + GC.avatar(member, ids(), 26) + GC.esc(member.name) + '</button>').join("");
}
function openAdd() {
  if (!data) return;
  $("chAddForm").reset();
  $("chAddStatus").textContent = "";
  Object.assign(form, { kind: "weekly", weekday: 0, emoji: "", emojiTouched: false, pool: ids() });
  $("chDate").min = data.today;
  $("chDate").value = addDays(data.today, 1);
  $("chDay").value = "31";
  renderForm();
  GC.openDialog("chAdd");
  setTimeout(() => $("chName").focus(), 30);
}
$("chAddBtn").addEventListener("click", openAdd);
$("chName").addEventListener("input", () => { if (!form.emojiTouched) form.emoji = ""; renderForm(); });
$("chAdd").addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const kind = target.closest("[data-kind]");
  if (kind) { form.kind = kind.dataset.kind; renderForm(); return; }
  const day = target.closest("[data-weekday]");
  if (day) { form.weekday = Number(day.dataset.weekday); renderForm(); return; }
  const emoji = target.closest("[data-emoji]");
  if (emoji) { form.emoji = emoji.dataset.emoji; form.emojiTouched = true; renderForm(); return; }
  const pool = target.closest("[data-pool]");
  if (pool) {
    const id = pool.dataset.pool;
    form.pool = form.pool.includes(id) ? form.pool.filter((value) => value !== id) : ids().filter((value) => value === id || form.pool.includes(value));
    renderForm();
  }
});
$("chAddForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("chName").value.trim();
  const status = $("chAddStatus");
  if (!name) { status.textContent = "Give it a name."; $("chName").focus(); return; }
  if (!form.pool.length) { status.textContent = "Pick at least one person."; return; }
  const schedule = form.kind === "once" ? { kind: "once", date: $("chDate").value }
    : form.kind === "weekly" ? { kind: "weekly", weekday: form.weekday, everyWeeks: Number($("chEvery").value) }
    : { kind: "monthly", day: Number($("chDay").value) };
  $("chAddSubmit").disabled = true;
  try {
    const result = await post("/api/chores", { name, emoji: form.emoji || guessEmoji(name), schedule, pool: form.pool });
    GC.closeDialog("chAdd");
    snack(result.chore.emoji + " " + result.chore.name + " added");
    week = null;
    refresh();
  } catch (error) { status.textContent = error.message; }
  finally { $("chAddSubmit").disabled = false; }
});

// --- Away dialog ---
function openAway(member) {
  awayFor = member.id;
  $("chAway-title").textContent = member.name + " is away";
  $("chAwayStatus").textContent = "";
  $("chAwayDate").min = addDays(data.today, 1);
  $("chAwayDate").value = addDays(data.today, 7);
  GC.openDialog("chAway");
}
$("chAway").addEventListener("click", (event) => {
  const quick = event.target instanceof Element ? event.target.closest("[data-away-days]") : null;
  if (quick) $("chAwayDate").value = addDays(data.today, Number(quick.dataset.awayDays));
});
$("chAwayForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const until = $("chAwayDate").value;
  if (!until) { $("chAwayStatus").textContent = "Pick a date."; return; }
  try {
    await post("/api/chores/away", { memberId: awayFor, until });
    GC.closeDialog("chAway");
    snack(nameOf(awayFor) + " is away until " + shortDate(until));
    refresh();
  } catch (error) { $("chAwayStatus").textContent = error.message; }
});

// --- Navigation and delegation ---
function go(nextWeek) { week = nextWeek; closeMenu(); refresh(); }
$("chToday").addEventListener("click", () => go(null));
$("chPrev").addEventListener("click", () => data && go(data.prevWeek));
$("chNext").addEventListener("click", () => data && go(data.nextWeek));
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const menuButton = target.closest("[data-menu]");
  if (menuButton) {
    const id = menuButton.dataset.menu;
    if (menuFor === id && !$("chMenu").hidden) closeMenu(); else openMenu(id, menuButton);
    return;
  }
  const inMenu = target.closest("#chMenu");
  if (!inMenu && !$("chMenu").hidden) closeMenu();
  const act = target.closest("[data-act]");
  if (act && inMenu && menuFor) {
    const id = menuFor;
    closeMenu();
    if (act.dataset.act === "skip") skip(id); else if (act.dataset.act === "delete") remove(id);
    return;
  }
  const giveButton = target.closest("[data-give]");
  if (giveButton) { closeMenu(); if ($("chDetail").open) GC.closeDialog("chDetail"); give(giveButton.dataset.chore, giveButton.dataset.give); return; }
  if (target.closest("[data-ch-add]")) { openAdd(); return; }
  const done = target.closest("[data-done]");
  if (done) { complete(done.dataset.done, done); return; }
  const detail = target.closest("[data-detail]");
  if (detail) { openDetail(detail.dataset.detail); return; }
  const away = target.closest("[data-away]");
  if (away) toggleAway(away.dataset.away);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("chMenu").hidden) { closeMenu(); return; }
  const target = event.target instanceof Element ? event.target : null;
  if (!data || event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]")) return;
  if (target && target.closest("input, textarea, select, [contenteditable]")) return;
  if (event.key === "ArrowLeft") go(data.prevWeek);
  else if (event.key === "ArrowRight") go(data.nextWeek);
  else if (event.key === "t") go(null);
});
window.addEventListener("resize", closeMenu);
window.addEventListener("scroll", closeMenu, { passive: true });

refresh();
setInterval(() => {
  if (document.hidden || document.querySelector("dialog[open]") || !$("chMenu").hidden) return;
  refresh();
}, 5000);
`;

export function renderChoresPage(): string {
  return renderPage({ title: "Chores", active: "chores", body, styles, script: script + POINTS_CLIENT_JS }); // money & points: level-up celebrations
}

// ---------------------------------------------------------------------------
// Home card ("Chores due", id homeChores): today's and overdue chores with a
// one-tap done button. Self-contained (own styles and script) so Home only
// has to place it.

const HOME_CSS = `
#homeChores .gc-list-item { padding:var(--gc-space-2) 0; }
#homeChores .ch-badge { width:36px; height:36px; border-radius:10px; font-size:18px; cursor:default; }
#homeChores .gc-list-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`;

const HOME_SCRIPT = String.raw`
document.addEventListener("DOMContentLoaded", function () {
  var GC = window.GC;
  var list = document.getElementById("homeChoresList");
  var empty = document.getElementById("homeChoresEmpty");
  var nextText = document.getElementById("homeChoresNext");
  if (!GC || !list) return;
  function load() {
    return fetch("/api/chores").then(function (response) { return response.ok ? response.json() : null; }).then(function (data) {
      if (!data) return;
      var ids = data.members.map(function (member) { return member.id; });
      var find = function (id) { return data.members.find(function (member) { return member.id === id; }); };
      var due = data.upNext.filter(function (chore) { return chore.status !== "upcoming"; });
      list.innerHTML = due.slice(0, 5).map(function (chore) {
        var member = find(chore.assigneeId);
        var color = member ? GC.memberColor(member.id, ids).solid : "#80868b";
        return '<li class="gc-list-item"><span class="ch-badge" style="--m:' + color + '" aria-hidden="true">' + GC.esc(chore.emoji) + '</span>'
          + '<div class="gc-list-main"><div class="gc-list-title">' + GC.esc(chore.name) + '</div><div class="gc-list-sub">'
          + (member ? GC.avatar(member, ids, 18) + '<span>' + GC.esc(member.name) + '</span>' : '<span>No one free</span>')
          + '<span aria-hidden="true">·</span><span class="ch-due is-' + chore.status + '">' + GC.esc(chore.dueText) + '</span></div></div>'
          + '<button type="button" class="ch-check" data-done="' + GC.esc(chore.id) + '" aria-label="' + GC.esc("Mark " + chore.name + " done") + '" title="Done">' + GC.icon("check") + '</button></li>';
      }).join("") + (due.length > 5 ? '<li class="home-more">+' + (due.length - 5) + ' more</li>' : "");
      empty.hidden = due.length > 0;
      var next = data.upNext.find(function (chore) { return chore.status === "upcoming"; });
      nextText.textContent = data.choreCount === 0 ? "No chores yet." : next ? "Next: " + next.emoji + " " + next.name + " · " + next.dueText : "Nothing coming up.";
    });
  }
  list.addEventListener("click", function (event) {
    var button = event.target instanceof Element ? event.target.closest("[data-done]") : null;
    if (!button) return;
    button.classList.add("is-done");
    button.disabled = true;
    fetch("/api/chores/done", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choreId: button.getAttribute("data-done") }) })
      .then(function (response) { if (response.ok && window.GC.celebrate) window.GC.celebrate("Chore done"); }) // [themes]
      .finally(function () { load().catch(function () {}); });
  });
  load().catch(function () {});
  setInterval(function () { if (!document.hidden) load().catch(function () {}); }, 5000);
});
`;

/** The Home "Chores due" card with its own styles and script. */
export function choresHomeCard(): string {
  return card({
    id: "homeChores",
    title: "Chores due",
    icon: "chores",
    flavor: "home.chores", // [themes]
    actions: button({ label: "Open", variant: "text", size: "sm", href: "/chores" }),
    body: `<ul class="gc-list" id="homeChoresList" aria-live="polite"></ul>
<div class="gc-empty" id="homeChoresEmpty" hidden>${icon("checkCircle", { size: 32 })}<p class="gc-empty-title">All caught up</p><p class="gc-empty-text" id="homeChoresNext"></p></div>
<style>${CHORE_BITS_CSS}${HOME_CSS}</style>
<script>${HOME_SCRIPT}</script>`,
  });
}
