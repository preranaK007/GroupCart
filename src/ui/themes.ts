/**
 * GroupCart skins: Classic (the default Google-Workspace look) plus four
 * game-inspired reskins. Everything here is original CSS/SVG; no game logos,
 * artwork, textures, or fonts. Theme names appear only as picker labels.
 *
 * How a skin is applied
 *   <html data-skin="classic|minecraft|cyberpunk"> is set before
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
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { registerRoute } from "../platform.js";

// ---------------------------------------------------------------------------
// Skin registry
// ---------------------------------------------------------------------------

export type SkinId = "classic" | "minecraft" | "cyberpunk";

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
  { id: "minecraft", name: "Minecraft", blurb: "Blocks, slots, and XP", scheme: "light", fonts: `${GOOGLE_FONTS}family=Press+Start+2P&family=VT323&display=swap` },
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
  "nav.home": { classic: "Home", minecraft: "Spawn", cyberpunk: "Crib" },
  "nav.groceries": { classic: "Kitchen", minecraft: "Furnace", cyberpunk: "Rations" },
  "nav.chores": { classic: "Chores", minecraft: "Quests", cyberpunk: "Gigs" },
  "nav.bills": { classic: "Money", minecraft: "Emeralds", cyberpunk: "Eddies" },
  "nav.more": { classic: "More", minecraft: "More", cyberpunk: "More" },
  "nav.calendar": { classic: "Calendar", minecraft: "Clock", cyberpunk: "Schedule" },
  "nav.settings": { classic: "Settings", minecraft: "Options", cyberpunk: "Cyberdeck" },
  "nav.chat": { classic: "Chat", minecraft: "Chat", cyberpunk: "Holocall" },
  "nav.lists": { classic: "Lists", minecraft: "Chests", cyberpunk: "Shards" },
  "nav.events": { classic: "Events", minecraft: "Raids", cyberpunk: "Ops" },
  "nav.people": { classic: "People", minecraft: "Players", cyberpunk: "Crew" },
  "nav.profiles": { classic: "Profiles", minecraft: "Players", cyberpunk: "Crew" },
  "appbar.sub": {
    classic: "",
    minecraft: ["Now with chores!", "Split it fairly!", "Don't forget the eggs!", "Shared carts!", "Also try dishes!", "Roommate-approved!", "Contains bread!", "Respawn at the fridge!", "Bring snacks!"],
    cyberpunk: "Link established",
  },

  // Empty states: emptyState({ flavor: "empty.chores" }) uses empty.chores.title / .text
  "empty.chores.title": { classic: "Nothing due", minecraft: "No quests", cyberpunk: "No gigs" },
  "empty.chores.text": { classic: "Chores will show up here.", minecraft: "Go punch some trees.", cyberpunk: "Gig board's empty. Go touch grass, choom." },
  "empty.events.title": { classic: "No events", minecraft: "Nothing scheduled", cyberpunk: "No ops" },
  "empty.events.text": { classic: "Household events will show up here.", minecraft: "Sleep through the night.", cyberpunk: "Calendar feed is clean." },
  "empty.bills.title": { classic: "No bills yet", minecraft: "No trades yet", cyberpunk: "No eddies owed" },
  "empty.bills.text": { classic: "Bill splits will show up here.", minecraft: "No emeralds changing hands.", cyberpunk: "Ledger's clean. Nobody flatlined." },
  "empty.cart.title": { classic: "Cart is empty", minecraft: "Inventory empty", cyberpunk: "No rations queued" },
  "empty.chat.title": { classic: "No messages", minecraft: "Chat is quiet", cyberpunk: "No incoming holocalls" },
  "soon.chores.title": { classic: "Chores are coming", minecraft: "Quests coming soon", cyberpunk: "Gigs incoming" },
  "soon.bills.title": { classic: "Bills are coming", minecraft: "Trading coming soon", cyberpunk: "Eddies incoming" },
  "soon.calendar.title": { classic: "Calendar is coming", minecraft: "Clock coming soon", cyberpunk: "Schedule incoming" },

  // Card and section titles: card({ flavor: "home.people" }) uses .title / .meta
  "home.groceries.title": { classic: "Groceries", minecraft: "Inventory", cyberpunk: "Rations" },
  "home.people.title": { classic: "People", minecraft: "Players", cyberpunk: "Crew" },
  "home.people.meta": { classic: "Grocery shares", minecraft: "Emerald shares", cyberpunk: "Eddies owed" },
  "home.chores.title": { classic: "Chores due", minecraft: "Quests", cyberpunk: "Gigs" },
  "home.upcoming.title": { classic: "Upcoming", minecraft: "Coming up", cyberpunk: "Upcoming ops" },
  "home.balances.title": { classic: "Balances", minecraft: "Emeralds", cyberpunk: "Eddies" },
  "cart.items.title": { classic: "Items", minecraft: "Items", cyberpunk: "Loadout" },
  "cart.split.title": { classic: "Split", minecraft: "Trades", cyberpunk: "Eddies" },
  "settings.appearance.title": { classic: "Appearance", minecraft: "Resource Packs", cyberpunk: "Chrome" },
  "settings.connections": { classic: "Connections", minecraft: "Mods", cyberpunk: "Netlinks" },

  // Notices (renderNotice eyebrow, by tone) and the completion flourish.
  "notice.success": { classic: "", minecraft: "Achievement get!", cyberpunk: "Upload complete" },
  "notice.warning": { classic: "", minecraft: "Uh oh!", cyberpunk: "Warning // ICE detected" },
  "notice.danger": { classic: "", minecraft: "Something exploded", cyberpunk: "Flatlined" },
  "notice.neutral": { classic: "", minecraft: "Server message", cyberpunk: "Incoming message" },
  "notice.accent": { classic: "", minecraft: "Server message", cyberpunk: "Incoming message" },
  "celebrate.title": { classic: "", minecraft: "Achievement get!", cyberpunk: "Gig complete" },
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
    celebrateTimer = setTimeout(dismiss, reduceMotion && reduceMotion.matches ? 1800 : 3600);
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
  --gc-tx-stamp:${STAMP_MASK};
  --gc-tx-cp-panel:${CP_PANEL};
  --gc-tx-cp-panel-hot:${CP_PANEL_HOT};
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
.gc-sw-minecraft { background:linear-gradient(#6aad3f 0 6px, transparent 6px), var(--gc-tx-mc-dirt) 0 0/16px 16px, #866043; border-radius:0; box-shadow:inset 0 0 0 1px #1b120b; }
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
.gc-pv-minecraft { background:var(--gc-tx-mc-planks) 0 0/32px 32px, #d3b07c; border-radius:0; }
.gc-pv-minecraft .gc-pv-bar { height:18px; background:var(--gc-tx-mc-grass) 0 0/32px 32px repeat-x, #866043; }
.gc-pv-minecraft .gc-pv-card { background:#c6c6c6; border:2px solid #000; box-shadow:inset 2px 2px 0 #fff, inset -2px -2px 0 #555; }
.gc-pv-minecraft .gc-pv-title { font-family:"Press Start 2P",ui-monospace,monospace; font-size:11px; color:#3f3f3f; font-weight:400; }
.gc-pv-minecraft .gc-pv-line { background:#8b8b8b; }
.gc-pv-minecraft .gc-pv-btn { height:13px; background:var(--gc-tx-mc-stone) 0 0/16px 16px, #666; border:2px solid #000; }
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
  padding-top:calc(10px + env(safe-area-inset-top)); background:var(--gc-tx-mc-grass) 0 0/64px 64px repeat-x, #866043; border-bottom:3px solid #24180e; color:#fff; }
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
export const SKIN_CSS = SHARED_CSS + MINECRAFT_CSS + CYBER_CSS;

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
