/**
 * GroupCart UI shell: one look for every page of the household app.
 *
 * Look: Google Workspace style. Flat surfaces, hairline borders, one restrained
 * accent (blue), small rounded chips, inline SVG icons, short labels, no
 * gradients, no heavy shadows. Light + dark via prefers-color-scheme. Phone
 * width (<=760px) turns the left rail into a bottom bar: the first five sections
 * plus "More" (a sheet with the rest, People and Settings).
 *
 * Pages can be installed to a phone's home screen (./pwa.ts adds the <head> tags).
 * With viewport-fit=cover, anything fixed to the bottom on phones adds
 * env(safe-area-inset-bottom) to its offset, as the bottom bar does.
 *
 * ── Building a page ─────────────────────────────────────────────────────────
 *   import { renderPage, card, listRow, list, chip, button } from "./ui/shell.js";
 *   const html = renderPage({
 *     title: "Chores",            // app-bar title + <title>
 *     active: "chores",           // NavKey to highlight
 *     body: card({ title: "This week", body: list([listRow({ title: "Trash" })]) }),
 *     styles: ".my-page { ... }", // optional page CSS (prefix classes per page)
 *     script: "...",             // optional inline JS; runs after window.GC exists
 *     actions: chip("Live", "accent"), // optional app-bar right side (HTML)
 *   });
 *   Add the route in src/dashboard.ts:  if (GET && path === "/chores") return sendHtml(response, html);
 *
 * ── Server helpers (all return HTML strings) ────────────────────────────────
 *   Text params are escaped; params documented as "HTML" are inserted as-is.
 *   icon(name, {size,label})            inline SVG; IconName lists what exists
 *   chip(label, tone, icon?)            status chip; tone: neutral|accent|success|warning|danger
 *   button({label, variant, size, icon, href, id, disabled, attrs})
 *                                       variant: primary|tonal|outline|text; size: md|sm
 *   avatarHtml(member, {allMemberIds,size}) / avatarStack(members, {allMemberIds,size})
 *                                       shows the member's profile photo or emoji when set
 *                                       (src/profiles.ts installs the directory), else the initial
 *   memberColor(memberId, allMemberIds?) → {solid, soft, on}: same color for a
 *                                       member everywhere (cart, chores, calendar, bills)
 *   card({title, meta, tip, actions, body, id, className})   surface with a header
 *   sectionHeader(title, {meta, actions})                    heading above cards
 *   list(rows) + listRow({leading, title, sub, trailing})    divided rows
 *   emptyState({icon, title, text, action})                  calm empty placeholder
 *   infoTip(text)                       "i" button with a tooltip (put prose here)
 *   dialog({id, title, body, actions})  modal on desktop, bottom sheet on phones;
 *                                       open with data-gc-open="id" or GC.openDialog(id),
 *                                       close with data-gc-close or GC.closeDialog(id)
 *   escapeHtml(value)
 *
 * ── Browser helpers (window.GC, for client-rendered pages) ──────────────────
 *   GC.esc, GC.dollars(cents), GC.memberColor(id, allIds), GC.avatar(member, allIds, size)
 *   (member may carry avatarUrl / avatarEmoji; otherwise window.GC_AVATARS is used),
 *   GC.icon(name), GC.chip(label, tone, icon), GC.listRow({leading,title,sub,trailing}),
 *   GC.time(date), GC.openDialog(id), GC.closeDialog(id)
 *
 * ── Layout classes ──────────────────────────────────────────────────────────
 *   gc-grid (main + 360px side column), gc-cards (auto-fit card grid), gc-stack,
 *   gc-row, gc-spacer, gc-stats/gc-stat, gc-track/gc-fill (progress), gc-muted,
 *   gc-meta, gc-hide-sm (hidden on phones), gc-disclosure (collapsible <details>).
 *   Tokens: --gc-bg, --gc-surface, --gc-surface-2, --gc-hover, --gc-border,
 *   --gc-text, --gc-text-2, --gc-muted, --gc-accent(-soft), --gc-success(-soft),
 *   --gc-warning(-soft), --gc-danger(-soft), --gc-space-1..6, --gc-radius-sm|md|lg|pill,
 *   --gc-fs-xs|sm|md|lg|xl|2xl, --gc-font, --gc-font-display (headings).
 *
 * ── Themes / skins (src/ui/themes.ts) ───────────────────────────────────────
 *   <html data-skin="classic|elden|minecraft|rdr|cyberpunk">; users pick one in
 *   Settings > Appearance or the app-bar palette menu. Every skin restyles the
 *   tokens and the .gc-* components above, so a page themes itself for free if
 *   it: uses only --gc-* tokens for color/radius/font (no hex colors, no fixed
 *   radii), builds with the helpers/classes above, and leaves h1–h3 font-family
 *   alone (skins set a display font on headings).
 *   Opt-ins:
 *     data-flavor="nav.chores"            on a leaf text element: skin-specific wording
 *     card({flavor}) / emptyState({flavor}) / sectionHeader(t, {flavor})
 *                                         use keys "<flavor>.title|.meta|.text" / "<flavor>"
 *     GC.t(key, fallback)                 same lookup in client code; GC.skin(), GC.setSkin(id)
 *     GC.celebrate("Trash taken out")     call after marking something done (no-op in Classic)
 *     <ul class="gc-list gc-people">      people rows; wanted posters in the Red Dead skin
 *     document "gc:skinchange" event      re-render anything drawn with canvas/inline colors
 *   Add flavor keys with registerFlavor({...}) from ./themes.js (see FLAVOR there).
 */

// --- Profiles & chat: account menu in the app bar (Viewing as / signed in, profile, sign out) ---
import { ACCOUNT_MENU_CSS, ACCOUNT_MENU_SCRIPT } from "./accountMenu.js";
// --- end profiles & chat ---
// [themes] skins and flavor text live in ./themes.ts
import { appearanceCard, currentSkin, flavored, skinClientScript, skinHead, skinScheme, skinStylesheet, skinSwitcher } from "./themes.js";
export { appearanceCard };
// [/themes]
import { PWA_HEAD } from "./pwa.js"; // home-screen install: manifest, icons, service worker

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

// --- Profiles & chat: "chat" nav item; "people" pages highlight no nav item ---
export type NavKey = "home" | "chat" | "groceries" | "chores" | "bills" | "calendar" | "settings" | "people" | HouseNavKey;
// --- end profiles & chat ---
// --- House: nav key (src/ui/housePage.ts registers its "nav.house" flavor) ---
type HouseNavKey = "house";
// --- end House ---

export type NavItem = { key: NavKey; href: string; label: string; icon: IconName };

/** Main sections: the desktop rail, in order. People and Settings live in the account (avatar) menu. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", href: "/", label: "Home", icon: "home" },
  { key: "chat", href: "/chat", label: "Chat", icon: "message" }, // profiles & chat
  { key: "groceries", href: "/groceries", label: "Kitchen", icon: "cart" },
  { key: "chores", href: "/chores", label: "Chores", icon: "chores" },
  { key: "bills", href: "/bills", label: "Money", icon: "receipt" },
  { key: "calendar", href: "/calendar", label: "Calendar", icon: "calendar" },
  { key: "house", href: "/house", label: "House", icon: "door" }, // House
];

/** Phones show this many NAV_ITEMS in the bottom bar; the rest go in the "More" sheet. */
const PHONE_BAR_ITEMS = 5;

/** Extra destinations in the phone "More" sheet (on desktop they are in the account menu). */
const MORE_ITEMS: readonly NavItem[] = [
  { key: "people", href: "/people", label: "People", icon: "users" },
  { key: "settings", href: "/settings", label: "Settings", icon: "settings" },
];

// ---------------------------------------------------------------------------
// Icons (inline SVG, 24px grid, stroke = currentColor)
// ---------------------------------------------------------------------------

const ICON_PATHS = {
  home: '<path d="M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  chores: '<path d="M11 6.5h9M11 12h9M11 17.5h9"/><path d="M3.8 6.6l1.5 1.5 2.6-3M3.8 12.1l1.5 1.5 2.6-3"/><circle cx="5.6" cy="17.5" r="1.4"/>',
  spark: '<path d="M12 3.5c.6 4.3 2.7 6.9 8.5 8.5-5.8 1.6-7.9 4.2-8.5 8.5-.6-4.3-2.7-6.9-8.5-8.5 5.8-1.6 7.9-4.2 8.5-8.5z"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevronRight: '<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.1L21 7.5H6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.2l2.6 2.6 4.8-5.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.2-2.5 3.7"/><path d="M12 16.8h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/>',
  store: '<path d="M4.5 10.5V20h15v-9.5"/><path d="M3.5 9l1.6-4.5h13.8L20.5 9a2.6 2.6 0 0 1-5.2 0 2.6 2.6 0 0 1-5.2 0 2.6 2.6 0 0 1-5.2 0z"/><path d="M10 20v-5h4v5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  message: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><circle cx="16.5" cy="9" r="2.6"/><path d="M16.5 14.2c2.2 0 3.7 1.5 4.2 4"/>',
  wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2"/><path d="M3.5 9.5h17"/><path d="M15.5 14h2"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4"/><path d="M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5v4"/>',
  chevronDown: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  sync: '<path d="M19.5 12a7.5 7.5 0 0 1-13.3 4.7M4.5 12a7.5 7.5 0 0 1 13.3-4.7"/><path d="M18 3.5v4h-4M6 20.5v-4h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><path d="M12 17.3h.01"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  // --- Profiles & chat icons ---
  person: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.9-3.7 3.8-5.8 7.5-5.8s6.6 2.1 7.5 5.8"/>',
  photo: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.8-4.8L7 19"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  leaf: '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14z"/><path d="M5 19l7-7"/>',
  cookie: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9h.01M14.5 8.5h.01M15 14h.01M9.5 15h.01M12 12h.01"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 5v14M16 5v14M3.5 9.5H8M3.5 14.5H8M16 9.5h4.5M16 14.5h4.5"/>',
  cake: '<path d="M4.5 20.5h15v-7a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5z"/><path d="M4.5 16c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 1.5-.5 1.5-.5"/><path d="M12 12V8.5M12 6.5c-.9-.8-.9-1.9 0-3 .9 1.1.9 2.2 0 3z"/>',
  edit: '<path d="M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L8.5 18.5z"/><path d="M13.5 7.5l3 3"/>',
  logout: '<path d="M14 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="M10 12h10M16.5 8.5L20 12l-3.5 3.5"/>',
  // --- end profiles & chat icons ---
  door: '<path d="M6.5 20.5V4.8a1.3 1.3 0 0 1 1.3-1.3h8.4a1.3 1.3 0 0 1 1.3 1.3v15.7"/><path d="M4 20.5h16"/><path d="M14.3 12.2h.01" stroke-width="2.6"/>', // House
  // Install on your phone (Settings): a phone, and Safari's Share button.
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.2"/><path d="M10.5 18.5h3"/>',
  share: '<path d="M12 14.5v-11M8.5 7L12 3.5 15.5 7"/><path d="M8.5 10.5H7a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1.5"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** Inline SVG icon. Decorative by default; pass `label` to expose it to screen readers. */
export function icon(name: IconName, options: { size?: number; label?: string; className?: string } = {}): string {
  const size = options.size ?? 20;
  const a11y = options.label ? `role="img" aria-label="${escapeHtml(options.label)}"` : 'aria-hidden="true" focusable="false"';
  const cls = options.className ? ` ${escapeHtml(options.className)}` : "";
  return `<svg class="gc-icon${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${ICON_PATHS[name]}</svg>`;
}

// ---------------------------------------------------------------------------
// Member colors (deterministic, shared by cart, calendar, and expenses)
// ---------------------------------------------------------------------------

/** Flat member colors; each has at least 4.5:1 contrast with white initials. */
export const MEMBER_PALETTE: readonly string[] = [
  "#3f51b5", // blueberry
  "#0b8043", // basil
  "#8e24aa", // grape
  "#d81b60", // raspberry
  "#0277bd", // peacock (deep)
  "#c43e00", // tangerine (deep)
  "#00796b", // teal
  "#5e35b1", // lavender (deep)
  "#6d4c41", // cocoa
  "#8a6100", // mustard (deep)
];

export type MemberColor = { solid: string; soft: string; on: string };

function hashString(value: string): number {
  // FNV-1a 32-bit. Keep in sync with the copy in CLIENT_HELPERS below.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic color slot for a member id. When `allMemberIds` (the whole
 * household) is passed, colors are distinct across that set (up to the palette
 * size) and stable for the same set, regardless of order.
 */
export function memberColorIndex(memberId: string, allMemberIds?: readonly string[]): number {
  const size = MEMBER_PALETTE.length;
  if (!allMemberIds || !allMemberIds.includes(memberId)) return hashString(memberId) % size;
  const used = new Set<number>();
  for (const id of [...new Set(allMemberIds)].sort()) {
    let slot = hashString(id) % size;
    if (used.size < size) while (used.has(slot)) slot = (slot + 1) % size;
    used.add(slot);
    if (id === memberId) return slot;
  }
  return hashString(memberId) % size;
}

/** `solid` for avatars/bars/blocks, `soft` for tinted backgrounds (works in light and dark), `on` for text on `solid`. */
export function memberColor(memberId: string, allMemberIds?: readonly string[]): MemberColor {
  const solid = MEMBER_PALETTE[memberColorIndex(memberId, allMemberIds)]!;
  return { solid, soft: `color-mix(in srgb, ${solid} 18%, transparent)`, on: "#ffffff" };
}

// --- Profiles: avatar directory, so uploaded photos and emoji avatars show everywhere ---
export type AvatarLook = { name?: string; avatarUrl?: string; avatarEmoji?: string };
let avatarDirectory: (() => Record<string, AvatarLook>) | null = null;

/** Installed by src/profiles.ts: member id → photo URL / emoji. Pages and GC.avatar use it automatically. */
export function setAvatarDirectory(provider: (() => Record<string, AvatarLook>) | null): void {
  avatarDirectory = provider;
}

function avatarLooks(): Record<string, AvatarLook> {
  try { return avatarDirectory?.() ?? {}; } catch { return {}; }
}
// --- end profiles avatar directory ---

/** Circle avatar: the member's photo or emoji (profiles), else their initial in their color. */
export function avatarHtml(member: { id: string; name: string; avatarUrl?: string; avatarEmoji?: string }, options: { allMemberIds?: readonly string[]; size?: number } = {}): string {
  const color = memberColor(member.id, options.allMemberIds);
  const size = options.size ?? 32;
  // --- Profiles: photo / emoji avatars ---
  const look = avatarDirectory ? avatarLooks()[member.id] : undefined;
  const photo = member.avatarUrl ?? look?.avatarUrl;
  const emoji = member.avatarEmoji ?? look?.avatarEmoji;
  if (photo) return `<img class="gc-avatar gc-avatar-photo" src="${escapeHtml(photo)}" alt="" style="--gc-avatar-size:${size}px" title="${escapeHtml(member.name)}" aria-hidden="true" />`;
  if (emoji) return `<span class="gc-avatar gc-avatar-emoji" style="--gc-avatar-bg:${color.solid};--gc-avatar-size:${size}px" title="${escapeHtml(member.name)}" aria-hidden="true">${escapeHtml(emoji)}</span>`;
  // --- end profiles ---
  const initial = (member.name.trim().charAt(0) || "?").toUpperCase();
  return `<span class="gc-avatar" style="--gc-avatar-bg:${color.solid};--gc-avatar-size:${size}px" title="${escapeHtml(member.name)}" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

// ---------------------------------------------------------------------------
// Small HTML helpers
// ---------------------------------------------------------------------------

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Small status chip. `label` is plain text (escaped). */
export function chip(label: string, tone: Tone = "neutral", iconName?: IconName): string {
  return `<span class="gc-chip gc-chip-${tone}">${iconName ? icon(iconName, { size: 14 }) : ""}${escapeHtml(label)}</span>`;
}

/** Small "i" button that shows `text` as a tooltip on hover/focus. */
export function infoTip(text: string, label = "More info"): string {
  return `<button type="button" class="gc-tip" data-tip="${escapeHtml(text)}" aria-label="${escapeHtml(label)}: ${escapeHtml(text)}">${icon("info", { size: 16 })}</button>`;
}

/** [themes] ` data-flavor="key"` attribute (or "") for opt-in skin wording. */
function flavorAttr(key: string | undefined): string {
  return key ? ` data-flavor="${escapeHtml(key)}"` : "";
}

/**
 * Centered empty state with an icon, a short title, and an optional one-liner. `action` is HTML.
 * [themes] `flavor` (e.g. "empty.chores") swaps title/text per skin via "<flavor>.title" / "<flavor>.text".
 */
export function emptyState(options: { icon: IconName; title: string; text?: string; action?: string; flavor?: string }): string {
  const f = options.flavor;
  return `<div class="gc-empty">${icon(options.icon, { size: 32 })}<p class="gc-empty-title"${flavorAttr(f && `${f}.title`)}>${escapeHtml(options.title)}</p>${options.text ? `<p class="gc-empty-text"${flavorAttr(f && `${f}.text`)}>${escapeHtml(options.text)}</p>` : ""}${options.action ?? ""}</div>`;
}

/** Overlapping avatars for a group of members (e.g. who shares an item or a chore). */
export function avatarStack(members: ReadonlyArray<{ id: string; name: string }>, options: { allMemberIds?: readonly string[]; size?: number } = {}): string {
  return `<span class="gc-avatars">${members.map((member) => avatarHtml(member, { allMemberIds: options.allMemberIds, size: options.size ?? 28 })).join("")}</span>`;
}

export type ButtonVariant = "primary" | "tonal" | "outline" | "text";

/** Pill button, or a link styled as one when `href` is set. `attrs` is raw HTML attributes. */
export function button(options: {
  label: string;
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: IconName;
  href?: string;
  id?: string;
  disabled?: boolean;
  external?: boolean;
  attrs?: string;
}): string {
  const variant = options.variant ?? "primary";
  const classes = ["gc-btn", variant === "primary" ? "" : `gc-btn-${variant}`, options.size === "sm" ? "gc-btn-sm" : ""].filter(Boolean).join(" ");
  const id = options.id ? ` id="${escapeHtml(options.id)}"` : "";
  const attrs = options.attrs ? ` ${options.attrs}` : "";
  const inner = `${options.icon ? icon(options.icon, { size: 18 }) : ""}${escapeHtml(options.label)}${options.external ? icon("external", { size: 16 }) : ""}`;
  if (options.href) {
    const target = options.external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a class="${classes}"${id} href="${escapeHtml(options.href)}"${target}${options.disabled ? ' aria-disabled="true" tabindex="-1"' : ""}${attrs}>${inner}</a>`;
  }
  return `<button class="${classes}"${id} type="button"${options.disabled ? " disabled" : ""}${attrs}>${inner}</button>`;
}

/** Heading that sits above a group of cards. `actions` is HTML. [themes] `flavor` = flavor key for the title. */
export function sectionHeader(title: string, options: { meta?: string; actions?: string; id?: string; flavor?: string } = {}): string {
  return `<div class="gc-section-head"><h2 class="gc-section-title"${options.id ? ` id="${escapeHtml(options.id)}"` : ""}${flavorAttr(options.flavor)}>${escapeHtml(title)}</h2>${options.meta ? `<span class="gc-meta">${escapeHtml(options.meta)}</span>` : ""}<span class="gc-spacer"></span>${options.actions ?? ""}</div>`;
}

/**
 * Surface with an optional header row. `body` and `actions` are HTML; `tip` becomes an info tooltip.
 * [themes] `flavor` (e.g. "home.people") swaps title/meta per skin via "<flavor>.title" / "<flavor>.meta".
 */
export function card(options: { title?: string; icon?: IconName; meta?: string; tip?: string; actions?: string; body: string; id?: string; className?: string; flavor?: string }): string {
  const id = options.id ? ` id="${escapeHtml(options.id)}"` : "";
  const cls = options.className ? ` ${escapeHtml(options.className)}` : "";
  const f = options.flavor;
  const head = options.title || options.actions
    ? `<div class="gc-card-head">${options.icon ? `<span class="gc-card-icon">${icon(options.icon, { size: 20 })}</span>` : ""}${options.title ? `<h2 class="gc-card-title"${flavorAttr(f && `${f}.title`)}>${escapeHtml(options.title)}</h2>` : ""}${options.meta ? `<span class="gc-meta"${flavorAttr(f && `${f}.meta`)}>${escapeHtml(options.meta)}</span>` : ""}<span class="gc-spacer"></span>${options.actions ?? ""}${options.tip ? infoTip(options.tip) : ""}</div>`
    : "";
  return `<section class="gc-card${cls}"${id}>${head}${options.body}</section>`;
}

/** One divided row: leading (avatar/icon HTML) · title + sub · trailing (amount/chip/button HTML). */
export function listRow(options: { leading?: string; title: string; sub?: string; trailing?: string; href?: string }): string {
  const title = options.href
    ? `<a class="gc-list-link" href="${escapeHtml(options.href)}">${escapeHtml(options.title)}</a>`
    : escapeHtml(options.title);
  return `<li class="gc-list-item">${options.leading ?? ""}<div class="gc-list-main"><div class="gc-list-title">${title}</div>${options.sub ? `<div class="gc-list-sub">${options.sub}</div>` : ""}</div>${options.trailing ?? ""}</li>`;
}

/** Wrap listRow() output in a list. */
export function list(rows: readonly string[], options: { id?: string } = {}): string {
  return `<ul class="gc-list"${options.id ? ` id="${escapeHtml(options.id)}"` : ""}>${rows.join("")}</ul>`;
}

/**
 * Modal dialog (bottom sheet on phones) using the native <dialog> element.
 * `body` and `actions` are HTML. Open with an element carrying
 * data-gc-open="<id>" or GC.openDialog(id); any [data-gc-close] inside closes it.
 */
export function dialog(options: { id: string; title: string; body: string; actions?: string }): string {
  const id = escapeHtml(options.id);
  return `<dialog class="gc-dialog" id="${id}" aria-labelledby="${id}-title">
  <div class="gc-dialog-head"><h2 class="gc-dialog-title" id="${id}-title">${escapeHtml(options.title)}</h2><button type="button" class="gc-icon-btn" data-gc-close aria-label="Close">${icon("close", { size: 20 })}</button></div>
  <div class="gc-dialog-body">${options.body}</div>
  ${options.actions ? `<div class="gc-dialog-actions">${options.actions}</div>` : ""}
</dialog>`;
}

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const LIGHT_TOKENS = `
  --gc-bg:#ffffff;
  --gc-surface:#ffffff;
  --gc-surface-2:#f8fafd;
  --gc-hover:#f1f3f4;
  --gc-border:#e0e3e7;
  --gc-border-strong:#c4c7c5;
  --gc-text:#1f1f1f;
  --gc-text-2:#444746;
  --gc-muted:#5f6368;
  --gc-accent:#0b57d0;
  --gc-accent-hover:#0842a0;
  --gc-accent-soft:#d3e3fd;
  --gc-on-accent:#ffffff;
  --gc-on-accent-soft:#041e49;
  --gc-success:#146c2e;
  --gc-success-soft:#c4eed0;
  --gc-warning:#7a4a00;
  --gc-warning-soft:#ffe8c2;
  --gc-danger:#b3261e;
  --gc-danger-soft:#f9dedc;
  --gc-track:#e9eef6;
  --gc-focus:#0b57d0;
  --gc-tooltip-bg:#3c4043;
  --gc-tooltip-text:#ffffff;`;

const DARK_TOKENS = `
  --gc-bg:#131314;
  --gc-surface:#1e1f20;
  --gc-surface-2:#1b1c1d;
  --gc-hover:#2a2b2d;
  --gc-border:#3c4043;
  --gc-border-strong:#5f6368;
  --gc-text:#e3e3e3;
  --gc-text-2:#c4c7c5;
  --gc-muted:#9aa0a6;
  --gc-accent:#a8c7fa;
  --gc-accent-hover:#c2d7fb;
  --gc-accent-soft:#0f3a73;
  --gc-on-accent:#062e6f;
  --gc-on-accent-soft:#d3e3fd;
  --gc-success:#6dd58c;
  --gc-success-soft:#0f3d22;
  --gc-warning:#ffc46b;
  --gc-warning-soft:#43300a;
  --gc-danger:#f2b8b5;
  --gc-danger-soft:#5c1a16;
  --gc-track:#2d3134;
  --gc-focus:#a8c7fa;
  --gc-tooltip-bg:#e3e3e3;
  --gc-tooltip-text:#1f1f1f;`;

const SCALE_TOKENS = `
  --gc-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --gc-fs-xs:12px;
  --gc-fs-sm:13px;
  --gc-fs-md:14px;
  --gc-fs-lg:16px;
  --gc-fs-xl:22px;
  --gc-fs-2xl:28px;
  --gc-space-1:4px;
  --gc-space-2:8px;
  --gc-space-3:12px;
  --gc-space-4:16px;
  --gc-space-5:24px;
  --gc-space-6:32px;
  --gc-radius-sm:8px;
  --gc-radius-md:12px;
  --gc-radius-lg:16px;
  --gc-radius-pill:999px;
  --gc-appbar-h:64px;
  --gc-rail-w:88px;
  --gc-bottomnav-h:64px;
  --gc-content-max:1160px;`;

/**
 * CSS custom properties for both themes. Dark follows prefers-color-scheme;
 * <html data-theme="light|dark"> forces one theme.
 */
export const TOKENS_CSS = `
:root { color-scheme: light dark; ${SCALE_TOKENS} ${LIGHT_TOKENS} }
:root[data-theme="light"] { color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK_TOKENS} } }
:root[data-theme="dark"] { color-scheme: dark; ${DARK_TOKENS} }`;

// ---------------------------------------------------------------------------
// Base CSS: layout shell + shared components
// ---------------------------------------------------------------------------

export const BASE_CSS = `
*,*::before,*::after { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
/* viewport-fit=cover: keep content out of the notch sides in landscape (fixed bars add their own insets). */
body { margin:0; padding:0 env(safe-area-inset-right) 0 env(safe-area-inset-left); background:var(--gc-bg); color:var(--gc-text); font:var(--gc-fs-md)/1.45 var(--gc-font); overflow-x:clip; }
h1,h2,h3,p { margin:0; }
a { color:var(--gc-accent); }
[hidden] { display:none !important; }
:focus-visible { outline:2px solid var(--gc-focus); outline-offset:2px; }
.gc-icon { flex:none; display:block; }
.gc-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }

/* App bar (grows by the top safe area, e.g. a status bar drawn over the page in a home-screen app) */
.gc-appbar { position:sticky; top:0; z-index:20; height:calc(var(--gc-appbar-h) + env(safe-area-inset-top)); display:flex; align-items:center; gap:var(--gc-space-4); padding:env(safe-area-inset-top) var(--gc-space-4) 0 var(--gc-space-5); background:var(--gc-surface); border-bottom:1px solid var(--gc-border); }
.gc-brand { display:flex; align-items:center; gap:10px; color:var(--gc-text); text-decoration:none; flex:none; }
.gc-logo { width:36px; height:36px; display:grid; place-items:center; border-radius:10px; background:var(--gc-accent); color:var(--gc-on-accent); }
.gc-brand-name { font-size:var(--gc-fs-xl); font-weight:400; letter-spacing:-.01em; }
.gc-appbar-title { font-size:var(--gc-fs-lg); font-weight:500; color:var(--gc-text-2); padding-left:var(--gc-space-4); border-left:1px solid var(--gc-border); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.gc-appbar-actions { margin-left:auto; display:flex; align-items:center; gap:var(--gc-space-2); min-width:0; }

/* Navigation rail */
.gc-frame { display:flex; min-height:calc(100vh - var(--gc-appbar-h) - env(safe-area-inset-top)); }
.gc-rail { position:sticky; top:calc(var(--gc-appbar-h) + env(safe-area-inset-top)); align-self:flex-start; width:var(--gc-rail-w); flex:none; display:flex; flex-direction:column; align-items:center; gap:var(--gc-space-2); padding:var(--gc-space-3) 0; height:calc(100vh - var(--gc-appbar-h) - env(safe-area-inset-top)); }
.gc-nav-item { width:72px; display:flex; flex-direction:column; align-items:center; gap:4px; padding:4px 0; color:var(--gc-text-2); text-decoration:none; font-size:var(--gc-fs-xs); font-weight:500; border-radius:var(--gc-radius-md); }
.gc-nav-pill { width:56px; height:32px; display:grid; place-items:center; border-radius:var(--gc-radius-pill); transition:background-color .15s ease; }
.gc-nav-item:hover .gc-nav-pill { background:var(--gc-hover); }
.gc-nav-item[aria-current="page"] { color:var(--gc-text); font-weight:600; }
.gc-nav-item[aria-current="page"] .gc-nav-pill { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
button.gc-nav-item { border:0; background:transparent; font-family:inherit; cursor:pointer; }
.gc-nav-more { display:none !important; }
.gc-more { display:grid; gap:2px; padding-bottom:var(--gc-space-2); }
.gc-more-item { display:flex; align-items:center; gap:var(--gc-space-4); min-height:48px; padding:0 var(--gc-space-3); border-radius:var(--gc-radius-md); color:var(--gc-text); text-decoration:none; font-weight:500; }
.gc-more-item .gc-icon { color:var(--gc-text-2); }
.gc-more-item:hover { background:var(--gc-hover); }
.gc-more-item[aria-current="page"] { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.gc-more-item[aria-current="page"] .gc-icon { color:inherit; }
.gc-main { flex:1; min-width:0; padding:var(--gc-space-5) var(--gc-space-5) var(--gc-space-6) var(--gc-space-2); }
.gc-content { max-width:var(--gc-content-max); margin:0 auto; }

/* Layout helpers */
.gc-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,360px); gap:var(--gc-space-5); align-items:start; }
.gc-stack { display:grid; gap:var(--gc-space-4); min-width:0; }
.gc-cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap:var(--gc-space-4); align-items:start; }
.gc-row { display:flex; align-items:center; gap:var(--gc-space-2); min-width:0; }
.gc-spacer { flex:1; }

/* Cards */
.gc-card { background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:var(--gc-radius-lg); padding:var(--gc-space-4) var(--gc-space-5); min-width:0; }
.gc-card-head { display:flex; align-items:center; gap:var(--gc-space-2); min-height:32px; margin-bottom:var(--gc-space-3); }
.gc-card-title { font-size:var(--gc-fs-lg); font-weight:500; }
.gc-card-icon { width:32px; height:32px; flex:none; display:grid; place-items:center; border-radius:50%; background:var(--gc-surface-2); border:1px solid var(--gc-border); color:var(--gc-text-2); }
.gc-section-head { display:flex; align-items:center; gap:var(--gc-space-2); min-height:32px; }
.gc-section-title { font-size:var(--gc-fs-sm); font-weight:500; color:var(--gc-muted); }
.gc-meta { color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.gc-muted { color:var(--gc-muted); }

/* Stat tiles */
.gc-stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--gc-space-3); }
.gc-stat { background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:var(--gc-radius-lg); padding:var(--gc-space-3) var(--gc-space-4); min-width:0; }
.gc-stat-label { display:flex; align-items:center; gap:6px; white-space:nowrap; overflow:hidden; color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; }
.gc-stat-value { font-size:var(--gc-fs-xl); font-weight:500; margin-top:2px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gc-stat-sub { color:var(--gc-muted); font-size:var(--gc-fs-xs); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* Progress */
.gc-track { height:6px; border-radius:var(--gc-radius-pill); background:var(--gc-track); overflow:hidden; margin-top:var(--gc-space-2); }
.gc-fill { height:100%; border-radius:inherit; background:var(--gc-accent); transition:width .25s ease; }
.gc-fill.is-over { background:var(--gc-warning); }

/* Chips */
.gc-chip { display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px; border-radius:var(--gc-radius-sm); font-size:var(--gc-fs-xs); font-weight:500; white-space:nowrap; border:1px solid transparent; }
.gc-chip-neutral { background:transparent; border-color:var(--gc-border); color:var(--gc-text-2); }
.gc-chip-accent { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.gc-chip-success { background:var(--gc-success-soft); color:var(--gc-success); }
.gc-chip-warning { background:var(--gc-warning-soft); color:var(--gc-warning); }
.gc-chip-danger { background:var(--gc-danger-soft); color:var(--gc-danger); }

/* Buttons */
.gc-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:36px; padding:0 16px; border-radius:var(--gc-radius-pill); border:1px solid transparent; font:500 var(--gc-fs-md)/1 var(--gc-font); cursor:pointer; text-decoration:none; white-space:nowrap; background:var(--gc-accent); color:var(--gc-on-accent); transition:background-color .15s ease; }
.gc-btn:not(:disabled):hover { background:var(--gc-accent-hover); }
.gc-btn-tonal { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.gc-btn-tonal:not(:disabled):hover { background:var(--gc-accent-soft); filter:brightness(.96); }
.gc-btn-outline { background:transparent; color:var(--gc-accent); border-color:var(--gc-border-strong); }
.gc-btn-outline:not(:disabled):hover, .gc-btn-text:not(:disabled):hover { background:var(--gc-hover); }
.gc-btn-text { background:transparent; color:var(--gc-accent); padding:0 10px; }
.gc-btn-sm { height:30px; padding:0 12px; font-size:var(--gc-fs-sm); }
.gc-btn:disabled, .gc-btn[aria-disabled="true"] { opacity:.4; cursor:not-allowed; filter:none; }
.gc-btn[aria-disabled="true"] { pointer-events:none; }
.gc-icon-btn { width:36px; height:36px; display:inline-grid; place-items:center; border:0; border-radius:50%; background:transparent; color:var(--gc-text-2); cursor:pointer; }
.gc-icon-btn:hover { background:var(--gc-hover); }

/* Form fields */
.gc-input, .gc-select { height:40px; min-width:0; padding:0 12px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-sm); background:var(--gc-surface); color:var(--gc-text); font:var(--gc-fs-md) var(--gc-font); }
.gc-input:focus, .gc-select:focus { outline:2px solid var(--gc-focus); outline-offset:-1px; border-color:transparent; }
.gc-input { flex:1; width:100%; }
.gc-field-row { display:flex; gap:var(--gc-space-2); min-width:0; }
.gc-status { min-height:18px; margin-top:var(--gc-space-2); font-size:var(--gc-fs-sm); color:var(--gc-text-2); }
.gc-status:empty { display:none; }

/* Avatars */
.gc-avatar { --gc-avatar-size:32px; width:var(--gc-avatar-size); height:var(--gc-avatar-size); flex:none; display:inline-grid; place-items:center; border-radius:50%; background:var(--gc-avatar-bg,#616161); color:#fff; font-size:calc(var(--gc-avatar-size) * .44); font-weight:600; line-height:1; user-select:none; }
.gc-avatars { display:inline-flex; }
.gc-avatars .gc-avatar { box-shadow:0 0 0 2px var(--gc-surface); }
.gc-avatars .gc-avatar + .gc-avatar { margin-left:-6px; }

/* Lists */
.gc-list { list-style:none; margin:0; padding:0; }
.gc-list-item { display:flex; align-items:center; gap:var(--gc-space-3); padding:var(--gc-space-3) 0; border-top:1px solid var(--gc-border); min-width:0; }
.gc-list-item:first-child { border-top:0; }
.gc-list-main { flex:1; min-width:0; }
.gc-list-title { font-weight:500; overflow-wrap:anywhere; }
.gc-list-link { color:inherit; text-decoration:none; }
.gc-list-link:hover { text-decoration:underline; }
.gc-list-sub { display:flex; flex-wrap:wrap; align-items:center; gap:6px; color:var(--gc-muted); font-size:var(--gc-fs-xs); margin-top:2px; }
.gc-amount { font-weight:500; font-variant-numeric:tabular-nums; white-space:nowrap; text-align:right; }

/* Empty state */
.gc-empty { display:grid; justify-items:center; gap:6px; padding:var(--gc-space-6) var(--gc-space-4); text-align:center; color:var(--gc-muted); }
.gc-empty > .gc-icon { width:32px; height:32px; }
.gc-empty-title { color:var(--gc-text); font-weight:500; font-size:var(--gc-fs-lg); }
.gc-empty-text { font-size:var(--gc-fs-sm); max-width:340px; }

/* Tooltip */
.gc-tip { position:relative; display:inline-grid; place-items:center; width:24px; height:24px; padding:0; border:0; border-radius:50%; background:transparent; color:var(--gc-muted); cursor:help; }
.gc-tip:hover, .gc-tip:focus-visible { background:var(--gc-hover); color:var(--gc-text); }
.gc-tip::after { content:attr(data-tip); position:absolute; top:calc(100% + 6px); right:-4px; z-index:30; width:max-content; max-width:min(260px, 70vw); padding:6px 10px; border-radius:6px; background:var(--gc-tooltip-bg); color:var(--gc-tooltip-text); font:400 var(--gc-fs-xs)/1.4 var(--gc-font); text-align:left; white-space:normal; pointer-events:none; opacity:0; visibility:hidden; transition:opacity .12s ease; }
.gc-tip:hover::after, .gc-tip:focus-visible::after { opacity:1; visibility:visible; }

/* Disclosure ("How it works") */
.gc-disclosure { background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:var(--gc-radius-lg); }
.gc-disclosure > summary { list-style:none; display:flex; align-items:center; gap:var(--gc-space-2); padding:var(--gc-space-3) var(--gc-space-5); cursor:pointer; font-weight:500; border-radius:var(--gc-radius-lg); }
.gc-disclosure > summary::-webkit-details-marker { display:none; }
.gc-disclosure > summary:hover { background:var(--gc-hover); }
.gc-disclosure > summary .gc-chevron { margin-left:auto; transition:transform .15s ease; color:var(--gc-muted); }
.gc-disclosure[open] > summary .gc-chevron { transform:rotate(180deg); }
.gc-disclosure-body { padding:0 var(--gc-space-5) var(--gc-space-4); color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.gc-steps { list-style:none; margin:0; padding:0; display:grid; gap:var(--gc-space-3); }
.gc-steps li { display:flex; gap:var(--gc-space-3); align-items:flex-start; }
.gc-steps .gc-step-icon { width:32px; height:32px; flex:none; display:grid; place-items:center; border-radius:50%; background:var(--gc-surface-2); border:1px solid var(--gc-border); color:var(--gc-text-2); }
.gc-steps strong { display:block; color:var(--gc-text); font-weight:500; font-size:var(--gc-fs-md); }

/* Sync indicator */
.gc-sync { display:inline-flex; align-items:center; gap:6px; color:var(--gc-muted); font-size:var(--gc-fs-xs); white-space:nowrap; }
.gc-dot { width:8px; height:8px; border-radius:50%; background:var(--gc-success); flex:none; }
.gc-sync.is-paused .gc-dot { background:var(--gc-warning); }

/* Dialog: centered modal; bottom sheet on phones */
.gc-dialog { width:min(480px, calc(100vw - 32px)); max-height:min(80vh, 720px); padding:0; border:0; border-radius:var(--gc-radius-lg); background:var(--gc-surface); color:var(--gc-text); box-shadow:0 4px 16px rgba(0,0,0,.16); }
.gc-dialog::backdrop { background:rgba(0,0,0,.32); }
.gc-dialog-head { display:flex; align-items:center; gap:var(--gc-space-2); padding:var(--gc-space-4) var(--gc-space-3) var(--gc-space-2) var(--gc-space-5); }
.gc-dialog-title { flex:1; font-size:var(--gc-fs-xl); font-weight:400; }
.gc-dialog-body { padding:0 var(--gc-space-5) var(--gc-space-4); overflow:auto; }
.gc-dialog-actions { display:flex; justify-content:flex-end; gap:var(--gc-space-2); padding:var(--gc-space-3) var(--gc-space-5) var(--gc-space-4); }

/* Placeholder pages */
.gc-placeholder { max-width:560px; margin:var(--gc-space-6) auto; }

/* Phone and small tablets: rail becomes a bottom bar */
@media (max-width: 760px) {
  .gc-appbar { padding:env(safe-area-inset-top) var(--gc-space-3) 0 var(--gc-space-4); gap:var(--gc-space-3); height:calc(56px + env(safe-area-inset-top)); }
  .gc-brand-name { display:none; }
  .gc-appbar-title { border-left:0; padding-left:0; font-size:var(--gc-fs-lg); color:var(--gc-text); }
  .gc-frame { display:block; min-height:0; }
  .gc-rail { position:fixed; top:auto; bottom:0; left:0; right:0; z-index:20; width:auto; height:var(--gc-bottomnav-h); flex-direction:row; justify-content:space-around; gap:0; padding:6px calc(4px + env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) calc(4px + env(safe-area-inset-left)); background:var(--gc-surface); border-top:1px solid var(--gc-border); box-sizing:content-box; }
  .gc-nav-item { width:auto; flex:1; min-width:0; font-size:11px; }
  .gc-nav-item > span:last-child { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gc-nav-pill { width:48px; height:30px; }
  .gc-nav-extra { display:none !important; }
  .gc-nav-more { display:flex !important; }
  .gc-dialog { width:100%; max-width:100%; margin:auto 0 0; border-radius:var(--gc-radius-lg) var(--gc-radius-lg) 0 0; padding-bottom:env(safe-area-inset-bottom); }
  .gc-main { padding:var(--gc-space-4) var(--gc-space-4) calc(var(--gc-bottomnav-h) + var(--gc-space-6) + env(safe-area-inset-bottom)); }
  .gc-grid { grid-template-columns:minmax(0,1fr); }
  .gc-stats { gap:var(--gc-space-2); }
  .gc-stat { padding:var(--gc-space-2) var(--gc-space-3); }
  .gc-stat-value { font-size:var(--gc-fs-lg); }
  .gc-card { padding:var(--gc-space-3) var(--gc-space-4); }
  .gc-disclosure > summary { padding:var(--gc-space-3) var(--gc-space-4); }
  .gc-disclosure-body { padding:0 var(--gc-space-4) var(--gc-space-4); }
  .gc-hide-sm { display:none !important; }
}
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { transition:none !important; } }
`;

// ---------------------------------------------------------------------------
// Browser helpers (window.GC), available to every page script
// ---------------------------------------------------------------------------

const CLIENT_ICON_JSON = JSON.stringify(Object.fromEntries((Object.keys(ICON_PATHS) as IconName[]).map((name) => [name, icon(name, { size: 16 })])));

/** Plain JS defining `window.GC`. Mirrors the server helpers above. */
export const CLIENT_HELPERS = `
(function () {
  var PALETTE = ${JSON.stringify(MEMBER_PALETTE)};
  var ICONS = ${CLIENT_ICON_JSON};
  function hash(value) {
    var h = 0x811c9dc5;
    for (var i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function colorIndex(id, all) {
    var size = PALETTE.length;
    if (!all || all.indexOf(id) < 0) return hash(id) % size;
    var ids = Array.from(new Set(all)).sort();
    var used = new Set();
    for (var i = 0; i < ids.length; i += 1) {
      var slot = hash(ids[i]) % size;
      if (used.size < size) while (used.has(slot)) slot = (slot + 1) % size;
      used.add(slot);
      if (ids[i] === id) return slot;
    }
    return hash(id) % size;
  }
  var GC = {
    esc: function (value) { return String(value).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); },
    dollars: function (cents) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); },
    memberColor: function (id, all) { var solid = PALETTE[colorIndex(id, all)]; return { solid: solid, soft: "color-mix(in srgb, " + solid + " 18%, transparent)", on: "#ffffff" }; },
    avatar: function (member, all, size) {
      var color = GC.memberColor(member.id, all);
      // profiles: photo / emoji avatars (from the member object or the page's avatar directory)
      var look = (window.GC_AVATARS || {})[member.id] || {};
      var photo = member.avatarUrl || look.avatarUrl, emoji = member.avatarEmoji || look.avatarEmoji;
      if (photo) return '<img class="gc-avatar gc-avatar-photo" src="' + GC.esc(photo) + '" alt="" style="--gc-avatar-size:' + (size || 32) + 'px" title="' + GC.esc(member.name) + '" aria-hidden="true" />';
      if (emoji) return '<span class="gc-avatar gc-avatar-emoji" style="--gc-avatar-bg:' + color.solid + ';--gc-avatar-size:' + (size || 32) + 'px" title="' + GC.esc(member.name) + '" aria-hidden="true">' + GC.esc(emoji) + '</span>';
      var initial = (String(member.name || "").trim().charAt(0) || "?").toUpperCase();
      return '<span class="gc-avatar" style="--gc-avatar-bg:' + color.solid + ';--gc-avatar-size:' + (size || 32) + 'px" title="' + GC.esc(member.name) + '" aria-hidden="true">' + GC.esc(initial) + '</span>';
    },
    icon: function (name) { return ICONS[name] || ""; },
    chip: function (label, tone, iconName) { return '<span class="gc-chip gc-chip-' + (tone || "neutral") + '">' + (iconName ? GC.icon(iconName) : "") + GC.esc(label) + '</span>'; },
    listRow: function (row) {
      return '<li class="gc-list-item">' + (row.leading || "") + '<div class="gc-list-main"><div class="gc-list-title">' + GC.esc(row.title) + '</div>'
        + (row.sub ? '<div class="gc-list-sub">' + row.sub + '</div>' : "") + '</div>' + (row.trailing || "") + '</li>';
    },
    time: function (date) { return (date || new Date()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); },
    openDialog: function (id) { var d = document.getElementById(id); if (d && !d.open) d.showModal(); },
    closeDialog: function (id) { var d = document.getElementById(id); if (d && d.open) d.close(); }
  };
  window.GC = GC;
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var opener = target.closest("[data-gc-open]");
    if (opener) { GC.openDialog(opener.getAttribute("data-gc-open")); return; }
    var closer = target.closest("[data-gc-close]");
    if (closer) { var d = closer.closest("dialog"); if (d) d.close(); return; }
    if (target.tagName === "DIALOG" && target.classList.contains("gc-dialog")) {
      var r = target.getBoundingClientRect();
      var e = event;
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) target.close();
    }
  });
})();
`;

// ---------------------------------------------------------------------------
// Page renderer
// ---------------------------------------------------------------------------

export type PageOptions = {
  /** Page name, shown in the app bar and the document title. */
  title: string;
  /** Which nav item is highlighted. */
  active: NavKey;
  /** Page markup placed inside <main> (HTML; escape user text with escapeHtml). */
  body: string;
  /** Optional inline JS, run after `window.GC` is defined. */
  script?: string;
  /** Optional page-specific CSS, appended after the base CSS. */
  styles?: string;
  /** Optional HTML for the right side of the app bar (chips, sync status). */
  actions?: string;
};

function renderNav(active: NavKey): string {
  const items = NAV_ITEMS.map((item, index) => {
    const current = item.key === active ? ' aria-current="page"' : "";
    const phoneClass = index < PHONE_BAR_ITEMS ? "" : " gc-nav-extra";
    // [themes] skin wording for the label; the title keeps the plain name as a hint.
    const label = flavored(`nav.${item.key}`, item.label);
    return `<a class="gc-nav-item${phoneClass}" href="${item.href}" title="${escapeHtml(item.label)}"${current}><span class="gc-nav-pill">${icon(item.icon, { size: 22 })}</span><span${label.attrs}>${label.html}</span></a>`;
  }).join("");
  // Phones only: "More" opens a sheet with the sections that don't fit the bottom bar.
  const inMore = moreSheetItems().some((item) => item.key === active);
  const more = flavored("nav.more", "More");
  return `${items}<button type="button" class="gc-nav-item gc-nav-more" data-gc-open="gcMoreSheet"${inMore ? ' aria-current="page"' : ""}><span class="gc-nav-pill">${icon("menu", { size: 22 })}</span><span${more.attrs}>${more.html}</span></button>`;
}

function moreSheetItems(): NavItem[] {
  return [...NAV_ITEMS.slice(PHONE_BAR_ITEMS), ...MORE_ITEMS];
}

function renderMoreSheet(active: NavKey): string {
  const rows = moreSheetItems().map((item) => {
    const label = flavored(`nav.${item.key}`, item.label);
    return `<a class="gc-more-item" href="${item.href}"${item.key === active ? ' aria-current="page"' : ""}>${icon(item.icon, { size: 22 })}<span${label.attrs}>${label.html}</span></a>`;
  }).join("");
  return dialog({ id: "gcMoreSheet", title: "More", body: `<nav class="gc-more" aria-label="More">${rows}</nav>` });
}

/** Full HTML document: app bar, navigation rail (bottom bar on phones), and the page body. */
export function renderPage(options: PageOptions): string {
  const title = escapeHtml(options.title);
  // [themes] request skin (cookie), flavored app-bar title when it is a nav page, subtitle slot.
  const skin = currentSkin();
  const navItem = [...NAV_ITEMS, ...MORE_ITEMS].find((item) => item.key === options.active && item.label === options.title);
  const appTitle = navItem ? flavored(`nav.${navItem.key}`, navItem.label, skin) : { attrs: "", html: title };
  const appSub = flavored("appbar.sub", "", skin);
  // [/themes]
  return `<!doctype html>
<html lang="en" data-skin="${skin}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="${skinScheme(skin)}" />
<title>${title} · GroupCart</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b57d0"/><g transform="translate(4 4)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS.cart}</g></svg>`)}" />
${PWA_HEAD}
${skinHead(skin)}
<style>${TOKENS_CSS}${BASE_CSS}${ACCOUNT_MENU_CSS}</style>
${skinStylesheet()}
${options.styles ? `<style>${options.styles}</style>` : ""}
</head>
<body>
<header class="gc-appbar">
  <a class="gc-brand" href="/" aria-label="GroupCart home"><span class="gc-logo">${icon("cart", { size: 22 })}</span><span class="gc-brand-name">GroupCart</span></a>
  <h1 class="gc-appbar-title"${appTitle.attrs}>${appTitle.html}</h1>
  <span class="gc-appbar-sub"${appSub.attrs}>${appSub.html}</span>
  <div class="gc-appbar-actions">${options.actions ?? ""}${skinSwitcher(skin)}<div class="gc-me" id="gcMe"></div></div>
</header>
<div class="gc-frame">
  <nav class="gc-rail" aria-label="Main">${renderNav(options.active)}</nav>
  <main class="gc-main" id="main"><div class="gc-content">${options.body}</div></main>
</div>
${renderMoreSheet(options.active)}
<script>window.GC_AVATARS=${JSON.stringify(avatarLooks()).replace(/</g, "\\u003c")};</script>
<script>${CLIENT_HELPERS}</script>
<script>${ACCOUNT_MENU_SCRIPT}</script>
<script>${skinClientScript()}</script>
${options.script ? `<script>${options.script}</script>` : ""}
</body>
</html>`;
}

/** Simple full-page message (used for Kroger sign-in results). */
export function renderNotice(options: { title: string; message: string; tone?: Tone; active?: NavKey; links?: Array<{ href: string; label: string; external?: boolean }> }): string {
  const tone = options.tone ?? "neutral";
  const iconName: IconName = tone === "success" ? "checkCircle" : tone === "danger" || tone === "warning" ? "alert" : "info";
  const eyebrow = flavored(`notice.${tone}`, ""); // [themes] e.g. "Item acquired" above the title
  const links = (options.links ?? []).map((link, index) => `<a class="gc-btn ${index ? "gc-btn-outline" : ""}" href="${escapeHtml(link.href)}"${link.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(link.label)}${link.external ? icon("external", { size: 16 }) : ""}</a>`).join("");
  const body = `<section class="gc-card gc-placeholder gc-notice gc-notice-${tone}">
  <div class="gc-notice-icon">${icon(iconName, { size: 28 })}</div>
  <p class="gc-notice-eyebrow"${eyebrow.attrs}>${eyebrow.html}</p>
  <h2 class="gc-card-title">${escapeHtml(options.title)}</h2>
  <p class="gc-muted">${escapeHtml(options.message)}</p>
  ${links ? `<div class="gc-row gc-notice-links">${links}</div>` : ""}
</section>`;
  const styles = `
.gc-notice { display:grid; gap:var(--gc-space-3); padding:var(--gc-space-5); }
.gc-notice-icon { width:48px; height:48px; display:grid; place-items:center; border-radius:50%; background:var(--gc-surface-2); color:var(--gc-text-2); }
.gc-notice-success .gc-notice-icon { background:var(--gc-success-soft); color:var(--gc-success); }
.gc-notice-warning .gc-notice-icon, .gc-notice-danger .gc-notice-icon { background:var(--gc-warning-soft); color:var(--gc-warning); }
.gc-notice-links { flex-wrap:wrap; margin-top:var(--gc-space-2); }`;
  return renderPage({ title: options.title, active: options.active ?? "groceries", body, styles });
}
