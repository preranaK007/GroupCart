import type { Profile, ProfileSection } from "../profiles.js";
import { avatarHtml, button, card, chip, dialog, emptyState, escapeHtml, icon, renderPage, sectionHeader, type IconName } from "./shell.js";
// --- Money & points: pay-back handles (Venmo / Cash App / PayPal.me), leaderboard and points chips ---
import { payHandleFields, payHandlesHtml } from "./payUi.js";
import { leaderboardCard, withPointsBadge } from "./pointsUi.js";
// --- end money & points ---

/**
 * People pages: /people (household grid) and /people/<id> (one profile, its "About" facts, and summary
 * cards from registerProfileSection). Your own profile has an edit dialog (photo, emoji, or initial avatar).
 * Server-rendered per request; the edit dialog posts to /api/profile and /api/profile/avatar.
 */

type Look = { id: string; name: string; avatarUrl?: string; avatarEmoji?: string };

function look(profile: Profile): Look {
  return {
    id: profile.memberId,
    name: profile.displayName,
    ...(profile.avatar.kind === "photo" && profile.avatar.url ? { avatarUrl: profile.avatar.url } : {}),
    ...(profile.avatar.kind === "emoji" && profile.avatar.emoji ? { avatarEmoji: profile.avatar.emoji } : {}),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function formatBirthday(value: string): string {
  const match = /^(?:(\d{4})-|--)(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "";
  return `${MONTHS[Number(match[2]) - 1] ?? ""} ${Number(match[3])}`;
}

function paymentHtml(handle: string): string {
  return payHandlesHtml(handle); // money & points: one link per service (src/ui/payUi.ts)
}

const sharedStyles = `
.pp-hello { margin:0 0 var(--gc-space-4); }
.pp-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:var(--gc-space-4); }
.pp-card { position:relative; min-width:0; overflow:hidden; display:grid; justify-items:center; align-content:start; gap:6px; padding:var(--gc-space-5) var(--gc-space-4); text-align:center; background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:var(--gc-radius-lg); color:inherit; text-decoration:none; transition:background-color .15s ease, border-color .15s ease; }
.pp-card:hover { background:var(--gc-surface-2); border-color:var(--gc-border-strong); }
.pp-card .gc-avatar { margin-bottom:var(--gc-space-2); }
.pp-name { font-size:var(--gc-fs-lg); font-weight:500; }
.pp-pronouns { color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.pp-bio { color:var(--gc-text-2); font-size:var(--gc-fs-sm); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.pp-tags { display:flex; flex-wrap:wrap; justify-content:center; gap:6px; margin-top:var(--gc-space-1); }
.pp-tags { max-width:100%; min-width:0; }
.pp-tag { max-width:100%; min-width:0; }
.pp-tag > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pp-you { position:absolute; top:var(--gc-space-3); right:var(--gc-space-3); }
.pf-hero { display:flex; align-items:center; gap:var(--gc-space-5); }
.pf-hero-main { flex:1; min-width:0; display:grid; gap:4px; }
.pf-name { font-size:var(--gc-fs-2xl); font-weight:400; letter-spacing:-.01em; overflow-wrap:anywhere; }
.pf-pronouns { color:var(--gc-muted); font-size:var(--gc-fs-sm); }
.pf-bio { color:var(--gc-text-2); margin-top:var(--gc-space-1); overflow-wrap:anywhere; }
.pf-facts .gc-list-item { align-items:flex-start; }
.pf-fact-icon { width:36px; height:36px; flex:none; display:grid; place-items:center; border-radius:50%; background:var(--gc-surface-2); border:1px solid var(--gc-border); color:var(--gc-text-2); }
.pf-fact-label { color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; }
.pf-fact-value { overflow-wrap:anywhere; }
.pf-fact-empty { color:var(--gc-muted); }
.pf-section .gc-list-item { padding:var(--gc-space-2) 0; }
.pf-form { display:grid; gap:var(--gc-space-3); }
.pf-field { display:grid; gap:4px; }
.pf-field > span { color:var(--gc-text-2); font-size:var(--gc-fs-xs); font-weight:500; }
.pf-field textarea.gc-input { height:auto; min-height:64px; padding:10px 12px; resize:vertical; font:var(--gc-fs-md)/1.4 var(--gc-font); }
.pf-two { display:grid; grid-template-columns:1fr 1fr; gap:var(--gc-space-2); }
.pf-avatar-row { display:flex; align-items:center; gap:var(--gc-space-4); }
.pf-avatar-actions { display:flex; flex-wrap:wrap; gap:var(--gc-space-2); }
.pf-emojis { display:grid; grid-template-columns:repeat(8, minmax(0,1fr)); gap:4px; }
.pf-emoji { aspect-ratio:1; display:grid; place-items:center; border:1px solid transparent; border-radius:var(--gc-radius-sm); background:transparent; font-size:22px; cursor:pointer; color:var(--gc-text); font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",var(--gc-font); }
.pf-emoji:hover { background:var(--gc-hover); }
.pf-emoji[aria-pressed="true"] { border-color:var(--gc-accent); background:var(--gc-accent-soft); }
.pf-emoji.pf-initial { font:600 16px var(--gc-font); color:var(--gc-text-2); }
.pf-status { min-height:18px; font-size:var(--gc-fs-sm); color:var(--gc-danger); }
.pf-status:empty { display:none; }
@media (max-width: 760px) {
  .pp-grid { grid-template-columns:repeat(2, minmax(0,1fr)); gap:var(--gc-space-3); }
  .pp-card { padding:var(--gc-space-4) var(--gc-space-3); }
  .pf-hero { gap:var(--gc-space-4); }
  .pf-hero .gc-avatar { --gc-avatar-size:72px !important; }
  .pf-name { font-size:var(--gc-fs-xl); }
  .pf-emoji { font-size:20px; }
  .pf-hero { flex-wrap:wrap; }
  .pf-hero > .gc-btn { order:3; flex-basis:100%; }
  .pf-two-text { grid-template-columns:minmax(0,1fr); }
}`;

// ---------------------------------------------------------------------------
// /people
// ---------------------------------------------------------------------------

/**
 * On the host computer: a sign-in link per roommate to share in the group chat, for when GroupCart can't text
 * sign-in codes (no iMessage connection) or someone is on a new device.
 */
function inviteLinksCard(profiles: Profile[]): string {
  const rows = profiles.map((profile) => `<li class="gc-list-item pp-invite">
  <div class="gc-list-main"><div class="gc-list-title">${escapeHtml(profile.displayName)}</div><input class="gc-input pp-invite-url" readonly hidden aria-label="${escapeHtml(profile.displayName)}’s invite link" /></div>
  ${button({ label: "Copy invite link", variant: "outline", size: "sm", icon: "lock", attrs: `data-invite="${escapeHtml(profile.memberId)}"` })}
</li>`).join("");
  return `<section class="gc-card" style="margin-top:var(--gc-space-4)"><div class="gc-card-head"><h2 class="gc-card-title">Invite links</h2></div>
<p class="gc-meta" style="margin:0 0 var(--gc-space-2)">Send each roommate their own link to sign in on their phone or laptop. A link works on a few devices for a week; making a new one turns off the old one.</p>
<ul class="gc-list">${rows}</ul></section>
<script>
document.querySelectorAll("[data-invite]").forEach(function (button) {
  button.addEventListener("click", function () {
    var row = button.closest(".pp-invite"), field = row.querySelector(".pp-invite-url");
    fetch("/api/auth/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId: button.getAttribute("data-invite") }) })
      .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || "Couldn't make a link."); return data; }); })
      .then(function (data) {
        field.value = data.url; field.hidden = false; field.select();
        if (navigator.clipboard) navigator.clipboard.writeText(data.url).then(function () { button.lastChild.textContent = "Copied"; }, function () {});
      })
      .catch(function (error) { alert(error.message); });
  });
});
</script>`;
}

export function renderPeoplePage(context: { profiles: Profile[]; viewerId: string | null; householdName: string; canInvite?: boolean }): string {
  const ids = context.profiles.map((profile) => profile.memberId);
  const me = context.profiles.find((profile) => profile.memberId === context.viewerId);
  const cards = context.profiles.map((profile) => {
    const tag = (text: string, tone: "success" | "neutral", iconName: IconName) => `<span class="gc-chip gc-chip-${tone} pp-tag" title="${escapeHtml(text)}">${icon(iconName, { size: 14 })}<span>${escapeHtml(text)}</span></span>`;
    const tags = [
      profile.dietary ? tag(profile.dietary, "success", "leaf") : "",
      profile.genres ? tag(profile.genres.split(",")[0]!.trim(), "neutral", "film") : "",
    ].join("");
    return `<a class="pp-card" href="/people/${encodeURIComponent(profile.memberId)}">
  ${profile.memberId === context.viewerId ? `<span class="pp-you">${chip("You", "accent")}</span>` : ""}
  ${withPointsBadge(profile.memberId, avatarHtml(look(profile), { allMemberIds: ids, size: 72 }))}
  <span class="pp-name">${escapeHtml(profile.displayName)}</span>
  ${profile.pronouns ? `<span class="pp-pronouns">${escapeHtml(profile.pronouns)}</span>` : ""}
  ${profile.bio ? `<p class="pp-bio">${escapeHtml(profile.bio)}</p>` : ""}
  ${tags ? `<span class="pp-tags">${tags}</span>` : ""}
</a>`;
  }).join("");
  const body = `
${leaderboardCard(context.viewerId) /* money & points: this month's standings */}
${sectionHeader(context.householdName, {
    meta: `${context.profiles.length} ${context.profiles.length === 1 ? "person" : "people"}`,
    actions: me ? button({ label: "Edit your profile", variant: "tonal", size: "sm", icon: "edit", href: `/people/${encodeURIComponent(me.memberId)}?edit=1` }) : "",
  })}
<div class="pp-grid" style="margin-top:var(--gc-space-3)">${cards || emptyState({ icon: "users", title: "No one here yet" })}</div>
${context.canInvite && context.profiles.length ? inviteLinksCard(context.profiles) : ""}`;
  return renderPage({ title: "People", active: "people", body, styles: sharedStyles });
}

// ---------------------------------------------------------------------------
// /people/<id>
// ---------------------------------------------------------------------------

function fact(iconName: IconName, label: string, valueHtml: string): string {
  return `<li class="gc-list-item"><span class="pf-fact-icon">${icon(iconName, { size: 18 })}</span><div class="gc-list-main"><div class="pf-fact-label">${escapeHtml(label)}</div><div class="pf-fact-value">${valueHtml}</div></div></li>`;
}

const EMOJI_CHOICES = ["😀", "😎", "🤓", "🥳", "😴", "🤠", "👻", "🐱", "🐶", "🦊", "🐼", "🐸", "🌿", "🌻", "🍕", "🍜", "☕", "🎧", "🎮", "🎲", "📚", "🧗", "🏀", "🚲"];

function editDialog(profile: Profile, ids: string[]): string {
  const [, month, day] = /^(?:\d{4}-|--)(\d{2})-(\d{2})$/.exec(profile.birthday) ?? [];
  const field = (name: string, label: string, value: string, options: { max: number; placeholder?: string; textarea?: boolean; autofocus?: boolean }) => options.textarea
    ? `<label class="pf-field"><span>${escapeHtml(label)}</span><textarea class="gc-input" name="${name}" maxlength="${options.max}" rows="2" placeholder="${escapeHtml(options.placeholder ?? "")}">${escapeHtml(value)}</textarea></label>`
    : `<label class="pf-field"><span>${escapeHtml(label)}</span><input class="gc-input" name="${name}" maxlength="${options.max}" value="${escapeHtml(value)}" placeholder="${escapeHtml(options.placeholder ?? "")}" autocomplete="off"${options.autofocus ? " autofocus" : ""} /></label>`;
  const emojis = [...new Set([...(profile.avatar.emoji ? [profile.avatar.emoji] : []), ...EMOJI_CHOICES])].slice(0, 24);
  const kind = profile.avatar.kind;
  const body = `<form class="pf-form" id="pfForm" novalidate>
  <div class="pf-avatar-row">
    <span id="pfPreview">${avatarHtml(look(profile), { allMemberIds: ids, size: 64 })}</span>
    <div class="pf-avatar-actions">
      <label class="gc-btn gc-btn-tonal gc-btn-sm" for="pfPhoto" tabindex="0">${icon("photo", { size: 18 })}Upload photo</label>
      <input type="file" id="pfPhoto" accept="image/*" hidden />
      ${profile.avatar.url ? button({ label: "Remove photo", variant: "text", size: "sm", id: "pfRemovePhoto" }) : ""}
    </div>
  </div>
  <div class="pf-emojis" role="group" aria-label="Avatar">
    <button type="button" class="pf-emoji pf-initial" data-kind="initial" aria-pressed="${kind === "initial"}" title="Use your initial">${escapeHtml((profile.displayName.trim().charAt(0) || "?").toUpperCase())}</button>
    ${emojis.slice(0, 23).map((emoji) => `<button type="button" class="pf-emoji" data-emoji="${escapeHtml(emoji)}" aria-pressed="${kind === "emoji" && profile.avatar.emoji === emoji}">${escapeHtml(emoji)}</button>`).join("")}
  </div>
  ${field("displayName", "Name", profile.displayName, { max: 40, autofocus: true })}
  ${field("pronouns", "Pronouns (optional)", profile.pronouns, { max: 24, placeholder: "e.g. she/her, he/him, they/them" })}
  ${field("bio", "About you", profile.bio, { max: 160, textarea: true, placeholder: "A line about you" })}
  ${field("dietary", "Dietary notes & allergies", profile.dietary, { max: 160, placeholder: "Vegetarian, no peanuts…" })}
  <div class="pf-two pf-two-text">
    ${field("snacks", "Favorite snacks", profile.snacks, { max: 120, placeholder: "Popcorn, chips…" })}
    ${field("genres", "Movie & game picks", profile.genres, { max: 120, placeholder: "Horror, Catan…" })}
  </div>
  <div class="pf-two">
    <label class="pf-field"><span>Birthday month</span><select class="gc-select" name="month"><option value="">—</option>${MONTHS.map((name, index) => `<option value="${String(index + 1).padStart(2, "0")}"${month === String(index + 1).padStart(2, "0") ? " selected" : ""}>${name}</option>`).join("")}</select></label>
    <label class="pf-field"><span>Day</span><select class="gc-select" name="day"><option value="">—</option>${Array.from({ length: 31 }, (_, index) => String(index + 1).padStart(2, "0")).map((value) => `<option value="${value}"${day === value ? " selected" : ""}>${Number(value)}</option>`).join("")}</select></label>
  </div>
  ${payHandleFields(profile.paymentHandle) /* money & points: Venmo / Cash App / PayPal.me, saved as paymentHandle */}
  <p class="pf-status" id="pfStatus" role="status" aria-live="polite"></p>
</form>`;
  return dialog({
    id: "editProfile",
    title: "Edit profile",
    body,
    actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Save", id: "pfSave" })}`,
  });
}

/** JSON for inline <script>: "<" is escaped so user text can never close the script element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const editScript = (profile: Profile, ids: string[]) => `
const form = document.getElementById("pfForm");
const status = document.getElementById("pfStatus");
const ids = ${scriptJson(ids)};
const me = { id: ${scriptJson(profile.memberId)}, name: ${scriptJson(profile.displayName)} };
let avatar = { kind: ${scriptJson(profile.avatar.kind)}, emoji: ${scriptJson(profile.avatar.emoji ?? "")}, url: ${scriptJson(profile.avatar.url ?? "")} };
function preview() {
  const member = { id: me.id, name: form.elements.displayName.value || me.name };
  if (avatar.kind === "photo" && avatar.url) member.avatarUrl = avatar.url;
  if (avatar.kind === "emoji" && avatar.emoji) member.avatarEmoji = avatar.emoji;
  window.GC_AVATARS = Object.assign({}, window.GC_AVATARS, { [me.id]: {} });
  document.getElementById("pfPreview").innerHTML = window.GC.avatar(member, ids, 64);
  form.querySelectorAll(".pf-emoji").forEach((button) => {
    const on = button.dataset.kind === "initial" ? avatar.kind === "initial" : avatar.kind === "emoji" && button.dataset.emoji === avatar.emoji;
    button.setAttribute("aria-pressed", String(on));
  });
}
form.addEventListener("click", (event) => {
  const choice = event.target.closest(".pf-emoji");
  if (!choice) return;
  if (choice.dataset.kind === "initial") avatar.kind = "initial";
  else { avatar.kind = "emoji"; avatar.emoji = choice.dataset.emoji; }
  preview();
});
form.elements.displayName.addEventListener("input", preview);

async function squareJpeg(file, size) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Couldn’t read that image.")); image.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(size, side);
    canvas.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  } finally { URL.revokeObjectURL(url); }
}
document.querySelector('label[for="pfPhoto"]').addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); document.getElementById("pfPhoto").click(); }
});
document.getElementById("pfPhoto").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  status.textContent = "Uploading…";
  try {
    const blob = await squareJpeg(file, 512);
    const response = await fetch("/api/profile/avatar", { method: "POST", headers: { "content-type": "image/jpeg", "x-gc-request": "1" }, body: blob });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed.");
    avatar = { kind: "photo", emoji: avatar.emoji, url: data.profile.avatar.url };
    status.textContent = "";
    preview();
  } catch (error) { status.textContent = error.message; }
});
const remove = document.getElementById("pfRemovePhoto");
if (remove) remove.addEventListener("click", async () => {
  await fetch("/api/profile/avatar", { method: "DELETE", headers: { "x-gc-request": "1" } });
  location.reload();
});
document.getElementById("pfSave").addEventListener("click", async () => {
  const value = (name) => form.elements[name].value;
  const month = value("month"), day = value("day");
  if (Boolean(month) !== Boolean(day)) { status.textContent = "Pick both a month and a day, or neither."; return; }
  const body = {
    displayName: value("displayName"), pronouns: value("pronouns"), bio: value("bio"), dietary: value("dietary"),
    snacks: value("snacks"), genres: value("genres"), paymentHandle: value("paymentHandle"),
    birthday: month ? "--" + month + "-" + day : "",
    avatarKind: avatar.kind, avatarEmoji: avatar.emoji || "",
  };
  const save = document.getElementById("pfSave");
  save.disabled = true;
  try {
    const response = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Couldn’t save.");
    location.replace(location.pathname);
  } catch (error) { status.textContent = error.message; save.disabled = false; }
});
if (new URLSearchParams(location.search).has("edit")) window.GC.openDialog("editProfile");
`;

export function renderProfilePage(context: { profile: Profile; householdIds: string[]; isSelf: boolean; sections: ProfileSection[] }): string {
  const { profile, isSelf } = context;
  const ids = context.householdIds;
  const empty = (text: string) => `<span class="pf-fact-empty">${escapeHtml(text)}</span>`;
  const notAdded = isSelf ? "Add in Edit profile" : "Not added";
  const birthday = formatBirthday(profile.birthday);
  const hero = card({
    body: `<div class="pf-hero">
  ${avatarHtml(look(profile), { allMemberIds: ids, size: 96 })}
  <div class="pf-hero-main">
    <h2 class="pf-name">${escapeHtml(profile.displayName)}</h2>
    ${profile.pronouns ? `<span class="pf-pronouns">${escapeHtml(profile.pronouns)}</span>` : ""}
    ${profile.bio ? `<p class="pf-bio">${escapeHtml(profile.bio)}</p>` : isSelf ? `<p class="pf-bio gc-muted">Add a line about you.</p>` : ""}
  </div>
  ${isSelf ? button({ label: "Edit", variant: "outline", size: "sm", icon: "edit", attrs: 'data-gc-open="editProfile"' }) : ""}
</div>`,
  });
  const facts = card({
    title: "About",
    className: "pf-facts",
    body: `<ul class="gc-list">
  ${fact("leaf", "Dietary notes & allergies", profile.dietary ? escapeHtml(profile.dietary) : empty(notAdded))}
  ${fact("cookie", "Favorite snacks", profile.snacks ? escapeHtml(profile.snacks) : empty(notAdded))}
  ${fact("film", "Movie & game picks", profile.genres ? escapeHtml(profile.genres) : empty(notAdded))}
  ${fact("cake", "Birthday", birthday ? escapeHtml(birthday) : empty(notAdded))}
  ${fact("wallet", "Pay", profile.paymentHandle ? paymentHtml(profile.paymentHandle) : empty(notAdded))}
</ul>`,
  });
  const sections = context.sections.map((section) => card({
    title: section.title,
    icon: section.icon,
    className: "pf-section",
    actions: section.href ? button({ label: "Open", variant: "text", size: "sm", href: section.href }) : "",
    body: section.html,
  })).join("");
  const body = `<div class="gc-grid">
  <div class="gc-stack">${hero}${facts}</div>
  <div class="gc-stack">${sections}</div>
</div>
${isSelf ? editDialog(profile, ids) : ""}`;
  return renderPage({
    title: isSelf ? "Your profile" : profile.displayName,
    active: "people",
    body,
    styles: sharedStyles,
    actions: button({ label: "Household", variant: "text", size: "sm", icon: "users", href: "/people" }),
    script: isSelf ? editScript(profile, ids) : undefined,
  });
}
