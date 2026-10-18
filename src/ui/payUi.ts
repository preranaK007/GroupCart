import { parsePayHandles, profilePayLinks } from "../payLinks.js";
import { escapeHtml } from "./shell.js";

/**
 * Pay-back UI (src/payLinks.ts builds the links on the server):
 *   PAY_CLIENT_JS   window.GCPay for client-rendered pages: GCPay.load() fetches the viewer's debts with
 *                   links (GET /api/pay-links); GCPay.actions(transfer) renders "Pay $26.67" + "Mark paid" for a
 *                   simplified debt the viewer owes (empty for anyone else's); GCPay.homeRows() renders the same
 *                   as compact rows for the Home balances card. "Mark paid" records the payback through
 *                   POST /api/bills/payment (the bills ledger) and fires a "gc:paid" event with its message.
 *   payHandleFields  Venmo / Cash App / PayPal.me inputs for the profile edit dialog (kept in the profile's
 *                   payment text, so nothing else changes).
 *   payHandlesHtml   the profile "Pay" row, one link per service.
 * Links only open the payment app or site; GroupCart never sends money or assumes a payment went through.
 */

export const PAY_CSS = `
.gp-actions { display:flex; align-items:center; justify-content:flex-end; gap:var(--gc-space-2); flex-wrap:wrap; }
.gp-home { display:grid; gap:var(--gc-space-2); margin-top:var(--gc-space-3); padding-top:var(--gc-space-3); border-top:1px solid var(--gc-border); }
.gp-label { color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; }
.gp-row { display:flex; align-items:center; gap:var(--gc-space-2); }
.gp-who { flex:1; min-width:0; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gp-pay { white-space:nowrap; }
.gp-pay .gc-icon { margin-right:-4px; }
.gp-menu { position:relative; display:inline-block; }
.gp-menu > summary { list-style:none; cursor:pointer; }
.gp-menu > summary::-webkit-details-marker { display:none; }
.gp-pop { position:absolute; right:0; top:calc(100% + 6px); z-index:30; min-width:200px; padding:var(--gc-space-1) 0; background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:var(--gc-radius-md); box-shadow:0 4px 16px rgba(0,0,0,.14); }
.gp-opt { display:flex; align-items:center; gap:var(--gc-space-2); min-height:40px; padding:0 var(--gc-space-4); color:var(--gc-text); text-decoration:none; font-size:var(--gc-fs-md); white-space:nowrap; }
.gp-opt:hover, .gp-opt:focus-visible { background:var(--gc-hover); outline:none; }
.gp-opt-handle { margin-left:auto; color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.gp-paid { white-space:nowrap; }
.is-paying .gp-paid { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
`;

export const PAY_CLIENT_JS = String.raw`
// Runs once window.GC exists (inline in a card body it waits for DOMContentLoaded).
;(function (run) { if (window.GC) run(); else document.addEventListener("DOMContentLoaded", run); })(function () {
  var GC = window.GC;
  if (!GC || window.GCPay) return;
  var data = null;
  var phone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");
  function first(name) { return String(name || "").split(/\s+/)[0]; }
  function load() {
    return fetch("/api/pay-links", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { data = d; return d; })
      .catch(function () { return null; });
  }
  function debt(fromId, toId) {
    if (!data || !data.viewerId || fromId !== data.viewerId) return null;
    return (data.debts || []).find(function (d) { return d.toId === toId; }) || null;
  }
  function link(option, cls, inner) {
    return '<a class="' + cls + '" data-gp-link href="' + GC.esc(option.url) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
  }
  function payButton(d, cents) {
    var options = d.options || [];
    if (!options.length) return "";
    var label = "Pay " + GC.dollars(cents);
    var items = [];
    options.forEach(function (o) {
      if (phone && o.appUrl) items.push('<a class="gp-opt" role="menuitem" data-gp-link href="' + GC.esc(o.appUrl) + '">' + GC.esc(o.label) + ' app<span class="gp-opt-handle">' + GC.esc(o.handle) + '</span></a>');
      items.push(link(o, "gp-opt", GC.esc(o.label) + '<span class="gp-opt-handle">' + GC.esc(o.handle) + '</span>').replace('<a ', '<a role="menuitem" '));
    });
    if (items.length === 1) return link(options[0], "gc-btn gc-btn-sm gp-pay", GC.esc(label)).replace('<a ', '<a title="Opens ' + GC.esc(options[0].label) + '" ');
    return '<details class="gp-menu"><summary class="gc-btn gc-btn-sm gp-pay" aria-label="' + GC.esc(label) + ': choose an app">' + GC.esc(label) + GC.icon("chevronDown") + '</summary><div class="gp-pop" role="menu">' + items.join("") + '</div></details>';
  }
  function markButton(fromId, toId, cents, toName) {
    return '<button type="button" class="gc-btn gc-btn-text gc-btn-sm gp-paid" data-gp-paid data-from="' + GC.esc(fromId) + '" data-to="' + GC.esc(toId) + '" data-cents="' + Number(cents) + '" data-name="' + GC.esc(first(toName)) + '" title="Record that you paid ' + GC.esc(first(toName)) + ' back">Mark paid</button>';
  }
  /** Pay + Mark paid for one simplified debt ({fromId, toId, cents, toName}) when the viewer owes it; else "". */
  function actions(t) {
    var d = debt(t.fromId, t.toId);
    if (!d) return "";
    return '<div class="gp-actions">' + payButton(d, t.cents) + markButton(t.fromId, t.toId, t.cents, t.toName || d.toName) + '</div>';
  }
  /** Compact "You owe" rows for the viewer (Home): avatar, name, [Pay $26.67], [Mark paid]. */
  function homeRows() {
    if (!data || !data.viewerId || !data.debts || !data.debts.length) return "";
    return '<div class="gp-home"><span class="gp-label">You owe</span>' + data.debts.map(function (d) {
      return '<div class="gp-row">' + GC.avatar({ id: d.toId, name: d.toName }, data.memberIds, 24) + '<span class="gp-who">' + GC.esc(first(d.toName)) + '</span>' + payButton(d, d.cents) + markButton(data.viewerId, d.toId, d.cents, d.toName) + '</div>';
    }).join("") + '</div>';
  }
  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    document.querySelectorAll("details.gp-menu[open]").forEach(function (menu) { if (!menu.contains(target)) menu.open = false; });
    var opened = target.closest("[data-gp-link]");
    if (opened) {
      var menu = opened.closest("details.gp-menu");
      if (menu) menu.open = false;
      var row = opened.closest(".gp-actions, .gp-row");
      if (row) row.classList.add("is-paying");
      return;
    }
    var paid = target.closest("[data-gp-paid]");
    if (!paid || paid.disabled) return;
    paid.disabled = true;
    var body = { fromId: paid.getAttribute("data-from"), toId: paid.getAttribute("data-to"), cents: Number(paid.getAttribute("data-cents")), memberId: paid.getAttribute("data-from") };
    fetch("/api/bills/payment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || d.message || "Couldn’t record that."); return d; }); })
      .then(function (d) {
        if (GC.celebrate) GC.celebrate("Paid " + paid.getAttribute("data-name") + " back");
        if (window.GCPoints) setTimeout(window.GCPoints.check, 1200); // a level-up from the payback replaces the flourish
        return load().then(function () { document.dispatchEvent(new CustomEvent("gc:paid", { detail: { message: d.message || "Payment recorded." } })); });
      })
      .catch(function (error) { paid.disabled = false; paid.title = error.message; paid.textContent = "Try again"; });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") document.querySelectorAll("details.gp-menu[open]").forEach(function (menu) { menu.open = false; });
  });
  window.GCPay = { load: load, actions: actions, homeRows: homeRows };
});
`;

/** Venmo / Cash App / PayPal.me fields for the profile edit dialog; they write the hidden "paymentHandle" input. */
export function payHandleFields(paymentHandle: string): string {
  const handles = parsePayHandles(paymentHandle);
  const input = (key: string, label: string, value: string | undefined, placeholder: string, max: number) =>
    `<label class="pf-field"><span>${escapeHtml(label)}</span><input class="gc-input" data-gp-handle="${key}" value="${escapeHtml(value ?? "")}" placeholder="${escapeHtml(placeholder)}" maxlength="${max}" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>`;
  return `<div class="gp-handles">
  <div class="gp-handle-grid">
    ${input("venmo", "Venmo", handles.venmo, "@username", 31)}
    ${input("cashapp", "Cash App", handles.cashapp, "$cashtag", 21)}
    ${input("paypal", "PayPal.me", handles.paypal, "username", 20)}
  </div>
  <input type="hidden" name="paymentHandle" value="${escapeHtml(paymentHandle)}" data-gp-rest="${escapeHtml(handles.rest)}" />
  <style>.gp-handle-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:var(--gc-space-2); }</style>
  <script>(function () {
    var form = document.getElementById("pfForm");
    if (!form) return;
    var hidden = form.querySelector('input[name="paymentHandle"]');
    var clean = { venmo: /[^A-Za-z0-9_-]/g, cashapp: /[^A-Za-z0-9_-]/g, paypal: /[^A-Za-z0-9]/g };
    function value(key) {
      var raw = form.querySelector('[data-gp-handle="' + key + '"]').value.trim();
      if (key === "paypal") raw = raw.replace(/^(?:https?:\\/\\/)?(?:www\\.)?paypal\\.me\\//i, "");
      return raw.replace(/^[@$]/, "").replace(clean[key], "");
    }
    form.addEventListener("input", function (event) {
      if (!event.target.hasAttribute || !event.target.hasAttribute("data-gp-handle")) return;
      var parts = [], v = value("venmo"), c = value("cashapp"), p = value("paypal"), rest = hidden.getAttribute("data-gp-rest") || "";
      if (v) parts.push("Venmo @" + v);
      if (c) parts.push("Cash App $" + c);
      if (p) parts.push("PayPal.me/" + p);
      if (rest) parts.push(rest);
      hidden.value = parts.join(" · ");
    });
  })();</script>
</div>`;
}

/** The profile "Pay" row: each handle links to that service's profile page; unrecognized text stays as text. */
export function payHandlesHtml(paymentHandle: string): string {
  const handles = parsePayHandles(paymentHandle);
  const links = profilePayLinks(handles).map((link) => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ${escapeHtml(link.handle.replace(/^paypal\.me\//, ""))}</a>`);
  if (handles.rest) links.push(escapeHtml(handles.rest));
  return links.join(" · ") || escapeHtml(paymentHandle);
}
