import { CLIENT_SPLIT_JS } from "../billSplit.js";
import { button, chip, dialog, icon, renderPage } from "./shell.js";

/**
 * Bills page (route "/bills"): drop a bill (or type one in), review the split, see
 * what's due, and settle up. Client-rendered from GET /api/bills (polled every 5 s
 * while no dialog is open). All writes are same-origin JSON POSTs to /api/bills/*.
 */

const styles = `
.bl-drop { position:relative; border:1.5px dashed var(--gc-border-strong); background:var(--gc-surface-2); transition:background-color .15s ease, border-color .15s ease; }
.bl-drop.is-over { border-color:var(--gc-accent); background:var(--gc-accent-soft); }
.bl-drop-main { display:flex; align-items:center; gap:var(--gc-space-4); flex-wrap:wrap; }
.bl-drop-icon { width:48px; height:48px; flex:none; display:grid; place-items:center; border-radius:14px; background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.bl-drop-text { flex:1; min-width:160px; }
.bl-drop-title { font-size:var(--gc-fs-lg); font-weight:500; }
.bl-drop-actions { display:flex; gap:var(--gc-space-2); flex-wrap:wrap; }
.bl-drop-foot { display:flex; align-items:center; gap:var(--gc-space-2) var(--gc-space-4); flex-wrap:wrap; margin-top:var(--gc-space-3); padding-top:var(--gc-space-3); border-top:1px solid var(--gc-border); }
.bl-label { color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; }
.bl-people { display:flex; gap:6px; flex-wrap:wrap; }
.bl-person { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 10px 0 3px; border-radius:var(--gc-radius-pill); border:1px solid var(--gc-border); background:var(--gc-surface); color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.bl-person:hover { background:var(--gc-hover); }
.bl-person[aria-pressed="true"] { background:var(--gc-accent-soft); border-color:transparent; color:var(--gc-on-accent-soft); }
.bl-samples { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.bl-busy { position:absolute; inset:0; display:none; place-items:center; border-radius:inherit; background:color-mix(in srgb, var(--gc-surface) 82%, transparent); font-weight:500; gap:8px; }
.bl-drop.is-busy .bl-busy { display:grid; }
.bl-spin { width:22px; height:22px; border-radius:50%; border:2.5px solid var(--gc-accent-soft); border-top-color:var(--gc-accent); animation:bl-spin .8s linear infinite; }
@keyframes bl-spin { to { transform:rotate(360deg); } }

.bl-row { cursor:pointer; border-radius:var(--gc-radius-md); margin:0 calc(-1 * var(--gc-space-2)); padding-left:var(--gc-space-2); padding-right:var(--gc-space-2); }
.bl-row:hover { background:var(--gc-hover); }
.bl-row + .bl-row { border-top-color:transparent; }
.bl-date { width:44px; flex:none; display:grid; justify-items:center; line-height:1.05; padding:4px 0; border-radius:10px; }
.bl-date-mon { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--gc-muted); }
.bl-date-day { font-size:22px; font-weight:400; font-variant-numeric:tabular-nums; }
.bl-date.is-soon { background:var(--gc-warning-soft); } .bl-date.is-soon .bl-date-mon, .bl-date.is-soon .bl-date-day { color:var(--gc-warning); }
.bl-date.is-late { background:var(--gc-danger-soft); } .bl-date.is-late .bl-date-mon, .bl-date.is-late .bl-date-day { color:var(--gc-danger); }
.bl-emoji { width:40px; height:40px; flex:none; display:grid; place-items:center; border-radius:12px; font-size:20px; background:var(--bl-tint, var(--gc-surface-2)); }
.bl-title { display:flex; align-items:center; gap:8px; min-width:0; font-weight:500; }
.bl-title > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bl-title .bl-mini { font-size:16px; line-height:1; }
.bl-sub { display:flex; align-items:center; gap:8px; margin-top:4px; color:var(--gc-muted); font-size:var(--gc-fs-xs); flex-wrap:wrap; }
.bl-arrow { color:var(--gc-muted); display:inline-flex; }
.bl-trail { display:grid; justify-items:end; gap:4px; }
.bl-thumb { width:44px; height:44px; flex:none; border-radius:10px; object-fit:cover; background:var(--gc-surface-2); border:1px solid var(--gc-border); }
.bl-cat-rent { --bl-tint:color-mix(in srgb, #3f51b5 16%, transparent); }
.bl-cat-utilities { --bl-tint:color-mix(in srgb, #e37400 18%, transparent); }
.bl-cat-internet { --bl-tint:color-mix(in srgb, #0277bd 16%, transparent); }
.bl-cat-groceries { --bl-tint:color-mix(in srgb, #0b8043 16%, transparent); }
.bl-cat-household { --bl-tint:color-mix(in srgb, #8e24aa 14%, transparent); }
.bl-cat-other { --bl-tint:var(--gc-surface-2); }

.bl-bal { list-style:none; margin:0; padding:0; }
.bl-bal li { display:flex; align-items:center; gap:var(--gc-space-3); padding:6px 0; }
.bl-bal-name { flex:1; min-width:0; font-weight:500; }
.bl-amt { font-variant-numeric:tabular-nums; font-weight:500; white-space:nowrap; }
.bl-pos { color:var(--gc-success); } .bl-neg { color:var(--gc-danger); } .bl-zero { color:var(--gc-muted); font-weight:400; font-size:var(--gc-fs-sm); }
.bl-settle { margin-top:var(--gc-space-3); padding-top:var(--gc-space-3); border-top:1px solid var(--gc-border); display:grid; gap:var(--gc-space-2); }
.bl-transfer { display:flex; align-items:center; gap:8px; }
.bl-transfer .bl-amt { margin-left:auto; }
.bl-even { display:flex; align-items:center; gap:var(--gc-space-2); color:var(--gc-success); font-weight:500; padding:var(--gc-space-2) 0; }
.bl-conn { display:grid; grid-template-columns:minmax(0,1fr); gap:var(--gc-space-3); }
.bl-conn-row { display:flex; align-items:center; gap:var(--gc-space-3); min-width:0; }
.bl-conn-row .gc-card-icon { width:36px; height:36px; }
.bl-conn-name { flex:1; min-width:0; font-weight:500; }
.bl-conn-name .gc-meta { display:block; font-weight:400; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

#blBill.gc-dialog { width:min(560px, calc(100vw - 32px)); }
#blBill[open], #blPay[open] { display:flex; flex-direction:column; }
#blBill .gc-dialog-body, #blPay .gc-dialog-body { flex:1; min-height:0; }
#blBill .gc-dialog-actions { border-top:1px solid var(--gc-border); }
.bl-preview { display:block; width:100%; max-height:200px; object-fit:contain; border-radius:var(--gc-radius-md); background:var(--gc-surface-2); border:1px solid var(--gc-border); margin-bottom:var(--gc-space-3); }
.bl-reading { margin-bottom:var(--gc-space-3); display:flex; gap:6px; flex-wrap:wrap; }
.bl-hint { display:flex; gap:8px; align-items:flex-start; padding:10px 12px; border-radius:var(--gc-radius-md); background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); font-size:var(--gc-fs-sm); margin-bottom:var(--gc-space-3); }
.bl-fields { display:grid; grid-template-columns:1fr 1fr; gap:var(--gc-space-3); }
.bl-field { display:grid; gap:4px; min-width:0; }
.bl-field .gc-input, .bl-field .gc-select { width:100%; }
.bl-money { position:relative; }
.bl-money::before { content:"$"; position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--gc-muted); pointer-events:none; }
.bl-money .gc-input { padding-left:24px; font-variant-numeric:tabular-nums; }
.bl-section { margin-top:var(--gc-space-4); display:grid; gap:var(--gc-space-2); }
.bl-seg { display:inline-flex; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); overflow:hidden; width:100%; }
.bl-seg button { flex:1; height:34px; border:0; background:transparent; color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:4px; }
.bl-seg button + button { border-left:1px solid var(--gc-border-strong); }
.bl-seg button[aria-pressed="true"] { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.bl-seg button:disabled { opacity:.4; cursor:not-allowed; }
.bl-split { list-style:none; margin:0; padding:0; display:grid; gap:2px; }
.bl-split li { display:flex; align-items:center; gap:var(--gc-space-2); min-height:44px; }
.bl-split .bl-who { flex:1; min-width:0; display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:500; }
.bl-split .bl-who input { width:18px; height:18px; accent-color:var(--gc-accent); margin:0; }
.bl-split li.is-out .bl-who { color:var(--gc-muted); font-weight:400; }
.bl-split li.is-out .gc-avatar { opacity:.35; }
.bl-split .bl-in { width:92px; flex:none; }
.bl-split .bl-in .gc-input { height:34px; text-align:right; }
.bl-pct { position:relative; } .bl-pct::after { content:"%"; position:absolute; right:10px; top:50%; transform:translateY(-50%); color:var(--gc-muted); pointer-events:none; } .bl-pct .gc-input { padding-right:24px; }
.bl-share { width:80px; flex:none; text-align:right; font-variant-numeric:tabular-nums; font-weight:500; }
.bl-items { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
.bl-items li { display:flex; align-items:center; gap:var(--gc-space-2); padding:6px 0; border-top:1px solid var(--gc-border); }
.bl-items li:first-child { border-top:0; }
.bl-item-main { flex:1; min-width:0; }
.bl-item-name { font-size:var(--gc-fs-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bl-toggles { display:flex; gap:4px; margin-top:4px; }
.bl-toggle { padding:0; border:0; background:transparent; border-radius:50%; cursor:pointer; }
.bl-toggle[aria-pressed="false"] .gc-avatar { opacity:.25; filter:grayscale(1); }
.bl-check { display:flex; align-items:center; gap:8px; padding:10px 12px; border-radius:var(--gc-radius-md); font-size:var(--gc-fs-sm); font-weight:500; }
.bl-check.ok { background:var(--gc-success-soft); color:var(--gc-success); }
.bl-check.bad { background:var(--gc-warning-soft); color:var(--gc-warning); }
.bl-switch { display:flex; align-items:center; gap:var(--gc-space-2); cursor:pointer; font-weight:500; }
.bl-switch input { width:18px; height:18px; accent-color:var(--gc-accent); margin:0; }
.bl-foot-note { color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.bl-danger { color:var(--gc-danger) !important; }
.bl-dialog-actions { display:flex; align-items:center; gap:var(--gc-space-2); width:100%; flex-wrap:wrap; }
.bl-err { color:var(--gc-danger); font-size:var(--gc-fs-sm); }
.bl-err:empty { display:none; }
.bl-pay-grid { display:grid; grid-template-columns:1fr auto 1fr; gap:var(--gc-space-2); align-items:end; }
.bl-pay-grid .bl-arrow { padding-bottom:10px; }
.bl-toast { position:fixed; left:50%; bottom:calc(var(--gc-space-5) + env(safe-area-inset-bottom)); transform:translateX(-50%) translateY(20px); opacity:0; z-index:40; max-width:min(560px, calc(100vw - 32px)); padding:12px 16px; border-radius:var(--gc-radius-md); background:var(--gc-tooltip-bg); color:var(--gc-tooltip-text); font-size:var(--gc-fs-sm); box-shadow:0 4px 12px rgba(0,0,0,.2); transition:opacity .2s ease, transform .2s ease; pointer-events:none; }
.bl-toast.is-on { opacity:1; transform:translateX(-50%) translateY(0); }
@media (max-width: 760px) {
  #blBill.gc-dialog { width:100%; }
  .bl-fields { grid-template-columns:1fr 1fr; }
  .bl-split .bl-in { width:84px; }
  .bl-share { width:70px; }
  .bl-toast { bottom:calc(var(--gc-bottomnav-h) + var(--gc-space-4) + env(safe-area-inset-bottom)); }
  .bl-drop-actions { width:100%; }
  .bl-drop-actions .gc-btn { flex:1; }
}
`;

const body = `
<div class="bl">
  <div class="gc-grid">
    <div class="gc-stack">
      <section class="gc-card bl-drop" id="blDrop" aria-label="Add a bill">
        <div class="bl-drop-main">
          <span class="bl-drop-icon">${icon("receipt", { size: 26 })}</span>
          <div class="bl-drop-text"><p class="bl-drop-title">Drop a bill</p><p class="gc-meta">Photo, screenshot, or PDF</p></div>
          <div class="bl-drop-actions">
            ${button({ label: "Upload", icon: "plus", id: "blPick" })}
            ${button({ label: "Type it in", variant: "outline", id: "blManual" })}
          </div>
        </div>
        <div class="bl-drop-foot">
          <span class="bl-label">Paid by</span><div class="bl-people" id="blPayer" role="group" aria-label="Paid by"></div>
          <span class="gc-spacer"></span>
          <div class="bl-samples" id="blSamples" hidden><span class="bl-label">Try</span></div>
        </div>
        <input type="file" id="blFile" accept="image/png,image/jpeg,image/heic,image/heif,image/webp,application/pdf" hidden />
        <div class="bl-busy" aria-live="polite"><span class="bl-spin"></span><span id="blBusyText">Reading…</span></div>
      </section>
      <section class="gc-card" id="blReview" hidden>
        <div class="gc-card-head"><h2 class="gc-card-title">To review</h2><span class="gc-meta" id="blReviewMeta"></span></div>
        <ul class="gc-list" id="blReviewList"></ul>
      </section>
      <section class="gc-card" id="blUpcoming">
        <div class="gc-card-head"><span class="gc-card-icon">${icon("calendar", { size: 20 })}</span><h2 class="gc-card-title">Upcoming</h2><span class="gc-meta" id="blUpcomingMeta"></span></div>
        <ul class="gc-list" id="blUpcomingList"></ul>
      </section>
      <section class="gc-card" id="blPaid" hidden>
        <div class="gc-card-head"><span class="gc-card-icon">${icon("checkCircle", { size: 20 })}</span><h2 class="gc-card-title">Paid</h2></div>
        <ul class="gc-list" id="blPaidList"></ul>
      </section>
    </div>
    <div class="gc-stack">
      <section class="gc-card" id="blBalances">
        <div class="gc-card-head"><span class="gc-card-icon">${icon("wallet", { size: 20 })}</span><h2 class="gc-card-title">Balances</h2><span class="gc-spacer"></span>${button({ label: "Record payment", variant: "tonal", size: "sm", id: "blPayOpen" })}</div>
        <div id="blBalancesBody"></div>
      </section>
      <section class="gc-card" id="blConnections">
        <div class="gc-card-head"><h2 class="gc-card-title">Connections</h2><span class="gc-spacer"></span>${button({ label: "Settings", variant: "text", size: "sm", href: "/settings" })}</div>
        <div class="bl-conn" id="blConn"></div>
      </section>
    </div>
  </div>
  ${dialog({ id: "blBill", title: "Bill", body: `<div id="blBillBody"></div>`, actions: `<div class="bl-dialog-actions"><button type="button" class="gc-btn gc-btn-text bl-danger" id="blDelete">Delete</button><span class="gc-spacer"></span><span class="bl-err" id="blBillErr"></span>${button({ label: "Mark paid", variant: "outline", id: "blMarkPaid" })}${button({ label: "Save", id: "blSave" })}</div>` })}
  ${dialog({ id: "blPay", title: "Record payment", body: `<div class="bl-pay-grid">
      <label class="bl-field"><span class="bl-label">From</span><select class="gc-select" id="blPayFrom"></select></label>
      <span class="bl-arrow">${icon("chevronRight", { size: 20 })}</span>
      <label class="bl-field"><span class="bl-label">To</span><select class="gc-select" id="blPayTo"></select></label>
    </div>
    <label class="bl-field" style="margin-top:12px"><span class="bl-label">Amount</span><span class="bl-money"><input class="gc-input" id="blPayAmount" inputmode="decimal" autocomplete="off" placeholder="0.00" /></span></label>
    <p class="bl-err" id="blPayErr" style="margin-top:8px"></p>`, actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Record", id: "blPaySave" })}` })}
  <div class="bl-toast" id="blToast" role="status" aria-live="polite"></div>
</div>`;

const script = String.raw`
${CLIENT_SPLIT_JS}
(function () {
  var GC = window.GC, Split = window.BillSplit;
  var $ = function (id) { return document.getElementById(id); };
  var CATS = [["rent", "🏠", "Rent"], ["utilities", "⚡", "Utilities"], ["internet", "📶", "Internet"], ["groceries", "🛒", "Groceries"], ["household", "🧻", "Household"], ["other", "🧾", "Other"]];
  var EMOJI = {}; CATS.forEach(function (c) { EMOJI[c[0]] = c[1]; });
  var state = { data: null, payer: null, edit: null, busy: false };
  try { state.payer = localStorage.getItem("gc.bills.payer"); } catch (e) {}

  function ids() { return state.data ? state.data.members.map(function (m) { return m.id; }) : []; }
  function member(id) { return (state.data && state.data.members.find(function (m) { return m.id === id; })) || { id: id || "?", name: "Someone" }; }
  function first(name) { return String(name || "").split(/\s+/)[0]; }
  function money(c, cur) { if (!cur || cur === "USD") return GC.dollars(c); try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(c / 100); } catch (e) { return GC.dollars(c); } }
  function parseCents(text) {
    var v = String(text || "").trim().replace(/^\$/, "").replace(/,/g, "");
    if (!/^(\d{1,9}(\.\d{0,2})?|\.\d{1,2})$/.test(v)) return null;
    var parts = v.split(".");
    return Number(parts[0] || "0") * 100 + Number(((parts[1] || "") + "00").slice(0, 2));
  }
  function centsText(c) { return c == null ? "" : (c / 100).toFixed(2); }
  function days(iso) { return Math.round((Date.parse(iso + "T12:00:00") - Date.parse(state.data.today + "T12:00:00")) / 86400000); }
  function dateObj(iso) { return new Date(iso + "T12:00:00"); }
  function toast(text) { var t = $("blToast"); t.textContent = text; t.classList.add("is-on"); clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.classList.remove("is-on"); }, 4200); }

  async function post(path, payload) {
    var response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    var data = {};
    try { data = await response.json(); } catch (e) {}
    if (!response.ok) throw new Error(data.error || data.message || "Something went wrong.");
    return data;
  }

  // ---------- rendering ----------
  function statusChip(bill) {
    switch (bill.status) {
      case "paid": return GC.chip("Paid", "success", "check");
      case "overdue": return GC.chip("Overdue", "danger", "alert");
      case "due_soon": var d = days(bill.dueDate); return GC.chip(d === 0 ? "Due today" : d === 1 ? "Tomorrow" : "In " + d + " days", "warning", "clock");
      case "needs_reading": return GC.chip("Needs reading", "accent", "spark");
      case "draft": return GC.chip("Draft", "neutral");
      default: return bill.dueDate ? GC.chip(dateObj(bill.dueDate).toLocaleDateString([], { month: "short", day: "numeric" }), "neutral") : "";
    }
  }
  function dateBadge(bill) {
    if (!bill.dueDate) return '<span class="bl-emoji bl-cat-' + bill.category + '" aria-hidden="true">' + GC.esc(bill.emoji) + '</span>';
    var d = dateObj(bill.dueDate), n = days(bill.dueDate);
    var cls = bill.status === "paid" ? "" : n < 0 ? " is-late" : n <= 3 ? " is-soon" : "";
    return '<span class="bl-date' + cls + '" aria-hidden="true"><span class="bl-date-mon">' + d.toLocaleDateString([], { month: "short" }) + '</span><span class="bl-date-day">' + d.getDate() + '</span></span>';
  }
  function people(bill) {
    var all = ids();
    var owing = bill.shares.filter(function (s) { return s.cents > 0 && s.memberId !== bill.payerId; }).map(function (s) { return member(s.memberId); });
    var payer = bill.payerId ? GC.avatar(member(bill.payerId), all, 20) : "";
    return payer + (owing.length ? '<span class="bl-arrow">' + GC.icon("chevronRight") + '</span><span class="gc-avatars">' + owing.map(function (m) { return GC.avatar(m, all, 20); }).join("") + '</span>' : "");
  }
  function billRow(bill, withDate) {
    var title = '<span class="bl-title">' + (withDate && bill.dueDate ? '<span class="bl-mini" aria-hidden="true">' + GC.esc(bill.emoji) + '</span>' : "") + '<span>' + GC.esc(bill.vendor || "Bill") + '</span></span>';
    var sub = '<div class="bl-sub">' + people(bill) + (bill.recurring ? '<span title="Repeats monthly">' + GC.icon("sync") + '</span>' : "") + '</div>';
    return '<li class="gc-list-item bl-row" tabindex="0" role="button" data-bill="' + GC.esc(bill.id) + '">' + (withDate ? dateBadge(bill) : '<span class="bl-emoji bl-cat-' + bill.category + '" aria-hidden="true">' + GC.esc(bill.emoji) + '</span>')
      + '<div class="gc-list-main">' + title + sub + '</div><div class="bl-trail"><span class="gc-amount">' + (bill.totalCents ? money(bill.totalCents, bill.currency) : "–") + '</span>' + statusChip(bill) + '</div></li>';
  }
  function reviewRow(bill) {
    var thumb = bill.file && bill.file.preview ? '<img class="bl-thumb" alt="" src="/api/bills/files/' + GC.esc(bill.file.id) + (bill.file.mimeType === "application/pdf" ? "?preview=1" : "") + '" loading="lazy" />' : '<span class="bl-emoji bl-cat-' + bill.category + '" aria-hidden="true">' + GC.esc(bill.emoji) + '</span>';
    var name = bill.state === "needs_reading" ? (bill.vendor || "Bill image") : (bill.vendor || "Bill");
    var who = bill.ownerId ? GC.avatar(member(bill.ownerId), ids(), 20) + '<span>' + GC.esc(first(member(bill.ownerId).name)) + '</span>' : "";
    return '<li class="gc-list-item bl-row" tabindex="0" role="button" data-bill="' + GC.esc(bill.id) + '">' + thumb + '<div class="gc-list-main"><span class="bl-title"><span>' + GC.esc(name) + '</span></span><div class="bl-sub">' + who + '</div></div><div class="bl-trail">'
      + (bill.totalCents ? '<span class="gc-amount">' + money(bill.totalCents, bill.currency) + '</span>' : "") + statusChip(bill) + '</div></li>';
  }
  function renderLists() {
    var bills = state.data.bills;
    var review = bills.filter(function (b) { return b.state === "needs_reading" || b.state === "draft"; });
    $("blReview").hidden = !review.length;
    $("blReviewMeta").textContent = review.length ? String(review.length) : "";
    $("blReviewList").innerHTML = review.map(reviewRow).join("");
    var upcoming = bills.filter(function (b) { return b.state === "saved" && !b.paidAt; }).sort(function (a, b) { return (a.dueDate || "9999").localeCompare(b.dueDate || "9999"); });
    var total = upcoming.reduce(function (t, b) { return t + (b.currency === "USD" ? b.totalCents || 0 : 0); }, 0);
    $("blUpcomingMeta").textContent = upcoming.length ? GC.dollars(total) : "";
    $("blUpcomingList").innerHTML = upcoming.length ? upcoming.map(function (b) { return billRow(b, true); }).join("")
      : '<li class="gc-empty">' + GC.icon("checkCircle") + '<p class="gc-empty-title">All paid up</p><p class="gc-empty-text">New bills show up here.</p></li>';
    var paid = bills.filter(function (b) { return b.state === "saved" && b.paidAt; }).sort(function (a, b) { return String(b.paidAt).localeCompare(String(a.paidAt)); }).slice(0, 8);
    $("blPaid").hidden = !paid.length;
    $("blPaidList").innerHTML = paid.map(function (b) { return billRow(b, false); }).join("");
  }
  function renderPayer() {
    var members = state.data.members;
    if (!members.some(function (m) { return m.id === state.payer; })) state.payer = members[0] ? members[0].id : null;
    $("blPayer").innerHTML = members.map(function (m) {
      return '<button type="button" class="bl-person" data-payer="' + GC.esc(m.id) + '" aria-pressed="' + (m.id === state.payer) + '">' + GC.avatar(m, ids(), 26) + GC.esc(first(m.name)) + '</button>';
    }).join("");
    var samples = state.data.samples || [];
    $("blSamples").hidden = !samples.length;
    if (samples.length && !$("blSamples").querySelector("button")) {
      $("blSamples").insertAdjacentHTML("beforeend", samples.filter(function (k) { return k !== "water"; }).map(function (k) {
        return '<button type="button" class="gc-btn gc-btn-text gc-btn-sm" data-sample="' + k + '">' + (k === "gas" ? "🔥 Gas bill" : k === "cleaning" ? "🧽 Cleaning invoice" : k) + '</button>';
      }).join(""));
    }
  }
  function renderBalances() {
    var b = state.data.balances, all = ids();
    var rows = b.net.slice().sort(function (x, y) { return y.cents - x.cents; }).map(function (e) {
      var m = state.data.members.find(function (x) { return x.id === e.memberId; }) || { id: e.memberId, name: e.name };
      var amt = e.cents > 0 ? '<span class="bl-amt bl-pos">+' + GC.dollars(e.cents) + '</span>' : e.cents < 0 ? '<span class="bl-amt bl-neg">−' + GC.dollars(-e.cents) + '</span>' : '<span class="bl-amt bl-zero">Even</span>';
      return '<li>' + GC.avatar(m, all, 32) + '<span class="bl-bal-name">' + GC.esc(m.name) + '</span>' + amt + '</li>';
    }).join("");
    var settle = b.transfers.length
      ? '<div class="bl-settle"><span class="bl-label">Settle up</span>' + b.transfers.map(function (t, i) {
        return '<div class="bl-transfer">' + GC.avatar({ id: t.fromId, name: t.fromName }, all, 24) + '<span class="bl-arrow">' + GC.icon("chevronRight") + '</span>' + GC.avatar({ id: t.toId, name: t.toName }, all, 24)
          + '<span class="gc-meta">' + GC.esc(first(t.fromName)) + ' pays ' + GC.esc(first(t.toName)) + '</span><span class="bl-amt">' + GC.dollars(t.cents) + '</span><button type="button" class="gc-btn gc-btn-text gc-btn-sm" data-settle="' + i + '">Record</button></div>';
      }).join("") + '</div>'
      : '<div class="bl-even">' + GC.icon("checkCircle") + 'Everyone’s even</div>';
    $("blBalancesBody").innerHTML = '<ul class="bl-bal">' + rows + '</ul>' + settle;
  }
  function renderConnections() {
    var i = state.data.integrations, sw = i.splitwise, an = i.anthropic;
    var swChip = sw.live ? GC.chip("Connected", "success", "check") : GC.chip("Simulated", "neutral");
    var swSub = sw.lastBill ? "Last: " + sw.lastBill.vendor + " · " + sw.lastBill.status : sw.live ? "Logs each saved bill" : "Nothing is sent";
    var anChip = an.configured ? GC.chip("Claude", "success", "check") : GC.chip("Your Claude", "accent", "spark");
    var anSub = an.configured ? an.model : "Ask your Claude to read images";
    $("blConn").innerHTML = '<div class="bl-conn-row"><span class="gc-card-icon">' + GC.icon("receipt") + '</span><span class="bl-conn-name">Splitwise<span class="gc-meta">' + GC.esc(swSub) + '</span></span>' + swChip + '</div>'
      + '<div class="bl-conn-row"><span class="gc-card-icon">' + GC.icon("spark") + '</span><span class="bl-conn-name">Bill reading<span class="gc-meta">' + GC.esc(anSub) + '</span></span>' + anChip + '</div>';
  }
  function render() { renderPayer(); renderLists(); renderBalances(); renderConnections(); }

  async function refresh() {
    if (document.querySelector("dialog[open]") || state.busy) return;
    var response = await fetch("/api/bills");
    if (!response.ok) throw new Error("Could not load bills");
    state.data = await response.json();
    $("mode").innerHTML = state.data.demoMode ? GC.chip("Demo", "neutral") : GC.chip("Live", "accent", "lock");
    $("sync").classList.remove("is-paused");
    $("syncState").textContent = "Synced " + GC.time();
    render();
  }
  function showSyncError(error) { $("sync").classList.add("is-paused"); $("syncState").textContent = "Sync paused"; $("sync").title = error.message || ""; }

  // ---------- upload ----------
  function setBusy(on, text) { state.busy = on; $("blDrop").classList.toggle("is-busy", on); $("blBusyText").textContent = text || "Reading…"; }
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).replace(/^data:[^,]*,/, "")); };
      reader.onerror = function () { reject(new Error("Couldn’t read that file.")); };
      reader.readAsDataURL(blob);
    });
  }
  async function upload(blob, name) {
    if (!state.payer) return toast("Add household members first.");
    if (blob.size > 8 * 1024 * 1024) return toast("That file is over 8 MB.");
    setBusy(true, "Reading…");
    try {
      var data = await post("/api/bills/upload", { memberId: state.payer, fileName: name || blob.name || "bill", mimeType: blob.type, dataBase64: await toBase64(blob) });
      setBusy(false);
      await refresh();
      if (data.notABill) return toast("That doesn’t look like a bill.");
      if (data.duplicate) toast("Already have this one.");
      else if (data.bill.state === "needs_reading") toast(data.readError ? data.readError : "Saved. Ask your Claude to read it, or type it in.");
      openEditor(data.bill);
    } catch (error) {
      setBusy(false);
      toast(error.message);
    }
  }
  $("blPick").addEventListener("click", function () { $("blFile").click(); });
  $("blFile").addEventListener("change", function () { var f = $("blFile").files[0]; if (f) upload(f); $("blFile").value = ""; });
  var drop = $("blDrop");
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("is-over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); if (t === "dragleave" && drop.contains(e.relatedTarget)) return; drop.classList.remove("is-over"); }); });
  drop.addEventListener("drop", function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) upload(f); });
  document.addEventListener("paste", function (e) {
    if (document.querySelector("dialog[open]")) return;
    var item = Array.from((e.clipboardData || {}).items || []).find(function (i) { return i.kind === "file"; });
    if (item) upload(item.getAsFile(), "pasted-bill.png");
  });
  $("blPayer").addEventListener("click", function (e) {
    var b = e.target.closest("[data-payer]"); if (!b) return;
    state.payer = b.getAttribute("data-payer");
    try { localStorage.setItem("gc.bills.payer", state.payer); } catch (err) {}
    renderPayer();
  });
  $("blSamples").addEventListener("click", async function (e) {
    var b = e.target.closest("[data-sample]"); if (!b) return;
    var kind = b.getAttribute("data-sample");
    var response = await fetch("/api/bills/samples/" + kind + ".png");
    if (response.ok) upload(await response.blob(), "sample-" + kind + "-bill.png");
  });
  $("blManual").addEventListener("click", function () {
    if (!state.data) return;
    openEditor({ id: null, state: "draft", status: "draft", vendor: "", category: "other", totalCents: null, currency: "USD", dueDate: null, payerId: state.payer, split: { mode: "equal", memberIds: ids() }, shares: [], items: [], recurring: false, reading: null, file: null });
  });

  // ---------- editor ----------
  function openEditor(bill) {
    var all = ids();
    var split = bill.split || { mode: "equal", memberIds: all };
    state.edit = {
      id: bill.id, state: bill.state, status: bill.status, file: bill.file, reading: bill.reading, splitwise: bill.splitwise, paidAt: bill.paidAt,
      vendor: bill.vendor || "", category: bill.category || "other", amount: centsText(bill.totalCents), currency: bill.currency || "USD", dueDate: bill.dueDate || "",
      payerId: bill.payerId || state.payer, recurring: !!bill.recurring, mode: split.mode,
      included: all.filter(function (id) { return split.memberIds.length ? split.memberIds.indexOf(id) >= 0 : true; }),
      weights: {}, amounts: {}, items: (bill.items || []).map(function (it) { return { description: it.description, cents: it.cents, memberIds: (it.memberIds || []).slice() }; }),
    };
    all.forEach(function (id) {
      var w = split.weights && split.weights[id];
      state.edit.weights[id] = w != null ? String(w) : "";
      var a = split.amounts && split.amounts[id];
      state.edit.amounts[id] = a != null ? centsText(a) : "";
    });
    if (split.mode === "percent") normalizePercentDisplay();
    $("blBill-title").textContent = bill.id ? (bill.state === "saved" ? "Bill" : "Review bill") : "New bill";
    $("blBillErr").textContent = "";
    renderEditor();
    GC.openDialog("blBill");
  }
  function normalizePercentDisplay() {
    var e = state.edit, sum = 0;
    e.included.forEach(function (id) { sum += Number(e.weights[id]) || 0; });
    if (sum > 0 && Math.abs(sum - 100) > 0.001) e.included.forEach(function (id) { e.weights[id] = String(Math.round((Number(e.weights[id]) || 0) / sum * 10000) / 100); });
  }
  function evenPercents(list) {
    var out = {}, n = list.length; if (!n) return out;
    var base = Math.floor(10000 / n), rem = 10000 - base * n;
    list.forEach(function (id, i) { out[id] = String((base + (i < rem ? 1 : 0)) / 100); });
    return out;
  }
  function spec() {
    var e = state.edit, s = { mode: e.mode, memberIds: e.included.slice() };
    if (e.mode === "percent") { s.weights = {}; e.included.forEach(function (id) { s.weights[id] = Number(e.weights[id]) || 0; }); }
    if (e.mode === "exact") { s.amounts = {}; e.included.forEach(function (id) { s.amounts[id] = parseCents(e.amounts[id] || "0") || 0; }); }
    if (e.mode === "item") s.items = e.items.map(function (it) { return { description: it.description, cents: it.cents, memberIds: it.memberIds.filter(function (id) { return e.included.indexOf(id) >= 0; }) }; });
    return s;
  }
  function check() {
    var e = state.edit, total = parseCents(e.amount);
    if (!total) return { ok: false, text: "Enter the total", shares: [] };
    if (!e.included.length) return { ok: false, text: "Pick who shares it", shares: [] };
    if (e.mode === "percent") {
      var sum = 0; e.included.forEach(function (id) { sum += Number(e.weights[id]) || 0; });
      if (Math.abs(sum - 100) > 0.001) { var r0 = Split.compute(total, spec()); return { ok: false, text: "Adds up to " + (Math.round(sum * 100) / 100) + "% of 100%", shares: r0.ok ? r0.shares : [] }; }
    }
    var r = Split.compute(total, spec());
    if (e.mode === "exact" && !r.ok && r.diff != null) return { ok: false, text: r.diff > 0 ? GC.dollars(r.diff) + " left to assign" : GC.dollars(-r.diff) + " over", shares: r.shares || [] };
    if (!r.ok) return { ok: false, text: r.error, shares: [] };
    var itemNote = "";
    if (e.mode === "item") { var itemSum = e.items.reduce(function (t, it) { return t + it.cents; }, 0); if (total > itemSum) itemNote = " · " + GC.dollars(total - itemSum) + " tax & fees shared"; }
    return { ok: true, text: GC.dollars(total) + " split " + r.shares.filter(function (s) { return s.cents > 0; }).length + " ways" + itemNote, shares: r.shares };
  }
  function renderEditor() {
    var e = state.edit, all = ids(), html = "";
    if (e.file && e.file.preview) html += '<a href="/api/bills/files/' + GC.esc(e.file.id) + '" target="_blank" rel="noopener"><img class="bl-preview" alt="Bill image" src="/api/bills/files/' + GC.esc(e.file.id) + (e.file.mimeType === "application/pdf" ? "?preview=1" : "") + '" /></a>';
    else if (e.file) html += '<p class="bl-reading"><a class="gc-btn gc-btn-outline gc-btn-sm" href="/api/bills/files/' + GC.esc(e.file.id) + '" target="_blank" rel="noopener">Open PDF</a></p>';
    if (e.state === "needs_reading" && !parseCents(e.amount)) html += '<div class="bl-hint">' + GC.icon("spark") + '<span>Ask your Claude to read this bill (GroupCart connector), or fill it in below.</span></div>';
    var chips = [];
    if (e.reading && e.reading.label && e.reading.method !== "manual") chips.push(GC.chip(e.reading.label, e.reading.confidence === "low" ? "warning" : "accent", "spark"));
    if (e.reading && e.reading.error) chips.push(GC.chip(e.reading.error, "warning", "alert"));
    if (e.status === "paid") chips.push(GC.chip("Paid", "success", "check"));
    if (e.splitwise) chips.push(GC.chip(e.splitwise.status === "logged" ? "In Splitwise" : e.splitwise.status === "simulated" ? "Splitwise: simulated" : "Splitwise: " + e.splitwise.status, e.splitwise.status === "failed" ? "danger" : "neutral", "receipt"));
    if (chips.length) html += '<div class="bl-reading">' + chips.join("") + '</div>';
    html += '<div class="bl-fields">'
      + '<label class="bl-field" style="grid-column:1 / -1"><span class="bl-label">Vendor</span><input class="gc-input" id="beVendor" maxlength="48" placeholder="e.g. Xfinity" value="' + GC.esc(e.vendor) + '" /></label>'
      + '<label class="bl-field"><span class="bl-label">Total</span><span class="bl-money"><input class="gc-input" id="beAmount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + GC.esc(e.amount) + '" /></span></label>'
      + '<label class="bl-field"><span class="bl-label">Due</span><input class="gc-input" type="date" id="beDue" value="' + GC.esc(e.dueDate) + '" /></label>'
      + '<label class="bl-field"><span class="bl-label">Type</span><select class="gc-select" id="beCat">' + CATS.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === e.category ? " selected" : "") + '>' + c[1] + " " + c[2] + '</option>'; }).join("") + '</select></label>'
      + '<label class="bl-switch" style="align-self:end;min-height:40px"><input type="checkbox" id="beRepeat"' + (e.recurring ? " checked" : "") + ' />Repeats monthly</label>'
      + '</div>';
    html += '<div class="bl-section"><span class="bl-label">Paid by</span><div class="bl-people" id="bePayer">' + state.data.members.map(function (m) {
      return '<button type="button" class="bl-person" data-be-payer="' + GC.esc(m.id) + '" aria-pressed="' + (m.id === e.payerId) + '">' + GC.avatar(m, all, 26) + GC.esc(first(m.name)) + '</button>';
    }).join("") + '</div></div>';
    var modes = [["equal", "Equal"], ["percent", "%"], ["exact", "Exact"], ["item", "Items"]];
    html += '<div class="bl-section"><span class="bl-label">Split</span><div class="bl-seg" role="group" aria-label="Split mode">' + modes.map(function (m) {
      var disabled = m[0] === "item" && !e.items.length;
      return '<button type="button" data-mode="' + m[0] + '" aria-pressed="' + (e.mode === m[0]) + '"' + (disabled ? ' disabled title="No line items"' : "") + '>' + (e.mode === m[0] ? GC.icon("check") : "") + m[1] + '</button>';
    }).join("") + '</div>';
    var result = check(), shareOf = {};
    result.shares.forEach(function (s) { shareOf[s.memberId] = s.cents; });
    html += '<ul class="bl-split" id="beSplit">' + state.data.members.map(function (m) {
      var inn = e.included.indexOf(m.id) >= 0, input = "";
      if (inn && e.mode === "percent") input = '<span class="bl-in bl-pct"><input class="gc-input" inputmode="decimal" data-weight="' + GC.esc(m.id) + '" value="' + GC.esc(e.weights[m.id] || "") + '" aria-label="' + GC.esc(m.name) + ' percent" /></span>';
      if (inn && e.mode === "exact") input = '<span class="bl-in bl-money"><input class="gc-input" inputmode="decimal" data-amount="' + GC.esc(m.id) + '" value="' + GC.esc(e.amounts[m.id] || "") + '" aria-label="' + GC.esc(m.name) + ' amount" /></span>';
      return '<li class="' + (inn ? "" : "is-out") + '"><label class="bl-who"><input type="checkbox" data-include="' + GC.esc(m.id) + '"' + (inn ? " checked" : "") + ' />' + GC.avatar(m, all, 28) + '<span>' + GC.esc(first(m.name)) + '</span></label>' + input
        + '<span class="bl-share">' + (inn && shareOf[m.id] != null ? GC.dollars(shareOf[m.id]) : "–") + '</span></li>';
    }).join("") + '</ul>';
    if (e.mode === "item") {
      html += '<ul class="bl-items">' + e.items.map(function (it, i) {
        return '<li><div class="bl-item-main"><div class="bl-item-name">' + GC.esc(it.description) + '</div><div class="bl-toggles">' + e.included.map(function (id) {
          var on = !it.memberIds.length || it.memberIds.indexOf(id) >= 0;
          return '<button type="button" class="bl-toggle" data-item="' + i + '" data-member="' + GC.esc(id) + '" aria-pressed="' + on + '" aria-label="' + GC.esc(member(id).name) + '">' + GC.avatar(member(id), all, 22) + '</button>';
        }).join("") + '</div></div><span class="bl-share">' + GC.dollars(it.cents) + '</span></li>';
      }).join("") + '</ul>';
    }
    html += '<div class="bl-check ' + (result.ok ? "ok" : "bad") + '" id="beCheck">' + GC.icon(result.ok ? "checkCircle" : "alert") + '<span>' + GC.esc(result.text) + '</span></div></div>';
    $("blBillBody").innerHTML = html;
    var saved = e.state === "saved";
    $("blDelete").hidden = !e.id;
    $("blMarkPaid").hidden = !saved;
    $("blMarkPaid").textContent = e.paidAt ? "Mark unpaid" : "Mark paid";
    $("blSave").textContent = saved ? "Update" : "Save";
    $("blSave").disabled = !result.ok || !e.payerId;
  }
  function refreshCheck() {
    var result = check(), shareOf = {};
    result.shares.forEach(function (s) { shareOf[s.memberId] = s.cents; });
    $("blBillBody").querySelectorAll("#beSplit li").forEach(function (li) {
      var id = li.querySelector("[data-include]").getAttribute("data-include");
      li.querySelector(".bl-share").textContent = state.edit.included.indexOf(id) >= 0 && shareOf[id] != null ? GC.dollars(shareOf[id]) : "–";
    });
    var c = $("beCheck");
    c.className = "bl-check " + (result.ok ? "ok" : "bad");
    c.innerHTML = GC.icon(result.ok ? "checkCircle" : "alert") + '<span>' + GC.esc(result.text) + '</span>';
    $("blSave").disabled = !result.ok || !state.edit.payerId;
  }
  $("blBillBody").addEventListener("input", function (ev) {
    var t = ev.target, e = state.edit;
    if (t.id === "beVendor") e.vendor = t.value;
    else if (t.id === "beAmount") e.amount = t.value;
    else if (t.id === "beDue") e.dueDate = t.value;
    else if (t.id === "beCat") e.category = t.value;
    else if (t.id === "beRepeat") e.recurring = t.checked;
    else if (t.hasAttribute("data-weight")) e.weights[t.getAttribute("data-weight")] = t.value;
    else if (t.hasAttribute("data-amount")) e.amounts[t.getAttribute("data-amount")] = t.value;
    else return;
    refreshCheck();
  });
  $("blBillBody").addEventListener("change", function (ev) {
    var t = ev.target, e = state.edit;
    if (t.id === "beCat") { e.category = t.value; return; }
    if (t.id === "beRepeat") { e.recurring = t.checked; return; }
    if (!t.hasAttribute("data-include")) return;
    var id = t.getAttribute("data-include");
    e.included = t.checked ? ids().filter(function (x) { return x === id || e.included.indexOf(x) >= 0; }) : e.included.filter(function (x) { return x !== id; });
    if (e.mode === "percent") e.weights = evenPercents(e.included);
    if (e.mode === "exact") seedExact();
    renderEditor();
  });
  function seedExact() {
    var e = state.edit, total = parseCents(e.amount);
    e.amounts = {};
    if (total) Split.equal(total, e.included).forEach(function (s) { e.amounts[s.memberId] = centsText(s.cents); });
  }
  $("blBillBody").addEventListener("click", function (ev) {
    var e = state.edit, t = ev.target;
    var modeBtn = t.closest("[data-mode]");
    if (modeBtn && !modeBtn.disabled) {
      var mode = modeBtn.getAttribute("data-mode");
      if (mode === e.mode) return;
      e.mode = mode;
      if (mode === "percent") e.weights = evenPercents(e.included);
      if (mode === "exact") seedExact();
      renderEditor();
      return;
    }
    var payerBtn = t.closest("[data-be-payer]");
    if (payerBtn) { e.payerId = payerBtn.getAttribute("data-be-payer"); renderEditor(); return; }
    var toggle = t.closest("[data-item]");
    if (toggle) {
      var item = e.items[Number(toggle.getAttribute("data-item"))], id = toggle.getAttribute("data-member");
      var current = item.memberIds.length ? item.memberIds.filter(function (x) { return e.included.indexOf(x) >= 0; }) : e.included.slice();
      current = current.indexOf(id) >= 0 ? current.filter(function (x) { return x !== id; }) : current.concat([id]);
      if (!current.length) return toast("Someone has to share each item.");
      item.memberIds = current.length === e.included.length ? [] : current;
      renderEditor();
    }
  });
  $("blSave").addEventListener("click", async function () {
    var e = state.edit, s = spec();
    delete s.items;
    var payload = { id: e.id || undefined, memberId: e.payerId, vendor: e.vendor, category: e.category, totalCents: parseCents(e.amount), dueDate: e.dueDate || null, payerId: e.payerId, recurring: e.recurring, split: s,
      items: e.items.map(function (it) { return { description: it.description, cents: it.cents, memberIds: it.memberIds.filter(function (id) { return e.included.indexOf(id) >= 0; }) }; }) };
    $("blSave").disabled = true;
    try {
      var data = await post("/api/bills/save", payload);
      GC.closeDialog("blBill");
      toast(data.message);
      await refresh();
    } catch (error) { $("blBillErr").textContent = error.message; $("blSave").disabled = false; }
  });
  $("blMarkPaid").addEventListener("click", async function () {
    try {
      var markingPaid = !state.edit.paidAt, paidName = state.edit.vendor || "Bill";
      var data = await post("/api/bills/paid", { id: state.edit.id, paid: markingPaid });
      GC.closeDialog("blBill"); toast(data.message);
      if (markingPaid && GC.celebrate) GC.celebrate(paidName + " paid"); // [themes] completion flourish (no-op in Classic)
      await refresh();
    } catch (error) { $("blBillErr").textContent = error.message; }
  });
  $("blDelete").addEventListener("click", async function () {
    if (!state.edit.id) return;
    if (!confirm("Delete this bill?")) return;
    try { var data = await post("/api/bills/delete", { id: state.edit.id }); GC.closeDialog("blBill"); toast(data.message); await refresh(); }
    catch (error) { $("blBillErr").textContent = error.message; }
  });
  function openRow(ev) {
    var row = ev.target.closest("[data-bill]"); if (!row) return;
    if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    var bill = state.data.bills.find(function (b) { return b.id === row.getAttribute("data-bill"); });
    if (bill) openEditor(bill);
  }
  ["blReviewList", "blUpcomingList", "blPaidList"].forEach(function (id) { $(id).addEventListener("click", openRow); $(id).addEventListener("keydown", openRow); });
  $("blBill").addEventListener("close", function () { refresh().catch(showSyncError); });

  // ---------- payments ----------
  function openPay(from, to, cents) {
    var options = state.data.members.map(function (m) { return '<option value="' + GC.esc(m.id) + '">' + GC.esc(m.name) + '</option>'; }).join("");
    $("blPayFrom").innerHTML = options; $("blPayTo").innerHTML = options;
    var all = ids();
    $("blPayFrom").value = from || state.payer || all[0];
    $("blPayTo").value = to || all.find(function (id) { return id !== $("blPayFrom").value; }) || all[0];
    $("blPayAmount").value = cents ? centsText(cents) : "";
    $("blPayErr").textContent = "";
    GC.openDialog("blPay");
    setTimeout(function () { $("blPayAmount").focus(); }, 50);
  }
  $("blPayOpen").addEventListener("click", function () { openPay(); });
  $("blBalancesBody").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-settle]"); if (!b) return;
    var t = state.data.balances.transfers[Number(b.getAttribute("data-settle"))];
    if (t) openPay(t.fromId, t.toId, t.cents);
  });
  $("blPaySave").addEventListener("click", async function () {
    var cents = parseCents($("blPayAmount").value);
    if (!cents) { $("blPayErr").textContent = "Enter an amount."; return; }
    try {
      var data = await post("/api/bills/payment", { fromId: $("blPayFrom").value, toId: $("blPayTo").value, cents: cents, memberId: $("blPayFrom").value });
      GC.closeDialog("blPay"); toast(data.message);
      if (GC.celebrate) GC.celebrate("Payment recorded"); // [themes]
      await refresh();
    } catch (error) { $("blPayErr").textContent = error.message; }
  });
  $("blPay").addEventListener("close", function () { refresh().catch(showSyncError); });

  refresh().catch(function (error) { $("mode").innerHTML = GC.chip("Offline", "warning", "alert"); showSyncError(error); });
  setInterval(function () { refresh().catch(showSyncError); }, 5000);
})();
`;

export function renderBillsPage(options: { demoMode: boolean }): string {
  const actions = `<span id="mode">${options.demoMode ? chip("Demo", "neutral") : chip("Live", "accent", "lock")}</span><span class="gc-sync gc-hide-sm" id="sync"><span class="gc-dot"></span><span id="syncState">Connecting…</span></span>`;
  return renderPage({ title: "Bills", active: "bills", body, styles, script, actions });
}
