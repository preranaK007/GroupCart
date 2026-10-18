import { button, card, icon, infoTip, renderPage } from "./shell.js";

/**
 * Web chat (route "/chat"): the household group conversation, iMessage-style in the app's flat look.
 * Mine on the right in the accent color; others on the left with avatar + name; GroupCart replies in an
 * outlined bubble. Data: GET /api/chat/messages (polled every 1.5 s), POST /api/chat/messages (JSON text,
 * or a raw image body with x-gc-text / x-gc-filename headers).
 * chatPreviewCard() is the small Home card (last few messages + a link to the composer).
 */

const BOT_AVATAR = (size: number) => `<span class="gc-avatar ch-bot-avatar" style="--gc-avatar-size:${size}px" aria-hidden="true">${icon("cart", { size: Math.round(size * 0.56) })}</span>`;

const styles = `
.gc-main { padding-top:var(--gc-space-4); padding-bottom:var(--gc-space-4); }
.ch { --ch-other:var(--gc-track); --ch-gap:2px; display:flex; flex-direction:column; max-width:820px; height:calc(100dvh - var(--gc-appbar-h) - 2 * var(--gc-space-4)); min-height:420px; margin:0 auto; background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:var(--gc-radius-lg); overflow:hidden; position:relative; }
.ch-head { display:flex; align-items:center; gap:var(--gc-space-3); padding:var(--gc-space-2) var(--gc-space-3) var(--gc-space-2) var(--gc-space-4); border-bottom:1px solid var(--gc-border); min-height:60px; }
.ch-group { display:flex; align-items:center; gap:var(--gc-space-3); min-width:0; color:inherit; text-decoration:none; border-radius:var(--gc-radius-md); padding:4px 8px 4px 4px; margin-left:-4px; }
.ch-group:hover { background:var(--gc-hover); }
.ch-title { display:grid; min-width:0; }
.ch-title strong { font-weight:500; font-size:var(--gc-fs-lg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ch-sub { color:var(--gc-muted); font-size:var(--gc-fs-xs); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ch-banner { display:flex; align-items:center; gap:var(--gc-space-2); padding:var(--gc-space-2) var(--gc-space-4); background:var(--gc-warning-soft); color:var(--gc-warning); font-size:var(--gc-fs-sm); }
.ch-scroll { flex:1; overflow-y:auto; overscroll-behavior:contain; padding:var(--gc-space-3) var(--gc-space-4) var(--gc-space-2); scroll-behavior:auto; }
.ch-earlier { display:flex; justify-content:center; padding:var(--gc-space-1) 0 var(--gc-space-3); }
.ch-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
.ch-sep { align-self:center; margin:var(--gc-space-4) 0 var(--gc-space-2); color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.ch-sep strong { font-weight:600; color:var(--gc-text-2); }
.ch-row { display:flex; align-items:flex-end; gap:var(--gc-space-2); margin-top:var(--ch-gap); max-width:100%; }
.ch-row.is-first { margin-top:var(--gc-space-3); }
.ch-sep + .ch-row.is-first { margin-top:0; }
.ch-row.is-mine { flex-direction:row-reverse; }
.ch-av { width:32px; flex:none; display:flex; }
.ch-col { display:flex; flex-direction:column; gap:var(--ch-gap); min-width:0; max-width:min(76%, 560px); }
.ch-row.is-mine .ch-col { align-items:flex-end; }
.ch-row:not(.is-mine) .ch-col { align-items:flex-start; }
.ch-name { color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; padding:0 12px 2px; }
.ch-row.is-bot .ch-name { color:var(--gc-accent); }
.ch-bubble { padding:8px 14px; border-radius:20px; background:var(--ch-other); color:var(--gc-text); white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.4; font-size:15px; }
.ch-bubble a { color:inherit; text-decoration:underline; }
.ch-row.is-mine .ch-bubble { background:var(--gc-accent); color:var(--gc-on-accent); }
.ch-row.is-bot .ch-bubble { background:var(--gc-surface); border:1px solid var(--gc-border); font-size:14px; }
.ch-row.is-mine:not(.is-first) .ch-col > :first-child { border-top-right-radius:6px; }
.ch-row.is-mine:not(.is-last) .ch-col > :last-child { border-bottom-right-radius:6px; }
.ch-row:not(.is-mine):not(.is-first) .ch-col > :first-child { border-top-left-radius:6px; }
.ch-row:not(.is-mine):not(.is-last) .ch-col > :last-child { border-bottom-left-radius:6px; }
.ch-col > .ch-name:first-child { border-radius:0 !important; }
.ch-emoji { font-size:40px; line-height:1.15; padding:0 2px; font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",var(--gc-font); }
.ch-img-link { display:block; border-radius:18px; overflow:hidden; border:1px solid var(--gc-border); background:var(--gc-surface-2); line-height:0; }
.ch-img { display:block; max-width:min(260px, 60vw); max-height:320px; width:auto; height:auto; object-fit:cover; }
.ch-file { display:inline-flex; align-items:center; gap:6px; padding:8px 12px; border-radius:18px; border:1px solid var(--gc-border); color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.ch-status { color:var(--gc-muted); font-size:11px; padding:2px 4px 0; }
.ch-status.is-failed { color:var(--gc-danger); }
.ch-status button { border:0; background:none; color:inherit; font:inherit; text-decoration:underline; cursor:pointer; padding:0; }
.ch-row.is-pending .ch-bubble, .ch-row.is-pending .ch-img-link { opacity:.6; }
.ch-bot-avatar { background:var(--gc-accent-soft) !important; color:var(--gc-on-accent-soft); }
.ch-typing { margin-top:var(--gc-space-3); }
.ch-dots { display:inline-flex; gap:4px; padding:12px 14px; border-radius:20px; background:var(--gc-surface); border:1px solid var(--gc-border); }
.ch-dots span { width:7px; height:7px; border-radius:50%; background:var(--gc-muted); animation:ch-blink 1.2s infinite ease-in-out; }
.ch-dots span:nth-child(2) { animation-delay:.15s; } .ch-dots span:nth-child(3) { animation-delay:.3s; }
@keyframes ch-blink { 0%, 80%, 100% { opacity:.25; transform:translateY(0); } 40% { opacity:1; transform:translateY(-2px); } }
@media (prefers-reduced-motion: reduce) { .ch-dots span { animation:none; opacity:.6; } }
.ch-jump { position:absolute; left:50%; bottom:118px; transform:translateX(-50%); z-index:2; display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 14px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-pill); background:var(--gc-surface); color:var(--gc-accent); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,.12); }
.ch-foot { border-top:1px solid var(--gc-border); padding:var(--gc-space-2) var(--gc-space-3) var(--gc-space-3); background:var(--gc-surface); }
.ch-suggest { display:flex; gap:var(--gc-space-2); overflow-x:auto; scrollbar-width:none; padding:2px 2px var(--gc-space-2); }
.ch-suggest::-webkit-scrollbar { display:none; }
.ch-suggest button { flex:none; height:30px; padding:0 12px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-sm); background:var(--gc-surface); color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.ch-suggest button:hover { background:var(--gc-hover); }
.ch-preview { position:relative; display:inline-block; margin:0 0 var(--gc-space-2) 44px; }
.ch-preview img { display:block; height:72px; max-width:160px; object-fit:cover; border-radius:12px; border:1px solid var(--gc-border); }
.ch-preview button { position:absolute; top:-8px; right:-8px; width:24px; height:24px; display:grid; place-items:center; border-radius:50%; border:1px solid var(--gc-border); background:var(--gc-surface); color:var(--gc-text-2); cursor:pointer; padding:0; }
.ch-composer { display:flex; align-items:flex-end; gap:var(--gc-space-2); }
.ch-attach { flex:none; width:40px; height:40px; display:grid; place-items:center; border-radius:50%; color:var(--gc-text-2); cursor:pointer; }
.ch-attach:hover { background:var(--gc-hover); }
.ch-field { flex:1; min-width:0; display:flex; align-items:flex-end; border:1px solid var(--gc-border-strong); border-radius:22px; background:var(--gc-surface); padding:0 4px 0 16px; }
.ch-field:focus-within { border-color:var(--gc-accent); box-shadow:0 0 0 1px var(--gc-accent); }
.ch-input { flex:1; min-width:0; border:0; outline:0; resize:none; background:transparent; color:var(--gc-text); font:15px/1.4 var(--gc-font); padding:10px 0; max-height:140px; }
.ch-send { flex:none; width:32px; height:32px; margin:4px 0; display:grid; place-items:center; border-radius:50%; border:0; background:var(--gc-accent); color:var(--gc-on-accent); cursor:pointer; transition:opacity .15s ease; }
.ch-send:disabled { opacity:.35; cursor:default; }
.ch-empty { margin:auto; text-align:center; color:var(--gc-muted); padding:var(--gc-space-6) var(--gc-space-4); }
@media (max-width: 760px) {
  .gc-main { padding:0 0 calc(var(--gc-bottomnav-h) + 12px + env(safe-area-inset-bottom)); }
  .ch { height:calc(100dvh - 56px - var(--gc-bottomnav-h) - 12px - env(safe-area-inset-bottom)); min-height:0; border:0; border-radius:0; max-width:none; }
  .ch-scroll { padding:var(--gc-space-2) var(--gc-space-3); }
  .ch-col { max-width:82%; }
  .ch-av { width:28px; }
  .ch-foot { padding:var(--gc-space-2); }
  .ch-jump { bottom:110px; }
}`;

const body = `
<div class="ch" id="chat">
  <div class="ch-head">
    <a class="ch-group" href="/people" title="Household"><span class="gc-avatars" id="chAvatars"></span><span class="ch-title"><strong id="chTitle">Household</strong><span class="ch-sub" id="chMembers"></span></span></a>
    <span class="gc-spacer"></span>
    <span id="chMode"></span>
    <span id="chTip"></span>
  </div>
  <div class="ch-banner" id="chBanner" hidden>${icon("info", { size: 18 })}<span id="chBannerText"></span></div>
  <div class="ch-scroll" id="chScroll">
    <div class="ch-earlier"><button class="gc-btn gc-btn-text gc-btn-sm" id="chEarlier" type="button" hidden>Load earlier</button></div>
    <ol class="ch-list" id="chList" aria-live="polite" aria-label="Messages"></ol>
    <div class="ch-row is-bot ch-typing" id="chTyping" hidden><span class="ch-av">${BOT_AVATAR(32)}</span><div class="ch-dots" aria-label="GroupCart is typing"><span></span><span></span><span></span></div></div>
  </div>
  <button class="ch-jump" id="chJump" type="button" hidden>${icon("chevronDown", { size: 16 })}New messages</button>
  <div class="ch-foot">
    <div class="ch-suggest" id="chSuggest"></div>
    <div class="ch-preview" id="chPreview" hidden><img id="chPreviewImg" alt="Photo to send" /><button type="button" id="chPreviewRemove" aria-label="Remove photo">${icon("close", { size: 14 })}</button></div>
    <form class="ch-composer" id="chForm" autocomplete="off">
      <label class="ch-attach" title="Add a photo" tabindex="0" id="chAttach">${icon("photo", { size: 22 })}<span class="gc-sr">Add a photo</span><input type="file" id="chFile" accept="image/*" hidden /></label>
      <div class="ch-field">
        <textarea class="ch-input" id="chInput" rows="1" placeholder="Message" aria-label="Message" enterkeyhint="send"></textarea>
        <button class="ch-send" id="chSend" type="submit" aria-label="Send" disabled>${icon("arrowUp", { size: 18 })}</button>
      </div>
    </form>
  </div>
</div>`;

const script = `
const GC = window.GC;
const $ = (id) => document.getElementById(id);
const scroller = $("chScroll"), list = $("chList"), input = $("chInput"), sendButton = $("chSend");
const BOT_AVATAR = ${JSON.stringify(BOT_AVATAR(32))};
const state = { messages: [], ids: new Set(), pending: [], me: null, household: [], typing: false, expectReply: false, live: false, groupConnected: true, hasEarlier: false, file: null, fileUrl: null };
let stick = true;

const dayKey = (date) => date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate();
function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return "Today";
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  if (today - date < 6 * 864e5) return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
const clock = (date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fullTime = (date) => date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function linkify(text) {
  const parts = String(text).split(/(https?:\\/\\/[^\\s<>"]+)/g);
  return parts.map((part, index) => {
    if (index % 2 === 0) return GC.esc(part);
    const trail = (part.match(/[.,!?;:)\\]]+$/) || [""])[0];
    const url = trail ? part.slice(0, -trail.length) : part;
    return '<a href="' + GC.esc(url) + '" target="_blank" rel="noopener noreferrer">' + GC.esc(url) + '</a>' + GC.esc(trail);
  }).join("");
}
function emojiOnly(text) {
  const trimmed = String(text).trim();
  if (!trimmed || /[0-9A-Za-z#*]/.test(trimmed)) return false;
  if (!/^(?:\\p{Extended_Pictographic}|\\p{Emoji_Component}|\\s)+$/u.test(trimmed)) return false;
  const count = (trimmed.match(/\\p{Extended_Pictographic}/gu) || []).length;
  return count > 0 && count <= 3;
}
function memberLook(id) { return state.household.find((member) => member.id === id) || null; }
const allIds = () => state.household.map((member) => member.id);
function avatarFor(message) {
  if (message.kind === "bot") return BOT_AVATAR;
  const member = memberLook(message.memberId) || { id: message.memberId || message.name, name: message.name };
  return GC.avatar(member, allIds(), 32);
}
const authorKey = (message) => message.kind === "bot" ? "bot" : (message.memberId || message.name);
const isMine = (message) => message.kind === "member" && state.me && message.memberId === state.me.id;

function attachmentHtml(item) {
  if (item.image && item.url) {
    return '<a class="ch-img-link" href="' + GC.esc(item.url) + '" target="_blank" rel="noopener"><img class="ch-img" src="' + GC.esc(item.url) + '" alt="' + GC.esc(item.name || "Photo") + '" loading="lazy" /></a>';
  }
  return '<span class="ch-file">' + GC.icon("photo") + GC.esc(item.name || "Attachment") + '</span>';
}

function render() {
  const items = state.messages.concat(state.pending);
  const lastMine = (() => { for (let i = items.length - 1; i >= 0; i -= 1) if (isMine(items[i]) || items[i].pending) return items[i]; return null; })();
  let html = "";
  for (let index = 0; index < items.length; index += 1) {
    const message = items[index];
    const prev = items[index - 1];
    const next = items[index + 1];
    const at = new Date(message.at);
    const prevAt = prev ? new Date(prev.at) : null;
    const separator = !prev || dayKey(prevAt) !== dayKey(at) || at - prevAt > 60 * 60e3;
    if (separator) html += '<li class="ch-sep"><strong>' + GC.esc(dayLabel(at)) + '</strong> ' + GC.esc(clock(at)) + '</li>';
    const nextAt = next ? new Date(next.at) : null;
    const nextSeparator = next && (dayKey(nextAt) !== dayKey(at) || nextAt - at > 60 * 60e3);
    const first = separator || !prev || authorKey(prev) !== authorKey(message) || at - prevAt > 5 * 60e3;
    const last = !next || nextSeparator || authorKey(next) !== authorKey(message) || nextAt - at > 5 * 60e3;
    const mine = isMine(message) || message.pending;
    const kind = message.kind === "bot" ? "is-bot" : mine ? "is-mine" : "is-other";
    const classes = ["ch-row", kind, first ? "is-first" : "", last ? "is-last" : "", message.pending ? "is-pending" : ""].filter(Boolean).join(" ");
    let col = "";
    if (!mine && first) col += '<div class="ch-name">' + GC.esc(message.name) + '</div>';
    for (const item of message.attachments || []) col += attachmentHtml(item);
    if (message.text) col += emojiOnly(message.text) ? '<div class="ch-emoji" title="' + GC.esc(fullTime(at)) + '">' + GC.esc(message.text) + '</div>' : '<div class="ch-bubble" title="' + GC.esc(fullTime(at)) + '">' + linkify(message.text) + '</div>';
    if (message === lastMine) {
      col += message.failed
        ? '<div class="ch-status is-failed">' + GC.esc(message.error || "Not sent") + ' · <button type="button" data-retry="' + GC.esc(message.tempId) + '">Retry</button></div>'
        : '<div class="ch-status">' + (message.pending ? "Sending…" : state.live ? "Sent to iMessage" : "Delivered") + '</div>';
    }
    html += '<li class="' + classes + '" data-id="' + GC.esc(message.id || message.tempId) + '">'
      + (mine ? "" : '<span class="ch-av">' + (last ? avatarFor(message) : "") + '</span>')
      + '<div class="ch-col">' + col + '</div></li>';
  }
  list.innerHTML = html || '<li class="ch-empty">' + GC.icon("message") + '<p data-flavor="empty.chat.title">No messages yet. Say hi!</p></li>';
  $("chTyping").hidden = !(state.typing || state.expectReply);
  $("chEarlier").hidden = !state.hasEarlier;
  list.querySelectorAll("img").forEach((img) => img.addEventListener("load", () => { if (stick) toBottom(); }, { once: true }));
}

function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96; }
function toBottom() { scroller.scrollTop = scroller.scrollHeight; $("chJump").hidden = true; }
scroller.addEventListener("scroll", () => { stick = nearBottom(); if (stick) $("chJump").hidden = true; });
$("chJump").addEventListener("click", () => { stick = true; toBottom(); });

function merge(messages) {
  let added = 0;
  for (const message of messages) {
    if (state.ids.has(message.id)) continue;
    state.ids.add(message.id);
    state.messages.push(message);
    added += 1;
  }
  state.messages.sort((a, b) => a.id - b.id);
  return added;
}

function renderHeader() {
  const ids = allIds();
  $("chAvatars").innerHTML = state.household.slice(0, 4).map((member) => GC.avatar(member, ids, 28)).join("");
  $("chMembers").textContent = state.household.map((member) => member.name).join(", ");
  $("chMode").innerHTML = state.live ? GC.chip("iMessage", "accent", "message") : GC.chip("Demo", "neutral");
  input.placeholder = state.me ? "Message as " + state.me.name : "Message";
  const banner = state.live && !state.groupConnected;
  $("chBanner").hidden = !banner;
  $("chBannerText").textContent = banner ? "Waiting for the iMessage group. Send any message there to connect." : "";
  input.disabled = banner;
  $("chAttach").style.pointerEvents = banner ? "none" : "";
  updateSend();
  const chips = ["cart", "help", "2 bananas", "approve"];
  $("chSuggest").innerHTML = chips.map((text) => '<button type="button" data-suggest="' + GC.esc(text) + '">' + GC.esc(text) + '</button>').join("");
  $("chSuggest").hidden = Boolean(input.value.trim() || state.file);
}

async function load(params) {
  const response = await fetch("/api/chat/messages?" + params, { headers: { accept: "application/json" } });
  if (response.status === 401) { location.href = "/signin?next=/chat"; throw new Error("Signed out"); }
  if (!response.ok) throw new Error("Could not load messages");
  return response.json();
}

async function initial() {
  const data = await load("limit=60");
  state.me = data.me; state.household = data.household; state.live = data.live; state.groupConnected = data.groupConnected;
  state.typing = data.typing; state.hasEarlier = data.hasEarlier;
  $("chTitle").textContent = data.householdName || "Household";
  $("chTip").innerHTML = data.live
    ? ${JSON.stringify(infoTip("Same conversation as the iMessage group. What you send here posts to the group as “Your name: …”."))}
    : ${JSON.stringify(infoTip("Demo: try “2 bananas”, “cart”, or “help”. Nothing is sent to iMessage."))};
  merge(data.messages);
  renderHeader();
  render();
  toBottom();
}

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const last = state.messages.length ? state.messages[state.messages.length - 1].id : 0;
    const data = await load("after=" + last + "&limit=100");
    const wasNear = nearBottom();
    const added = merge(data.messages);
    const typingChanged = state.typing !== data.typing;
    state.typing = data.typing;
    if (added && data.messages.some((message) => message.kind === "bot")) state.expectReply = false;
    if (!data.typing && state.expectReply && !added) state.expectReply = state.expectReply === "first" ? false : "first";
    if (state.groupConnected !== data.groupConnected) { state.groupConnected = data.groupConnected; renderHeader(); }
    if (added || typingChanged) {
      render();
      if (wasNear || stick) toBottom(); else if (added) $("chJump").hidden = false;
    }
  } catch (error) { /* keep polling */ }
  pollTimer = setTimeout(poll, document.hidden ? 6000 : 1500);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

$("chEarlier").addEventListener("click", async () => {
  const first = state.messages[0];
  if (!first) return;
  const data = await load("before=" + first.id + "&limit=60");
  const height = scroller.scrollHeight;
  merge(data.messages);
  state.hasEarlier = data.hasEarlier;
  render();
  scroller.scrollTop = scroller.scrollHeight - height;
});

async function prepareImage(file) {
  if (/^image\\/(png|jpeg|gif|webp)$/.test(file.type) && file.size <= 4 * 1024 * 1024) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Couldn’t read that image.")); image.src = url; });
    const scale = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  } finally { URL.revokeObjectURL(url); }
}

async function send(text, file, retryOf) {
  const temp = retryOf || { tempId: "t" + Date.now() + Math.random().toString(36).slice(2, 6), kind: "member", name: state.me ? state.me.name : "", text, attachments: [], at: new Date().toISOString(), pending: true, file };
  temp.failed = false; temp.pending = true;
  if (file && !temp.attachments.length) temp.attachments = [{ image: true, url: URL.createObjectURL(file), name: file.name }];
  if (!retryOf) state.pending.push(temp);
  stick = true;
  render(); toBottom();
  try {
    let response;
    if (file) {
      const blob = await prepareImage(file);
      response = await fetch("/api/chat/messages", { method: "POST", headers: { "content-type": blob.type || "application/octet-stream", "x-gc-request": "1", "x-gc-text": encodeURIComponent(text), "x-gc-filename": encodeURIComponent(file.name || "photo") }, body: blob });
    } else {
      response = await fetch("/api/chat/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Not sent");
    state.pending = state.pending.filter((item) => item !== temp);
    merge([data.message]);
    state.expectReply = true;
    render(); toBottom();
    setTimeout(poll, 300);
  } catch (error) {
    temp.pending = true; temp.failed = true; temp.error = error.message;
    render();
  }
}

list.addEventListener("click", (event) => {
  const retry = event.target.closest("[data-retry]");
  if (!retry) return;
  const temp = state.pending.find((item) => item.tempId === retry.getAttribute("data-retry"));
  if (temp) send(temp.text, temp.file, temp);
});

function updateSend() {
  sendButton.disabled = input.disabled || !(input.value.trim() || state.file);
  $("chSuggest").hidden = Boolean(input.value.trim() || state.file);
}
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
input.addEventListener("input", () => { autosize(); updateSend(); });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("chForm").requestSubmit(); }
});
function clearFile() {
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.file = null; state.fileUrl = null; $("chFile").value = ""; $("chPreview").hidden = true; updateSend();
}
$("chFile").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  clearFile();
  state.file = file; state.fileUrl = URL.createObjectURL(file);
  $("chPreviewImg").src = state.fileUrl; $("chPreview").hidden = false;
  updateSend(); input.focus();
});
$("chAttach").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); $("chFile").click(); } });
$("chPreviewRemove").addEventListener("click", clearFile);
$("chForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  const file = state.file;
  if (!text && !file) return;
  input.value = ""; autosize();
  state.file = null; $("chPreview").hidden = true; $("chFile").value = "";
  updateSend();
  send(text, file);
  input.focus();
});
$("chSuggest").addEventListener("click", (event) => {
  const chipButton = event.target.closest("[data-suggest]");
  if (!chipButton) return;
  const text = chipButton.getAttribute("data-suggest");
  if (state.live) { input.value = text; autosize(); updateSend(); input.focus(); }
  else send(text, null);
});

initial().then(() => { pollTimer = setTimeout(poll, 1500); }).catch(() => {
  list.innerHTML = '<li class="ch-empty">' + GC.icon("alert") + '<p>Couldn’t load the chat. Retrying…</p></li>';
  setTimeout(() => location.reload(), 5000);
});
`;

export function renderChatPage(): string {
  return renderPage({ title: "Chat", active: "chat", body, styles, script });
}

// ---------------------------------------------------------------------------
// Home card
// ---------------------------------------------------------------------------

const previewStyles = `
.hc-list .gc-list-item { padding:var(--gc-space-2) 0; align-items:flex-start; }
.hc-top { display:flex; align-items:baseline; gap:var(--gc-space-2); }
.hc-name { font-weight:500; font-size:var(--gc-fs-sm); }
.hc-time { color:var(--gc-muted); font-size:var(--gc-fs-xs); margin-left:auto; flex:none; }
.hc-text { color:var(--gc-text-2); font-size:var(--gc-fs-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hc-compose { display:flex; align-items:center; gap:var(--gc-space-2); height:40px; margin-top:var(--gc-space-3); padding:0 4px 0 16px; border:1px solid var(--gc-border-strong); border-radius:22px; color:var(--gc-muted); text-decoration:none; }
.hc-compose:hover { background:var(--gc-hover); }
.hc-compose span:first-child { flex:1; }
.hc-send { width:32px; height:32px; display:grid; place-items:center; border-radius:50%; background:var(--gc-accent); color:var(--gc-on-accent); }
.hc-list .ch-bot-avatar { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }`;

const previewScript = `
document.addEventListener("DOMContentLoaded", function () {
  var GC = window.GC;
  var listEl = document.getElementById("homeChatList");
  if (!listEl) return;
  var bot = ${JSON.stringify(BOT_AVATAR(28))};
  function load() {
    fetch("/api/chat/messages?limit=3", { headers: { accept: "application/json" } })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (!data) return;
        var ids = data.household.map(function (member) { return member.id; });
        listEl.innerHTML = data.messages.length ? data.messages.map(function (message) {
          var member = data.household.find(function (m) { return m.id === message.memberId; }) || { id: message.memberId || message.name, name: message.name };
          var text = message.text || (message.attachments.length ? "📷 Photo" : "");
          return '<li class="gc-list-item">' + (message.kind === "bot" ? bot : GC.avatar(member, ids, 28))
            + '<div class="gc-list-main"><div class="hc-top"><span class="hc-name">' + GC.esc(message.name) + '</span><span class="hc-time">' + GC.esc(GC.time(new Date(message.at))) + '</span></div>'
            + '<div class="hc-text">' + GC.esc(text.split("\\n")[0]) + '</div></div></li>';
        }).join("") : '<li class="gc-empty"><p class="gc-empty-text">No messages yet.</p></li>';
      })
      .catch(function () {});
  }
  load();
  setInterval(load, 4000);
});`;

/** Home card: the last few group messages and a link to the composer. */
export function chatPreviewCard(): string {
  return `<style>${previewStyles}</style>${card({
    id: "homeChat",
    title: "Chat",
    icon: "message",
    actions: button({ label: "Open", variant: "text", size: "sm", href: "/chat" }),
    body: `<ul class="gc-list hc-list" id="homeChatList" aria-live="polite"><li class="gc-empty"><p class="gc-empty-text">Loading…</p></li></ul>
<a class="hc-compose" href="/chat"><span>Message the group</span><span class="hc-send">${icon("arrowUp", { size: 16 })}</span></a>`,
  })}<script>${previewScript}</script>`;
}

