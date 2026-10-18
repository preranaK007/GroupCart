/**
 * GroupCart skins: Classic (the default Google-Workspace look) plus four
 * game-inspired reskins. Everything here is original CSS/SVG; no game logos,
 * artwork, textures, or fonts. Theme names appear only as picker labels.
 *
 * How a skin is applied
 *   <html data-skin="classic|elden|minecraft|rdr|cyberpunk"> is set before
 *   first paint: the server renders it from the `gc-skin` cookie (see
 *   runWithRequestSkin in src/dashboard.ts) and a tiny inline <head> script
 *   corrects it from localStorage (or a `?skin=` preview param). Google Fonts
 *   load only while a game skin is active. GC.setSkin(id) switches live.
 *
 * How pages inherit a skin (nothing to do if you build on src/ui/shell.ts)
 *   1. Tokens: each skin redefines every --gc-* custom property (colors, fonts,
 *      radii, type scale) and adds --gc-font-display for headings.
 *   2. Components: each skin restyles the shared .gc-* classes (app bar, rail,
 *      cards, buttons, chips, lists, inputs, avatars, dialogs, tooltips, empty
 *      states, notices, progress). Component overrides use `:where([data-skin])`
 *      so they have the same specificity as the base rules: page CSS still wins.
 *   3. Flavor text: add data-flavor="key" to a leaf text element (or call
 *      GC.t(key, fallback) in client code). Keys live in FLAVOR below; add your
 *      own with registerFlavor({...}). Classic text is never changed.
 *   4. GC.celebrate("Trash taken out") after marking something done shows the
 *      skin's completion flourish (no-op in Classic).
 *   5. Lists of people: add class "gc-people" to a .gc-list of avatar rows to get
 *      wanted posters in the Red Dead skin (a normal list elsewhere).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { registerRoute } from "../platform.js";

// ---------------------------------------------------------------------------
// Skin registry
// ---------------------------------------------------------------------------

export type SkinId = "classic" | "elden" | "minecraft" | "rdr" | "cyberpunk";

export type SkinInfo = {
  id: SkinId;
  /** Picker label. */
  name: string;
  /** One short line under the picker preview. */
  blurb: string;
  /** CSS color-scheme while the skin is active (game skins have one fixed look). */
  scheme: "light dark" | "light" | "dark";
  /** Google Fonts stylesheet, loaded only while this skin is active. */
  fonts: string;
};

const GOOGLE_FONTS = "https://fonts.googleapis.com/css2?";

export const SKINS: readonly SkinInfo[] = [
  { id: "classic", name: "Classic", blurb: "Clean and calm", scheme: "light dark", fonts: "" },
  { id: "elden", name: "Elden Ring", blurb: "Tarnished gold and grace", scheme: "dark", fonts: `${GOOGLE_FONTS}family=Cinzel:wght@500;600;700&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap` },
  { id: "minecraft", name: "Minecraft", blurb: "Blocks, slots, and XP", scheme: "light", fonts: `${GOOGLE_FONTS}family=Press+Start+2P&family=VT323&display=swap` },
  { id: "rdr", name: "Red Dead Redemption", blurb: "Parchment, ink, and bounties", scheme: "light", fonts: `${GOOGLE_FONTS}family=Rye&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap` },
  { id: "cyberpunk", name: "Cyberpunk 2077", blurb: "Neon, chrome, and glitches", scheme: "dark", fonts: `${GOOGLE_FONTS}family=Rajdhani:wght@500;600;700&family=Chakra+Petch:ital,wght@0,400;0,500;0,600;1,400&display=swap` },
];

export const SKIN_COOKIE = "gc-skin";

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === "string" && SKINS.some((skin) => skin.id === value);
}

function skinInfo(id: SkinId): SkinInfo {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0]!;
}

export function skinScheme(id: SkinId): string {
  return skinInfo(id).scheme;
}

// ---------------------------------------------------------------------------
// Per-request skin (from the cookie), so the server renders data-skin, the
// fonts <link>, and flavored nav text without a flash.
// ---------------------------------------------------------------------------

const requestSkin = new AsyncLocalStorage<SkinId>();

export function skinFromCookieHeader(header: string | undefined): SkinId {
  const match = /(?:^|;\s*)gc-skin=([a-z]+)/.exec(header ?? "");
  return match && isSkinId(match[1]) ? match[1] : "classic";
}

/** Wrap a request handler so renderPage() sees the browser's skin cookie. */
export function runWithRequestSkin<T>(request: IncomingMessage, handler: () => T): T {
  return requestSkin.run(skinFromCookieHeader(request.headers.cookie), handler);
}

/** Skin of the request being rendered ("classic" outside a request). */
export function currentSkin(): SkinId {
  return requestSkin.getStore() ?? "classic";
}

// ---------------------------------------------------------------------------
// Flavor text. `classic` documents the default; Classic pages never change.
// A value may be a list (one is picked at random per page view).
// ---------------------------------------------------------------------------

type GameSkin = Exclude<SkinId, "classic">;
export type FlavorEntry = { classic?: string } & Partial<Record<GameSkin, string | readonly string[]>>;

const FLAVOR: Record<string, FlavorEntry> = {
  // Navigation and app-bar titles (keys follow NavKey; extra keys are ready for upcoming pages).
  "nav.home": { classic: "Home", elden: "Grace", minecraft: "Spawn", rdr: "Camp", cyberpunk: "Crib" },
  "nav.groceries": { classic: "Groceries", elden: "Merchant", minecraft: "Inventory", rdr: "Supplies", cyberpunk: "Rations" },
  "nav.chores": { classic: "Chores", elden: "Trials", minecraft: "Quests", rdr: "Odd Jobs", cyberpunk: "Gigs" },
  "nav.bills": { classic: "Bills", elden: "Runes", minecraft: "Emeralds", rdr: "Bounties", cyberpunk: "Eddies" },
  "nav.calendar": { classic: "Calendar", elden: "Omens", minecraft: "Clock", rdr: "Almanac", cyberpunk: "Schedule" },
  "nav.settings": { classic: "Settings", elden: "System", minecraft: "Options", rdr: "Satchel", cyberpunk: "Cyberdeck" },
  "nav.chat": { classic: "Chat", elden: "Whispers", minecraft: "Chat", rdr: "Telegraph", cyberpunk: "Holocall" },
  "nav.lists": { classic: "Lists", elden: "Scrolls", minecraft: "Chests", rdr: "Journal", cyberpunk: "Shards" },
  "nav.events": { classic: "Events", elden: "Summons", minecraft: "Raids", rdr: "Shindigs", cyberpunk: "Ops" },
  "nav.people": { classic: "People", elden: "Tarnished", minecraft: "Players", rdr: "Posse", cyberpunk: "Crew" },
  "nav.profiles": { classic: "Profiles", elden: "Tarnished", minecraft: "Players", rdr: "Posse", cyberpunk: "Crew" },
  "appbar.sub": {
    classic: "",
    elden: "Grace found",
    minecraft: ["Now with chores!", "Split it fairly!", "Don't forget the eggs!", "Shared carts!", "Also try dishes!", "Roommate-approved!", "Contains bread!", "Respawn at the fridge!", "Bring snacks!"],
    rdr: "Est. 1899",
    cyberpunk: "Link established",
  },

  // Empty states: emptyState({ flavor: "empty.chores" }) uses empty.chores.title / .text
  "empty.chores.title": { classic: "Nothing due", elden: "No trials remain", minecraft: "No quests", rdr: "Quiet day at camp", cyberpunk: "No gigs" },
  "empty.chores.text": { classic: "Chores will show up here.", elden: "No chores. Rest at the site of grace.", minecraft: "Go punch some trees.", rdr: "Wanted: someone to take out the trash.", cyberpunk: "Gig board's empty. Go touch grass, choom." },
  "empty.events.title": { classic: "No events", elden: "No omens", minecraft: "Nothing scheduled", rdr: "No shindigs", cyberpunk: "No ops" },
  "empty.events.text": { classic: "Household events will show up here.", elden: "The stars are quiet tonight.", minecraft: "Sleep through the night.", rdr: "Nothing in the almanac, partner.", cyberpunk: "Calendar feed is clean." },
  "empty.bills.title": { classic: "No bills yet", elden: "No runes owed", minecraft: "No trades yet", rdr: "No bounties", cyberpunk: "No eddies owed" },
  "empty.bills.text": { classic: "Bill splits will show up here.", elden: "Your debts are settled, Tarnished.", minecraft: "No emeralds changing hands.", rdr: "Nobody owes nobody nothin'.", cyberpunk: "Ledger's clean. Nobody flatlined." },
  "empty.cart.title": { classic: "Cart is empty", elden: "Nothing to carry", minecraft: "Inventory empty", rdr: "Satchel's empty", cyberpunk: "No rations queued" },
  "empty.chat.title": { classic: "No messages", elden: "No whispers yet", minecraft: "Chat is quiet", rdr: "No telegrams", cyberpunk: "No incoming holocalls" },
  "soon.chores.title": { classic: "Chores are coming", elden: "Trials draw near", minecraft: "Quests coming soon", rdr: "Odd jobs comin'", cyberpunk: "Gigs incoming" },
  "soon.bills.title": { classic: "Bills are coming", elden: "Runes draw near", minecraft: "Trading coming soon", rdr: "Bounties comin'", cyberpunk: "Eddies incoming" },
  "soon.calendar.title": { classic: "Calendar is coming", elden: "Omens draw near", minecraft: "Clock coming soon", rdr: "Almanac comin'", cyberpunk: "Schedule incoming" },

  // Card and section titles: card({ flavor: "home.people" }) uses .title / .meta
  "home.groceries.title": { classic: "Groceries", elden: "Provisions", minecraft: "Inventory", rdr: "Supplies", cyberpunk: "Rations" },
  "home.people.title": { classic: "People", elden: "Tarnished", minecraft: "Players", rdr: "Wanted", cyberpunk: "Crew" },
  "home.people.meta": { classic: "Grocery shares", elden: "Runes owed", minecraft: "Emerald shares", rdr: "Bounties", cyberpunk: "Eddies owed" },
  "home.chores.title": { classic: "Chores due", elden: "Trials", minecraft: "Quests", rdr: "Odd jobs", cyberpunk: "Gigs" },
  "home.upcoming.title": { classic: "Upcoming", elden: "Omens", minecraft: "Coming up", rdr: "Almanac", cyberpunk: "Upcoming ops" },
  "home.balances.title": { classic: "Balances", elden: "Runes", minecraft: "Emeralds", rdr: "Bounties", cyberpunk: "Eddies" },
  "cart.items.title": { classic: "Items", elden: "Provisions", minecraft: "Items", rdr: "Supplies", cyberpunk: "Loadout" },
  "cart.split.title": { classic: "Split", elden: "Runes owed", minecraft: "Trades", rdr: "Bounty", cyberpunk: "Eddies" },
  "settings.appearance.title": { classic: "Appearance", elden: "Garments", minecraft: "Resource Packs", rdr: "Wardrobe", cyberpunk: "Chrome" },
  "settings.connections": { classic: "Connections", elden: "Pacts", minecraft: "Mods", rdr: "Telegraph lines", cyberpunk: "Netlinks" },

  // Notices (renderNotice eyebrow, by tone) and the completion flourish.
  "notice.success": { classic: "", elden: "Item acquired", minecraft: "Achievement get!", rdr: "Telegram", cyberpunk: "Upload complete" },
  "notice.warning": { classic: "", elden: "Something stirs", minecraft: "Uh oh!", rdr: "Bad news, partner", cyberpunk: "Warning // ICE detected" },
  "notice.danger": { classic: "", elden: "Thy path is barred", minecraft: "Something exploded", rdr: "Trouble on the trail", cyberpunk: "Flatlined" },
  "notice.neutral": { classic: "", elden: "A message", minecraft: "Server message", rdr: "Telegram", cyberpunk: "Incoming message" },
  "notice.accent": { classic: "", elden: "A message", minecraft: "Server message", rdr: "Telegram", cyberpunk: "Incoming message" },
  "celebrate.title": { classic: "", elden: "Task completed", minecraft: "Achievement get!", rdr: "Job done", cyberpunk: "Gig complete" },
};

/** Add or override flavor keys (call at module load from a page module). */
export function registerFlavor(entries: Record<string, FlavorEntry>): void {
  Object.assign(FLAVOR, entries);
}

/** Flavored text for `skin`, or `fallback` (the Classic text) when there is none. */
export function flavorText(key: string, fallback: string, skin: SkinId = currentSkin()): string {
  const value = skin === "classic" ? undefined : FLAVOR[key]?.[skin];
  if (value === undefined) return fallback;
  return typeof value === "string" ? value : value[Math.floor(Math.random() * value.length)] ?? fallback;
}

/**
 * Server-rendered flavored text for request-time markup (nav, app bar):
 * `<span${f.attrs}>${f.html}</span>`. Pages built at module load should use
 * plain data-flavor="key" instead; the browser swaps it before first paint.
 */
export function flavored(key: string, classicText: string, skin: SkinId = currentSkin()): { attrs: string; html: string } {
  return {
    attrs: ` data-flavor="${esc(key)}" data-flavor-orig="${esc(classicText)}" data-flavor-skin="${skin}"`,
    html: esc(flavorText(key, classicText, skin)),
  };
}

// ---------------------------------------------------------------------------
// Markup: <head> bits, app-bar switcher, Settings "Appearance" card
// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const PALETTE_ICON = `<svg class="gc-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3.5c-4.8 0-8.5 3.6-8.5 8.3 0 4.6 3.7 8.7 8.3 8.7 1.3 0 2-.8 2-1.8 0-.6-.3-1-.6-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h2.1c2.5 0 3.9-1.6 3.9-3.9 0-4-3.8-6.8-8.5-6.8z"/><circle cx="7.6" cy="11.4" r="1.1"/><circle cx="10.2" cy="7.6" r="1.1"/><circle cx="14.6" cy="7.6" r="1.1"/></svg>`;

/** Runs in <head> before first paint: picks the skin, loads its fonts, sets color-scheme. */
function headScript(): string {
  const fonts = Object.fromEntries(SKINS.map((skin) => [skin.id, skin.fonts]));
  const schemes = Object.fromEntries(SKINS.map((skin) => [skin.id, skin.scheme]));
  return String.raw`(function(){var d=document.documentElement,F=${jsonForScript(fonts)},S=${jsonForScript(schemes)},s=null,m;
try{s=localStorage.getItem("gc-skin")}catch(e){}
if(!F.hasOwnProperty(s)){m=/(?:^|;\s*)gc-skin=([a-z]+)/.exec(document.cookie);s=m&&F.hasOwnProperty(m[1])?m[1]:"classic"}
m=/[?&]skin=([a-z]+)/.exec(location.search);if(m&&F.hasOwnProperty(m[1]))s=m[1];
d.setAttribute("data-skin",s);
var l=document.getElementById("gc-skin-fonts"),f=F[s];
if(f){if(!l){l=document.createElement("link");l.id="gc-skin-fonts";l.rel="stylesheet";document.head.appendChild(l)}if(l.getAttribute("href")!==f)l.setAttribute("href",f)}else if(l){l.parentNode.removeChild(l)}
var c=document.querySelector('meta[name="color-scheme"]');if(c)c.setAttribute("content",S[s])})();`;
}

/** Fonts link (when the cookie names a game skin) + the pre-paint skin script. Goes in <head>. */
export function skinHead(skin: SkinId = currentSkin()): string {
  const fonts = skinInfo(skin).fonts;
  const link = fonts
    ? `<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin /><link id="gc-skin-fonts" rel="stylesheet" href="${esc(fonts)}" />`
    : "";
  return `${link}<script>${headScript()}</script>`;
}

/** Palette button + menu for the app bar. */
export function skinSwitcher(skin: SkinId = currentSkin()): string {
  const items = SKINS.map((option) => `<button type="button" class="gc-skin-item" role="menuitemradio" tabindex="-1" aria-checked="${option.id === skin}" data-gc-skin="${option.id}"><span class="gc-skin-swatch gc-sw-${option.id}" aria-hidden="true"></span><span>${esc(option.name)}</span></button>`).join("");
  return `<div class="gc-skin-switch"><button type="button" class="gc-icon-btn gc-skin-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="gcSkinMenu" aria-label="Theme" title="Theme">${PALETTE_ICON}</button><div class="gc-skin-menu" id="gcSkinMenu" role="menu" aria-label="Theme" hidden>${items}</div></div>`;
}

/** Settings card with a live preview tile per skin. */
export function appearanceCard(skin: SkinId = currentSkin()): string {
  const options = SKINS.map((option) => `<label class="gc-skin-option"><input class="gc-sr" type="radio" name="gc-skin" value="${option.id}"${option.id === skin ? " checked" : ""} /><span class="gc-skin-preview gc-pv-${option.id}" aria-hidden="true"><i class="gc-pv-bar"></i><i class="gc-pv-card"><b class="gc-pv-title">Aa</b><i class="gc-pv-line"></i><i class="gc-pv-line gc-pv-short"></i><i class="gc-pv-btn"></i></i></span><span class="gc-skin-text"><span class="gc-skin-name">${esc(option.name)}</span><span class="gc-skin-blurb">${esc(option.blurb)}</span></span></label>`).join("");
  return `<section class="gc-card gc-appearance" id="appearance" aria-labelledby="appearanceTitle">
  <div class="gc-card-head"><span class="gc-card-icon">${PALETTE_ICON}</span><h2 class="gc-card-title" id="appearanceTitle" data-flavor="settings.appearance.title">Appearance</h2><span class="gc-meta">Saved in this browser</span></div>
  <div class="gc-skin-options" role="radiogroup" aria-labelledby="appearanceTitle">${options}</div>
</section>`;
}

/** window.GC additions: skin, setSkin, t, applyFlavor, celebrate; switcher + picker wiring. */
export function skinClientScript(): string {
  const skins = SKINS.map(({ id, name, fonts, scheme }) => ({ id, name, fonts, scheme }));
  return String.raw`(function () {
  var GC = window.GC || (window.GC = {});
  var root = document.documentElement;
  var SKINS = ${jsonForScript(skins)};
  var FLAVOR = ${jsonForScript(FLAVOR)};
  var KEY = "gc-skin";
  var byId = {};
  SKINS.forEach(function (s) { byId[s.id] = s; });
  var reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var picks = {};
  function current() { var s = root.getAttribute("data-skin"); return byId[s] ? s : "classic"; }
  function pick(key, s, value) {
    if (typeof value === "string") return value;
    var k = key + "|" + s;
    if (!(k in picks)) picks[k] = value[Math.floor(Math.random() * value.length)] || "";
    return picks[k];
  }
  GC.skins = SKINS.map(function (s) { return { id: s.id, name: s.name }; });
  GC.skin = current;
  GC.t = function (key, fallback) {
    var entry = FLAVOR[key], s = current();
    var value = s !== "classic" && entry ? entry[s] : null;
    if (value == null) return fallback != null ? String(fallback) : (entry && entry.classic != null ? entry.classic : "");
    return pick(key, s, value);
  };
  function flavorOne(el, s) {
    if (el.getAttribute("data-flavor-skin") === s) return;
    if (!el.hasAttribute("data-flavor-orig")) el.setAttribute("data-flavor-orig", el.textContent);
    var text = GC.t(el.getAttribute("data-flavor"), el.getAttribute("data-flavor-orig"));
    if (el.textContent !== text) el.textContent = text;
    el.setAttribute("data-flavor-skin", s);
  }
  GC.applyFlavor = function (scope) {
    var s = current(), base = scope || document;
    if (base.nodeType === 1 && base.hasAttribute("data-flavor")) flavorOne(base, s);
    var list = base.querySelectorAll ? base.querySelectorAll("[data-flavor]") : [];
    for (var i = 0; i < list.length; i += 1) flavorOne(list[i], s);
  };
  function writeCookie(id) { document.cookie = KEY + "=" + id + "; path=/; max-age=31536000; samesite=lax"; }
  function setFonts(id) {
    var href = byId[id].fonts, link = document.getElementById("gc-skin-fonts");
    if (!href) { if (link) link.parentNode.removeChild(link); return; }
    if (!link) { link = document.createElement("link"); link.id = "gc-skin-fonts"; link.rel = "stylesheet"; document.head.appendChild(link); }
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }
  function syncPickers() {
    var s = current(), i;
    var items = document.querySelectorAll("[data-gc-skin]");
    for (i = 0; i < items.length; i += 1) items[i].setAttribute("aria-checked", String(items[i].getAttribute("data-gc-skin") === s));
    var radios = document.querySelectorAll('input[name="gc-skin"]');
    for (i = 0; i < radios.length; i += 1) radios[i].checked = radios[i].value === s;
  }
  GC.setSkin = function (id) {
    if (!byId[id]) return false;
    root.setAttribute("data-skin", id);
    try { localStorage.setItem(KEY, id); } catch (e) {}
    writeCookie(id);
    setFonts(id);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", byId[id].scheme);
    GC.applyFlavor(document);
    syncPickers();
    try { document.dispatchEvent(new CustomEvent("gc:skinchange", { detail: { skin: id } })); } catch (e) {}
    return true;
  };

  var celebrateTimer = 0;
  GC.celebrate = function (detail) {
    var s = current();
    if (s === "classic") return;
    var old = document.querySelector(".gc-celebrate");
    if (old) old.parentNode.removeChild(old);
    clearTimeout(celebrateTimer);
    var el = document.createElement("div");
    el.className = "gc-celebrate";
    el.setAttribute("role", "status");
    el.innerHTML = '<div class="gc-celebrate-box" title="Dismiss"><span class="gc-celebrate-icon" aria-hidden="true"></span><span class="gc-celebrate-text"><span class="gc-celebrate-title">'
      + GC.esc(GC.t("celebrate.title", "Done")) + '</span>' + (detail ? '<span class="gc-celebrate-detail">' + GC.esc(detail) + '</span>' : "") + '</span></div>';
    document.body.appendChild(el);
    function onKey(event) { if (event.key === "Escape") dismiss(); }
    function dismiss() {
      if (!el.parentNode) return;
      document.removeEventListener("keydown", onKey);
      clearTimeout(celebrateTimer);
      el.classList.add("is-leaving");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, reduceMotion && reduceMotion.matches ? 0 : 400);
    }
    el.addEventListener("click", dismiss);
    document.addEventListener("keydown", onKey);
    celebrateTimer = setTimeout(dismiss, reduceMotion && reduceMotion.matches ? 1800 : s === "elden" ? 2500 : 3600);
  };

  var switcher = document.querySelector(".gc-skin-switch");
  if (switcher) {
    var toggle = switcher.querySelector(".gc-skin-btn");
    var menu = switcher.querySelector(".gc-skin-menu");
    var menuItems = function () { return Array.prototype.slice.call(menu.querySelectorAll("[data-gc-skin]")); };
    var openMenu = function () {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      var selected = menu.querySelector('[aria-checked="true"]') || menuItems()[0];
      if (selected) selected.focus();
    };
    var closeMenu = function (refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (refocus) toggle.focus();
    };
    toggle.addEventListener("click", function () { if (menu.hidden) openMenu(); else closeMenu(false); });
    toggle.addEventListener("keydown", function (event) { if (event.key === "ArrowDown") { event.preventDefault(); openMenu(); } });
    menu.addEventListener("click", function (event) {
      var item = event.target.closest("[data-gc-skin]");
      if (!item) return;
      GC.setSkin(item.getAttribute("data-gc-skin"));
      closeMenu(true);
    });
    menu.addEventListener("keydown", function (event) {
      var items = menuItems(), index = items.indexOf(document.activeElement), next = -1;
      if (event.key === "ArrowDown") next = (index + 1) % items.length;
      else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else if (event.key === "Escape") { event.preventDefault(); closeMenu(true); return; }
      else if (event.key === "Tab") { closeMenu(false); return; }
      if (next >= 0) { event.preventDefault(); items[next].focus(); }
    });
    document.addEventListener("click", function (event) { if (!switcher.contains(event.target)) closeMenu(false); });
  }
  document.addEventListener("change", function (event) {
    var input = event.target;
    if (input && input.name === "gc-skin" && input.checked) GC.setSkin(input.value);
  });

  try {
    var stored = localStorage.getItem(KEY);
    if (byId[stored] && document.cookie.indexOf(KEY + "=" + stored) < 0) writeCookie(stored);
  } catch (e) {}
  GC.applyFlavor(document);
  syncPickers();
  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j += 1) if (added[j].nodeType === 1) GC.applyFlavor(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
})();`;
}

// ---------------------------------------------------------------------------
// Generated art (all original): SVG data URIs for pixel tiles, frames, noise
// ---------------------------------------------------------------------------

function svgUrl(svg: string): string {
  return `url("data:image/svg+xml,${svg.replace(/[\n\r]+\s*/g, "").replace(/[%#<>"{}|^`]/g, (character) => encodeURIComponent(character))}")`;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type PixelGrid = Array<Array<string | null>>;

/** Pixel-art tile from a color grid (null = base/transparent), one <path> per color, runs merged. */
function pixelTile(grid: PixelGrid, scale: number, base: string | null): string {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const byColor = new Map<string, string[]>();
  grid.forEach((row, y) => {
    let x = 0;
    while (x < cols) {
      const color = row[x] ?? null;
      let run = 1;
      while (x + run < cols && (row[x + run] ?? null) === color) run += 1;
      if (color) {
        const list = byColor.get(color) ?? [];
        list.push(`M${x} ${y}h${run}v1h-${run}z`);
        byColor.set(color, list);
      }
      x += run;
    }
  });
  const paths = [...byColor].map(([color, d]) => `<path fill='${color}' d='${d.join("")}'/>`).join("");
  const fill = base ? `<rect width='${cols}' height='${rows}' fill='${base}'/>` : "";
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='${cols * scale}' height='${rows * scale}' viewBox='0 0 ${cols} ${rows}' shape-rendering='crispEdges'>${fill}${paths}</svg>`);
}

function grid(cols: number, rows: number, paint: (x: number, y: number) => string | null): PixelGrid {
  return Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => paint(x, y)));
}

const DIRT_SHADES: ReadonlyArray<[number, string]> = [[0.12, "#6b4b33"], [0.2, "#5a3e2a"], [0.3, "#9a7250"], [0.35, "#b08359"], [0.38, "#7a6a5c"]];

function dirtPixel(rand: () => number): string | null {
  const roll = rand();
  for (const [limit, color] of DIRT_SHADES) if (roll < limit) return color;
  return null;
}

const MC_DIRT = (() => {
  const rand = mulberry32(11);
  return pixelTile(grid(16, 16, () => dirtPixel(rand)), 4, "#866043");
})();

/** Grass-block side: grass on top with a ragged edge, dirt below. */
const MC_GRASS = (() => {
  const rand = mulberry32(5);
  const greens = ["#5b9a35", "#6aad3f", "#4e8a2c", "#7bbf4a"];
  const depth = Array.from({ length: 16 }, () => 3 + Math.floor(rand() * 2.6));
  return pixelTile(grid(16, 16, (x, y) => {
    if (y < depth[x]!) return greens[Math.floor(rand() * greens.length)]!;
    if (y === depth[x] && rand() < 0.35) return "#4e8a2c";
    return dirtPixel(rand);
  }), 4, "#866043");
})();

/** Light oak planks: four boards, seams, end joints, grain streaks. */
const MC_PLANKS = (() => {
  const rand = mulberry32(23);
  const joints = [5, -1, 11, -1];
  const pixels = grid(16, 16, () => null);
  for (let y = 0; y < 16; y += 1) {
    const board = Math.floor(y / 4);
    const row = y % 4;
    let streak = 0;
    let streakColor: string | null = null;
    for (let x = 0; x < 16; x += 1) {
      if (row === 3) { pixels[y]![x] = "#b48e59"; continue; }
      if (x === joints[board]) { pixels[y]![x] = "#bb9661"; continue; }
      if (row === 0 && rand() < 0.5) { pixels[y]![x] = "#dcbb87"; continue; }
      if (streak <= 0 && rand() < 0.16) { streak = 2 + Math.floor(rand() * 5); streakColor = rand() < 0.75 ? "#c7a370" : "#dcbc8a"; }
      if (streak > 0) { pixels[y]![x] = streakColor; streak -= 1; }
    }
  }
  return pixelTile(pixels, 4, "#d3b07c");
})();

const MC_STONE = (() => {
  const rand = mulberry32(3);
  const shades: ReadonlyArray<[number, string]> = [[0.16, "#5a5a5a"], [0.3, "#717171"], [0.36, "#7b7b7b"], [0.4, "#525252"]];
  return pixelTile(grid(16, 16, () => {
    const roll = rand();
    for (const [limit, color] of shades) if (roll < limit) return color;
    return null;
  }), 2, "#666666");
})();

/** Subtle light/dark speckle for "wool block" avatars. */
const MC_WOOL = (() => {
  const rand = mulberry32(17);
  return pixelTile(grid(8, 8, () => {
    const roll = rand();
    return roll < 0.22 ? "rgba(255,255,255,.13)" : roll < 0.42 ? "rgba(0,0,0,.13)" : null;
  }), 2, null);
})();

/** A small original pixel gem for the "achievement" toast. */
const MC_GEM = (() => {
  const map = [
    "............",
    "....aaaa....",
    "...abbbba...",
    "..abccccba..",
    ".abccddccba.",
    ".abcdeedcba.",
    ".abcdeedcba.",
    ".abccddccba.",
    "..abccccba..",
    "...abbbba...",
    "....aaaa....",
    "............",
  ];
  const colors: Record<string, string> = { a: "#0d3d1d", b: "#17a34a", c: "#3fd16e", d: "#8af2a8", e: "#e6fff0" };
  return pixelTile(map.map((line) => [...line].map((ch) => colors[ch] ?? null)), 3, null);
})();

function eldenCorner(rotate: number): string {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><g transform='rotate(${rotate} 9 9)'><path d='M.5 13V.5H13' fill='none' stroke='#c9a961' stroke-opacity='.85'/><path d='M.5 .5l3 3' stroke='#c9a961' stroke-opacity='.5'/><rect x='3.6' y='3.6' width='3' height='3' fill='#e9cf8c' transform='rotate(45 5.1 5.1)'/></g></svg>`);
}

const ELDEN_CORNERS = "var(--gc-tx-er-tl) top 4px left 4px no-repeat, var(--gc-tx-er-tr) top 4px right 4px no-repeat, var(--gc-tx-er-br) bottom 4px right 4px no-repeat, var(--gc-tx-er-bl) bottom 4px left 4px no-repeat";

const PAPER_NOISE = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .32 0 0 0 0 .2 0 0 0 0 .08 0 0 0 .55 0'/></filter><rect width='240' height='240' filter='url(#n)' opacity='.3'/><filter id='s' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.016' numOctaves='2' seed='4' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .45 0 0 0 0 .3 0 0 0 0 .12 0 0 0 1.3 -.6'/></filter><rect width='240' height='240' filter='url(#s)' opacity='.28'/></svg>`);

const WOOD_GRAIN_X = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='480' height='120'><filter id='g' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.004 .16' numOctaves='3' seed='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.6 1'/></filter><rect width='480' height='120' filter='url(#g)' opacity='.55'/></svg>`);
const WOOD_GRAIN_Y = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='120' height='480'><filter id='g' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.16 .004' numOctaves='3' seed='9' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.6 1'/></filter><rect width='120' height='480' filter='url(#g)' opacity='.55'/></svg>`);

/** Hand-inked double rule, displaced with turbulence; used as a 9-slice border-image. */
const RDR_FRAME = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'><filter id='r' x='-10%' y='-10%' width='120%' height='120%'><feTurbulence type='fractalNoise' baseFrequency='.12' numOctaves='2' seed='7'/><feDisplacementMap in='SourceGraphic' scale='2.4' xChannelSelector='R' yChannelSelector='G'/></filter><g fill='none' stroke='#3b2a1a' filter='url(#r)'><rect x='2' y='2' width='56' height='56' stroke-width='2.2'/><rect x='6' y='6' width='48' height='48' stroke-width='1' stroke-opacity='.7'/></g></svg>`);

/** Alpha speckle that makes rubber stamps look worn. */
const STAMP_MASK = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='m' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='11' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2.6 0 0 0 2.15'/></filter><rect width='120' height='120' filter='url(#m)'/></svg>`);

/** Angular neon panel (cut corners, glow, yellow tab); 9-slice border-image with 6px glow margin. */
function cyberPanel(stroke: string, tab: string): string {
  const shape = "M6.5 6.5H43.5L57.5 20.5V57.5H20.5L6.5 43.5Z";
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><filter id='g' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='2.4'/></filter><path d='${shape}' fill='none' stroke='${stroke}' stroke-opacity='.5' stroke-width='2' filter='url(#g)'/><path d='${shape}' fill='#0e0f15' fill-opacity='.95' stroke='${stroke}' stroke-opacity='.62'/><path d='M6.5 6.5H19' stroke='${tab}' stroke-width='3'/><path d='M49 57.5h8.5' stroke='${tab}' stroke-opacity='.8' stroke-width='2'/></svg>`);
}
const CP_PANEL = cyberPanel("#00f0ff", "#fcee0a");
const CP_PANEL_HOT = cyberPanel("#ff2a6d", "#fcee0a");

// ---------------------------------------------------------------------------
// CSS. `@R` = :root[data-skin="x"] (tokens, page-specific overrides that must
// beat page CSS); `@S` = :where([data-skin="x"]) (zero-specificity prefix, so
// shared component overrides tie with the base rules and pages still win).
// ---------------------------------------------------------------------------

function scoped(id: SkinId, css: string): string {
  return css.replace(/@R/g, `:root[data-skin="${id}"]`).replace(/@S/g, `:where([data-skin="${id}"])`);
}

const CUT = (size: string) => `polygon(0 0,100% 0,100% calc(100% - ${size}),calc(100% - ${size}) 100%,0 100%)`;

/** Every generated texture is defined once here and referenced with var() below (keeps pages small). */
const TEXTURES_CSS = `:root {
  --gc-tx-mc-dirt:${MC_DIRT};
  --gc-tx-mc-grass:${MC_GRASS};
  --gc-tx-mc-planks:${MC_PLANKS};
  --gc-tx-mc-stone:${MC_STONE};
  --gc-tx-mc-wool:${MC_WOOL};
  --gc-tx-mc-gem:${MC_GEM};
  --gc-tx-paper:${PAPER_NOISE};
  --gc-tx-grain-x:${WOOD_GRAIN_X};
  --gc-tx-grain-y:${WOOD_GRAIN_Y};
  --gc-tx-ink-frame:${RDR_FRAME};
  --gc-tx-stamp:${STAMP_MASK};
  --gc-tx-cp-panel:${CP_PANEL};
  --gc-tx-cp-panel-hot:${CP_PANEL_HOT};
  --gc-tx-er-tl:${eldenCorner(0)}; --gc-tx-er-tr:${eldenCorner(90)}; --gc-tx-er-br:${eldenCorner(180)}; --gc-tx-er-bl:${eldenCorner(270)};
}`;

const SHARED_CSS = TEXTURES_CSS + `
:root { --gc-font-display:var(--gc-font); }
.gc-appbar-sub { flex:none; color:var(--gc-muted); font-size:var(--gc-fs-xs); white-space:nowrap; }
.gc-appbar-sub:empty { display:none; }
.gc-notice-eyebrow { font-size:var(--gc-fs-xs); font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--gc-accent); }
.gc-notice-eyebrow:empty { display:none; }

/* Theme switcher (app bar) */
.gc-skin-switch { position:relative; flex:none; }
.gc-skin-menu { position:absolute; top:calc(100% + 8px); right:0; z-index:40; width:240px; max-width:calc(100vw - 24px); padding:6px; display:grid; gap:2px; background:var(--gc-surface); color:var(--gc-text); border:1px solid var(--gc-border); border-radius:var(--gc-radius-md); box-shadow:0 8px 28px rgba(0,0,0,.22); }
.gc-skin-item { display:flex; align-items:center; gap:10px; width:100%; min-height:40px; padding:6px 10px; border:0; border-radius:var(--gc-radius-sm); background:transparent; color:inherit; font:inherit; font-size:var(--gc-fs-md); text-align:left; cursor:pointer; }
.gc-skin-item:hover, .gc-skin-item:focus-visible { background:var(--gc-hover); }
.gc-skin-item[aria-checked="true"] { font-weight:600; }
.gc-skin-item[aria-checked="true"]::after { content:""; flex:none; margin-left:auto; width:6px; height:11px; border:solid currentColor; border-width:0 2px 2px 0; transform:translateY(-2px) rotate(45deg); }
.gc-skin-swatch { width:34px; height:24px; flex:none; border-radius:4px; box-shadow:inset 0 0 0 1px rgba(0,0,0,.28); }
.gc-sw-classic { background:radial-gradient(circle at 74% 70%, #0b57d0 0 3.5px, transparent 4px), linear-gradient(#ffffff 0 7px, #e0e3e7 7px 8px, #f8fafd 8px); }
.gc-sw-elden { background:radial-gradient(circle at 50% 62%, #fff1c4 0 1.5px, rgba(240,212,138,.55) 2.5px, rgba(240,212,138,.12) 7px, transparent 11px), #14120e; box-shadow:inset 0 0 0 1px #9c8150, inset 0 0 0 3px #14120e, inset 0 0 0 4px rgba(201,169,97,.4); }
.gc-sw-minecraft { background:linear-gradient(#6aad3f 0 6px, transparent 6px), var(--gc-tx-mc-dirt) 0 0/16px 16px, #866043; border-radius:0; box-shadow:inset 0 0 0 1px #1b120b; }
.gc-sw-rdr { background:radial-gradient(circle at 70% 56%, transparent 4px, #8b1c1c 4.5px 6px, transparent 6.5px), var(--gc-tx-paper) 0 0/120px 120px, #e8d8b3; border-radius:2px; box-shadow:inset 0 0 0 1px #3b2a1a, inset 0 0 0 3px #e8d8b3, inset 0 0 0 4px rgba(59,42,26,.6); }
.gc-sw-cyberpunk { background:linear-gradient(90deg, #fcee0a 0 9px, transparent 9px), linear-gradient(180deg, transparent 15px, #ff2a6d 15px 17px, transparent 17px), #0e0f15; border-radius:0; box-shadow:inset 0 0 0 1px #00f0ff; clip-path:${CUT("6px")}; }

/* Settings: Appearance picker */
.gc-skin-options { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(118px, 100%), 1fr)); gap:var(--gc-space-4) var(--gc-space-3); }
.gc-skin-option { position:relative; display:grid; gap:8px; align-content:start; min-width:0; cursor:pointer; }
.gc-skin-preview { position:relative; display:block; height:88px; overflow:hidden; border-radius:var(--gc-radius-md); box-shadow:0 0 0 1px var(--gc-border); transition:transform .15s ease; }
.gc-skin-option:hover .gc-skin-preview { transform:translateY(-2px); }
.gc-skin-option input:checked + .gc-skin-preview { box-shadow:0 0 0 2px var(--gc-surface), 0 0 0 4px var(--gc-accent); }
.gc-skin-option input:focus-visible + .gc-skin-preview { outline:2px solid var(--gc-focus); outline-offset:6px; }
.gc-skin-text { display:grid; gap:2px; min-width:0; }
.gc-skin-name { font-weight:600; font-size:var(--gc-fs-sm); }
.gc-skin-option input:checked ~ .gc-skin-text .gc-skin-name::after { content:" · On"; color:var(--gc-accent); }
.gc-skin-blurb { color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.gc-skin-preview i, .gc-skin-preview b { display:block; font-style:normal; }
.gc-pv-bar { position:absolute; inset:0 0 auto; height:16px; }
.gc-pv-card { position:absolute; left:12px; right:12px; top:26px; bottom:10px; padding:7px 9px; }
.gc-pv-title { font-size:16px; line-height:1; font-weight:600; }
.gc-pv-line { height:4px; margin-top:7px; width:72%; }
.gc-pv-short { width:44%; margin-top:5px; }
.gc-pv-btn { position:absolute; right:9px; bottom:8px; width:30px; height:11px; }
.gc-pv-classic { background:#f8fafd; }
.gc-pv-classic .gc-pv-bar { background:#fff; border-bottom:1px solid #e0e3e7; }
.gc-pv-classic .gc-pv-card { background:#fff; border:1px solid #e0e3e7; border-radius:8px; }
.gc-pv-classic .gc-pv-title { color:#1f1f1f; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-weight:500; }
.gc-pv-classic .gc-pv-line { background:#e0e3e7; border-radius:2px; }
.gc-pv-classic .gc-pv-btn { background:#0b57d0; border-radius:99px; }
.gc-pv-elden { background:radial-gradient(ellipse 80% 70% at 50% 0%, rgba(214,180,106,.24), transparent 70%), #0d0c0a; }
.gc-pv-elden .gc-pv-bar { background:#14120e; border-bottom:1px solid rgba(212,180,106,.6); }
.gc-pv-elden .gc-pv-card { background:${ELDEN_CORNERS}, #171510; border:1px solid #6d5a35; }
.gc-pv-elden .gc-pv-title { font-family:"Cinzel",Georgia,serif; color:#e3c77f; letter-spacing:.06em; padding-left:10px; }
.gc-pv-elden .gc-pv-line { height:1px; margin-left:10px; background:linear-gradient(90deg, #c9a961, transparent); }
.gc-pv-elden .gc-pv-btn { background:linear-gradient(#3b3223, #1b1711); border:1px solid #c9a961; box-shadow:0 0 8px rgba(240,212,138,.45); right:14px; bottom:12px; }
.gc-pv-minecraft { background:var(--gc-tx-mc-planks) 0 0/32px 32px, #d3b07c; border-radius:0; }
.gc-pv-minecraft .gc-pv-bar { height:18px; background:var(--gc-tx-mc-grass) 0 0/32px 32px repeat-x, #866043; }
.gc-pv-minecraft .gc-pv-card { background:#c6c6c6; border:2px solid #000; box-shadow:inset 2px 2px 0 #fff, inset -2px -2px 0 #555; }
.gc-pv-minecraft .gc-pv-title { font-family:"Press Start 2P",ui-monospace,monospace; font-size:11px; color:#3f3f3f; font-weight:400; }
.gc-pv-minecraft .gc-pv-line { background:#8b8b8b; }
.gc-pv-minecraft .gc-pv-btn { height:13px; background:var(--gc-tx-mc-stone) 0 0/16px 16px, #666; border:2px solid #000; }
.gc-pv-rdr { background:var(--gc-tx-paper) 0 0/240px 240px, #e8d8b3; border-radius:2px; }
.gc-pv-rdr .gc-pv-bar { background:linear-gradient(180deg, #3b2615, #24160b); border-bottom:2px solid #120a04; }
.gc-pv-rdr .gc-pv-card { background:#f3e8cf; border:1px solid transparent; border-image:var(--gc-tx-ink-frame) 10 / 8px / 0 round; }
.gc-pv-rdr .gc-pv-title { font-family:"Rye",Georgia,serif; color:#2a1c10; font-weight:400; }
.gc-pv-rdr .gc-pv-line { height:0; border-top:1px dashed rgba(59,42,26,.7); }
.gc-pv-rdr .gc-pv-btn { background:#8b1c1c; border:1px solid #5e1010; box-shadow:inset 0 0 0 1px #8b1c1c, inset 0 0 0 2px rgba(251,241,220,.6); }
.gc-pv-cyberpunk { background:linear-gradient(rgba(0,240,255,.08) 1px, transparent 1px) 0 0/10px 10px, linear-gradient(90deg, rgba(0,240,255,.08) 1px, transparent 1px) 0 0/10px 10px, #07070b; border-radius:0; }
.gc-pv-cyberpunk .gc-pv-bar { background:#0e0f15; border-bottom:1px solid #fcee0a; }
.gc-pv-cyberpunk .gc-pv-card { border:1px solid transparent; border-image:var(--gc-tx-cp-panel) 24 fill / 14px / 3px stretch; }
.gc-pv-cyberpunk .gc-pv-title { font-family:"Rajdhani","Arial Narrow",sans-serif; font-weight:700; color:#fcee0a; letter-spacing:.08em; text-transform:uppercase; }
.gc-pv-cyberpunk .gc-pv-line { height:2px; background:#00f0ff; box-shadow:0 0 6px #00f0ff; }
.gc-pv-cyberpunk .gc-pv-short { background:#ff2a6d; box-shadow:0 0 6px #ff2a6d; }
.gc-pv-cyberpunk .gc-pv-btn { background:#fcee0a; clip-path:${CUT("4px")}; }

/* Game skins: long calendar action labels wrap instead of overflowing the panel */
:root:not([data-skin="classic"]) .cal .cal-person-actions .cal-btn { height:auto; min-height:30px; padding:6px 12px; white-space:normal; line-height:1.2; text-align:center; letter-spacing:.03em; }

/* Completion flourish (GC.celebrate); each skin positions and dresses it */
.gc-celebrate { position:fixed; z-index:200; pointer-events:none; }
.gc-celebrate-box { pointer-events:auto; cursor:pointer; }
.gc-celebrate-title, .gc-celebrate-detail { display:block; }
.gc-celebrate-icon { display:none; }
@media (prefers-reduced-motion: reduce) {
  .gc-celebrate *, .gc-appbar-sub, .gc-appbar-sub::after, .gc-btn { animation:none !important; }
}
`;

// ── Elden Ring–inspired: umber darkness, tarnished gold, engraved plates ──
const ELDEN_CSS = scoped("elden", `
@R { color-scheme:dark;
  --gc-bg:#0d0c0a; --gc-surface:#171510; --gc-surface-2:#1f1c16; --gc-hover:#28241b;
  --gc-border:#4a3f29; --gc-border-strong:#7d6a43;
  --gc-text:#e8dfc8; --gc-text-2:#cfc4a8; --gc-muted:#a69a7c;
  --gc-accent:#d4b46a; --gc-accent-hover:#e9cf8c; --gc-accent-soft:#3a3020; --gc-on-accent:#15110a; --gc-on-accent-soft:#f0deaa;
  --gc-success:#a9cf8f; --gc-success-soft:#1f2b1a; --gc-warning:#e8bd62; --gc-warning-soft:#35290f; --gc-danger:#ec9282; --gc-danger-soft:#3d1a15;
  --gc-track:#2a251b; --gc-focus:#f3d78f; --gc-tooltip-bg:#0b0a08; --gc-tooltip-text:#e8dfc8;
  --gc-font:"EB Garamond","Cormorant Garamond",Garamond,Georgia,serif; --gc-font-display:"Cinzel","Trajan Pro",Georgia,serif;
  --gc-fs-xs:13px; --gc-fs-sm:14.5px; --gc-fs-md:16px; --gc-fs-lg:18px; --gc-fs-xl:24px; --gc-fs-2xl:32px;
  --gc-radius-sm:2px; --gc-radius-md:2px; --gc-radius-lg:3px; --gc-radius-pill:2px;
  scrollbar-color:#5a4a2e #0d0c0a; }
@R body { background:#0d0c0a; }
@S body::before { content:""; position:fixed; inset:0; z-index:-1; pointer-events:none;
  background:radial-gradient(ellipse 70% 45% at 50% 0%, rgba(214,180,106,.14), transparent 70%), radial-gradient(ellipse at 50% 45%, transparent 40%, rgba(0,0,0,.66) 100%); }
@S ::selection { background:rgba(212,180,106,.38); color:#fff8e6; }
@S :where(h1,h2,h3) { font-family:var(--gc-font-display); }
@S a { text-decoration-color:rgba(212,180,106,.45); text-underline-offset:3px; }

@S .gc-appbar { background:linear-gradient(180deg, #1a1711, #0f0e0b); border-bottom:1px solid transparent; border-image:linear-gradient(90deg, transparent, rgba(212,180,106,.7) 18%, rgba(212,180,106,.7) 82%, transparent) 1; box-shadow:0 8px 24px rgba(0,0,0,.5); }
@S .gc-logo { width:28px; height:28px; margin:0 6px; border-radius:0; transform:rotate(45deg); background:radial-gradient(circle, #3a3020, #15120c 75%); border:1px solid #c9a961; color:#f3d78f; box-shadow:0 0 14px rgba(240,212,138,.35), inset 0 0 0 2px #15120c, inset 0 0 0 3px rgba(201,169,97,.45); }
@S .gc-logo > .gc-icon { transform:rotate(-45deg); width:17px; height:17px; }
@S .gc-brand-name { font-family:var(--gc-font-display); font-weight:600; font-size:20px; letter-spacing:.08em; color:#e9d39a; text-shadow:0 0 16px rgba(240,212,138,.3); }
@S .gc-appbar-title { font-family:var(--gc-font-display); font-weight:500; letter-spacing:.06em; color:var(--gc-text); border-left-color:rgba(212,180,106,.35); }
@S .gc-appbar-sub { display:inline-flex; align-items:center; gap:9px; font-style:italic; font-size:15px; color:#c4ad72; }
@S .gc-appbar-sub::before { content:""; width:6px; height:6px; transform:rotate(45deg); background:#f3d78f; box-shadow:0 0 8px #f3d78f, 0 0 16px rgba(243,215,143,.6); }

@S .gc-rail { background:linear-gradient(90deg, rgba(10,9,7,.7), rgba(23,21,16,.55)); border-right:1px solid transparent; border-image:linear-gradient(180deg, transparent, rgba(212,180,106,.38) 12%, rgba(212,180,106,.38) 88%, transparent) 1; }
@S .gc-nav-item { font-family:var(--gc-font-display); font-size:10.5px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:#a69a7c; }
@S .gc-nav-pill { position:relative; border-radius:2px; }
@S .gc-nav-item:hover { color:#e9d39a; }
@S .gc-nav-item:hover .gc-nav-pill { background:radial-gradient(closest-side, rgba(240,212,138,.18), transparent); }
@S .gc-nav-item[aria-current="page"] { color:#f3e2b2; font-weight:700; }
@S .gc-nav-item[aria-current="page"] .gc-nav-pill { background:radial-gradient(closest-side, rgba(240,212,138,.42), rgba(240,212,138,.1) 65%, transparent); color:#fff6d8; }
@S .gc-nav-item[aria-current="page"] .gc-icon { filter:drop-shadow(0 0 4px rgba(240,212,138,.9)); }
@S .gc-nav-item[aria-current="page"] .gc-nav-pill::after { content:""; position:absolute; left:50%; bottom:-4px; width:5px; height:5px; margin-left:-2.5px; transform:rotate(45deg); background:#f3d78f; box-shadow:0 0 6px #f3d78f; }

@S :is(.gc-card, .gc-stat, .gc-disclosure) { background:${ELDEN_CORNERS}, linear-gradient(180deg, rgba(255,236,190,.04), rgba(255,236,190,0) 160px), var(--gc-surface); border:1px solid #3f3524; box-shadow:inset 0 1px 0 rgba(255,236,190,.05), 0 14px 34px rgba(0,0,0,.38); }
@S .gc-card-head { padding-bottom:10px; border-bottom:1px solid transparent; border-image:linear-gradient(90deg, rgba(212,180,106,.6), rgba(212,180,106,.14) 70%, transparent) 1; }
@S .gc-card-title { font-family:var(--gc-font-display); font-weight:600; font-size:16.5px; letter-spacing:.07em; color:#e3c77f; }
@S .gc-card-icon { width:24px; height:24px; margin:0 8px 0 4px; border-radius:0; transform:rotate(45deg); background:#120f0a; border-color:#6d5a35; color:#d4b46a; }
@S .gc-card-icon > .gc-icon { transform:rotate(-45deg); width:15px; height:15px; }
@S .gc-section-title { display:flex; align-items:center; gap:10px; font-family:var(--gc-font-display); font-size:13px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:#c9b27a; }
@S .gc-section-title::before { content:""; width:6px; height:6px; transform:rotate(45deg); border:1px solid #d4b46a; }
@S .gc-meta { font-style:italic; }
@S .gc-stat-label { font-family:var(--gc-font-display); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:#b9a678; }
@S .gc-stat-value { font-family:var(--gc-font-display); font-weight:500; color:#f0e3bf; }

@S .gc-track { height:6px; border-radius:0; background:#0f0d0a; box-shadow:inset 0 0 0 1px #3d3423; }
@S .gc-fill { border-radius:0; background:linear-gradient(90deg, #8a6d36, #e3c77f); box-shadow:0 0 10px rgba(240,212,138,.45); }
@S .gc-fill.is-over { background:linear-gradient(90deg, #7a2418, #e07a62); box-shadow:0 0 10px rgba(224,122,98,.45); }

@S .gc-chip { height:22px; padding:0 8px; border-radius:1px; font-family:var(--gc-font-display); font-size:10.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
@S .gc-chip-neutral { border-color:#5a4a2e; color:#d6cbad; }
@S .gc-chip-accent { border-color:rgba(212,180,106,.45); }
@S .gc-chip-success { border-color:rgba(169,207,143,.35); }
@S .gc-chip-warning { border-color:rgba(232,189,98,.35); }
@S .gc-chip-danger { border-color:rgba(236,146,130,.35); }

@S .gc-btn { height:38px; padding:0 20px; border-radius:1px; border:1px solid #9c8150; font:600 12.5px/1 var(--gc-font-display); letter-spacing:.12em; text-transform:uppercase; color:#f3e2b2; text-shadow:0 1px 0 #000;
  background:linear-gradient(180deg, #3b3223 0%, #272118 49%, #1b1711 51%, #241e16 100%);
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.65), inset 0 0 0 2px rgba(240,212,138,.16), 0 2px 6px rgba(0,0,0,.5); transition:box-shadow .2s ease, border-color .2s ease, color .2s ease; }
@S .gc-btn:not(:disabled):hover { background:linear-gradient(180deg, #463b29 0%, #2e271c 49%, #211c15 51%, #2a241a 100%); border-color:#e3c77f; color:#fff4d1;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.65), inset 0 0 0 2px rgba(240,212,138,.28), 0 0 18px rgba(240,212,138,.35); }
@S .gc-btn-tonal { background:linear-gradient(180deg, #2a251b, #1c1913); border-color:#6d5a35; color:#e3c77f; }
@S .gc-btn-tonal:not(:disabled):hover { filter:none; }
@S .gc-btn-outline { background:transparent; border-color:#6d5a35; color:#e3c77f; box-shadow:none; }
@S .gc-btn-outline:not(:disabled):hover { background:rgba(240,212,138,.06); border-color:#e3c77f; box-shadow:0 0 14px rgba(240,212,138,.25); }
@S .gc-btn-text { background:transparent; border-color:transparent; box-shadow:none; color:#e3c77f; padding:0 10px; }
@S .gc-btn-text:not(:disabled):hover { background:radial-gradient(closest-side, rgba(240,212,138,.14), transparent); border-color:transparent; box-shadow:none; text-shadow:0 0 10px rgba(240,212,138,.6); }
@S .gc-btn-sm { height:32px; padding:0 14px; font-size:11px; }
@S .gc-icon-btn { border-radius:2px; color:#cfc4a8; }
@S .gc-icon-btn:hover { background:radial-gradient(closest-side, rgba(240,212,138,.2), transparent); color:#f3e2b2; }

@S :is(.gc-input, .gc-select) { border-radius:1px; background:#0f0d0a; border-color:#5a4a2e; color:var(--gc-text); font-size:16px; }
@S :is(.gc-input, .gc-select):focus { outline:1px solid var(--gc-focus); outline-offset:-1px; border-color:transparent; box-shadow:0 0 14px rgba(240,212,138,.32); }
@S .gc-input::placeholder { color:#8a7f63; font-style:italic; }

@S .gc-avatar { font-family:var(--gc-font-display); font-weight:700; box-shadow:0 0 0 1px #0d0c0a, 0 0 0 2px #9c8150; filter:saturate(.6) brightness(.9); }
@S .gc-avatars .gc-avatar { box-shadow:0 0 0 1px #0d0c0a, 0 0 0 2px #9c8150; }
@S .gc-avatars .gc-avatar + .gc-avatar { margin-left:-4px; }

@S .gc-list-item { border-top:1px solid transparent; border-image:linear-gradient(90deg, transparent, rgba(212,180,106,.3) 12%, rgba(212,180,106,.3) 88%, transparent) 1; }
@S .gc-list-title { font-size:16.5px; }
@S .gc-amount { font-family:var(--gc-font-display); font-weight:600; color:#ead7a4; }

@S .gc-empty > .gc-icon { color:#a8894f; filter:drop-shadow(0 0 8px rgba(240,212,138,.4)); }
@S .gc-empty-title { font-family:var(--gc-font-display); font-weight:600; letter-spacing:.06em; color:#e3c77f; }
@S .gc-empty-title::after { content:""; display:block; width:96px; height:1px; margin:8px auto 2px; background:linear-gradient(90deg, transparent, #c9a961, transparent); }
@S .gc-empty-text { font-style:italic; font-size:15.5px; color:#b9ac8b; }

@S .gc-tip::after { border:1px solid #6d5a35; border-radius:1px; font:400 14.5px/1.4 var(--gc-font); box-shadow:0 10px 24px rgba(0,0,0,.6); }
@S .gc-disclosure > summary { margin:3px; font-family:var(--gc-font-display); font-size:14px; letter-spacing:.06em; color:#e3c77f; }
@S .gc-disclosure > summary:hover { background:radial-gradient(ellipse at 30% 50%, rgba(240,212,138,.09), transparent 70%); }
@S .gc-steps .gc-step-icon { width:24px; height:24px; margin:4px; border-radius:0; transform:rotate(45deg); border-color:#6d5a35; background:#120f0a; color:#d4b46a; }
@S .gc-steps .gc-step-icon > .gc-icon { transform:rotate(-45deg); }
@S .gc-steps strong { font-family:var(--gc-font-display); letter-spacing:.04em; color:#e3c77f; font-size:14.5px; }
@S .gc-dot { background:#f3d78f; box-shadow:0 0 8px rgba(240,212,138,.9); }
@S .gc-sync.is-paused .gc-dot { background:#7a6a48; box-shadow:none; }

@S .gc-dialog { border:1px solid #9c8150; background:${ELDEN_CORNERS}, linear-gradient(180deg, #1d1a14, #131109); box-shadow:0 0 0 1px #000, 0 24px 60px rgba(0,0,0,.7), 0 0 40px rgba(240,212,138,.08); }
@S .gc-dialog::backdrop { background:radial-gradient(ellipse at center, rgba(0,0,0,.55), rgba(0,0,0,.86)); }
@S .gc-dialog-title { font-family:var(--gc-font-display); font-weight:600; letter-spacing:.06em; color:#e3c77f; }
@S .gc-skin-menu { border-color:#6d5a35; background:${ELDEN_CORNERS}, #15130f; box-shadow:0 16px 40px rgba(0,0,0,.6); }
@S .gc-skin-item:hover, @S .gc-skin-item:focus-visible { background:radial-gradient(ellipse at 30% 50%, rgba(240,212,138,.16), transparent 75%); }
@S .gc-notice-eyebrow { font-family:var(--gc-font-display); font-size:12px; letter-spacing:.26em; color:#e3c77f; }
@R .gc-notice-icon { border-radius:0; transform:rotate(45deg) scale(.82); background:#120f0a; border:1px solid #c9a961; color:#f3d78f; box-shadow:0 0 18px rgba(240,212,138,.3); }
@R .gc-notice-icon > .gc-icon { transform:rotate(-45deg); }

/* Known pages */
@R .home-date { font-family:var(--gc-font-display); font-weight:500; letter-spacing:.04em; color:#efe1bb; }
@R .home-big { font-family:var(--gc-font-display); color:#f0e3bf; }
@R .cart-banner { background:#14120d; border-color:#4a3f29; }
@R .set-icon { border-radius:0; transform:rotate(45deg) scale(.8); background:#120f0a; border-color:#6d5a35; color:#d4b46a; }
@R .set-icon > .gc-icon { transform:rotate(-45deg); }
@R .set-facts { border-top:1px solid transparent; border-image:linear-gradient(90deg, rgba(212,180,106,.4), transparent) 1; }

/* Calendar */
@R .cal.cal { --cal-line:#3d3423; --cal-line-soft:rgba(212,180,106,.1); --cal-free-bg:rgba(169,207,143,.1); --cal-free-edge:#a9cf8f; --cal-free-text:#c3e2ad;
  --cal-ovl-2:rgba(255,236,190,.05); --cal-ovl-3:rgba(255,236,190,.1); --cal-ovl-4:rgba(255,236,190,.16); --cal-ovl-edge:#a69a7c; --cal-now:#f3d78f; --cal-warn:#e8bd62; --cal-danger:#ec9282; }
@R .cal :is(.cal-main, .cal-panel) { border-color:#3f3524; box-shadow:0 14px 34px rgba(0,0,0,.38); }
@R .cal .cal-panel { background:${ELDEN_CORNERS}, var(--gc-surface); }
@R .cal .cal-btn { border-radius:1px; border-color:#6d5a35; background:linear-gradient(180deg, #2a251b, #1c1913); color:#e3c77f; font:600 12px/1 var(--gc-font-display); letter-spacing:.1em; text-transform:uppercase; }
@R .cal .cal-btn.primary { border-color:#c9a961; color:#f3e2b2; background:linear-gradient(180deg, #3b3223, #1b1711); }
@R .cal .cal-btn.quiet { background:transparent; border-color:transparent; color:#cfc4a8; }
@R .cal .cal-btn:hover { border-color:#e3c77f; box-shadow:0 0 12px rgba(240,212,138,.3); }
@R .cal .cal-icon { border-radius:2px; color:#e3c77f; }
@R .cal .cal-chip { border-radius:1px; background:transparent; border:1px solid rgba(212,180,106,.45); color:#e3c77f; font:600 11px/1 var(--gc-font-display); letter-spacing:.08em; text-transform:uppercase; }
@R .cal .cal-range { font-family:var(--gc-font-display); font-weight:500; letter-spacing:.04em; color:#efe1bb; }
@R .cal .cal-panel h2 { font-family:var(--gc-font-display); font-size:13px; letter-spacing:.1em; text-transform:uppercase; color:#e3c77f; }
@R .cal .cal-head-dow { font-family:var(--gc-font-display); }
@R .cal .cal-head.today .cal-head-dow { color:#f3d78f; }
@R .cal .cal-head.today .cal-head-date { background:radial-gradient(circle, rgba(240,212,138,.25), transparent 70%); color:#fff1c4; box-shadow:0 0 0 1px #c9a961, 0 0 14px rgba(240,212,138,.45); }
@R .cal .cal-busy { border-radius:1px; background:color-mix(in srgb, var(--m-solid) 34%, var(--gc-surface)); color:#efe6cf; }
@R .cal .cal-avatar { color:#fff; font-family:var(--gc-font-display); box-shadow:0 0 0 1px #0d0c0a, 0 0 0 2px #9c8150; filter:saturate(.6) brightness(.9); }
@R .cal .cal-now { box-shadow:0 0 8px rgba(243,215,143,.8); }
@R .cal .cal-best button { border-radius:2px; }
@R .cal .cal-best-day { font-size:15px; }

@S .gc-celebrate { inset:0; display:grid; align-content:center; padding-bottom:8vh; }
@S .gc-celebrate-box { display:block; padding:34px 16px 30px; text-align:center; background:linear-gradient(180deg, transparent, rgba(6,5,4,.88) 26%, rgba(6,5,4,.88) 74%, transparent); animation:gc-er-band 2.6s ease both; }
@S .gc-celebrate-title { font:600 clamp(26px, 7vw, 68px)/1.08 var(--gc-font-display); letter-spacing:.06em; text-transform:uppercase; color:#e9cf8c; background:linear-gradient(180deg, #fff3cf 0%, #e9cf8c 45%, #a8843f 100%); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; filter:drop-shadow(0 0 18px rgba(240,212,138,.45)); animation:gc-er-title 2.6s ease both; }
@S .gc-celebrate-detail { margin-top:10px; font:italic 400 18px/1.3 var(--gc-font); color:#d8ccb0; }
@S .gc-celebrate.is-leaving { opacity:0; transition:opacity .35s ease; }
@keyframes gc-er-band { 0% { opacity:0 } 14% { opacity:1 } 82% { opacity:1 } 100% { opacity:0 } }
@keyframes gc-er-title { 0% { opacity:0; letter-spacing:.18em; } 18% { opacity:1 } 100% { letter-spacing:.06em } }

@S :focus-visible { outline:2px solid var(--gc-focus); outline-offset:3px; box-shadow:0 0 0 5px rgba(243,215,143,.14), 0 0 18px rgba(243,215,143,.5); }

@media (max-width: 760px) {
  @S .gc-rail { background:linear-gradient(180deg, #17150f, #0b0a08); border-right:0; border-top:1px solid transparent; border-image:linear-gradient(90deg, transparent, rgba(212,180,106,.65) 18%, rgba(212,180,106,.65) 82%, transparent) 1; }
  @S .gc-nav-item { font-size:9px; letter-spacing:0; }
  @S .gc-appbar-sub { display:none; }
  @S .gc-appbar-title { font-size:15px; }
  @S .gc-card-title { font-size:15px; letter-spacing:.04em; }
  @S .gc-stat-label { gap:4px; font-size:10px; letter-spacing:.02em; }
  @S .gc-stat-label > .gc-icon { width:13px; height:13px; }
}
`);

// ── Minecraft-inspired: grass-block app bar, hotbar nav, inventory panels ──
const MC_PANEL = "background:#c6c6c6; border:2px solid #000; border-radius:0; box-shadow:inset 3px 3px 0 #fff, inset -3px -3px 0 #555, 4px 4px 0 rgba(0,0,0,.28);";
const MC_SLOT = "background:#8b8b8b; border:0; border-radius:0; box-shadow:inset 2px 2px 0 #373737, inset -2px -2px 0 #fff; color:#fff;";
const MC_STONE_BTN = `background:var(--gc-tx-mc-stone) 0 0/32px 32px, #666; border:2px solid #000; border-radius:0; color:#fff; text-shadow:2px 2px 0 #3f3f3f; box-shadow:inset 2px 2px 0 rgba(255,255,255,.38), inset -2px -3px 0 rgba(0,0,0,.42);`;
const MINECRAFT_CSS = scoped("minecraft", `
@R { color-scheme:light;
  --gc-bg:#d3b07c; --gc-surface:#c6c6c6; --gc-surface-2:#d4d4d4; --gc-hover:#d9d9d9;
  --gc-border:#8b8b8b; --gc-border-strong:#373737;
  --gc-text:#1e1e1e; --gc-text-2:#2f2f2f; --gc-muted:#3d3d3d;
  --gc-accent:#1f4a16; --gc-accent-hover:#2a5e1d; --gc-accent-soft:#a6d683; --gc-on-accent:#ffffff; --gc-on-accent-soft:#143010;
  --gc-success:#1f4f15; --gc-success-soft:#a6d683; --gc-warning:#4f3700; --gc-warning-soft:#f6d661; --gc-danger:#7f0f0f; --gc-danger-soft:#f4adad;
  --gc-track:#1b1b1b; --gc-focus:#111111; --gc-tooltip-bg:#100010; --gc-tooltip-text:#ffffff;
  --gc-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --gc-font-display:"Press Start 2P",ui-monospace,Menlo,monospace; --gc-font-pixel:"VT323",ui-monospace,Menlo,monospace;
  --gc-radius-sm:0; --gc-radius-md:0; --gc-radius-lg:0; --gc-radius-pill:0; }
@R body { background:var(--gc-tx-mc-planks) 0 0/64px 64px, #d3b07c; }
@S ::selection { background:#2f6b1f; color:#fff; }
@S :where(h1,h2,h3) { font-family:var(--gc-font-display); font-weight:400; line-height:1.5; }
@S a { text-decoration-thickness:2px; }

@S .gc-appbar { --gc-text:#fff; --gc-text-2:#f2f2f2; --gc-muted:#ececec; --gc-border:rgba(0,0,0,.55); --gc-hover:rgba(255,255,255,.18);
  padding-top:10px; background:var(--gc-tx-mc-grass) 0 0/64px 64px repeat-x, #866043; border-bottom:3px solid #24180e; color:#fff; }
@S .gc-logo { width:34px; height:34px; border-radius:0; background:linear-gradient(#6aad3f 0 9px, transparent 9px), var(--gc-tx-mc-dirt) 0 0/32px 32px, #866043; border:2px solid #1b120b; box-shadow:inset -3px -3px 0 rgba(0,0,0,.3), inset 3px 3px 0 rgba(255,255,255,.2); color:#fff; }
@S .gc-logo > .gc-icon { filter:drop-shadow(2px 2px 0 rgba(0,0,0,.65)); }
@S .gc-brand-name { font-family:var(--gc-font-display); font-size:15px; color:#fff; text-shadow:3px 3px 0 #3f3f3f; letter-spacing:0; }
@S .gc-appbar-title { font-family:var(--gc-font-display); font-weight:400; font-size:13px; line-height:1.6; color:#fff; text-shadow:2px 2px 0 #3f3f3f; border-left:3px solid rgba(0,0,0,.35); }
@S .gc-appbar-sub { font:21px/1 var(--gc-font-pixel); color:#ffff55; text-shadow:2px 2px 0 #3f3f15; transform:rotate(-10deg); animation:gc-mc-splash .5s ease-in-out infinite alternate; }
@S .gc-appbar .gc-sync { font:19px/1 var(--gc-font-pixel); text-shadow:2px 2px 0 #3f3f3f; }
@S .gc-appbar .gc-icon-btn:hover { background:rgba(255,255,255,.18); box-shadow:inset 0 0 0 2px #fff; }
@keyframes gc-mc-splash { from { transform:rotate(-10deg) scale(1); } to { transform:rotate(-10deg) scale(1.08); } }

@S .gc-rail { background:linear-gradient(rgba(0,0,0,.46), rgba(0,0,0,.46)), var(--gc-tx-mc-dirt) 0 0/64px 64px, #866043; border-right:3px solid #1b120b; }
@S .gc-nav-item { gap:6px; border-radius:0; color:#fff; font:19px/1 var(--gc-font-pixel); text-shadow:2px 2px 0 #3f3f3f; }
@S .gc-nav-pill { width:48px; height:42px; border-radius:0; background:rgba(0,0,0,.42); border:2px solid #8b8b8b; box-shadow:inset 2px 2px 0 rgba(0,0,0,.45), inset -2px -2px 0 rgba(255,255,255,.12); color:#fff; }
@S .gc-nav-pill > .gc-icon { filter:drop-shadow(2px 2px 0 rgba(0,0,0,.65)); }
@S .gc-nav-item:hover .gc-nav-pill { background:rgba(255,255,255,.14); border-color:#c6c6c6; }
@S .gc-nav-item[aria-current="page"] { color:#ffff55; font-weight:400; }
@S .gc-nav-item[aria-current="page"] .gc-nav-pill { background:rgba(255,255,255,.14); border:3px solid #fff; box-shadow:0 0 0 2px #000, inset 0 0 0 2px #555; color:#fff; }

@S :is(.gc-card, .gc-stat, .gc-disclosure) { ${MC_PANEL} }
@S .gc-card-title { font-family:var(--gc-font-display); font-size:12px; font-weight:400; line-height:1.6; color:#3f3f3f; }
@S .gc-card-icon { ${MC_SLOT} }
@S .gc-card-icon > .gc-icon { filter:drop-shadow(1px 1px 0 #3f3f3f); }
@S .gc-section-title { font-family:var(--gc-font-display); font-size:11px; font-weight:400; line-height:1.6; color:#2b1d0e; }
@S .gc-meta { font:19px/1 var(--gc-font-pixel); }
@S .gc-muted { color:var(--gc-muted); }
@S .gc-stat-label { font:clamp(17px, 1.6vw, 20px)/1 var(--gc-font-pixel); color:#3f3f3f; }
@S .gc-stat-value { font:clamp(25px, 2.7vw, 34px)/1 var(--gc-font-pixel); color:#1e1e1e; }
@S .gc-stat-sub { font:18px/1.1 var(--gc-font-pixel); }

@S .gc-track { position:relative; height:12px; border-radius:0; background:#1b1b1b; box-shadow:0 0 0 2px #000; margin-left:2px; margin-right:2px; }
@S .gc-track::after { content:""; position:absolute; inset:0; pointer-events:none; background:repeating-linear-gradient(90deg, transparent 0 calc(10% - 2px), rgba(0,0,0,.7) calc(10% - 2px) 10%); }
@S .gc-fill { border-radius:0; background:linear-gradient(180deg, #d3ff8a 0 25%, #80d42a 25% 72%, #4f8f12 72%); }
@S .gc-fill.is-over { background:linear-gradient(180deg, #ffb0b0 0 25%, #e33 25% 72%, #8f1111 72%); }

@S .gc-chip { height:24px; padding:0 7px; border-radius:0; border:2px solid rgba(0,0,0,.6); font:19px/1 var(--gc-font-pixel); font-weight:400; box-shadow:inset 2px 2px 0 rgba(255,255,255,.45), inset -2px -2px 0 rgba(0,0,0,.18); }
@S .gc-chip-neutral { background:#b4b4b4; color:#1e1e1e; border-color:#555; }
@S .gc-appbar .gc-chip-neutral { background:#c6c6c6; }

@S .gc-btn { height:38px; padding:0 16px; font:22px/1 var(--gc-font-pixel); font-weight:400; ${MC_STONE_BTN} }
@S .gc-btn:not(:disabled):hover { background:var(--gc-tx-mc-stone) 0 0/32px 32px, #666; border-color:#fff; color:#ffffa0; }
@S .gc-btn:not(:disabled):active { box-shadow:inset -2px -2px 0 rgba(255,255,255,.3), inset 2px 3px 0 rgba(0,0,0,.42); }
@S .gc-btn-tonal { background:#2f6e20; }
@S .gc-btn-tonal:not(:disabled):hover { background:#3a8428; filter:none; }
@S .gc-btn-outline { background:#c6c6c6; color:#1e1e1e; text-shadow:none; border-color:#373737; box-shadow:inset 2px 2px 0 #fff, inset -2px -2px 0 #8b8b8b; }
@S .gc-btn-outline:not(:disabled):hover { background:#dadada; border-color:#000; color:#000; }
@S .gc-btn-text { background:transparent; border-color:transparent; box-shadow:none; color:#1f4f15; text-shadow:none; padding:0 8px; }
@S .gc-btn-text:not(:disabled):hover { background:rgba(255,255,255,.45); border-color:transparent; color:#000; }
@S .gc-btn-sm { height:30px; padding:0 10px; font-size:19px; }
@S .gc-btn:disabled, @S .gc-btn[aria-disabled="true"] { opacity:1; background:#2c2c2c; color:#a0a0a0; text-shadow:none; box-shadow:none; border-color:#000; }
@S .gc-icon-btn { border-radius:0; }
@S .gc-icon-btn:hover { background:rgba(255,255,255,.35); box-shadow:inset 0 0 0 2px currentColor; }

@S :is(.gc-input, .gc-select) { border-radius:0; background:#000; color:#fff; border:2px solid #a0a0a0; font-size:15px; }
@S :is(.gc-input, .gc-select):focus { outline:2px solid #000; outline-offset:0; border-color:#fff; }
@S .gc-input::placeholder { color:#a8a8a8; }
@S :is(.gc-input, .gc-select):disabled { background:#2c2c2c; color:#a0a0a0; }

@S .gc-avatar { border-radius:0; font-family:var(--gc-font-display); font-weight:400; font-size:calc(var(--gc-avatar-size) * .36); text-shadow:2px 2px 0 rgba(0,0,0,.45);
  background:var(--gc-tx-mc-wool) 0 0/16px 16px, var(--gc-avatar-bg, #616161); box-shadow:inset 2px 2px 0 rgba(255,255,255,.28), inset -2px -2px 0 rgba(0,0,0,.32), 0 0 0 2px #000; }
@S .gc-avatars .gc-avatar { box-shadow:inset 2px 2px 0 rgba(255,255,255,.28), inset -2px -2px 0 rgba(0,0,0,.32), 0 0 0 2px #000; }
@S .gc-avatars .gc-avatar + .gc-avatar { margin-left:-2px; }

@S .gc-list-item { border-top:2px solid #8b8b8b; box-shadow:inset 0 2px 0 #e4e4e4; }
@S .gc-list-item:first-child { box-shadow:none; }
@S .gc-amount { font:23px/1 var(--gc-font-pixel); }
@S .gc-list-sub { font-size:12.5px; }

@S .gc-empty > .gc-icon { width:44px; height:44px; padding:8px; ${MC_SLOT} }
@S .gc-empty-title { margin-top:6px; font-family:var(--gc-font-display); font-size:11px; font-weight:400; line-height:1.6; color:#3f3f3f; }
@S .gc-empty-text { color:#2f2f2f; }

@S .gc-tip::after { background:rgba(16,0,16,.95); color:#fff; border:2px solid #3c0f8a; border-radius:0; box-shadow:0 0 0 2px #100010; font:19px/1.1 var(--gc-font-pixel); padding:6px 9px; }
@S .gc-disclosure > summary { margin:3px; border-radius:0; font-family:var(--gc-font-display); font-size:11px; font-weight:400; line-height:1.6; }
@S .gc-disclosure > summary:hover { background:#d4d4d4; }
@S .gc-disclosure-body { color:#262626; }
@S .gc-steps .gc-step-icon { ${MC_SLOT} }
@S .gc-steps strong { font:21px/1.1 var(--gc-font-pixel); color:#1e1e1e; }
@S .gc-dot { width:10px; height:10px; border-radius:0; background:#80ff20; box-shadow:0 0 0 2px #000; }
@S .gc-sync.is-paused .gc-dot { background:#ffaa00; }

@S .gc-dialog { ${MC_PANEL} }
@S .gc-dialog::backdrop { background:rgba(16,16,16,.62); }
@S .gc-dialog-title { font-family:var(--gc-font-display); font-size:14px; line-height:1.5; color:#3f3f3f; }
@S .gc-skin-menu { --gc-text:#1e1e1e; --gc-hover:#8b8b8b; ${MC_PANEL} padding:8px; }
@S .gc-skin-item { border-radius:0; font:21px/1 var(--gc-font-pixel); }
@S .gc-skin-item:hover, @S .gc-skin-item:focus-visible { color:#fff; text-shadow:2px 2px 0 #3f3f3f; }
@S .gc-notice-eyebrow { font-family:var(--gc-font-display); font-size:10px; line-height:1.6; letter-spacing:0; text-transform:none; color:#1f4f15; }
@R .gc-notice-icon { ${MC_SLOT} }

/* Known pages */
@R .home-date { font:46px/1 var(--gc-font-pixel); letter-spacing:0; color:#24180e; text-shadow:2px 2px 0 rgba(255,255,255,.4); }
@R .home-hello .gc-meta { color:#24180e; }
@R .home-big { font:44px/1 var(--gc-font-pixel); }
@R .cart-banner { ${MC_PANEL} color:#1e1e1e; }
@R .set-icon { ${MC_SLOT} }
@R .set-icon > .gc-icon { filter:drop-shadow(1px 1px 0 #3f3f3f); }
@R .set-facts { border-top:2px solid #8b8b8b; }
@R .set-facts dt, @R .cart-facts dt { font:19px/1 var(--gc-font-pixel); color:#3d3d3d; }
@R .cart-price-sub { font:17px/1 var(--gc-font-pixel); color:#3d3d3d; }

/* Calendar */
@R .cal.cal { --cal-line:#8b8b8b; --cal-line-soft:rgba(55,55,55,.2); --cal-free-bg:rgba(128,212,42,.34); --cal-free-edge:#2f6b1f; --cal-free-text:#173a0c;
  --cal-ovl-2:rgba(0,0,0,.1); --cal-ovl-3:rgba(0,0,0,.2); --cal-ovl-4:rgba(0,0,0,.3); --cal-ovl-edge:#373737; --cal-now:#e01b1b; --cal-warn:#5a3d00; --cal-danger:#8f1111; }
@R .cal :is(.cal-main, .cal-panel) { ${MC_PANEL} }
@R .cal .cal-btn { font:21px/1 var(--gc-font-pixel); font-weight:400; ${MC_STONE_BTN} }
@R .cal .cal-btn.primary { background:#2f6e20; }
@R .cal .cal-btn.quiet { background:transparent; border-color:transparent; box-shadow:none; color:#1e1e1e; text-shadow:none; }
@R .cal .cal-btn:hover { border-color:#fff; color:#ffffa0; }
@R .cal .cal-btn.quiet:hover { background:rgba(255,255,255,.4); color:#000; border-color:transparent; }
@R .cal .cal-icon { border-radius:0; color:#24180e; font:30px/1 var(--gc-font-pixel); }
@R .cal .cal-icon:hover { background:rgba(255,255,255,.35); box-shadow:inset 0 0 0 2px #24180e; }
@R .cal .cal-chip { height:30px; border-radius:0; background:#c6c6c6; color:#1e1e1e; border:2px solid #000; font:20px/1 var(--gc-font-pixel); box-shadow:inset 2px 2px 0 #fff, inset -2px -2px 0 #8b8b8b; }
@R .cal .cal-chip::before { border-radius:0; background:#2f6e20; width:8px; height:8px; }
@R .cal .cal-notice { border-radius:0; border:2px solid #000; }
@R .cal .cal-range { font-family:var(--gc-font-display); font-size:14px; font-weight:400; line-height:1.5; color:#24180e; }
@R .cal .cal-panel h2 { font-family:var(--gc-font-display); font-size:11px; font-weight:400; line-height:1.6; color:#3f3f3f; }
@R .cal .cal-head-dow { font:18px/1 var(--gc-font-pixel); letter-spacing:0; }
@R .cal .cal-head-date { border-radius:0; font:26px/1 var(--gc-font-pixel); }
@R .cal .cal-head.today .cal-head-dow { color:#1f4f15; }
@R .cal .cal-head.today .cal-head-date { background:#2f6e20; color:#fff; box-shadow:0 0 0 2px #000, inset 2px 2px 0 rgba(255,255,255,.3); text-shadow:2px 2px 0 rgba(0,0,0,.4); }
@R .cal .cal-gutter span, @R .cal .cal-corner { font:16px/1 var(--gc-font-pixel); color:#3d3d3d; }
@R .cal :is(.cal-busy, .cal-free, .cal-best button, .cal-best-len, .cal-key i) { border-radius:0; }
@R .cal .cal-busy { background:color-mix(in srgb, var(--m-solid) 30%, #d8d8d8); }
@R .cal .cal-now::before { border-radius:0; }
@R .cal .cal-avatar { border-radius:0; color:#fff; font-family:var(--gc-font-display); font-size:10px; text-shadow:1px 1px 0 rgba(0,0,0,.5); box-shadow:0 0 0 2px #000, inset 2px 2px 0 rgba(255,255,255,.25); }
@R .cal .cal-best-day { font:21px/1 var(--gc-font-pixel); }
/* [calendar-detail] Day view strip and headers, all-day chips, "available" chips, popover */
@R .cal :is(.cal-strip-day, .cal-strip-num, .cal-house-badge, .cal-adchip, .cal-pop-swatch, .cal-range-btn, .cal-head-btn, .cal-key-member) { border-radius:0; }
@R .cal .cal-ev.cal-busy.is-free { border-radius:0; border:2px dashed color-mix(in srgb, var(--m-solid) 80%, #000); background:rgba(255,255,255,.45); }
@R .cal .cal-strip-day { font:16px/1 var(--gc-font-pixel); letter-spacing:0; color:#3d3d3d; }
@R .cal .cal-strip-num { font:22px/1 var(--gc-font-pixel); color:#24180e; }
@R .cal .cal-strip-day.is-today .cal-strip-num { color:#1f4f15; box-shadow:inset 0 0 0 2px #2f6e20; }
@R .cal .cal-strip-day[aria-pressed="true"] .cal-strip-num { background:#2f6e20; color:#fff; box-shadow:0 0 0 2px #000, inset 2px 2px 0 rgba(255,255,255,.3); text-shadow:2px 2px 0 rgba(0,0,0,.4); }
@R .cal .cal-who-name { font:20px/1 var(--gc-font-pixel); font-weight:400; color:#24180e; }
@R .cal .cal-pop-title { font-size:12px; line-height:1.6; }
@media (max-width: 640px) { @R .cal .cal-range { font-size:11px; } }

/* "Achievement get!" toast */
@S .gc-celebrate { top:calc(var(--gc-appbar-h) + 12px); right:12px; }
@S .gc-celebrate-box { display:flex; align-items:center; gap:12px; width:min(340px, calc(100vw - 24px)); padding:10px 14px 10px 10px; background:#212121; border:2px solid #000; box-shadow:inset 0 0 0 2px #555, 4px 4px 0 rgba(0,0,0,.35); animation:gc-mc-in .35s ease-out both; transition:transform .35s ease-in; }
@S .gc-celebrate-icon { display:block; width:40px; height:40px; flex:none; background:var(--gc-tx-mc-gem) center/36px 36px no-repeat, #8b8b8b; box-shadow:inset 2px 2px 0 #373737, inset -2px -2px 0 #fff; }
@S .gc-celebrate-title { font:10px/1.6 var(--gc-font-display); color:#ffff55; text-shadow:2px 2px 0 #3f3f15; }
@S .gc-celebrate-detail { margin-top:2px; font:21px/1.05 var(--gc-font-pixel); color:#fff; }
@S .gc-celebrate.is-leaving .gc-celebrate-box { transform:translateX(calc(100% + 24px)); }
@keyframes gc-mc-in { from { transform:translateX(calc(100% + 24px)); } to { transform:none; } }

@S :focus-visible { outline:3px solid #111; outline-offset:2px; }
@S :is(.gc-appbar, .gc-rail) :focus-visible { outline-color:#fff; }
@S .gc-skin-menu :focus-visible { outline-color:#111; }

@media (max-width: 760px) {
  @S .gc-rail { border-right:0; border-top:3px solid #1b120b; }
  @S .gc-nav-item { gap:3px; font-size:16px; }
  @S .gc-nav-pill { width:40px; height:30px; }
  @S .gc-appbar-sub { display:none; }
  @S .gc-appbar-title { font-size:11px; border-left:0; padding-left:0; }
  @S .gc-stat-label { font-size:17px; }
  @S .gc-stat-value { font-size:25px; }
  @S .gc-stat-sub { font-size:16px; }
  @R .home-date { font-size:36px; }
}
`);

// ── Red Dead–inspired: parchment, inked frames, leather, stamped labels ──
const RDR_PAPER = `background:var(--gc-tx-paper) 0 0/240px 240px, #f3e8cf;`;
const RDR_INKED = `border:1px solid transparent; border-image:var(--gc-tx-ink-frame) 10 / 10px / 0 round;`;
const RDR_CSS = scoped("rdr", `
@R { color-scheme:light;
  --gc-bg:#e8d8b3; --gc-surface:#f3e8cf; --gc-surface-2:#eadbb8; --gc-hover:#e6d3a8;
  --gc-border:#a58c66; --gc-border-strong:#3b2a1a;
  --gc-text:#2a1c10; --gc-text-2:#45311f; --gc-muted:#65503a;
  --gc-accent:#8b1c1c; --gc-accent-hover:#a32323; --gc-accent-soft:#efcdb8; --gc-on-accent:#fbf1dc; --gc-on-accent-soft:#5c1010;
  --gc-success:#2e5426; --gc-success-soft:#d3dfb3; --gc-warning:#6f4108; --gc-warning-soft:#f0d394; --gc-danger:#8b1c1c; --gc-danger-soft:#efc4b2;
  --gc-track:#dcc69a; --gc-focus:#8b1c1c; --gc-tooltip-bg:#2b1d12; --gc-tooltip-text:#f6ead0;
  --gc-font:"Libre Baskerville",Baskerville,Georgia,serif; --gc-font-display:"Rye","Rockwell Extra Bold",Georgia,serif;
  --gc-fs-xs:11.5px; --gc-fs-sm:12.5px; --gc-fs-md:13.5px; --gc-fs-lg:15.5px; --gc-fs-xl:22px; --gc-fs-2xl:28px;
  --gc-radius-sm:2px; --gc-radius-md:2px; --gc-radius-lg:2px; --gc-radius-pill:3px;
  scrollbar-color:#7a5f3f #e8d8b3; }
@R body { background:var(--gc-tx-paper) 0 0/240px 240px, #e8d8b3; }
@S body::before { content:""; position:fixed; inset:0; z-index:-1; pointer-events:none; background:radial-gradient(ellipse at 50% 45%, transparent 50%, rgba(110,66,24,.3) 100%); }
@S ::selection { background:#8b1c1c; color:#fbf1dc; }
@S :where(h1,h2,h3) { font-family:var(--gc-font-display); font-weight:400; }

@S .gc-appbar { --gc-text:#f6ead0; --gc-text-2:#eadbb8; --gc-muted:#dcc8a0; --gc-border:rgba(246,234,208,.4); --gc-hover:rgba(246,234,208,.12); --gc-focus:#f6ead0;
  background:linear-gradient(90deg, rgba(233,210,160,.5) 0 6px, transparent 6px 11px) left 0 bottom 7px/11px 1px repeat-x, var(--gc-tx-grain-x) 0 0/480px 120px, linear-gradient(180deg, #3d2816, #24160b);
  border-bottom:3px solid #120a04; box-shadow:0 4px 14px rgba(43,29,18,.35); color:#f6ead0; }
@S .gc-logo { border-radius:50%; background:#8b1c1c; color:#f6ead0; box-shadow:0 0 0 2px #24160b, 0 0 0 3px #d9b77a, inset 0 0 0 2px rgba(246,234,208,.35); }
@S .gc-brand-name { font-family:var(--gc-font-display); font-size:23px; letter-spacing:.03em; color:#f6ead0; text-shadow:0 2px 0 #120a04; }
@S .gc-appbar-title { font-family:var(--gc-font-display); font-weight:400; font-size:19px; color:#f6ead0; border-left:1px solid rgba(246,234,208,.3); }
@S .gc-appbar-sub { font-style:italic; font-size:13px; letter-spacing:.04em; color:#dcc8a0; }
@S .gc-appbar .gc-dot { background:#9fd38a; }

@S .gc-rail { background:linear-gradient(180deg, rgba(233,210,160,.45) 0 6px, transparent 6px 11px) right 7px top 0/1px 11px repeat-y, var(--gc-tx-grain-y) 0 0/120px 480px, linear-gradient(90deg, #2a1a0d, #3a2412); box-shadow:inset -3px 0 0 #120a04; }
@S .gc-nav-item { color:#e8d6ae; font:700 10px/1.2 var(--gc-font); letter-spacing:.1em; text-transform:uppercase; }
@S .gc-nav-pill { border-radius:3px; }
@S .gc-nav-item:hover .gc-nav-pill { background:rgba(246,234,208,.12); }
@S .gc-nav-item[aria-current="page"] { color:#fff6e2; }
@S .gc-nav-item[aria-current="page"] .gc-nav-pill { background:#8b1c1c; color:#fbf1dc; box-shadow:inset 0 0 0 1px #5e1010, inset 0 0 0 3px #8b1c1c, inset 0 0 0 4px rgba(246,234,208,.6), 0 2px 0 #120a04; }

@S :is(.gc-card, .gc-stat, .gc-disclosure) { ${RDR_PAPER} ${RDR_INKED} border-radius:0; box-shadow:3px 4px 0 rgba(59,42,26,.14); }
@S .gc-card-head { padding-bottom:8px; border-bottom:3px double rgba(59,42,26,.6); }
@S .gc-card-title { font-family:var(--gc-font-display); font-weight:400; font-size:19px; letter-spacing:.02em; color:#2a1c10; }
@S .gc-card-icon { background:transparent; border:1.5px solid #3b2a1a; color:#3b2a1a; }
@S .gc-section-title { display:flex; align-items:center; gap:10px; font-family:var(--gc-font-display); font-size:17px; font-weight:400; color:#2a1c10; }
@S .gc-section-title::before, @S .gc-section-title::after { content:""; width:26px; height:4px; border-top:1px solid #3b2a1a; border-bottom:1px solid #3b2a1a; }
@S .gc-meta { font-style:italic; }
@S .gc-stat-label { font:700 10px/1.2 var(--gc-font); letter-spacing:.12em; text-transform:uppercase; color:#45311f; }
@S .gc-stat-value { font-family:var(--gc-font-display); font-weight:400; font-size:24px; color:#2a1c10; }

@S .gc-track { height:8px; border-radius:0; background:#e8d6ad; box-shadow:0 0 0 1px #3b2a1a; }
@S .gc-fill { border-radius:0; background:repeating-linear-gradient(-45deg, #8b1c1c 0 3px, #a72b22 3px 6px); }
@S .gc-fill.is-over { background:repeating-linear-gradient(-45deg, #3b2a1a 0 3px, #5a4024 3px 6px); }

@S .gc-chip { height:22px; border-radius:2px; border:1.5px solid currentColor; background:transparent; font:700 10px/1 var(--gc-font); letter-spacing:.08em; text-transform:uppercase; -webkit-mask:var(--gc-tx-stamp) 0 0/120px 120px; mask:var(--gc-tx-stamp) 0 0/120px 120px; }
@S .gc-chip-neutral { color:#45311f; border-color:#45311f; }
@S .gc-chip-accent { color:#7a1515; background:rgba(139,28,28,.07); }
@S .gc-chip-success { background:rgba(46,84,38,.08); }
@S .gc-chip-warning { background:rgba(111,65,8,.08); }
@S .gc-chip-danger { background:rgba(139,28,28,.08); }
@S .gc-appbar .gc-chip-neutral { color:#f6ead0; border-color:#f6ead0; }
@S .gc-appbar .gc-chip-accent { color:#ffd9c9; border-color:#ffd9c9; background:rgba(139,28,28,.45); }

@S .gc-btn { height:38px; padding:0 18px; border-radius:2px; border:2px solid #5e1010; background:#8b1c1c; color:#fbf1dc; font:700 11.5px/1 var(--gc-font); letter-spacing:.14em; text-transform:uppercase;
  box-shadow:inset 0 0 0 2px #8b1c1c, inset 0 0 0 3px rgba(251,241,220,.55), 1px 2px 0 rgba(59,42,26,.25); transition:transform .12s ease, background-color .12s ease; }
@S .gc-btn:not(:disabled):hover { background:#a32323; box-shadow:inset 0 0 0 2px #a32323, inset 0 0 0 3px rgba(251,241,220,.6), 1px 2px 0 rgba(59,42,26,.25); transform:rotate(-1deg); }
@S .gc-btn-tonal { background:#e3cfa5; color:#2a1c10; border-color:#3b2a1a; box-shadow:inset 0 0 0 2px #e3cfa5, inset 0 0 0 3px rgba(59,42,26,.5); }
@S .gc-btn-tonal:not(:disabled):hover { background:#ecdcb9; filter:none; box-shadow:inset 0 0 0 2px #ecdcb9, inset 0 0 0 3px rgba(59,42,26,.5); }
@S .gc-btn-outline { background:transparent; color:#8b1c1c; border:3px double #8b1c1c; box-shadow:none; }
@S .gc-btn-outline:not(:disabled):hover { background:rgba(139,28,28,.07); box-shadow:none; }
@S .gc-btn-text { background:transparent; border-color:transparent; box-shadow:none; color:#8b1c1c; padding:0 8px; }
@S .gc-btn-text:not(:disabled):hover { background:transparent; box-shadow:none; transform:none; text-decoration:underline; text-underline-offset:3px; }
@S .gc-btn-sm { height:30px; padding:0 12px; font-size:10.5px; }
@S .gc-icon-btn:hover { background:rgba(59,42,26,.1); }
@S .gc-appbar .gc-icon-btn:hover { background:rgba(246,234,208,.14); }

@S :is(.gc-input, .gc-select) { border-radius:0; border:0; border-bottom:2px solid #3b2a1a; background:rgba(255,250,236,.6); color:#2a1c10; }
@S :is(.gc-input, .gc-select):focus { outline:2px solid #8b1c1c; outline-offset:2px; border-bottom-color:#8b1c1c; }
@S .gc-input::placeholder { color:#6f5a40; font-style:italic; }

@S .gc-avatar { font-family:var(--gc-font-display); font-weight:400; box-shadow:0 0 0 2px #f3e8cf, 0 0 0 3px #3b2a1a; filter:sepia(.45) saturate(.9); }
@S .gc-avatars .gc-avatar { box-shadow:0 0 0 2px #f3e8cf, 0 0 0 3px #3b2a1a; }
@S .gc-avatars .gc-avatar + .gc-avatar { margin-left:-3px; }

@S .gc-list-item { border-top:1px dashed rgba(59,42,26,.45); }
@S .gc-amount { font-weight:700; }

/* Wanted posters: .gc-list.gc-people */
@S .gc-people { display:grid; grid-template-columns:repeat(auto-fill, minmax(92px, 1fr)); gap:16px 10px; padding:8px 2px 6px; }
@S .gc-people > .gc-list-item { position:relative; flex-direction:column; justify-content:flex-start; gap:5px; min-width:0; padding:14px 6px 11px; text-align:center; ${RDR_INKED} background:var(--gc-tx-paper) 0 0/240px 240px, #efe0bb; box-shadow:2px 3px 0 rgba(59,42,26,.2); transform:rotate(-1.3deg); }
@S .gc-people > .gc-list-item:nth-child(even) { transform:rotate(1.1deg); }
@S .gc-people > .gc-list-item:first-child { border-top:1px solid transparent; }
@S .gc-people > .gc-list-item::before { content:"Wanted"; align-self:stretch; padding-bottom:5px; border-bottom:3px double rgba(59,42,26,.6); font:400 14px/1 var(--gc-font-display); letter-spacing:.06em; text-transform:uppercase; color:#2a1c10; }
@S .gc-people > .gc-list-item::after { content:""; position:absolute; top:5px; left:50%; width:7px; height:7px; margin-left:-3.5px; border-radius:50%; background:radial-gradient(circle at 35% 35%, #9a8a74, #3b2a1a); }
@S .gc-people .gc-avatar { --gc-avatar-size:48px !important; border-radius:4px; }
@S .gc-people .gc-list-main { flex:none; width:100%; }
@S .gc-people .gc-list-title { font-family:var(--gc-font-display); font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@S .gc-people .gc-list-sub { justify-content:center; }
@S .gc-people .gc-chip { max-width:100%; padding:0 5px; letter-spacing:.03em; }
@S .gc-people .gc-amount { text-align:center; font-size:14px; }
@S .gc-people .gc-amount::before { content:"Bounty"; display:block; font:700 9px/1.5 var(--gc-font); letter-spacing:.16em; text-transform:uppercase; color:#8b1c1c; }

@S .gc-empty > .gc-icon { color:#3b2a1a; }
@S .gc-empty-title { font-family:var(--gc-font-display); font-weight:400; font-size:19px; color:#2a1c10; }
@S .gc-empty-text { font-style:italic; color:#45311f; }
@S .gc-tip::after { border-radius:1px; border:1px solid #d9b77a; box-shadow:2px 3px 0 rgba(0,0,0,.25); font:italic 400 12.5px/1.45 var(--gc-font); }
@S .gc-disclosure > summary { margin:6px; padding:8px 14px; border-radius:0; font-family:var(--gc-font-display); font-weight:400; font-size:16px; }
@S .gc-steps .gc-step-icon { border-radius:50%; background:transparent; border:1.5px solid #3b2a1a; color:#3b2a1a; }
@S .gc-steps strong { font-weight:700; }
@S .gc-dot { background:#2e5426; }
@S .gc-sync.is-paused .gc-dot { background:#c27a1a; }

@S .gc-dialog { ${RDR_PAPER} ${RDR_INKED} box-shadow:0 20px 50px rgba(30,18,8,.45); }
@S .gc-dialog::backdrop { background:rgba(43,29,18,.55); }
@S .gc-dialog-title { font-family:var(--gc-font-display); font-weight:400; }
@S .gc-skin-menu { --gc-text:#2a1c10; --gc-text-2:#45311f; --gc-muted:#65503a; --gc-hover:#e6d3a8; --gc-border:#a58c66; ${RDR_PAPER} ${RDR_INKED} padding:8px; box-shadow:0 14px 34px rgba(30,18,8,.4); }
@S .gc-skin-menu :focus-visible { outline-color:#8b1c1c; }
@S .gc-notice-eyebrow { font:700 11px/1.3 var(--gc-font); letter-spacing:.22em; color:#8b1c1c; }
@R .gc-notice-icon { background:transparent; border:2px solid #3b2a1a; color:#3b2a1a; box-shadow:0 0 0 3px #f3e8cf, 0 0 0 4px #3b2a1a; }

/* Known pages */
@R .home-date { font-family:var(--gc-font-display); font-weight:400; letter-spacing:.01em; }
@R .home-big { font-family:var(--gc-font-display); }
@R .cart-banner { ${RDR_PAPER} ${RDR_INKED} color:#2a1c10; }
@R .set-icon { border-radius:50%; background:transparent; border:1.5px solid #3b2a1a; color:#3b2a1a; }
@R .set-facts { border-top:1px dashed rgba(59,42,26,.45); }

/* Calendar */
@R .cal.cal { --cal-line:rgba(59,42,26,.55); --cal-line-soft:rgba(59,42,26,.16);
  --cal-free-bg:repeating-linear-gradient(-45deg, rgba(46,84,38,.2) 0 5px, rgba(46,84,38,.07) 5px 10px); --cal-free-edge:#2e5426; --cal-free-text:#1f3d1a;
  --cal-ovl-2:rgba(59,42,26,.1); --cal-ovl-3:rgba(59,42,26,.2); --cal-ovl-4:rgba(59,42,26,.3); --cal-ovl-edge:#3b2a1a; --cal-now:#8b1c1c; --cal-warn:#6f4108; --cal-danger:#8b1c1c; }
@R .cal .cal-main { border:2px solid #3b2a1a; border-radius:0; outline:1px solid #3b2a1a; outline-offset:2px; }
@R .cal .cal-panel { ${RDR_PAPER} ${RDR_INKED} border-radius:0; box-shadow:3px 4px 0 rgba(59,42,26,.14); }
@R .cal .cal-btn { border-radius:2px; border:2px solid #3b2a1a; background:#e3cfa5; color:#2a1c10; font:700 11px/1 var(--gc-font); letter-spacing:.12em; text-transform:uppercase; box-shadow:inset 0 0 0 2px #e3cfa5, inset 0 0 0 3px rgba(59,42,26,.45); }
@R .cal .cal-btn.primary { background:#8b1c1c; color:#fbf1dc; border-color:#5e1010; box-shadow:inset 0 0 0 2px #8b1c1c, inset 0 0 0 3px rgba(251,241,220,.55); }
@R .cal .cal-btn.quiet { background:transparent; border-color:transparent; box-shadow:none; color:#8b1c1c; }
@R .cal .cal-btn:hover { transform:rotate(-1deg); }
@R .cal .cal-icon { color:#2a1c10; }
@R .cal .cal-icon:hover { background:rgba(59,42,26,.1); }
@R .cal .cal-chip { border-radius:2px; background:transparent; border:1.5px solid #8b1c1c; color:#8b1c1c; font:700 10.5px/1 var(--gc-font); letter-spacing:.12em; text-transform:uppercase; }
@R .cal .cal-notice { border-radius:0; }
@R .cal .cal-range { font-family:var(--gc-font-display); font-weight:400; font-size:22px; }
@media (max-width: 640px) { @R .cal .cal-range { font-size:17px; } } /* [calendar-detail] */
@R .cal .cal-panel h2 { font-family:var(--gc-font-display); font-weight:400; font-size:17px; padding-bottom:6px; border-bottom:3px double rgba(59,42,26,.55); }
@R .cal .cal-head-dow { font:700 10px/1 var(--gc-font); letter-spacing:.14em; }
@R .cal .cal-head-date { font-family:var(--gc-font-display); }
@R .cal .cal-head.today .cal-head-dow { color:#8b1c1c; }
@R .cal .cal-head.today .cal-head-date { background:transparent; color:#8b1c1c; box-shadow:0 0 0 2px #8b1c1c, 0 0 0 4px #f3e8cf, 0 0 0 5px #8b1c1c; }
@R .cal .cal-busy { border-radius:1px; background:color-mix(in srgb, var(--m-solid) 26%, #f3e8cf); }
@R .cal .cal-avatar { color:#fff; font-family:var(--gc-font-display); box-shadow:0 0 0 2px #f3e8cf, 0 0 0 3px #3b2a1a; filter:sepia(.45); }

/* "Job done" stamp */
@S .gc-celebrate { top:calc(var(--gc-appbar-h) + 16px); left:50%; transform:translateX(-50%); }
@S .gc-celebrate-box { display:grid; justify-items:center; gap:10px; min-width:min(300px, calc(100vw - 32px)); padding:18px 22px 14px; ${RDR_PAPER} ${RDR_INKED} box-shadow:0 14px 34px rgba(30,18,8,.35); animation:gc-rdr-in .3s ease-out both; }
@S .gc-celebrate-text { display:grid; justify-items:center; gap:10px; }
@S .gc-celebrate-title { padding:8px 16px 6px; border:4px double #8b1c1c; font:400 30px/1 var(--gc-font-display); letter-spacing:.08em; text-transform:uppercase; color:#8b1c1c; transform:rotate(-6deg); -webkit-mask:var(--gc-tx-stamp) 0 0/120px 120px; mask:var(--gc-tx-stamp) 0 0/120px 120px; animation:gc-rdr-stamp .42s cubic-bezier(.2,1.5,.4,1) .1s both; }
@S .gc-celebrate-detail { font:italic 14px/1.4 var(--gc-font); color:#2a1c10; }
@S .gc-celebrate.is-leaving { opacity:0; transition:opacity .35s ease; }
@keyframes gc-rdr-in { from { opacity:0; transform:translateY(-14px); } }
@keyframes gc-rdr-stamp { from { opacity:0; transform:rotate(-6deg) scale(1.9); } to { opacity:1; transform:rotate(-6deg) scale(1); } }

@S :focus-visible { outline:2px solid #8b1c1c; outline-offset:2px; }
@S :is(.gc-appbar, .gc-rail) :focus-visible { outline-color:#f6ead0; }

@media (max-width: 760px) {
  @S .gc-rail { background:linear-gradient(90deg, rgba(233,210,160,.45) 0 6px, transparent 6px 11px) left 0 top 6px/11px 1px repeat-x, var(--gc-tx-grain-x) 0 0/480px 120px, linear-gradient(180deg, #3a2412, #2a1a0d); box-shadow:inset 0 3px 0 #120a04; }
  @S .gc-nav-item { font-size:9px; letter-spacing:.05em; }
  @S .gc-appbar-sub { display:none; }
  @S .gc-appbar-title { font-size:17px; border-left:0; padding-left:0; }
  @S .gc-card-title { font-size:16.5px; }
  @S .gc-stat-label { gap:4px; font-size:9px; letter-spacing:.02em; }
  @S .gc-stat-label > .gc-icon { width:13px; height:13px; }
}
`);

// ── Cyberpunk 2077–inspired: neon HUD, angular cuts, electric yellow ──
const CP_INK = "#0a0a0a";
const CYBER_CSS = scoped("cyberpunk", `
@R { color-scheme:dark;
  --gc-bg:#07070b; --gc-surface:#0e0f15; --gc-surface-2:#14161e; --gc-hover:#1b1e29;
  --gc-border:#263040; --gc-border-strong:#3e4c63;
  --gc-text:#e9f3f4; --gc-text-2:#bfd0d4; --gc-muted:#8fa3aa;
  --gc-accent:#fcee0a; --gc-accent-hover:#fff66e; --gc-accent-soft:#2b2a08; --gc-on-accent:${CP_INK}; --gc-on-accent-soft:#fff27a;
  --gc-success:#35f2b8; --gc-success-soft:#0b2a24; --gc-warning:#ffb627; --gc-warning-soft:#2f2209; --gc-danger:#ff4f7e; --gc-danger-soft:#3a0d1d;
  --gc-track:#151924; --gc-focus:#00f0ff; --gc-tooltip-bg:#05060a; --gc-tooltip-text:#e9f3f4;
  --gc-font:"Chakra Petch","Barlow",system-ui,sans-serif; --gc-font-display:"Rajdhani","Barlow Condensed","Arial Narrow",sans-serif;
  --gc-fs-md:14.5px; --gc-fs-lg:16.5px;
  --gc-radius-sm:0; --gc-radius-md:0; --gc-radius-lg:0; --gc-radius-pill:0;
  scrollbar-color:#2c3a4a #07070b; }
@R body { background:linear-gradient(rgba(0,240,255,.045) 1px, transparent 1px) 0 0/28px 28px, linear-gradient(90deg, rgba(0,240,255,.045) 1px, transparent 1px) 0 0/28px 28px, #07070b; }
@S body::before { content:""; position:fixed; inset:0; z-index:-1; pointer-events:none;
  background:repeating-linear-gradient(180deg, rgba(255,255,255,.03) 0 1px, transparent 1px 3px), radial-gradient(ellipse 60% 50% at 95% 0%, rgba(255,42,109,.14), transparent 70%), radial-gradient(ellipse 50% 50% at 0% 100%, rgba(0,240,255,.1), transparent 70%); }
@S ::selection { background:#fcee0a; color:${CP_INK}; }
@S :where(h1,h2,h3) { font-family:var(--gc-font-display); font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
@S a { color:#00f0ff; }

@S .gc-appbar { background:rgba(9,10,15,.94); border-bottom:1px solid transparent; border-image:linear-gradient(90deg, #fcee0a 0 140px, rgba(0,240,255,.6) 140px, rgba(255,42,109,.55) 75%, transparent) 1; box-shadow:0 8px 24px rgba(0,0,0,.5); }
@S .gc-logo { border-radius:0; background:#fcee0a; color:${CP_INK}; clip-path:polygon(0 0,100% 0,100% 70%,70% 100%,0 100%); }
@S .gc-brand-name { font-family:var(--gc-font-display); font-weight:700; font-size:22px; letter-spacing:.14em; text-transform:uppercase; color:#fcee0a; text-shadow:2px 0 rgba(255,42,109,.55), -2px 0 rgba(0,240,255,.45); }
@S .gc-appbar-title { font-family:var(--gc-font-display); font-weight:600; font-size:17px; letter-spacing:.1em; text-transform:uppercase; color:#e9f3f4; border-left:2px solid rgba(0,240,255,.5); }
@S .gc-appbar-sub { font:500 11px/1 var(--gc-font); letter-spacing:.18em; text-transform:uppercase; color:#00f0ff; }
@S .gc-appbar-sub::after { content:"_"; animation:gc-cp-blink 1s steps(1) infinite; }
@keyframes gc-cp-blink { 50% { opacity:0; } }

@S .gc-rail { background:linear-gradient(180deg, rgba(14,15,21,.92), rgba(7,7,11,.92)); border-right:1px solid rgba(0,240,255,.28); box-shadow:1px 0 14px rgba(0,240,255,.08); }
@S .gc-nav-item { font:600 11.5px/1.1 var(--gc-font-display); letter-spacing:.12em; text-transform:uppercase; color:#9fb2b8; }
@S .gc-nav-pill { border-radius:0; clip-path:polygon(0 0,100% 0,100% 62%,84% 100%,0 100%); }
@S .gc-nav-item:hover { color:#00f0ff; }
@S .gc-nav-item:hover .gc-nav-pill { background:rgba(0,240,255,.12); }
@S .gc-nav-item[aria-current="page"] { color:#fcee0a; font-weight:700; }
@S .gc-nav-item[aria-current="page"] .gc-nav-pill { background:#fcee0a; color:${CP_INK}; }

@S :is(.gc-card, .gc-stat, .gc-disclosure) { background:transparent; border:1px solid transparent; border-radius:0; border-image:var(--gc-tx-cp-panel) 24 fill / 24px / 6px stretch; box-shadow:none; }
@S .gc-card-head { padding-bottom:8px; border-bottom:1px solid rgba(0,240,255,.18); }
@S .gc-card-title { font:700 17px/1.1 var(--gc-font-display); letter-spacing:.08em; text-transform:uppercase; color:#e9f3f4; }
@S .gc-card-title::before { content:""; display:inline-block; width:4px; height:.85em; margin-right:8px; vertical-align:-1px; background:#fcee0a; box-shadow:0 0 8px rgba(252,238,10,.7); }
@S .gc-card-icon { border-radius:0; background:rgba(0,240,255,.07); border:1px solid rgba(0,240,255,.45); color:#00f0ff; clip-path:polygon(0 0,100% 0,100% 70%,70% 100%,0 100%); }
@S .gc-card-icon + .gc-card-title::before { display:none; }
@S .gc-section-title { display:flex; align-items:center; gap:8px; font:700 13px/1 var(--gc-font-display); letter-spacing:.2em; text-transform:uppercase; color:#00f0ff; }
@S .gc-section-title::before { content:""; width:8px; height:8px; background:#fcee0a; clip-path:${CUT("3px")}; }
@S .gc-meta { font-family:var(--gc-font-display); font-weight:600; font-size:12.5px; letter-spacing:.08em; text-transform:uppercase; }
@S .gc-stat-label { font:600 12.5px/1 var(--gc-font-display); letter-spacing:.14em; text-transform:uppercase; color:#9fb2b8; }
@S .gc-stat-value { font:700 28px/1.1 var(--gc-font-display); color:#fcee0a; text-shadow:0 0 12px rgba(252,238,10,.35); }

@S .gc-track { height:8px; border-radius:0; background:rgba(0,240,255,.06); box-shadow:inset 0 0 0 1px rgba(0,240,255,.35); }
@S .gc-fill { border-radius:0; background:repeating-linear-gradient(90deg, #fcee0a 0 5px, transparent 5px 7px); filter:drop-shadow(0 0 4px rgba(252,238,10,.6)); }
@S .gc-fill.is-over { background:repeating-linear-gradient(90deg, #ff2a6d 0 5px, transparent 5px 7px); filter:drop-shadow(0 0 4px rgba(255,42,109,.6)); }

@S .gc-chip { height:22px; padding:0 10px 0 8px; border-radius:0; border:1px solid currentColor; font:700 12px/1 var(--gc-font-display); letter-spacing:.1em; text-transform:uppercase; clip-path:${CUT("6px")}; }
@S .gc-chip-neutral { color:#bfd0d4; border-color:rgba(191,208,212,.5); }
@S .gc-chip-accent { background:rgba(252,238,10,.1); color:#fcee0a; }
@S .gc-chip-success { background:rgba(53,242,184,.08); }
@S .gc-chip-warning { background:rgba(255,182,39,.08); }
@S .gc-chip-danger { background:rgba(255,79,126,.1); }

@S .gc-btn { --cp-c:10px; --cp-edge:#fcee0a; --cp-fill:#fcee0a; position:relative; isolation:isolate; height:38px; padding:0 20px; border:0; border-radius:0; background:transparent; color:${CP_INK}; font:700 15px/1 var(--gc-font-display); letter-spacing:.1em; text-transform:uppercase; transition:filter .15s ease; }
@S .gc-btn::before, @S .gc-btn::after { content:""; position:absolute; z-index:-1; }
@S .gc-btn::before { inset:0; background:var(--cp-edge); clip-path:polygon(0 0,100% 0,100% calc(100% - var(--cp-c)),calc(100% - var(--cp-c)) 100%,0 100%); }
@S .gc-btn::after { inset:1px; background:var(--cp-fill); clip-path:polygon(0 0,100% 0,100% calc(100% - var(--cp-c) + .5px),calc(100% - var(--cp-c) + .5px) 100%,0 100%); }
@S .gc-btn:not(:disabled):hover { background:transparent; --cp-edge:#fff36b; --cp-fill:#fff36b; filter:drop-shadow(0 0 8px rgba(252,238,10,.55)); animation:gc-cp-glitch .3s steps(2, end) 1; }
@S .gc-btn-tonal { --cp-edge:#fcee0a; --cp-fill:#17160a; color:#fcee0a; }
@S .gc-btn-tonal:not(:disabled):hover { --cp-edge:#fff36b; --cp-fill:#25230c; color:#fff36b; filter:drop-shadow(0 0 6px rgba(252,238,10,.4)); animation:none; }
@S .gc-btn-outline { --cp-edge:#00f0ff; --cp-fill:#0b1016; color:#00f0ff; }
@S .gc-btn-outline:not(:disabled):hover { --cp-edge:#00f0ff; --cp-fill:#0c1d24; color:#8af9ff; filter:drop-shadow(0 0 6px rgba(0,240,255,.45)); animation:none; }
@S .gc-btn-text { --cp-edge:transparent; --cp-fill:transparent; color:#00f0ff; padding:0 10px; }
@S .gc-btn-text:not(:disabled):hover { --cp-edge:transparent; --cp-fill:rgba(0,240,255,.1); color:#8af9ff; filter:none; animation:none; }
@S .gc-btn-sm { --cp-c:8px; height:30px; padding:0 14px; font-size:13.5px; }
@keyframes gc-cp-glitch {
  0% { transform:translate(0); text-shadow:-2px 0 #ff2a6d, 2px 0 #00f0ff; }
  25% { transform:translate(-2px, 1px); text-shadow:2px 0 #ff2a6d, -2px 0 #00f0ff; }
  50% { transform:translate(2px, -1px); text-shadow:-1px 0 #ff2a6d, 1px 0 #00f0ff; }
  75% { transform:translate(-1px, 0); text-shadow:1px 0 #ff2a6d, -1px 0 #00f0ff; }
  100% { transform:translate(0); text-shadow:none; } }
@S .gc-icon-btn { border-radius:0; color:#bfd0d4; }
@S .gc-icon-btn:hover { background:rgba(0,240,255,.12); color:#00f0ff; }

@S :is(.gc-input, .gc-select) { border-radius:0; background:#08090d; border:1px solid #2c3a4a; color:#e9f3f4; }
@S :is(.gc-input, .gc-select):focus { outline:1px solid #00f0ff; outline-offset:-1px; border-color:#00f0ff; box-shadow:0 0 12px rgba(0,240,255,.3); }
@S .gc-input::placeholder { color:#70838b; }

@S .gc-avatar { border-radius:0; clip-path:polygon(22% 0,100% 0,100% 78%,78% 100%,0 100%,0 22%); font-family:var(--gc-font-display); font-weight:700; font-size:calc(var(--gc-avatar-size) * .5); }
@S .gc-avatars .gc-avatar { box-shadow:none; }
@S .gc-avatars .gc-avatar + .gc-avatar { margin-left:-3px; }

@S .gc-list-item { border-top:1px solid rgba(143,163,170,.16); }
@S .gc-amount { font:600 16.5px/1 var(--gc-font-display); letter-spacing:.04em; color:#e9f3f4; }

@S .gc-empty > .gc-icon { color:#00f0ff; filter:drop-shadow(0 0 6px rgba(0,240,255,.6)); }
@S .gc-empty-title { font:700 17px/1.1 var(--gc-font-display); letter-spacing:.12em; text-transform:uppercase; color:#e9f3f4; }
@S .gc-empty-text { color:#9fb2b8; }
@S .gc-tip::after { border-radius:0; border:1px solid rgba(0,240,255,.6); box-shadow:0 0 14px rgba(0,240,255,.25); }
@S .gc-disclosure > summary { margin:3px; border-radius:0; font:700 15px/1.2 var(--gc-font-display); letter-spacing:.1em; text-transform:uppercase; }
@S .gc-disclosure > summary:hover { background:rgba(0,240,255,.06); }
@S .gc-steps .gc-step-icon { border-radius:0; background:rgba(0,240,255,.07); border-color:rgba(0,240,255,.45); color:#00f0ff; clip-path:polygon(0 0,100% 0,100% 70%,70% 100%,0 100%); }
@S .gc-steps strong { font:700 15px/1.2 var(--gc-font-display); letter-spacing:.06em; text-transform:uppercase; }
@S .gc-dot { border-radius:0; background:#35f2b8; box-shadow:0 0 8px #35f2b8; }
@S .gc-sync.is-paused .gc-dot { background:#ffb627; box-shadow:0 0 8px #ffb627; }

@S .gc-dialog { background:transparent; border:1px solid transparent; border-radius:0; border-image:var(--gc-tx-cp-panel-hot) 24 fill / 24px / 6px stretch; box-shadow:none; }
@S .gc-dialog::backdrop { background:rgba(0,0,0,.72); }
@S .gc-dialog-title { font-family:var(--gc-font-display); font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
@S .gc-skin-menu { background:#0b0c11; border:1px solid rgba(0,240,255,.5); box-shadow:0 0 22px rgba(0,240,255,.16); clip-path:${CUT("12px")}; }
@S .gc-skin-item { border-radius:0; font:600 15px/1 var(--gc-font-display); letter-spacing:.08em; text-transform:uppercase; }
@S .gc-skin-item:hover, @S .gc-skin-item:focus-visible { background:rgba(252,238,10,.12); color:#fcee0a; outline:none; }
@S .gc-notice-eyebrow { font:600 12px/1.2 var(--gc-font-display); letter-spacing:.22em; color:#00f0ff; }
@R .gc-notice-icon { border-radius:0; background:rgba(0,240,255,.08); color:#00f0ff; clip-path:polygon(0 0,100% 0,100% 70%,70% 100%,0 100%); }

/* Known pages */
@R .home-date { font-family:var(--gc-font-display); font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
@R .home-big { font-family:var(--gc-font-display); font-weight:700; color:#fcee0a; text-shadow:0 0 12px rgba(252,238,10,.35); }
@R .cart-banner { background:rgba(0,240,255,.05); border-color:rgba(0,240,255,.35); }
@R .set-icon { border-radius:0; background:rgba(0,240,255,.07); border-color:rgba(0,240,255,.45); color:#00f0ff; clip-path:polygon(0 0,100% 0,100% 72%,72% 100%,0 100%); }
@R .set-facts { border-top-color:rgba(0,240,255,.18); }

/* Calendar */
@R .cal.cal { --cal-line:rgba(0,240,255,.25); --cal-line-soft:rgba(0,240,255,.08);
  --cal-free-bg:repeating-linear-gradient(-45deg, rgba(53,242,184,.17) 0 4px, rgba(53,242,184,.05) 4px 8px); --cal-free-edge:#35f2b8; --cal-free-text:#7dffd6;
  --cal-ovl-2:rgba(255,42,109,.08); --cal-ovl-3:rgba(255,42,109,.15); --cal-ovl-4:rgba(255,42,109,.22); --cal-ovl-edge:#ff2a6d; --cal-now:#ff2a6d; --cal-warn:#ffb627; --cal-danger:#ff4f7e; }
@R .cal .cal-main { border:1px solid rgba(0,240,255,.4); border-radius:0; box-shadow:0 0 18px rgba(0,240,255,.08); }
@R .cal .cal-panel { background:transparent; border:1px solid transparent; border-radius:0; border-image:var(--gc-tx-cp-panel) 24 fill / 24px / 6px stretch; }
@R .cal .cal-btn { border-radius:0; border:1px solid #fcee0a; background:#17160a; color:#fcee0a; font:700 14px/1 var(--gc-font-display); letter-spacing:.1em; text-transform:uppercase; clip-path:${CUT("8px")}; }
@R .cal .cal-btn:hover { background:#25230c; }
@R .cal .cal-btn:focus-visible { outline:2px solid #00f0ff; outline-offset:-5px; }
@R .cal .cal-btn.primary { background:#fcee0a; color:${CP_INK}; }
@R .cal .cal-btn.quiet { background:transparent; border-color:transparent; color:#00f0ff; }
@R .cal .cal-icon { border-radius:0; color:#00f0ff; }
@R .cal .cal-icon:hover { background:rgba(0,240,255,.12); }
@R .cal .cal-chip { border-radius:0; background:rgba(252,238,10,.1); color:#fcee0a; border:1px solid rgba(252,238,10,.6); font:700 12.5px/1 var(--gc-font-display); letter-spacing:.1em; text-transform:uppercase; clip-path:${CUT("6px")}; }
@R .cal .cal-chip::before { border-radius:0; }
@R .cal .cal-notice { border-radius:0; }
@R .cal .cal-range { font:700 22px/1 var(--gc-font-display); letter-spacing:.06em; text-transform:uppercase; }
@R .cal .cal-panel h2 { font:700 14px/1.2 var(--gc-font-display); letter-spacing:.14em; text-transform:uppercase; color:#00f0ff; }
@R .cal .cal-head-dow { font-family:var(--gc-font-display); font-weight:600; letter-spacing:.14em; }
@R .cal .cal-head-date { border-radius:0; font-family:var(--gc-font-display); font-weight:600; }
@R .cal .cal-head.today .cal-head-dow { color:#fcee0a; }
@R .cal .cal-head.today .cal-head-date { background:#fcee0a; color:${CP_INK}; clip-path:polygon(0 0,100% 0,100% 70%,70% 100%,0 100%); }
@R .cal :is(.cal-busy, .cal-free, .cal-best button, .cal-best-len, .cal-key i) { border-radius:0; }
@R .cal .cal-busy { background:color-mix(in srgb, var(--m-solid) 32%, #0e0f15); color:#e9f3f4; }
@R .cal .cal-now { box-shadow:0 0 8px #ff2a6d; }
@R .cal .cal-now::before { border-radius:0; transform:rotate(45deg); }
@R .cal .cal-avatar { border-radius:0; color:#fff; font-family:var(--gc-font-display); clip-path:polygon(22% 0,100% 0,100% 78%,78% 100%,0 100%,0 22%); }
@R .cal .cal-best-day { font:600 15px/1.1 var(--gc-font-display); letter-spacing:.04em; }
/* [calendar-detail] Day view strip and headers, all-day chips, "available" chips, popover */
@R .cal :is(.cal-strip-day, .cal-strip-num, .cal-house-badge, .cal-adchip, .cal-pop-swatch, .cal-range-btn, .cal-head-btn, .cal-key-member) { border-radius:0; }
@R .cal .cal-ev.cal-busy.is-free { border-radius:0; border-color:color-mix(in srgb, var(--m-solid) 85%, #fff); background:rgba(14,15,21,.7); color:#e9f3f4; }
@R .cal .cal-strip-day { font-family:var(--gc-font-display); font-weight:600; letter-spacing:.14em; }
@R .cal .cal-strip-num { font-family:var(--gc-font-display); font-weight:600; }
@R .cal .cal-strip-day.is-today { color:#fcee0a; }
@R .cal .cal-strip-day.is-today .cal-strip-num { color:#fcee0a; box-shadow:inset 0 0 0 1.5px #fcee0a; }
@R .cal .cal-strip-day[aria-pressed="true"] .cal-strip-num { background:#fcee0a; color:${CP_INK}; box-shadow:none; clip-path:polygon(0 0,100% 0,100% 70%,70% 100%,0 100%); }
@R .cal .cal-who-name { font-family:var(--gc-font-display); letter-spacing:.06em; text-transform:uppercase; }
@R .cal .cal-house-badge { background:rgba(0,240,255,.1); color:#00f0ff; clip-path:polygon(22% 0,100% 0,100% 78%,78% 100%,0 100%,0 22%); }
@R .cal .cal-pop-title { letter-spacing:.04em; }
@R .cal .cal-pop.cal-panel { background-color:#0e0f15; }
@media (max-width: 640px) { @R .cal .cal-range { font-size:17px; } }

/* "Gig complete" HUD banner */
@S .gc-celebrate { top:calc(var(--gc-appbar-h) + 14px); left:50%; transform:translateX(-50%); }
@S .gc-celebrate-box { display:grid; justify-items:center; min-width:min(320px, calc(100vw - 32px)); animation:gc-cp-in .5s linear both; }
@S .gc-celebrate-text { display:grid; justify-items:center; }
@S .gc-celebrate-title { padding:10px 28px 8px; background:#fcee0a; color:${CP_INK}; font:700 clamp(24px, 6vw, 32px)/1 var(--gc-font-display); letter-spacing:.22em; text-transform:uppercase; clip-path:${CUT("12px")}; text-shadow:2px 0 rgba(255,42,109,.6), -2px 0 rgba(0,240,255,.6); }
@S .gc-celebrate-detail { margin-top:6px; padding:6px 14px; background:rgba(7,7,11,.94); border:1px solid rgba(0,240,255,.5); color:#00f0ff; font:600 13px/1.2 var(--gc-font-display); letter-spacing:.14em; text-transform:uppercase; }
@S .gc-celebrate.is-leaving { opacity:0; transition:opacity .3s steps(3, end); }
@keyframes gc-cp-in { 0% { opacity:0; transform:translateX(-8px); } 20% { opacity:1; transform:translateX(5px); } 30% { opacity:.3; } 45% { opacity:1; transform:none; } 60% { opacity:.6; } 70%, 100% { opacity:1; } }

@S :focus-visible { outline:2px solid #00f0ff; outline-offset:2px; }

@media (max-width: 760px) {
  @S .gc-rail { border-right:0; border-top:1px solid rgba(0,240,255,.35); box-shadow:0 -1px 14px rgba(0,240,255,.08); }
  @S .gc-nav-item { font-size:10.5px; letter-spacing:.06em; }
  @S .gc-stat-label { letter-spacing:.06em; }
  @S .gc-appbar-sub { display:none; }
  @S .gc-appbar-title { border-left:0; padding-left:0; }
}
`);

/** All skin CSS (~100 KB). Served once as a cached stylesheet; renderPage() links it after the base CSS and before page CSS. */
export const SKIN_CSS = SHARED_CSS + ELDEN_CSS + MINECRAFT_CSS + RDR_CSS + CYBER_CSS;

const SKIN_CSS_VERSION = createHash("sha256").update(SKIN_CSS).digest("hex").slice(0, 12);
const SKIN_CSS_PATH = "/ui/skins.css";

/** Render-blocking <link> to the versioned skin stylesheet (no flash; cached for a year per version). */
export function skinStylesheet(): string {
  return `<link rel="stylesheet" href="${SKIN_CSS_PATH}?v=${SKIN_CSS_VERSION}" />`;
}

registerRoute((request, response, url) => {
  if (request.method !== "GET" || url.pathname !== SKIN_CSS_PATH) return false;
  const current = url.searchParams.get("v") === SKIN_CSS_VERSION;
  response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": current ? "public, max-age=31536000, immutable" : "no-cache" });
  response.end(SKIN_CSS);
  return true;
});
