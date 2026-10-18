import { CARD_KINDS, CARD_KIND_ORDER } from "../houseParse.js";
import { button, dialog, escapeHtml, renderPage, type PageOptions } from "./shell.js";
import { registerFlavor } from "./themes.js";

/**
 * House (route "/house"), the Home chip, and the quiet-hours band on /calendar.
 *
 * Page: a row of pinned info tiles (Wi-Fi, door code, trash day, landlord; passwords and codes masked with
 * tap-to-reveal and copy), unpinned cards as small pills, then three cards: Repairs (status chips, photo thumbs),
 * Guests & quiet hours, and Polls (vote bars). Data comes from GET /api/house (src/house.ts); edits are JSON POSTs
 * to /api/house/*. Secrets are fetched only on reveal/copy/edit (POST /api/house/reveal).
 *
 * houseHomeChip() is one compact line in Home's date header (GET /api/house/summary): extra quiet hours tonight,
 * guests today, open repairs, or tonight's quiet hours. withQuietHours(page) draws quiet hours as a hatched band on
 * the calendar after each render (calendarPage.ts dispatches `gc:calendar-rendered`).
 */

// [themes] skin wording for the nav item and the section titles.
registerFlavor({
  "nav.house": { classic: "House", minecraft: "Base", cyberpunk: "Safehouse" },
  "house.repairs.title": { classic: "Repairs", minecraft: "Anvil", cyberpunk: "Maintenance" },
  "house.guests.title": { classic: "Guests & quiet hours", minecraft: "Visitors & bedtime", cyberpunk: "Guests & quiet mode" },
  "house.polls.title": { classic: "Polls", minecraft: "Votes", cyberpunk: "Netpolls" },
});

const svg = (paths: string, size = 18) => `<svg class="gc-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICONS = {
  wifi: svg('<path d="M2.8 9.2a13.5 13.5 0 0 1 18.4 0"/><path d="M5.8 12.6a9 9 0 0 1 12.4 0"/><path d="M8.9 16a4.6 4.6 0 0 1 6.2 0"/><circle cx="12" cy="19.2" r="1" fill="currentColor" stroke="none"/>'),
  door: svg('<circle cx="8" cy="15.5" r="3.8"/><path d="M10.8 12.8l8.7-8.7M16.2 7.4l2.4 2.4M13.9 9.7l2 2"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l1 12.2h9L17.5 7"/><path d="M10 11v5M14 11v5"/>'),
  landlord: svg('<path d="M5 20.5V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15.5"/><path d="M15 9.5h3a1 1 0 0 1 1 1v10"/><path d="M3.5 20.5h17"/><path d="M8 8h1.5M11 8h1M8 11.5h1.5M11 11.5h1M8 15h1.5M11 15h1"/>'),
  rules: svg('<path d="M9 6.5h10M9 12h10M9 17.5h10"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.6"/>'),
  emergency: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><path d="M12 17.3h.01"/>'),
  note: svg('<path d="M5 4.5h14v10l-5 5H5z"/><path d="M14 19.5v-5h5"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eyeOff: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path d="M4 4l16 16"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
  phone: svg('<path d="M6.6 3.5h2.9l1.5 4-2 1.4a11 11 0 0 0 6.1 6.1l1.4-2 4 1.5v2.9a2 2 0 0 1-2 2A16 16 0 0 1 4.6 5.5a2 2 0 0 1 2-2z"/>', 16),
  wrench: svg('<path d="M16.4 3.6a4.2 4.2 0 0 0-4 5.4l-8 8a1.9 1.9 0 0 0 2.6 2.6l8-8a4.2 4.2 0 0 0 5.4-4l-2.7 1.4-2.3-2.3z"/>'),
  moon: svg('<path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z"/>'),
  guests: svg('<rect x="5" y="7.5" width="14" height="12" rx="2"/><path d="M9 7.5V5.2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.3"/><path d="M9 11v5M15 11v5"/>'),
  poll: svg('<path d="M4.5 6.5h9M4.5 12h15M4.5 17.5h6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  camera: svg('<path d="M4 8.5h3.2L8.7 6h6.6l1.5 2.5H20v10.5H4z"/><circle cx="12" cy="13.6" r="3.2"/>'),
  left: svg('<path d="M14.5 6.5L9 12l5.5 5.5"/>'),
  right: svg('<path d="M9.5 6.5L15 12l-5.5 5.5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 16),
  pin: svg('<path d="M9 4.5h6l-1 5 3 3H7l3-3z"/><path d="M12 12.5v7"/>', 16),
};

function sectionCard(options: { id: string; title: string; flavor: string; icon: string; actions: string; body: string }): string {
  return `<section class="gc-card hs-section" id="${options.id}"><div class="gc-card-head"><span class="gc-card-icon">${options.icon}</span><h2 class="gc-card-title" data-flavor="${options.flavor}.title">${escapeHtml(options.title)}</h2><span class="gc-spacer"></span>${options.actions}</div>${options.body}</section>`;
}

const field = (label: string, control: string) => `<label class="hs-field"><span class="hs-field-label">${escapeHtml(label)}</span>${control}</label>`;

const cardDialog = dialog({
  id: "hsCardDialog",
  title: "Card",
  body: `<form class="hs-form" id="hsCardForm" autocomplete="off">
    <div class="hs-kinds" id="hsKinds" role="radiogroup" aria-label="Type"></div>
    ${field("Title", '<input class="gc-input" name="title" maxlength="40" required />')}
    <div class="hs-form" id="hsCardFields"></div>
    <label class="hs-check"><input type="checkbox" name="pinned" /> Pin to the top row</label>
    <p class="gc-status" id="hsCardStatus" role="status"></p>
  </form>`,
  actions: `${button({ label: "Delete", variant: "text", size: "sm", id: "hsCardDelete", attrs: 'data-danger' })}<span class="gc-spacer"></span>
    <button type="button" class="gc-icon-btn" id="hsCardLeft" aria-label="Move earlier" title="Move earlier">${ICONS.left}</button>
    <button type="button" class="gc-icon-btn" id="hsCardRight" aria-label="Move later" title="Move later">${ICONS.right}</button>
    ${button({ label: "Save", id: "hsCardSave" })}`,
});

const repairDialog = dialog({
  id: "hsRepairDialog",
  title: "Repair",
  body: `<div class="hs-photo" id="hsRepairPhoto"></div>
    <div class="hs-seg" id="hsRepairStatus" role="radiogroup" aria-label="Status">
      <button type="button" role="radio" data-status="open">Open</button><button type="button" role="radio" data-status="reported">Reported</button><button type="button" role="radio" data-status="fixed">Fixed</button>
    </div>
    ${field("Who’s on it", '<select class="gc-select" id="hsRepairAssignee"></select>')}
    <ol class="hs-log" id="hsRepairLog"></ol>
    <input type="file" accept="image/*" id="hsRepairFile" hidden />`,
  actions: `${button({ label: "Photo", variant: "text", size: "sm", icon: "photo", id: "hsRepairPhotoBtn" })}<span class="gc-spacer"></span>${button({ label: "Done", variant: "tonal", attrs: "data-gc-close" })}`,
});

const newRepairDialog = dialog({
  id: "hsNewRepairDialog",
  title: "New repair",
  body: `<form class="hs-form" id="hsNewRepairForm" autocomplete="off">
    ${field("What’s broken?", '<input class="gc-input" name="title" maxlength="80" placeholder="Kitchen faucet leaking" required />')}
    <label class="hs-file"><input type="file" accept="image/*" name="photo" />${ICONS.camera}<span id="hsNewRepairFileName">Add a photo (optional)</span></label>
    <p class="gc-status" id="hsNewRepairStatus" role="status"></p>
  </form>`,
  actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Log repair", id: "hsNewRepairSave" })}`,
});

const guestDialog = dialog({
  id: "hsGuestDialog",
  title: "Guests heads-up",
  body: `<form class="hs-form" id="hsGuestForm" autocomplete="off">
    ${field("Who’s coming?", '<input class="gc-input" name="who" maxlength="40" placeholder="Friends, my sister, Sam…" required />')}
    <div class="hs-two">${field("Day", '<input class="gc-input" type="date" name="date" required />')}${field("Time (optional)", '<input class="gc-input" type="time" name="startTime" />')}</div>
    ${field("Staying until (optional)", '<input class="gc-input" type="date" name="endDate" />')}
    ${field("Note (optional)", '<input class="gc-input" name="note" maxlength="200" />')}
    <p class="gc-meta">Posted to the group; roommates can reply “ok” or “concern”.</p>
    <p class="gc-status" id="hsGuestStatus" role="status"></p>
  </form>`,
  actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Post heads-up", id: "hsGuestSave" })}`,
});

const quietDialog = dialog({
  id: "hsQuietDialog",
  title: "Quiet hours",
  body: `<form class="hs-form" id="hsQuietForm" autocomplete="off">
    <p class="hs-sub">One night</p>
    <div class="hs-two">${field("Night of", '<input class="gc-input" type="date" name="date" required />')}${field("Reason (optional)", '<input class="gc-input" name="reason" maxlength="80" placeholder="Exam tomorrow" />')}</div>
    <div class="hs-two">${field("From", '<input class="gc-input" type="time" name="start" value="22:00" required />')}${field("Until", '<input class="gc-input" type="time" name="end" value="08:00" />')}</div>
    <div class="gc-row">${button({ label: "Add for that night", variant: "tonal", size: "sm", id: "hsQuietAdd" })}</div>
    <ul class="hs-mini-list" id="hsQuietUpcoming"></ul>
  </form>
  <form class="hs-form hs-default" id="hsQuietDefaultForm" autocomplete="off">
    <p class="hs-sub">Household default</p>
    <label class="hs-check"><input type="checkbox" name="enabled" /> On</label>
    <div class="hs-two">${field("From", '<input class="gc-input" type="time" name="start" />')}${field("Until", '<input class="gc-input" type="time" name="end" />')}</div>
    <div class="hs-nights" id="hsNights" role="group" aria-label="Nights"></div>
    <div class="gc-row">${button({ label: "Save default", variant: "tonal", size: "sm", id: "hsQuietDefaultSave" })}</div>
    <p class="gc-status" id="hsQuietStatus" role="status"></p>
  </form>`,
  actions: button({ label: "Done", variant: "tonal", attrs: "data-gc-close" }),
});

const pollDialog = dialog({
  id: "hsPollDialog",
  title: "New poll",
  body: `<form class="hs-form" id="hsPollForm" autocomplete="off">
    ${field("Question", '<input class="gc-input" name="question" maxlength="120" placeholder="Takeout tonight?" required />')}
    ${field("Options, one per line", '<textarea class="gc-input hs-textarea" name="options" rows="4" placeholder="Thai&#10;Pizza&#10;Sushi" required></textarea>')}
    <p class="gc-meta">Posted to the group. One vote each; closes in 24 hours or when everyone has voted.</p>
    <p class="gc-status" id="hsPollStatus" role="status"></p>
  </form>`,
  actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Post poll", id: "hsPollSave" })}`,
});

const body = `
<div class="hs" id="hs">
  <section class="hs-board" aria-label="House info">
    <div class="hs-tiles" id="hsTiles"><div class="hs-tile hs-skeleton"></div><div class="hs-tile hs-skeleton"></div><div class="hs-tile hs-skeleton"></div><div class="hs-tile hs-skeleton"></div></div>
    <div class="hs-more" id="hsMore"></div>
  </section>
  <div class="gc-cards hs-sections">
    ${sectionCard({ id: "hsRepairs", title: "Repairs", flavor: "house.repairs", icon: ICONS.wrench, actions: button({ label: "New", variant: "text", size: "sm", icon: "plus", id: "hsRepairNew" }), body: '<ul class="gc-list" id="hsRepairList"></ul><div id="hsRepairFixed"></div>' })}
    ${sectionCard({ id: "hsGuests", title: "Guests & quiet hours", flavor: "house.guests", icon: ICONS.guests, actions: button({ label: "Add", variant: "text", size: "sm", icon: "plus", id: "hsGuestNew" }), body: '<div id="hsQuiet"></div><ul class="gc-list" id="hsGuestList"></ul>' })}
    ${sectionCard({ id: "hsPolls", title: "Polls", flavor: "house.polls", icon: ICONS.poll, actions: button({ label: "New", variant: "text", size: "sm", icon: "plus", id: "hsPollNew" }), body: '<div id="hsPollList"></div>' })}
  </div>
</div>
<div class="hs-toast" id="hsToast" role="status" aria-live="polite" hidden></div>
${cardDialog}${repairDialog}${newRepairDialog}${guestDialog}${quietDialog}${pollDialog}`;

const styles = `
.hs-board { margin-bottom:var(--gc-space-5); }
.hs-tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(176px, 1fr)); gap:var(--gc-space-3); }
.hs-tile { position:relative; display:flex; flex-direction:column; gap:4px; min-height:112px; min-width:0; padding:var(--gc-space-3) var(--gc-space-4); background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:var(--gc-radius-lg); transition:background-color .15s ease; }
.hs-tile:hover { background:var(--gc-hover); }
.hs-skeleton { background:var(--gc-surface-2); border-style:dashed; }
.hs-tile-open { position:absolute; inset:0; z-index:0; width:100%; padding:0; border:0; background:transparent; border-radius:inherit; cursor:pointer; }
.hs-tile-top { display:flex; align-items:center; gap:var(--gc-space-2); min-width:0; }
.hs-ico { width:28px; height:28px; flex:none; display:grid; place-items:center; border-radius:50%; background:var(--gc-surface-2); color:var(--gc-text-2); }
.hs-k-wifi .hs-ico { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.hs-k-door .hs-ico { background:var(--gc-warning-soft); color:var(--gc-warning); }
.hs-k-trash .hs-ico { background:var(--gc-success-soft); color:var(--gc-success); }
.hs-k-emergency .hs-ico { background:var(--gc-danger-soft); color:var(--gc-danger); }
.hs-tile-label { flex:1; min-width:0; color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hs-tile-value { font-size:var(--gc-fs-lg); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.hs-tile-sub { color:var(--gc-muted); font-size:var(--gc-fs-xs); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hs-secret { display:flex; align-items:center; gap:2px; min-width:0; }
.hs-secret-text { flex:1; min-width:0; font-variant-numeric:tabular-nums; letter-spacing:.06em; color:var(--gc-text-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hs-secret-text.is-shown { color:var(--gc-text); letter-spacing:.02em; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:var(--gc-fs-sm); }
.hs-k-door .hs-secret-text { font-size:var(--gc-fs-lg); }
.hs-act { position:relative; z-index:1; width:32px; height:32px; flex:none; display:inline-grid; place-items:center; padding:0; border:0; border-radius:50%; background:transparent; color:var(--gc-text-2); cursor:pointer; text-decoration:none; }
.hs-act:hover { background:color-mix(in srgb, var(--gc-text) 8%, transparent); color:var(--gc-text); }
.hs-call { width:auto; height:28px; gap:6px; padding:0 10px 0 8px; margin-top:auto; align-self:flex-start; border-radius:var(--gc-radius-pill); border:1px solid var(--gc-border); font-size:var(--gc-fs-xs); color:var(--gc-accent); display:inline-flex; align-items:center; }
.hs-more { display:flex; flex-wrap:wrap; gap:var(--gc-space-2); margin-top:var(--gc-space-3); }
.hs-pill { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px 0 10px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-pill); background:var(--gc-surface); color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.hs-pill:hover { background:var(--gc-hover); color:var(--gc-text); }
.hs-pill.is-add { border-style:dashed; color:var(--gc-accent); }
.hs-sections { align-items:start; }
.hs-section .gc-list-item { padding:var(--gc-space-2) 0; }
.hs-row { display:flex; align-items:center; gap:var(--gc-space-3); width:100%; min-width:0; padding:0; border:0; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:var(--gc-radius-sm); }
.hs-row:hover .gc-list-title { text-decoration:underline; }
.hs-thumb { width:44px; height:44px; flex:none; border-radius:10px; object-fit:cover; background:var(--gc-surface-2); border:1px solid var(--gc-border); display:grid; place-items:center; color:var(--gc-muted); }
.hs-emoji { width:44px; height:44px; flex:none; display:grid; place-items:center; border-radius:10px; background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:20px; line-height:1; }
.hs-more-link { margin-top:var(--gc-space-1); }
.hs-quiet { display:flex; align-items:center; gap:var(--gc-space-3); padding:var(--gc-space-2) var(--gc-space-3); margin:0 0 var(--gc-space-2); border-radius:var(--gc-radius-md); background:repeating-linear-gradient(-45deg, color-mix(in srgb, var(--gc-text) 5%, transparent) 0 1.5px, transparent 1.5px 7px), var(--gc-surface-2); }
.hs-quiet .hs-ico { background:var(--gc-surface); }
.hs-quiet-main { flex:1; min-width:0; }
.hs-quiet-title { font-weight:500; }
.hs-react { display:flex; gap:4px; flex:none; }
.hs-react button { display:inline-flex; align-items:center; gap:4px; height:28px; padding:0 8px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-pill); background:var(--gc-surface); color:var(--gc-text-2); font:500 var(--gc-fs-xs) var(--gc-font); cursor:pointer; }
.hs-react button[aria-pressed="true"] { background:var(--gc-accent-soft); border-color:transparent; color:var(--gc-on-accent-soft); }
.hs-react button.is-concern[aria-pressed="true"] { background:var(--gc-warning-soft); color:var(--gc-warning); }
.hs-react button:disabled { cursor:default; opacity:.85; }
.hs-poll + .hs-poll { margin-top:var(--gc-space-4); padding-top:var(--gc-space-4); border-top:1px solid var(--gc-border); }
.hs-poll-head { display:grid; gap:2px; margin-bottom:var(--gc-space-2); }
.hs-poll-q { font-weight:500; min-width:0; }
.hs-opts { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
.hs-opt { position:relative; display:flex; align-items:center; gap:var(--gc-space-2); width:100%; min-height:36px; padding:0 var(--gc-space-3); overflow:hidden; border:1px solid var(--gc-border); border-radius:var(--gc-radius-sm); background:var(--gc-surface); color:var(--gc-text); font:var(--gc-fs-sm) var(--gc-font); text-align:left; cursor:pointer; }
.hs-opt:disabled { cursor:default; }
.hs-opt-fill { position:absolute; inset:0 auto 0 0; background:var(--gc-track); transition:width .25s ease; }
.hs-opt.is-lead .hs-opt-fill { background:color-mix(in srgb, var(--gc-accent) 16%, transparent); }
.hs-opt.is-mine { border-color:var(--gc-accent); }
.hs-opt > :not(.hs-opt-fill) { position:relative; }
.hs-opt-label { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hs-opt-mine { color:var(--gc-accent); display:inline-grid; }
.hs-opt-count { font-weight:600; font-variant-numeric:tabular-nums; color:var(--gc-text-2); }
.hs-opt .gc-avatars .gc-avatar { box-shadow:0 0 0 2px var(--gc-surface); }
.hs-poll-foot { display:flex; align-items:center; gap:var(--gc-space-2); margin-top:var(--gc-space-1); }
.hs-closed { margin-top:var(--gc-space-3); padding-top:var(--gc-space-2); border-top:1px solid var(--gc-border); }
.hs-closed li { display:flex; align-items:center; gap:var(--gc-space-2); padding:4px 0; font-size:var(--gc-fs-sm); color:var(--gc-text-2); min-width:0; }
.hs-closed li span:first-child { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hs-mini-list { list-style:none; margin:0; padding:0; }
.hs-mini-list li { display:flex; align-items:center; gap:var(--gc-space-2); padding:4px 0; font-size:var(--gc-fs-sm); }
.hs-mini-list li span { flex:1; min-width:0; }
.hs-form { display:grid; gap:var(--gc-space-3); }
.hs-default { margin-top:var(--gc-space-4); padding-top:var(--gc-space-4); border-top:1px solid var(--gc-border); }
.hs-sub { font-weight:500; font-size:var(--gc-fs-sm); color:var(--gc-text-2); }
.hs-field { display:grid; gap:4px; min-width:0; }
.hs-field-label { font-size:var(--gc-fs-xs); color:var(--gc-muted); font-weight:500; }
.hs-two { display:grid; grid-template-columns:1fr 1fr; gap:var(--gc-space-3); }
.hs-textarea { height:auto; padding:8px 12px; resize:vertical; font:var(--gc-fs-md)/1.45 var(--gc-font); }
.hs-secret-input { display:flex; gap:4px; }
.hs-check { display:flex; align-items:center; gap:var(--gc-space-2); font-size:var(--gc-fs-sm); color:var(--gc-text-2); }
.hs-kinds { display:flex; flex-wrap:wrap; gap:6px; }
.hs-kinds:empty { display:none; }
.hs-kind { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px 0 8px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-pill); background:var(--gc-surface); color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.hs-kind[aria-checked="true"] { background:var(--gc-accent-soft); border-color:transparent; color:var(--gc-on-accent-soft); }
.hs-nights { display:flex; gap:6px; }
.hs-nights button { width:34px; height:34px; border-radius:50%; border:1px solid var(--gc-border); background:var(--gc-surface); color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.hs-nights button[aria-pressed="true"] { background:var(--gc-accent); border-color:transparent; color:var(--gc-on-accent); }
.hs-photo img { display:block; width:100%; max-height:280px; object-fit:contain; background:var(--gc-surface-2); border-radius:var(--gc-radius-md); border:1px solid var(--gc-border); margin-bottom:var(--gc-space-3); }
.hs-seg { display:flex; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); overflow:hidden; margin-bottom:var(--gc-space-3); }
.hs-seg button { flex:1; height:36px; border:0; border-left:1px solid var(--gc-border-strong); background:transparent; color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.hs-seg button:first-child { border-left:0; }
.hs-seg button[aria-checked="true"] { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.hs-log { list-style:none; margin:var(--gc-space-3) 0 0; padding:0 0 0 14px; border-left:2px solid var(--gc-border); display:grid; gap:6px; }
.hs-log li { position:relative; font-size:var(--gc-fs-sm); color:var(--gc-text-2); }
.hs-log li::before { content:""; position:absolute; left:-19px; top:6px; width:8px; height:8px; border-radius:50%; background:var(--gc-border-strong); }
.hs-log li.is-fixed::before { background:var(--gc-success); }
.hs-log time { color:var(--gc-muted); font-size:var(--gc-fs-xs); margin-left:6px; }
.hs-file { display:flex; align-items:center; gap:var(--gc-space-2); height:40px; padding:0 12px; border:1px dashed var(--gc-border-strong); border-radius:var(--gc-radius-sm); color:var(--gc-text-2); cursor:pointer; font-size:var(--gc-fs-sm); }
.hs-file input { position:absolute; width:1px; height:1px; opacity:0; }
.hs-file:focus-within { outline:2px solid var(--gc-focus); }
[data-danger] { color:var(--gc-danger) !important; }
.hs-toast { position:fixed; left:50%; bottom:var(--gc-space-5); z-index:40; transform:translateX(-50%); max-width:calc(100vw - 32px); padding:10px 16px; border-radius:var(--gc-radius-sm); background:var(--gc-tooltip-bg); color:var(--gc-tooltip-text); font-size:var(--gc-fs-sm); box-shadow:0 2px 8px rgba(0,0,0,.2); }
@media (max-width: 760px) {
  .hs-tiles { grid-template-columns:repeat(2, minmax(0, 1fr)); gap:var(--gc-space-2); }
  .hs-tile { min-height:104px; padding:var(--gc-space-2) var(--gc-space-3); }
  .hs-board { margin-bottom:var(--gc-space-4); }
  .hs-toast { bottom:calc(var(--gc-bottomnav-h) + var(--gc-space-4) + env(safe-area-inset-bottom)); }
}
`;

// Client script: plain JS (no template literals) so this TS template stays readable.
const script = `
(function () {
  var GC = window.GC, esc = GC.esc;
  var ICONS = ${JSON.stringify(ICONS).replace(/</g, "\\u003c")};
  var KIND_ORDER = ${JSON.stringify(CARD_KIND_ORDER)};
  var KINDS = ${JSON.stringify(CARD_KINDS).replace(/</g, "\\u003c")};
  var $ = function (id) { return document.getElementById(id); };
  var state = null, showFixed = false, revealed = {}, editing = null, repairId = null;

  function api(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "Something went wrong."); return d; }); });
  }
  var toastTimer = null;
  function toast(text) {
    var el = $("hsToast");
    el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }
  function load() {
    return fetch("/api/house", { headers: { accept: "application/json" } }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.cards) { state = d; render(); }
    }).catch(function () {});
  }
  function member(id) { return (state.members.filter(function (m) { return m.id === id; })[0]) || { id: id || "?", name: "Someone" }; }
  function allIds() { return state.members.map(function (m) { return m.id; }); }
  function avatar(id, size) { return GC.avatar(member(id), allIds(), size || 24); }
  function first(name) { return String(name || "").split(" ")[0]; }
  function shortDate(iso) { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); }
  function ageLabel(days) { return days <= 0 ? "today" : days === 1 ? "1 day" : days + " days"; }
  function anyDialogOpen() { return Boolean(document.querySelector("dialog[open]")); }

  function render() {
    renderTiles(); renderRepairs(); renderGuests(); renderPolls();
    if (GC.applyFlavor) GC.applyFlavor($("hs"));
  }

  // ---- Info tiles ----------------------------------------------------------
  function secretRow(card, key) {
    var shown = revealed[card.id] && revealed[card.id][key];
    var noun = card.kind === "wifi" ? "password" : "code";
    return '<div class="hs-secret"><span class="hs-secret-text' + (shown ? " is-shown" : "") + '">' + esc(shown || "\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022") + '</span>'
      + '<button type="button" class="hs-act" data-reveal="' + esc(card.id) + '" data-key="' + key + '" aria-label="' + (shown ? "Hide " : "Show ") + noun + '" title="' + (shown ? "Hide" : "Show") + '">' + (shown ? ICONS.eyeOff : ICONS.eye) + '</button>'
      + '<button type="button" class="hs-act" data-copy="' + esc(card.id) + '" data-key="' + key + '" aria-label="Copy ' + noun + '" title="Copy">' + ICONS.copy + '</button></div>';
  }
  function tile(card) {
    var f = card.fields, k = card.kind, value = "", sub = "", extra = "", secret = "";
    if (k === "wifi") { value = f.network || ""; if (card.secrets.indexOf("password") >= 0) secret = secretRow(card, "password"); }
    else if (k === "door") { if (card.secrets.indexOf("code") >= 0) secret = secretRow(card, "code"); sub = f.note || ""; }
    else if (k === "trash") { value = f.trash || ""; sub = f.recycling ? "Recycling: " + f.recycling : ""; }
    else if (k === "landlord") {
      value = f.name || "";
      if (f.phone) extra = '<a class="hs-act hs-call" href="tel:' + esc(String(f.phone).replace(/[^0-9+]/g, "")) + '">' + ICONS.phone + '<span>' + esc(f.phone) + '</span></a>';
      else if (f.email) sub = f.email;
    } else {
      var lines = String(f.text || "").split("\\n").filter(function (line) { return line.trim(); });
      value = (lines[0] || "").replace(/^\\s*(?:[-*\\u2022]|\\d+[.)])\\s*/, "");
      sub = lines.length > 1 ? "+" + (lines.length - 1) + " more" : "";
    }
    return '<div class="hs-tile hs-k-' + k + '">'
      + '<button type="button" class="hs-tile-open" data-card="' + esc(card.id) + '" aria-label="Open ' + esc(card.title) + '"></button>'
      + '<div class="hs-tile-top"><span class="hs-ico">' + (ICONS[k] || ICONS.note) + '</span><span class="hs-tile-label">' + esc(card.title) + '</span>' + (card.hint ? GC.chip(card.hint, "accent") : "") + '</div>'
      + (value ? '<div class="hs-tile-value" title="' + esc(value) + '">' + esc(value) + '</div>' : "") + secret
      + (sub ? '<div class="hs-tile-sub">' + esc(sub) + '</div>' : "") + extra + '</div>';
  }
  function renderTiles() {
    var pinned = state.cards.filter(function (c) { return c.pinned; });
    var others = state.cards.filter(function (c) { return !c.pinned; });
    if (!state.cards.length) {
      $("hsTiles").innerHTML = ["wifi", "door", "trash", "landlord"].map(function (k) {
        return '<div class="hs-tile hs-skeleton hs-k-' + k + '"><button type="button" class="hs-tile-open" data-new="' + k + '" aria-label="Add ' + esc(KINDS[k].label) + '"></button>'
          + '<div class="hs-tile-top"><span class="hs-ico">' + ICONS[k] + '</span><span class="hs-tile-label">' + esc(KINDS[k].label) + '</span></div><div class="hs-tile-sub">' + ICONS.plus + '</div></div>';
      }).join("");
    } else {
      $("hsTiles").innerHTML = pinned.map(tile).join("");
    }
    $("hsMore").innerHTML = others.map(function (c) {
      return '<button type="button" class="hs-pill" data-card="' + esc(c.id) + '">' + (ICONS[c.kind] || ICONS.note) + esc(c.title) + '</button>';
    }).join("") + '<button type="button" class="hs-pill is-add" data-new="">' + ICONS.plus + 'Add</button>';
  }
  function reveal(cardId) {
    return api("/api/house/reveal", { id: cardId }).then(function (d) { return d.fields || {}; });
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    var area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    try { document.execCommand("copy"); } finally { document.body.removeChild(area); }
    return Promise.resolve();
  }

  // ---- Card dialog ---------------------------------------------------------
  function openCard(card, kind) {
    editing = card ? { id: card.id, kind: card.kind } : { id: null, kind: kind || "wifi" };
    var form = $("hsCardForm");
    $("hsCardDialog").querySelector(".gc-dialog-title").textContent = card ? card.title : "New card";
    $("hsKinds").innerHTML = card ? "" : KIND_ORDER.map(function (k) {
      return '<button type="button" class="hs-kind" role="radio" aria-checked="' + (k === editing.kind) + '" data-kind="' + k + '">' + ICONS[k] + esc(KINDS[k].label) + '</button>';
    }).join("");
    form.title.value = card ? card.title : KINDS[editing.kind].label;
    form.pinned.checked = card ? card.pinned : ["wifi", "door", "trash", "landlord"].indexOf(editing.kind) >= 0;
    $("hsCardDelete").hidden = !card; $("hsCardLeft").hidden = !card; $("hsCardRight").hidden = !card;
    $("hsCardStatus").textContent = "";
    renderFields(card ? card.fields : {}, {});
    GC.openDialog("hsCardDialog");
    if (card && card.secrets.length) reveal(card.id).then(function (secrets) { if (editing && editing.id === card.id) renderFields(card.fields, secrets); }).catch(function () {});
  }
  function renderFields(fields, secrets) {
    $("hsCardFields").innerHTML = KINDS[editing.kind].fields.map(function (spec) {
      var value = spec.secret ? (secrets[spec.key] || "") : (fields[spec.key] || "");
      var control;
      if (spec.multiline) control = '<textarea class="gc-input hs-textarea" rows="4" name="f_' + spec.key + '" placeholder="' + esc(spec.placeholder || "") + '">' + esc(value) + '</textarea>';
      else if (spec.secret) control = '<span class="hs-secret-input"><input class="gc-input" type="password" name="f_' + spec.key + '" value="' + esc(value) + '" autocomplete="off" /><button type="button" class="gc-icon-btn" data-toggle-secret aria-label="Show">' + ICONS.eye + '</button></span>';
      else control = '<input class="gc-input" type="' + (spec.type || "text") + '" name="f_' + spec.key + '" value="' + esc(value) + '" placeholder="' + esc(spec.placeholder || "") + '" />';
      return '<label class="hs-field"><span class="hs-field-label">' + esc(spec.label) + '</span>' + control + '</label>';
    }).join("");
  }
  function saveCard() {
    var form = $("hsCardForm"), fields = {};
    KINDS[editing.kind].fields.forEach(function (spec) { var input = form.elements["f_" + spec.key]; if (input) fields[spec.key] = input.value; });
    $("hsCardStatus").textContent = "Saving…";
    api("/api/house/cards", { id: editing.id, kind: editing.kind, title: form.title.value, fields: fields, pinned: form.pinned.checked })
      .then(function () { delete revealed[editing.id]; GC.closeDialog("hsCardDialog"); toast("Saved"); return load(); })
      .catch(function (e) { $("hsCardStatus").textContent = e.message; });
  }

  // ---- Repairs -------------------------------------------------------------
  var STATUS = { open: ["Open", "warning"], reported: ["Reported", "accent"], fixed: ["Fixed", "success"] };
  function repairRow(r) {
    var thumb = r.photoUrl ? '<img class="hs-thumb" src="' + esc(r.photoUrl) + '" alt="" loading="lazy" />' : '<span class="hs-thumb">' + ICONS.wrench + '</span>';
    var status = STATUS[r.status] || STATUS.open;
    var sub = GC.chip(status[0], status[1]) + '<span>' + esc(first(member(r.createdBy).name)) + ' · ' + esc(r.status === "fixed" ? "fixed " + shortDate(r.closedAt) : ageLabel(r.ageDays)) + '</span>';
    return '<li class="gc-list-item"><button type="button" class="hs-row" data-repair="' + esc(r.id) + '">' + thumb
      + '<div class="gc-list-main"><div class="gc-list-title">' + esc(r.title) + '</div><div class="gc-list-sub">' + sub + '</div></div>'
      + (r.assigneeId ? avatar(r.assigneeId, 24) : "") + '</button></li>';
  }
  function renderRepairs() {
    var open = state.repairs.open, fixed = state.repairs.fixed;
    $("hsRepairList").innerHTML = open.length ? open.map(repairRow).join("")
      : '<li class="gc-empty">' + ICONS.check + '<p class="gc-empty-title">Nothing broken</p><p class="gc-empty-text">Text “broken: …” with a photo, or tap New.</p></li>';
    $("hsRepairFixed").innerHTML = fixed.length
      ? (showFixed ? '<ul class="gc-list">' + fixed.map(repairRow).join("") + '</ul>' : "")
        + '<button type="button" class="gc-btn gc-btn-text gc-btn-sm hs-more-link" id="hsToggleFixed">' + (showFixed ? "Hide fixed" : "Fixed (" + fixed.length + ")") + '</button>'
      : "";
  }
  function findRepair(id) { return state.repairs.open.concat(state.repairs.fixed).filter(function (r) { return r.id === id; })[0]; }
  function logLine(entry) {
    var who = entry.memberId ? first(member(entry.memberId).name) : "";
    var text = entry.kind === "opened" ? "Opened by " + who
      : entry.kind === "photo" ? "Photo added" + (who ? " by " + who : "")
      : entry.kind === "reported" ? "Reported to the landlord" + (who ? " · " + who : "")
      : entry.kind === "fixed" ? "Fixed" + (who ? " · " + who : "")
      : entry.kind === "reopened" ? "Reopened" + (who ? " by " + who : "")
      : entry.kind === "assigned" ? first(member(entry.note).name) + " is on it"
      : entry.kind === "unassigned" ? "Unassigned"
      : entry.kind === "note" ? who + ": " + (entry.note || "") : entry.kind;
    return '<li class="' + (entry.kind === "fixed" ? "is-fixed" : "") + '">' + esc(text) + '<time>' + esc(shortDate(entry.at)) + '</time></li>';
  }
  function openRepair(id) {
    var r = findRepair(id);
    if (!r) return;
    repairId = id;
    $("hsRepairDialog").querySelector(".gc-dialog-title").textContent = "#" + r.number + " " + r.title;
    $("hsRepairPhoto").innerHTML = r.photoUrl ? '<img src="' + esc(r.photoUrl) + '" alt="Photo of ' + esc(r.title) + '" />' : "";
    $("hsRepairPhotoBtn").lastChild.textContent = r.photoUrl ? "Replace photo" : "Add photo";
    Array.prototype.forEach.call($("hsRepairStatus").querySelectorAll("[data-status]"), function (b) { b.setAttribute("aria-checked", String(b.getAttribute("data-status") === r.status)); });
    $("hsRepairAssignee").innerHTML = '<option value="">Nobody yet</option>' + state.members.map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === r.assigneeId ? " selected" : "") + '>' + esc(m.name) + '</option>'; }).join("");
    $("hsRepairLog").innerHTML = r.log.map(logLine).join("");
    GC.openDialog("hsRepairDialog");
  }
  function updateRepair(change, message) {
    var id = repairId;
    change.id = id;
    api("/api/house/repairs/update", change).then(function () { toast(message); return load(); }).then(function () { if ($("hsRepairDialog").open) openRepair(id); }).catch(function (e) { toast(e.message); });
  }
  function uploadPhoto(id, file) {
    return fetch("/api/house/repairs/photo?id=" + encodeURIComponent(id), { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-gc-request": "1" }, body: file })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "Couldn’t add the photo."); return d; }); });
  }

  // ---- Guests & quiet hours ------------------------------------------------
  function renderGuests() {
    var q = state.quiet, tonight = q.tonight;
    var title = tonight ? tonight.label : (q.default.enabled ? q.default.label : "Quiet hours off");
    var meta = tonight && tonight.kind === "adhoc"
      ? (tonight.createdBy ? first(member(tonight.createdBy).name) + (tonight.reason ? " · " + tonight.reason.charAt(0).toLowerCase() + tonight.reason.slice(1) : "") : (tonight.reason || "Tonight only"))
      : tonight ? "Household default" : (q.default.enabled ? "Not tonight" : "");
    $("hsQuiet").innerHTML = '<div class="hs-quiet"><span class="hs-ico">' + ICONS.moon + '</span><div class="hs-quiet-main"><div class="hs-quiet-title">' + esc(title) + '</div><div class="gc-meta">' + esc(meta) + '</div></div>'
      + '<button type="button" class="gc-btn gc-btn-text gc-btn-sm" id="hsQuietEdit">Edit</button></div>';
    var viewer = state.viewerId;
    $("hsGuestList").innerHTML = state.guests.length ? state.guests.map(function (g) {
      var mine = g.reactions[viewer] ? g.reactions[viewer].reaction : null;
      var oks = 0, concerns = 0, concernNotes = [];
      Object.keys(g.reactions).forEach(function (id) { if (g.reactions[id].reaction === "ok") oks += 1; else { concerns += 1; concernNotes.push(first(member(id).name) + (g.reactions[id].note ? ": " + g.reactions[id].note : "")); } });
      var host = g.hostId === viewer;
      var react = '<span class="hs-react"><button type="button" data-react="ok" data-event="' + esc(g.eventId) + '" aria-pressed="' + (mine === "ok") + '"' + (host ? " disabled" : "") + ' title="OK with it">\\ud83d\\udc4d ' + oks + '</button>'
        + '<button type="button" class="is-concern" data-react="concern" data-event="' + esc(g.eventId) + '" aria-pressed="' + (mine === "concern") + '"' + (host ? " disabled" : "") + ' title="' + esc(concernNotes.join(" · ") || "Concern") + '">\\u26a0\\ufe0f ' + concerns + '</button></span>';
      return '<li class="gc-list-item"><span class="hs-emoji">' + esc(g.emoji) + '</span><div class="gc-list-main"><div class="gc-list-title"><a class="gc-list-link" href="/calendar?event=' + encodeURIComponent(g.eventId) + '&week=' + esc(g.date) + '">' + esc(g.title) + '</a></div>'
        + '<div class="gc-list-sub"><span>' + esc(g.label) + '</span>' + (g.hostId ? '<span>· ' + esc(first(member(g.hostId).name)) + '</span>' : "") + '</div></div>' + react + '</li>';
    }).join("") : '<li class="gc-empty"><p class="gc-empty-text">No guests coming up. Text “having friends over Fri 8pm”.</p></li>';
  }
  function openQuiet() {
    var q = state.quiet, form = $("hsQuietForm"), def = $("hsQuietDefaultForm");
    form.date.value = new Date(state.now - (new Date(state.now).getHours() < 6 ? 86400000 : 0)).toLocaleDateString("en-CA");
    form.reason.value = "";
    var hhmm = function (m) { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
    def.enabled.checked = q.default.enabled; def.start.value = hhmm(q.default.startMin); def.end.value = hhmm(q.default.endMin);
    $("hsNights").innerHTML = ["S", "M", "T", "W", "T", "F", "S"].map(function (d, i) {
      return '<button type="button" data-night="' + i + '" aria-pressed="' + (q.default.nights.indexOf(i) >= 0) + '" aria-label="' + ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i] + ' night">' + d + '</button>';
    }).join("");
    $("hsQuietUpcoming").innerHTML = q.upcoming.map(function (w) {
      return '<li><span>' + esc(w.label) + (w.reason ? " · " + esc(w.reason) : "") + '</span><button type="button" class="gc-icon-btn" data-cancel-quiet="' + esc(w.id) + '" aria-label="Cancel">\\u00d7</button></li>';
    }).join("");
    $("hsQuietStatus").textContent = "";
    GC.openDialog("hsQuietDialog");
  }

  // ---- Polls ---------------------------------------------------------------
  function renderPolls() {
    var viewer = state.viewerId, total = state.members.length;
    var open = state.polls.open.map(function (p) {
      var voted = Object.keys(p.votes).length, max = Math.max.apply(null, p.counts.concat([0]));
      var left = Math.max(0, p.closesAt - Date.now()), hours = Math.ceil(left / 3600000);
      var opts = p.options.map(function (label, i) {
        var n = i + 1, count = p.counts[i] || 0, pct = voted ? Math.round(count / voted * 100) : 0;
        var who = Object.keys(p.votes).filter(function (id) { return p.votes[id] === n; });
        var mine = p.votes[viewer] === n;
        return '<li><button type="button" class="hs-opt' + (mine ? " is-mine" : "") + (max && count === max ? " is-lead" : "") + '" data-poll="' + esc(p.id) + '" data-option="' + n + '" aria-pressed="' + mine + '">'
          + '<span class="hs-opt-fill" style="width:' + pct + '%"></span><span class="hs-opt-label">' + esc(label) + '</span>' + (mine ? '<span class="hs-opt-mine">' + ICONS.check + '</span>' : "")
          + (who.length ? '<span class="gc-avatars">' + who.map(function (id) { return avatar(id, 20); }).join("") + '</span>' : "") + '<span class="hs-opt-count">' + count + '</span></button></li>';
      }).join("");
      return '<div class="hs-poll"><div class="hs-poll-head"><span class="hs-poll-q">' + esc(p.question) + '</span><span class="gc-meta">' + esc(first(member(p.createdBy).name)) + ' · ' + voted + '/' + total + ' voted · ' + (hours <= 1 ? "closing soon" : hours + "h left") + '</span></div>'
        + '<ul class="hs-opts">' + opts + '</ul><div class="hs-poll-foot"><span class="gc-spacer"></span><button type="button" class="gc-btn gc-btn-text gc-btn-sm" data-close-poll="' + esc(p.id) + '">Close poll</button></div></div>';
    }).join("");
    var closed = state.polls.closed.length ? '<ul class="hs-mini-list hs-closed">' + state.polls.closed.map(function (p) {
      var winners = p.leaders.map(function (n) { return p.options[n - 1]; });
      return '<li><span>' + esc(p.question) + '</span>' + (winners.length ? GC.chip(winners.length === 1 ? winners[0] : "Tie", "success") : GC.chip("No votes", "neutral")) + '</li>';
    }).join("") + '</ul>' : "";
    $("hsPollList").innerHTML = (open || '<div class="gc-empty"><p class="gc-empty-text">No open polls. Text “poll: takeout tonight? thai, pizza, sushi”.</p></div>') + closed;
  }

  // ---- Events --------------------------------------------------------------
  document.addEventListener("click", function (event) {
    var t = event.target instanceof Element ? event.target : null;
    if (!t || !state) return;
    var el;
    if ((el = t.closest("[data-reveal]"))) {
      var id = el.getAttribute("data-reveal"), key = el.getAttribute("data-key");
      if (revealed[id] && revealed[id][key]) { delete revealed[id]; renderTiles(); return; }
      reveal(id).then(function (secrets) {
        revealed[id] = secrets; renderTiles();
        setTimeout(function () { if (revealed[id] === secrets) { delete revealed[id]; renderTiles(); } }, 30000);
      }).catch(function (e) { toast(e.message); });
      return;
    }
    if ((el = t.closest("[data-copy]"))) {
      var cardId = el.getAttribute("data-copy"), field = el.getAttribute("data-key");
      reveal(cardId).then(function (secrets) { return copyText(secrets[field] || ""); }).then(function () { toast(field === "password" ? "Password copied" : "Code copied"); }).catch(function (e) { toast(e.message || "Couldn’t copy"); });
      return;
    }
    if ((el = t.closest("[data-card]"))) { var card = state.cards.filter(function (c) { return c.id === el.getAttribute("data-card"); })[0]; if (card) openCard(card); return; }
    if ((el = t.closest("[data-new]"))) { openCard(null, el.getAttribute("data-new") || "note"); return; }
    if ((el = t.closest("[data-kind]"))) {
      editing.kind = el.getAttribute("data-kind");
      Array.prototype.forEach.call($("hsKinds").children, function (b) { b.setAttribute("aria-checked", String(b === el)); });
      $("hsCardForm").title.value = KINDS[editing.kind].label;
      $("hsCardForm").pinned.checked = ["wifi", "door", "trash", "landlord"].indexOf(editing.kind) >= 0;
      renderFields({}, {});
      return;
    }
    if ((el = t.closest("[data-toggle-secret]"))) {
      var input = el.parentNode.querySelector("input");
      input.type = input.type === "password" ? "text" : "password";
      el.innerHTML = input.type === "password" ? ICONS.eye : ICONS.eyeOff;
      return;
    }
    if ((el = t.closest("[data-repair]"))) { openRepair(el.getAttribute("data-repair")); return; }
    if ((el = t.closest("[data-status]"))) {
      var status = el.getAttribute("data-status");
      updateRepair({ status: status }, status === "fixed" ? "Marked fixed" : status === "reported" ? "Marked reported" : "Reopened");
      if (status === "fixed" && GC.celebrate) GC.celebrate("Repair fixed");
      return;
    }
    if ((el = t.closest("[data-react]"))) {
      var guest = state.guests.filter(function (g) { return g.eventId === el.getAttribute("data-event"); })[0];
      var current = guest && guest.reactions[state.viewerId] ? guest.reactions[state.viewerId].reaction : null;
      var next = el.getAttribute("data-react");
      api("/api/house/guests/react", { eventId: el.getAttribute("data-event"), reaction: current === next ? null : next }).then(load).catch(function (e) { toast(e.message); });
      return;
    }
    if ((el = t.closest("[data-poll]"))) {
      api("/api/house/polls/vote", { pollId: el.getAttribute("data-poll"), option: Number(el.getAttribute("data-option")) })
        .then(function (d) { toast(d.closedText ? "Everyone voted, poll closed" : "Vote saved"); return load(); }).catch(function (e) { toast(e.message); });
      return;
    }
    if ((el = t.closest("[data-close-poll]"))) {
      if (!confirm("Close this poll and post the result?")) return;
      api("/api/house/polls/close", { pollId: el.getAttribute("data-close-poll") }).then(function () { toast("Poll closed"); return load(); }).catch(function (e) { toast(e.message); });
      return;
    }
    if ((el = t.closest("[data-night]"))) { el.setAttribute("aria-pressed", String(el.getAttribute("aria-pressed") !== "true")); return; }
    if ((el = t.closest("[data-cancel-quiet]"))) {
      api("/api/house/quiet/cancel", { id: el.getAttribute("data-cancel-quiet") }).then(function () { toast("Cancelled"); return load(); }).then(openQuiet).catch(function (e) { toast(e.message); });
      return;
    }
    if (t.closest("#hsToggleFixed")) { showFixed = !showFixed; renderRepairs(); return; }
    if (t.closest("#hsQuietEdit")) { openQuiet(); return; }
  });

  $("hsCardSave").addEventListener("click", saveCard);
  $("hsCardForm").addEventListener("submit", function (e) { e.preventDefault(); saveCard(); });
  $("hsCardDelete").addEventListener("click", function () {
    if (!editing || !editing.id || !confirm("Delete this card?")) return;
    api("/api/house/cards/delete", { id: editing.id }).then(function () { GC.closeDialog("hsCardDialog"); toast("Deleted"); return load(); }).catch(function (e) { $("hsCardStatus").textContent = e.message; });
  });
  ["hsCardLeft", "hsCardRight"].forEach(function (id, i) {
    $(id).addEventListener("click", function () {
      if (!editing || !editing.id) return;
      api("/api/house/cards/move", { id: editing.id, direction: i ? 1 : -1 }).then(load).catch(function (e) { $("hsCardStatus").textContent = e.message; });
    });
  });

  $("hsRepairNew").addEventListener("click", function () { $("hsNewRepairForm").reset(); $("hsNewRepairFileName").textContent = "Add a photo (optional)"; $("hsNewRepairStatus").textContent = ""; GC.openDialog("hsNewRepairDialog"); });
  $("hsNewRepairForm").photo.addEventListener("change", function () { var f = this.files && this.files[0]; $("hsNewRepairFileName").textContent = f ? f.name : "Add a photo (optional)"; });
  function saveNewRepair() {
    var form = $("hsNewRepairForm"), file = form.photo.files && form.photo.files[0];
    if (!form.title.value.trim()) { form.title.focus(); return; }
    $("hsNewRepairStatus").textContent = "Saving…";
    api("/api/house/repairs", { title: form.title.value }).then(function (d) { return file ? uploadPhoto(d.repair.id, file) : d; })
      .then(function () { GC.closeDialog("hsNewRepairDialog"); toast("Repair logged"); return load(); })
      .catch(function (e) { $("hsNewRepairStatus").textContent = e.message; });
  }
  $("hsNewRepairSave").addEventListener("click", saveNewRepair);
  $("hsNewRepairForm").addEventListener("submit", function (e) { e.preventDefault(); saveNewRepair(); });
  $("hsRepairAssignee").addEventListener("change", function () { updateRepair({ assigneeId: this.value || null }, this.value ? first(member(this.value).name) + " is on it" : "Unassigned"); });
  $("hsRepairPhotoBtn").addEventListener("click", function () { $("hsRepairFile").click(); });
  $("hsRepairFile").addEventListener("change", function () {
    var file = this.files && this.files[0], id = repairId;
    if (!file || !id) return;
    uploadPhoto(id, file).then(function () { toast("Photo added"); return load(); }).then(function () { openRepair(id); }).catch(function (e) { toast(e.message); });
    this.value = "";
  });

  $("hsGuestNew").addEventListener("click", function () {
    var form = $("hsGuestForm");
    form.reset(); form.date.value = new Date(state.now).toLocaleDateString("en-CA"); $("hsGuestStatus").textContent = "";
    GC.openDialog("hsGuestDialog");
  });
  function saveGuest() {
    var form = $("hsGuestForm");
    $("hsGuestStatus").textContent = "Posting…";
    api("/api/house/guests", { who: form.who.value, date: form.date.value, startTime: form.startTime.value || null, endDate: form.endDate.value || null, note: form.note.value })
      .then(function () { GC.closeDialog("hsGuestDialog"); toast("Heads-up posted"); return load(); })
      .catch(function (e) { $("hsGuestStatus").textContent = e.message; });
  }
  $("hsGuestSave").addEventListener("click", saveGuest);
  $("hsGuestForm").addEventListener("submit", function (e) { e.preventDefault(); saveGuest(); });

  $("hsQuietAdd").addEventListener("click", function () {
    var form = $("hsQuietForm");
    $("hsQuietStatus").textContent = "";
    api("/api/house/quiet", { date: form.date.value, start: form.start.value, end: form.end.value || null, reason: form.reason.value })
      .then(function () { toast("Quiet hours added"); return load(); }).then(openQuiet).catch(function (e) { $("hsQuietStatus").textContent = e.message; });
  });
  $("hsQuietForm").addEventListener("submit", function (e) { e.preventDefault(); $("hsQuietAdd").click(); });
  $("hsQuietDefaultSave").addEventListener("click", function () {
    var def = $("hsQuietDefaultForm");
    var toMin = function (v) { var p = String(v || "").split(":"); return p.length === 2 ? Number(p[0]) * 60 + Number(p[1]) : undefined; };
    var nights = Array.prototype.filter.call($("hsNights").children, function (b) { return b.getAttribute("aria-pressed") === "true"; }).map(function (b) { return Number(b.getAttribute("data-night")); });
    api("/api/house/quiet/default", { enabled: def.enabled.checked, startMin: toMin(def.start.value), endMin: toMin(def.end.value), nights: nights })
      .then(function () { $("hsQuietStatus").textContent = "Saved."; return load(); }).catch(function (e) { $("hsQuietStatus").textContent = e.message; });
  });
  $("hsQuietDefaultForm").addEventListener("submit", function (e) { e.preventDefault(); $("hsQuietDefaultSave").click(); });

  $("hsPollNew").addEventListener("click", function () { $("hsPollForm").reset(); $("hsPollStatus").textContent = ""; GC.openDialog("hsPollDialog"); });
  function savePoll() {
    var form = $("hsPollForm");
    var options = form.options.value.split(/\\n|,/).map(function (o) { return o.trim(); }).filter(Boolean);
    $("hsPollStatus").textContent = "Posting…";
    api("/api/house/polls", { question: form.question.value, options: options }).then(function () { GC.closeDialog("hsPollDialog"); toast("Poll posted"); return load(); })
      .catch(function (e) { $("hsPollStatus").textContent = e.message; });
  }
  $("hsPollSave").addEventListener("click", savePoll);
  $("hsPollForm").addEventListener("submit", function (e) { e.preventDefault(); savePoll(); });

  load();
  setInterval(function () { if (document.visibilityState === "visible" && !anyDialogOpen()) load(); }, 15000);
})();
`;

export function renderHousePage(_options: { demoMode: boolean }): string {
  return renderPage({ title: "House", active: "house", body, styles, script });
}

// ---------------------------------------------------------------------------
// Home: one compact line in the date header (not a card)

const homeChipStyles = `
.hh-line { display:inline-flex; align-items:center; gap:6px; height:28px; margin-top:var(--gc-space-2); padding:0 12px 0 8px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-pill); color:var(--gc-text-2); background:var(--gc-surface); font-size:var(--gc-fs-xs); font-weight:500; text-decoration:none; max-width:100%; }
.hh-line:hover { background:var(--gc-hover); color:var(--gc-text); }
.hh-line.is-warning { background:var(--gc-warning-soft); border-color:transparent; color:var(--gc-warning); }
.hh-line span:last-child { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
`;

const homeChipScript = `
document.addEventListener("DOMContentLoaded", function () {
  var link = document.getElementById("homeHouse");
  if (!link) return;
  var ICONS = ${JSON.stringify({ moon: ICONS.moon, guests: ICONS.guests, wrench: ICONS.wrench })};
  function refresh() {
    fetch("/api/house/summary", { headers: { accept: "application/json" } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var line = d && d.line;
      link.hidden = !line;
      if (!line) return;
      link.className = "hh-line" + (line.tone === "warning" ? " is-warning" : "");
      link.innerHTML = (ICONS[line.icon] || "") + "<span></span>";
      link.lastChild.textContent = line.text;
    }).catch(function () {});
  }
  refresh();
  setInterval(function () { if (document.visibilityState === "visible") refresh(); }, 60000);
});
`;

/** One compact House line for Home's date header (id homeHouse; hidden when there's nothing to say). */
export function houseHomeChip(): string {
  return `<a class="hh-line" id="homeHouse" href="/house" hidden></a><style>${homeChipStyles}</style><script>${homeChipScript}</script>`;
}

// ---------------------------------------------------------------------------
// Calendar: quiet hours as a subtle hatched band

type QuietCalendar = { windows: Array<{ start: number; end: number; kind: string; label: string; reason: string | null; by: string | null }>; label: string };
let quietProvider: (() => QuietCalendar) | null = null;

/** Installed by setupHouse(): the quiet windows around now (embedded in /calendar). */
export function setQuietCalendarProvider(provider: (() => QuietCalendar) | null): void {
  quietProvider = provider;
}

const calendarStyles = `
.hq-band { position:absolute; left:0; right:0; z-index:1; pointer-events:none; background:repeating-linear-gradient(-45deg, color-mix(in srgb, var(--gc-text) 9%, transparent) 0 1.5px, transparent 1.5px 7px); }
.hq-band.is-start { border-top:1px dashed color-mix(in srgb, var(--gc-text) 28%, transparent); }
.hq-band span { display:block; padding:1px 6px; font-size:10px; line-height:13px; font-weight:500; color:var(--gc-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cal-key .k-quiet { background:repeating-linear-gradient(-45deg, color-mix(in srgb, var(--gc-text) 22%, transparent) 0 1.5px, transparent 1.5px 5px); box-shadow:inset 0 0 0 1px var(--cal-line-soft, var(--gc-border)); }
`;

// Draws only from the calendar's `gc:calendar-rendered` hook (no edits to its render functions). Week view: one
// band per ".cal-day[data-date]"; day view: one band across ".cal-dayrow[data-day]". A night that starts below the
// visible hours gets a short labelled strip at the bottom edge ("Quiet 11pm").
const calendarScript = `
(function () {
  var Q = window.GC_QUIET || { windows: [] };
  var fmt = {};
  var CAP = 15;
  function minutesOf(ms, tz) {
    var f = fmt[tz] || (fmt[tz] = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }));
    var h = 0, m = 0;
    f.formatToParts(new Date(ms)).forEach(function (p) { if (p.type === "hour") h = Number(p.value) % 24; if (p.type === "minute") m = Number(p.value); });
    return h * 60 + m;
  }
  function clock(minutes) {
    var h = Math.floor(minutes / 60) % 24, m = minutes % 60;
    return h === 0 && m === 0 ? "midnight" : (h % 12 || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h < 12 ? "am" : "pm");
  }
  document.addEventListener("gc:calendar-rendered", function (event) {
    var view = event.detail || {}, data = view.data || {}, grid = document.getElementById("calGrid");
    var days = view.days || data.days || [];
    if (!grid || !Q.windows.length || !days.length || !view.ppm) return;
    var tz = data.timeZone, lo = view.startHour * 60, hi = view.endHour * 60, any = false;
    var dayView = view.view === "day";
    days.forEach(function (day) {
      var column = grid.querySelector(dayView ? '.cal-dayrow[data-day="' + day.date + '"]' : '.cal-day[data-date="' + day.date + '"]');
      if (!column) return;
      Q.windows.forEach(function (w) {
        var a0 = Math.max(w.start, day.start), b0 = Math.min(w.end, day.end);
        if (b0 <= a0) return;
        var from = a0 <= day.start ? 0 : minutesOf(a0, tz), to = b0 >= day.end ? 1440 : (minutesOf(b0, tz) || 1440);
        var starts = w.start >= day.start;
        var band = document.createElement("div");
        band.title = "Quiet hours · " + w.label + (w.by ? " · " + w.by : "") + (w.reason ? ": " + w.reason : "");
        var a = Math.max(from, lo), b = Math.min(to, hi), label = "";
        if (b > a) {
          band.className = "hq-band" + (starts && from >= lo ? " is-start" : "");
          band.style.top = ((a - lo) * view.ppm).toFixed(1) + "px";
          band.style.height = Math.max(2, (b - a) * view.ppm).toFixed(1) + "px";
          if (starts && (b - a) * view.ppm >= CAP) label = "Quiet";
        } else if (starts && from >= hi) {
          // Starts below the visible hours: a short strip at the bottom edge says when.
          band.className = "hq-band is-start";
          band.style.top = ((hi - lo) * view.ppm - CAP).toFixed(1) + "px";
          band.style.height = CAP + "px";
          label = "Quiet " + clock(from);
        } else {
          return;
        }
        if (label) { var span = document.createElement("span"); span.textContent = label; band.appendChild(span); }
        column.appendChild(band);
        any = true;
      });
    });
    if (any) queueMicrotask(function () {
      var key = document.getElementById("calKey");
      if (key && !key.querySelector(".k-quiet")) { var item = document.createElement("span"); item.innerHTML = '<i class="k-quiet"></i>Quiet hours'; key.appendChild(item); }
    });
  });
})();
`;

/** Adds the quiet-hours band (and its key entry) to the calendar page. */
export function withQuietHours(page: PageOptions): PageOptions {
  if (!quietProvider) return page;
  let data: QuietCalendar;
  try { data = quietProvider(); } catch { return page; }
  return {
    ...page,
    styles: `${page.styles ?? ""}${calendarStyles}`,
    script: `${page.script ?? ""}\nwindow.GC_QUIET = ${JSON.stringify(data).replace(/</g, "\\u003c")};\n${calendarScript}`,
  };
}
