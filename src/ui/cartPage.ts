import { CART_VIEW_SCRIPT } from "./cartView.js";
import { chip, icon, infoTip, renderPage } from "./shell.js";

/**
 * Groceries page (route "/groceries"): the shared cart. Rendered once; all data comes from GET /api/cart,
 * polled every 2.5 s. Items are grouped by roommate (shared items first; src/ui/cartView.ts). Active sharing
 * sessions (upstream's `sharingSessions` in the snapshot) show as chips in the Split card; they are managed in the
 * group chat. The recurring weekly/biweekly/monthly lists are shown read-only in the Lists tab (src/ui/listsPanel.ts).
 *
 * Live mode: the signed-in member adds Kroger products, removes their own items, approves their own share, and
 * orders with Kroger from the Order card (src/groceryActions.ts). Each click is posted to the iMessage group as
 * their message. GroupCart fills a Kroger cart; the member picks a time and pays on Kroger.
 * Demo mode keeps its demo controls (sample requests as any member, approve as anyone, mock checkout); the server
 * rejects those in live mode.
 */

const KROGER_CART_URL = "https://www.kroger.com/cart";

const body = `
<div class="gc-grid">
  <div class="gc-stack">
    <div class="gc-stats">
      <div class="gc-stat">
        <div class="gc-stat-label">${icon("cart", { size: 16 })}Total</div>
        <div class="gc-stat-value" id="total">$0.00</div>
        <div class="gc-stat-sub" id="itemCount">No items</div>
      </div>
      <div class="gc-stat" id="budget">
        <div class="gc-stat-label">${icon("wallet", { size: 16 })}<span>Budget</span></div>
        <div class="gc-stat-value" id="budgetText">–</div>
        <div class="gc-track" role="progressbar" aria-label="Budget used" aria-valuemin="0" aria-valuemax="100" id="budgetTrack"><div class="gc-fill" id="budgetProgress" style="width:0%"></div></div>
        <div class="gc-stat-sub" id="budgetAmounts"></div>
      </div>
      <div class="gc-stat">
        <div class="gc-stat-label">${icon("users", { size: 16 })}Approved</div>
        <div class="gc-stat-value" id="approvalCount">–</div>
        <div class="gc-stat-sub" id="revision"></div>
      </div>
    </div>

    <section class="gc-card" id="orderPanel" hidden aria-labelledby="orderTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="orderTitle">Order</h2>
        <span class="gc-spacer"></span>
        ${infoTip("Buttons here post to the household iMessage group as you, like texting “approve” or “checkout”. GroupCart fills a Kroger cart; you pick a time and pay on Kroger. It never places an order or takes payment.")}
      </div>
      <div class="cart-order" id="orderBody"></div>
      <p class="gc-status" id="orderStatus" role="status" aria-live="polite"></p>
    </section>

    <section class="gc-card" aria-labelledby="itemsTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="itemsTitle" data-flavor="cart.items.title">Items</h2>
        <span class="gc-spacer"></span>
        ${infoTip("Grouped by who pays: shared items first, then each roommate’s own. Sample prices are estimates; Kroger prices are store-specific quotes. Every change creates a new revision.")}
      </div>
      <div class="cart-groups" id="items"></div>
      <p class="gc-status" id="itemsStatus" role="status" aria-live="polite"></p>
    </section>

    <section class="gc-card" id="demoPanel" hidden aria-labelledby="demoTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="demoTitle">Try a request</h2>
        ${chip("Demo", "neutral")}
        <span class="gc-spacer"></span>
        ${infoTip("Sends a sample group message as the chosen member. Nothing is sent to iMessage.")}
      </div>
      <div class="cart-compose">
        <select class="gc-select" id="member" aria-label="Send as"></select>
        <div class="gc-field-row">
          <input class="gc-input" id="request" placeholder="2 bananas, or start sharing with a roommate" autocomplete="off" aria-label="Request" />
          <button class="gc-btn" id="send" type="button">${icon("send", { size: 18 })}<span class="gc-hide-sm">Add</span><span class="gc-sr">Add request</span></button>
        </div>
      </div>
      <p class="gc-status" id="status" role="status" aria-live="polite"></p>
    </section>

    <section class="gc-card" id="catalogPanel" aria-labelledby="catalogTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="catalogTitle">Kroger catalog</h2>
        <span id="krogerMode"></span>
        <span class="gc-spacer"></span>
        ${infoTip("Live Kroger listings, with store prices when a store is set. Searching never changes a Kroger cart. In live mode, Add puts the item in GroupCart’s cart for you and tells the group.")}
      </div>
      <div class="gc-field-row">
        <input class="gc-input" id="krogerQuery" placeholder="Search milk, eggs…" autocomplete="off" aria-label="Search Kroger" />
        <button class="gc-btn gc-btn-tonal" id="krogerSearch" type="button">${icon("search", { size: 18 })}<span class="gc-hide-sm">Search</span><span class="gc-sr">Search Kroger</span></button>
      </div>
      <p class="gc-status" id="krogerStatus" role="status" aria-live="polite"></p>
      <ul class="gc-list" id="krogerResults"></ul>
    </section>
  </div>

  <div class="gc-stack">
    <section class="gc-card" id="approvalsPanel" aria-labelledby="splitTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="splitTitle" data-flavor="cart.split.title">Split</h2>
        <span class="gc-meta">Pre-tax</span>
        <span class="gc-spacer"></span>
        ${infoTip("Estimated share per person. Any cart edit resets approvals.")}
      </div>
      <div class="cart-sessions" id="sessions"></div>
      <ul class="gc-list" id="people"></ul>
      <div class="cart-actions" id="demoActions" hidden>
        <button class="gc-btn" id="checkout" type="button">${icon("check", { size: 18 })}Mock checkout</button>
        ${infoTip("Simulated checkout. No payment is taken.")}
      </div>
      <p class="gc-status" id="approvalStatus" role="status" aria-live="polite"></p>
    </section>

    <section class="gc-card" id="krogerPanel" aria-labelledby="krogerTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="krogerTitle">Kroger</h2>
        <span class="gc-spacer"></span>
        <a class="gc-btn gc-btn-text gc-btn-sm" href="/settings">Settings</a>
      </div>
      <dl class="cart-facts" id="krogerFacts"></dl>
    </section>

    <details class="gc-disclosure" id="howItWorks">
      <summary>${icon("help", { size: 20 })}How it works${icon("chevronDown", { size: 20, className: "gc-chevron" })}</summary>
      <div class="gc-disclosure-body">
        <ol class="gc-steps">
          <li><span class="gc-step-icon">${icon("message", { size: 16 })}</span><div><strong>Add groceries</strong>Text the group “2 bananas”, or “start sharing with <span class="cart-share-name">a roommate</span>” to split what you both add. Text “help” for more.</div></li>
          <li><span class="gc-step-icon">${icon("users", { size: 16 })}</span><div><strong>Everyone approves</strong>Any change resets approvals.</div></li>
          <li><span class="gc-step-icon">${icon("store", { size: 16 })}</span><div><strong>Order with Kroger</strong>Items go to one member’s Kroger cart. They pick a time and pay on Kroger.</div></li>
        </ol>
        <p class="cart-how-note" id="howMode"></p>
        <p class="cart-how-note">Stock checks are point-in-time. This page refreshes every few seconds.</p>
      </div>
    </details>
  </div>
</div>`;

const styles = `
.cart-compose { display:grid; grid-template-columns:minmax(120px,180px) minmax(0,1fr); gap:var(--gc-space-2); }
.cart-actions { display:flex; align-items:center; gap:var(--gc-space-2); margin-top:var(--gc-space-3); padding-top:var(--gc-space-3); border-top:1px solid var(--gc-border); }
.cart-actions .gc-btn { flex:1; }
.cart-share { flex-basis:100%; padding-left:44px; }
.cart-share .gc-track { margin-top:6px; height:4px; }
.cart-person { flex-wrap:wrap; row-gap:0; }
.cart-facts { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--gc-space-3) var(--gc-space-4); margin:0; align-items:center; }
.cart-facts dt { color:var(--gc-muted); font-size:var(--gc-fs-sm); }
.cart-facts dd { margin:0; display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:6px; text-align:right; min-width:0; }
.cart-how-note { margin-top:var(--gc-space-3); color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.cart-how-note:empty { display:none; }
.cart-sessions { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:var(--gc-space-3); }
.cart-sessions:empty { display:none; }
.cart-price-sub { font-size:var(--gc-fs-xs); color:var(--gc-muted); text-align:right; font-weight:400; }
.cart-you { display:inline-block; margin-left:6px; padding:0 6px; border-radius:var(--gc-radius-pill); background:var(--gc-surface-2); color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; line-height:18px; vertical-align:1px; }
/* Items grouped by roommate */
.cart-group + .cart-group { margin-top:var(--gc-space-2); padding-top:var(--gc-space-2); border-top:1px solid var(--gc-border); }
.cart-group-head { display:flex; align-items:center; gap:var(--gc-space-2); padding:var(--gc-space-1) 0; min-width:0; }
.cart-group-name { flex:1; min-width:0; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cart-group-icon { width:24px; height:24px; flex:none; display:grid; place-items:center; border-radius:50%; background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.cart-group .gc-list-item { padding:var(--gc-space-2) 0; }
.cart-remove { width:30px; height:30px; flex:none; display:grid; place-items:center; padding:0; border:0; border-radius:50%; background:transparent; color:var(--gc-muted); cursor:pointer; }
.cart-remove:hover { background:var(--gc-hover); color:var(--gc-text); }
.cart-remove:disabled { opacity:.4; cursor:not-allowed; }
/* Order card (live mode) */
.cart-order { display:grid; gap:var(--gc-space-3); }
.cart-order-lead { display:flex; align-items:center; gap:var(--gc-space-2); margin:0; font-weight:500; }
.cart-order-lead .gc-icon { flex:none; color:var(--gc-muted); }
.cart-tone-success .gc-icon { color:var(--gc-success); }
.cart-tone-warning .gc-icon { color:var(--gc-warning); }
.cart-tone-accent .gc-icon { color:var(--gc-accent); }
.cart-order-note { margin:0; color:var(--gc-muted); font-size:var(--gc-fs-sm); }
.cart-order-warn { display:flex; align-items:flex-start; gap:var(--gc-space-2); margin:0; padding:var(--gc-space-2) var(--gc-space-3); border-radius:var(--gc-radius-md); background:var(--gc-warning-soft); color:var(--gc-text); font-size:var(--gc-fs-sm); }
.cart-order-warn .gc-icon { flex:none; margin-top:2px; color:var(--gc-warning); }
.cart-order-actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--gc-space-2); }
.cart-order-btn { min-width:220px; }
.cart-waiting { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:var(--gc-space-2) var(--gc-space-4); }
.cart-waiting li { display:inline-flex; align-items:center; gap:6px; font-size:var(--gc-fs-sm); }
.cart-issues { list-style:none; margin:0; padding:0; display:grid; gap:var(--gc-space-2); }
.cart-issue { display:grid; gap:var(--gc-space-2); padding:var(--gc-space-3); border:1px solid var(--gc-border); border-radius:var(--gc-radius-md); }
.cart-issue-head { display:flex; flex-wrap:wrap; align-items:center; gap:var(--gc-space-2); }
.cart-issue-name { flex:1; min-width:0; font-weight:500; overflow-wrap:anywhere; }
.cart-issue > .gc-btn-text { justify-self:start; }
.cart-alts { list-style:none; margin:0; padding:0; display:grid; gap:var(--gc-space-2); }
.cart-alt { display:flex; align-items:center; gap:var(--gc-space-2); font-size:var(--gc-fs-sm); }
.cart-alt-main { flex:1; min-width:0; overflow-wrap:anywhere; }
@media (max-width: 760px) {
  .cart-compose { grid-template-columns:minmax(0,1fr); }
  .gc-stat .gc-track { margin-top:4px; }
  .cart-order-btn { flex:1; min-width:0; }
}`;

const actions = `
<span id="mode">${chip("Loading", "neutral")}</span>
<span class="gc-sync gc-hide-sm" id="sync"><span class="gc-dot"></span><span id="syncState">Connecting…</span></span>`;

const script = `
${CART_VIEW_SCRIPT}
const { esc, dollars, chip, icon } = window.GC;
const $ = (id) => document.getElementById(id);
const KROGER_CART_URL = ${JSON.stringify(KROGER_CART_URL)};
let latest = null;
let allIds = [];
let busy = false; // a button's request is in flight: keep the Order card as it is until it finishes
let orderShown = "";
const avatar = (member, size) => window.GC.avatar(member, allIds, size);
const memberName = (id) => (latest && latest.members.find((member) => member.id === id) || {}).name || "a member";
const live = () => Boolean(latest && !latest.demoMode);
const firstLine = (text) => String(text || "").split("\\n")[0];

function itemRow(item, shared) {
  // participantNames is sorted by name (not aligned with participantIds), so look names up by id.
  const people = item.participantIds.map((id) => ({ id, name: memberName(id) }));
  const source = item.priceSource === "kroger"
    ? '<span class="gc-chip gc-chip-accent" title="Store-specific Kroger quote">Kroger</span>'
    : '<span class="gc-chip gc-chip-neutral" title="Sample price, estimate only">Estimate</span>';
  // Live mode: a roommate takes themselves off their own items (a shared one keeps going for the others). The cart
  // is locked while a Kroger checkout is open.
  const removable = live() && !latest.krogerCheckout && item.participantIds.includes(latest.viewerId);
  const removeLabel = (shared ? "Remove my share of " : "Remove ") + item.name;
  return '<li class="gc-list-item">'
    + (shared ? '<span class="gc-avatars">' + people.map((person) => avatar(person, 24)).join("") + '</span>' : "")
    + '<div class="gc-list-main"><div class="gc-list-title">' + esc(item.name) + '</div>'
    + '<div class="gc-list-sub">' + source + (shared ? '<span>' + esc(item.participantNames.join(", ")) + '</span>' : "") + '</div></div>'
    + '<div class="gc-amount">' + dollars(item.totalCents) + '<div class="cart-price-sub">' + item.quantity + ' × ' + dollars(item.unitPriceCents) + '</div></div>'
    + (removable ? '<button class="cart-remove" type="button" data-remove="' + esc(item.id) + '" aria-label="' + esc(removeLabel) + '" title="' + esc(removeLabel) + '">' + icon("close") + '</button>' : "")
    + '</li>';
}

function renderItems() {
  const items = latest.items;
  $("itemCount").textContent = items.length ? items.length + (items.length === 1 ? " item" : " items") : "No items";
  if (!items.length) {
    $("items").innerHTML = '<div class="gc-empty">' + icon("cart") + '<p class="gc-empty-title" data-flavor="empty.cart.title">Cart is empty</p><p class="gc-empty-text">' + (latest.demoMode ? "Try a request below." : "Search Kroger below, or text an item to the group.") + '</p></div>';
    return;
  }
  $("items").innerHTML = CartView.groupItems(latest).map((group) => {
    const count = group.items.length + (group.items.length === 1 ? " item" : " items");
    const head = group.key === "shared"
      ? '<span class="cart-group-icon">' + icon("users") + '</span><span class="cart-group-name">Shared</span>'
      : group.member
        ? avatar(group.member, 24) + '<span class="cart-group-name">' + esc(group.member.name) + (live() && group.member.id === latest.viewerId ? '<span class="cart-you">you</span>' : "") + '</span>'
        : '<span class="cart-group-icon">' + icon("person") + '</span><span class="cart-group-name">Former members</span>';
    return '<section class="cart-group"><div class="cart-group-head">' + head + '<span class="gc-meta">' + count + '</span><span class="gc-amount">' + dollars(group.totalCents) + '</span></div>'
      + '<ul class="gc-list">' + group.items.map((item) => itemRow(item, group.key === "shared")).join("") + '</ul></section>';
  }).join("");
}

function renderSessions() {
  // Upstream sharing sessions: everything a participant adds is split among the session.
  $("sessions").innerHTML = (latest.sharingSessions || []).map((session) =>
    '<span title="Since ' + esc(window.GC.time(new Date(session.startedAt))) + '. Text “stop sharing” to end it.">' + chip("Sharing: " + session.participantNames.join(", "), "accent", "users") + '</span>'
  ).join("");
}

function renderBudget() {
  const within = latest.totalCents <= latest.budgetCents;
  const pct = latest.budgetCents > 0 ? latest.totalCents / latest.budgetCents * 100 : 0;
  $("budgetText").textContent = dollars(Math.abs(latest.budgetCents - latest.totalCents));
  $("budgetAmounts").textContent = (within ? "left of " : "over ") + dollars(latest.budgetCents);
  $("budget").title = "Budget: " + dollars(latest.totalCents) + " of " + dollars(latest.budgetCents);
  $("budgetProgress").style.width = Math.min(100, pct) + "%";
  $("budgetProgress").classList.toggle("is-over", !within);
  $("budgetTrack").setAttribute("aria-valuenow", String(Math.round(Math.min(100, pct))));
}

function renderPeople() {
  const demo = latest.demoMode;
  const memberMax = Math.max(1, ...latest.members.map((member) => member.shareCents));
  const approved = latest.members.filter((member) => member.approved).length;
  $("approvalCount").textContent = latest.members.length ? approved + " / " + latest.members.length : "–";
  $("people").innerHTML = latest.members.map((member) => {
    const color = window.GC.memberColor(member.id, allIds);
    // An empty cart has nothing to approve, so no "Waiting" column.
    const status = !latest.items.length ? "" : member.approved ? chip("Approved", "success", "check") : chip("Waiting", "neutral", "clock");
    const you = !demo && member.id === latest.viewerId;
    // The demo approves as anyone; live mode only as yourself.
    const approveButton = !member.approved && (demo || (you && latest.items.length))
      ? '<button class="gc-btn gc-btn-outline gc-btn-sm" type="button" data-approve="' + esc(member.id) + '"' + (latest.items.length ? "" : " disabled") + '>Approve</button>'
      : "";
    return '<li class="gc-list-item cart-person">' + avatar(member, 32)
      + '<div class="gc-list-main"><div class="gc-list-title">' + esc(member.name) + (you ? '<span class="cart-you">you</span>' : "") + '</div><div class="gc-list-sub">' + status + '</div></div>'
      + approveButton
      + '<div class="gc-amount">' + dollars(member.shareCents) + '</div>'
      + '<div class="cart-share"><div class="gc-track"><div class="gc-fill" style="width:' + Math.round(member.shareCents / memberMax * 100) + '%;background:' + color.solid + '"></div></div></div></li>';
  }).join("") || '<li class="gc-empty"><p class="gc-empty-text">Add members to GROUP_CART_MEMBERS.</p></li>';
  $("checkout").disabled = !demo || !latest.items.length || latest.members.some((member) => !member.approved);
}

function renderKroger() {
  const store = !latest.krogerConfigured
    ? chip("Not connected", "neutral")
    : latest.krogerLocationConfigured ? chip("Store prices on", "success", "check") : chip("No store set", "warning");
  $("krogerMode").innerHTML = latest.krogerConfigured
    ? (latest.krogerLocationConfigured ? chip("Store prices", "success") : chip("No store", "warning"))
    : chip("Not connected", "neutral");
  $("krogerSearch").disabled = !latest.krogerConfigured;
  $("krogerQuery").disabled = !latest.krogerConfigured;
  const sent = latest.krogerLastCart;
  const last = !latest.demoMode && sent
    ? chip(sent.memberName + "’s cart", "success", "check") + '<a class="gc-btn gc-btn-text gc-btn-sm" href="' + KROGER_CART_URL + '" target="_blank" rel="noopener noreferrer">Open</a>'
    : latest.checkedOutRevision ? chip("Rev " + latest.checkedOutRevision, "neutral") : '<span class="gc-muted">None yet</span>';
  // Live mode shows the checkout itself in the Order card; the demo's checkout is simulated.
  $("krogerFacts").innerHTML = '<dt>Store</dt><dd>' + store + '</dd>'
    + (latest.demoMode ? '<dt>Checkout</dt><dd>' + chip("Simulated", "neutral") + '</dd>' : "")
    + '<dt>Last checkout</dt><dd>' + last + '</dd>';
}

// --- Order card (live mode): the viewer's next step, from CartView.orderState (src/ui/cartView.ts) ---
function lead(iconName, tone, html) {
  return '<p class="cart-order-lead cart-tone-' + tone + '">' + icon(iconName) + '<span>' + html + '</span></p>';
}
const note = (html) => '<p class="cart-order-note">' + html + '</p>';
const row = (html) => '<div class="cart-order-actions">' + html + '</div>';
const orderButton = (action, label, iconName, variant) => '<button class="gc-btn ' + (variant || "") + ' cart-order-btn" type="button" data-order="' + action + '">' + icon(iconName) + '<span>' + esc(label) + '</span></button>';
const cancelButton = '<button class="gc-btn gc-btn-text gc-btn-sm" type="button" data-order="cancel">Cancel checkout</button>';
const names = (people) => people.map((person) => esc(person.name.split(" ")[0])).join(", ");

function issueHtml(issue) {
  const choice = issue.choice;
  if (choice && choice.kind === "settled") return '<li class="cart-issue"><div class="cart-issue-head"><span class="cart-issue-name">' + esc(issue.name) + '</span>' + chip("Settled", "success", "check") + '</div></li>';
  const removing = Boolean(choice && choice.kind === "remove");
  const status = removing ? chip("Will remove", "neutral") : choice ? chip("Will swap", "accent", "check") : "";
  const alternatives = issue.alternatives.map((alt) => {
    const picked = Boolean(choice && choice.kind === "replace" && choice.option === alt.option);
    return '<li class="cart-alt"><span class="cart-alt-main">' + esc(alt.description) + (alt.size ? ' <span class="gc-meta">· ' + esc(alt.size) + '</span>' : "") + '</span>'
      + '<span class="gc-amount">' + (alt.priceCents === null ? "–" : dollars(alt.priceCents)) + '</span>'
      + '<button class="gc-btn gc-btn-outline gc-btn-sm" type="button" data-review-item="' + issue.number + '" data-review-option="' + alt.option + '"' + (picked || alt.priceCents === null ? " disabled" : "") + '>' + (picked ? "Chosen" : "Swap") + '</button></li>';
  }).join("");
  return '<li class="cart-issue"><div class="cart-issue-head"><span class="cart-issue-name">' + esc(issue.name) + (issue.quantity > 1 ? " × " + issue.quantity : "") + '</span>' + status + '</div>'
    + (alternatives ? '<ul class="cart-alts">' + alternatives + '</ul>' : note("Kroger didn’t suggest an in-stock swap."))
    + '<button class="gc-btn gc-btn-text gc-btn-sm" type="button" data-review-item="' + issue.number + '"' + (removing ? " disabled" : "") + '>Remove for everyone</button></li>';
}

function orderHtml(state) {
  const me = latest.members.find((member) => member.id === latest.viewerId);
  switch (state.step) {
    case "unavailable":
      return lead("store", "muted", "Kroger isn’t connected") + note("Add the Kroger app credentials and a store to .env, then restart GroupCart.");
    case "empty":
      return lead("cart", "muted", "Nothing to order yet") + note("Add groceries, everyone approves, then order with Kroger in one tap.");
    case "approvals": {
      const others = state.waiting.filter((person) => !person.you);
      const waiting = '<ul class="cart-waiting">' + state.waiting.map((person) => '<li>' + avatar(person, 24) + '<span>' + (person.you ? "You" : esc(person.name)) + '</span></li>').join("") + '</ul>';
      if (state.viewerApproved) {
        return lead("clock", "warning", "Waiting for approval") + waiting
          + row('<button class="gc-btn cart-order-btn" type="button" disabled>' + icon("store") + '<span>Order with Kroger</span></button>')
          + note("Ordering opens once everyone approves. Any cart change resets approvals.");
      }
      return lead("clock", "warning", "Waiting for approval") + waiting
        + row(orderButton("approve", "Approve my share" + (me ? " · " + dollars(me.shareCents) : ""), "check"))
        + note(others.length ? "Then " + names(others) + (others.length === 1 ? " approves" : " approve") + ", and anyone can order." : "You’re the last one. Then order with Kroger.");
    }
    case "ready":
      return lead("checkCircle", "success", "Everyone approved")
        + row(orderButton("order", "Order with Kroger", "store"))
        + note("Checks stock at the store, then adds everything to your Kroger cart. You pick a time and pay on Kroger.");
    case "review":
      return lead("alert", "warning", "Some items aren’t available at the store")
        + '<ol class="cart-issues">' + state.items.map(issueHtml).join("") + '</ol>'
        + note("Choose a swap or remove each one. The choices apply together, then everyone approves again.")
        + row(cancelButton);
    case "choosing":
      return state.mine
        ? lead("store", "accent", "Choose whose Kroger cart gets the items") + row(orderButton("order", "Use my Kroger account", "store") + cancelButton)
        : lead("clock", "muted", esc(state.requesterName) + " is starting a Kroger order");
    case "signin": {
      if (!state.canSignInHere) return lead("clock", "muted", "Waiting for " + esc(state.accountName) + " to sign in to Kroger") + note("Their Kroger cart gets the approved items.");
      const label = state.mine ? "Sign in to Kroger" : "Sign in to " + state.accountName + "’s Kroger";
      return lead("lock", "accent", state.mine ? "Sign in to Kroger to send the items" : esc(state.accountName) + "’s Kroger account gets the items")
        + row('<a class="gc-btn cart-order-btn" href="' + esc(state.signInUrl) + '">' + icon("lock") + '<span>' + esc(label) + '</span></a>' + (state.canCancel ? cancelButton : ""))
        + (state.needsHost ? '<p class="cart-order-warn">' + icon("alert") + '<span>Kroger sign-in only finishes on the computer running GroupCart. Open Groceries there to sign in.</span></p>' : "")
        + note("After sign-in, GroupCart adds the approved items to that Kroger cart. It never places the order.");
    }
    case "sending":
      return lead("sync", "accent", "Adding items to " + esc(state.accountName) + "’s Kroger cart…");
    case "sent":
      return lead("checkCircle", "success", "Sent " + state.itemCount + (state.itemCount === 1 ? " item" : " items") + " to " + (state.mine ? "your" : esc(state.accountName) + "’s") + " Kroger cart")
        + row('<a class="gc-btn ' + (state.mine ? "" : "gc-btn-outline ") + 'cart-order-btn" href="' + KROGER_CART_URL + '" target="_blank" rel="noopener noreferrer">' + icon("external") + '<span>Open Kroger cart</span></a>')
        + note((state.mine ? "Pick a pickup or delivery time and pay" : esc(state.accountName.split(" ")[0]) + " picks a pickup or delivery time and pays") + " on Kroger. GroupCart never places the order.");
    default:
      return lead("clock", "muted", "Kroger checkout: " + esc(String(state.status).replace(/_/g, " ")));
  }
}

function renderOrder() {
  const state = CartView.orderState(latest);
  $("orderPanel").hidden = !state;
  if (!state || busy) return;
  const html = orderHtml(state);
  if (html !== orderShown) { $("orderBody").innerHTML = html; orderShown = html; }
}

function renderMemberSelect() {
  const select = $("member");
  const selected = select.value;
  select.innerHTML = latest.members.map((member) => '<option value="' + esc(member.id) + '">' + esc(member.name) + '</option>').join("");
  if (latest.members.some((member) => member.id === selected)) select.value = selected;
  // Example sharing partner: a real roommate other than the one sending (generic wording until loaded).
  const partner = latest.members.find((member) => member.id !== (latest.demoMode ? select.value : latest.viewerId));
  if (partner) {
    const first = partner.name.split(" ")[0];
    $("request").placeholder = "2 bananas, or start sharing with " + first;
    document.querySelectorAll(".cart-share-name").forEach((node) => { node.textContent = first; });
  }
}

async function refresh() {
  const response = await fetch("/api/cart");
  if (!response.ok) throw new Error("Could not load cart");
  latest = await response.json();
  allIds = latest.members.map((member) => member.id);
  const demo = latest.demoMode;
  $("mode").innerHTML = demo ? chip("Demo", "neutral") : chip("Live", "accent", "lock");
  $("sync").classList.remove("is-paused");
  $("syncState").textContent = "Synced " + window.GC.time();
  $("demoPanel").hidden = !demo;
  $("demoActions").hidden = !demo;
  $("send").disabled = !demo;
  $("request").disabled = !demo;
  $("catalogTitle").textContent = demo ? "Kroger catalog" : "Add from Kroger";
  $("howMode").textContent = demo
    ? "Demo mode: requests, prices, approvals, and checkout are simulated. No payment is taken."
    : "Buttons here post to the iMessage group as you. GroupCart adds items to a Kroger cart; you pick a time and pay on Kroger. It never places an order or takes payment.";
  $("total").textContent = dollars(latest.totalCents);
  $("revision").textContent = "Revision " + latest.revision;
  renderBudget();
  renderItems();
  renderSessions();
  renderPeople();
  renderKroger();
  renderOrder();
  renderMemberSelect();
}

async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok && !result.message) throw new Error(result.error || "Request failed");
  return result;
}

/** Live-mode action (src/groceryActions.ts): GroupCart's reply, or an Error with the reason it was refused. */
async function act(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "That didn’t go through. Try again.");
  return result.message || "";
}

/** Runs one Order-card or Split-card action, then shows GroupCart's answer unless the card now explains it. */
async function runAction(path, body, statusId) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("#orderBody button, #people [data-approve]").forEach((button) => { button.disabled = true; });
  $(statusId).textContent = path.endsWith("/order") ? "Checking stock at the store…" : "Posting to the group…";
  let message;
  let failed = false;
  try { message = await act(path, body); } catch (error) { message = error.message; failed = true; }
  busy = false;
  orderShown = "";
  await refresh().catch(showSyncError);
  const step = (CartView.orderState(latest) || {}).step;
  // The card shows the sign-in link and the review itself; the reply would repeat them as long text.
  $(statusId).textContent = !failed && (step === "signin" || step === "review" || step === "sending") ? "" : firstLine(message);
  if (!failed && path.endsWith("/approve") && latest.members.some((member) => member.id === latest.viewerId && member.approved)) window.GC.celebrate("You approved the groceries");
}

$("orderBody").addEventListener("click", (event) => {
  const target = event.target.closest("button[data-order], button[data-review-item]");
  if (!target || target.disabled) return;
  if (target.hasAttribute("data-review-item")) {
    const option = target.getAttribute("data-review-option");
    runAction("/api/groceries/review", { item: Number(target.getAttribute("data-review-item")), ...(option ? { option: Number(option) } : {}) }, "orderStatus");
  } else {
    runAction("/api/groceries/" + target.getAttribute("data-order"), {}, "orderStatus");
  }
});

$("items").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button || button.disabled) return;
  button.disabled = true;
  $("itemsStatus").textContent = "Removing…";
  try { $("itemsStatus").textContent = firstLine(await act("/api/groceries/remove", { itemId: button.getAttribute("data-remove") })); }
  catch (error) { $("itemsStatus").textContent = error.message; button.disabled = false; }
  await refresh().catch(showSyncError);
});

$("send").addEventListener("click", async () => {
  const input = $("request");
  const text = input.value.trim();
  if (!text) return;
  try {
    const result = await post("/api/demo-message", { memberId: $("member").value, text });
    $("status").textContent = result.message;
    input.value = "";
    await refresh();
  } catch (error) { $("status").textContent = error.message; }
});
$("request").addEventListener("keydown", (event) => { if (event.key === "Enter") $("send").click(); });

$("krogerSearch").addEventListener("click", async () => {
  const query = $("krogerQuery").value.trim();
  if (!query) return;
  const status = $("krogerStatus");
  const results = $("krogerResults");
  status.textContent = "Searching Kroger…";
  results.innerHTML = "";
  try {
    const response = await fetch("/api/kroger/products?q=" + encodeURIComponent(query));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Search failed.");
    status.textContent = data.total + " matching items";
    results.innerHTML = data.products.map((product) => {
      const price = product.promoPriceCents !== null && product.promoPriceCents > 0 ? product.promoPriceCents : product.regularPriceCents;
      const priceText = price === null ? "No store price" : dollars(price);
      const sub = [product.brand || "Kroger catalog", product.size || ""].filter(Boolean).join(" · ");
      // Live mode: Add puts this exact product in the cart for you. It needs a store price and a UPC to be ordered.
      const add = live()
        ? '<button class="gc-btn gc-btn-tonal gc-btn-sm" type="button" data-add="' + esc(product.productId) + '"' + (price === null || !product.upc ? ' disabled title="No store price, so it can’t be ordered"' : "") + '>' + icon("plus") + '<span>Add</span></button>'
        : "";
      return '<li class="gc-list-item"><div class="gc-list-main"><div class="gc-list-title">' + esc(product.description) + '</div><div class="gc-list-sub">' + esc(sub) + '</div></div><div class="gc-amount">' + esc(priceText) + '</div>' + add + '</li>';
    }).join("") || '<li class="gc-empty"><p class="gc-empty-text">No matching products.</p></li>';
  } catch (error) { status.textContent = error.message; }
});
$("krogerQuery").addEventListener("keydown", (event) => { if (event.key === "Enter") $("krogerSearch").click(); });

$("krogerResults").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-add]");
  if (!button || button.disabled) return;
  button.disabled = true;
  const status = $("krogerStatus");
  status.textContent = "Adding…";
  try {
    status.textContent = firstLine(await act("/api/groceries/add", { productId: button.getAttribute("data-add") }));
    button.innerHTML = icon("check") + "<span>Added</span>";
    setTimeout(() => { button.innerHTML = icon("plus") + "<span>Add</span>"; button.disabled = false; }, 1500);
  } catch (error) { status.textContent = error.message; button.disabled = false; }
  await refresh().catch(showSyncError);
});

$("people").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-approve]");
  if (!button || button.disabled) return;
  if (live()) { runAction("/api/groceries/approve", {}, "approvalStatus"); return; }
  button.disabled = true;
  const memberId = button.getAttribute("data-approve");
  try {
    const result = await post("/api/approve", { memberId });
    $("approvalStatus").textContent = result.message;
    if (result.ok) window.GC.celebrate(memberName(memberId) + " approved the cart");
    await refresh();
  }
  catch (error) { $("approvalStatus").textContent = error.message; button.disabled = false; }
});

$("checkout").addEventListener("click", async () => {
  try {
    const result = await post("/api/checkout", {});
    $("approvalStatus").textContent = result.message;
    if (result.ok) window.GC.celebrate("Groceries checked out");
    await refresh();
  }
  catch (error) { $("approvalStatus").textContent = error.message; }
});

const showSyncError = (error) => {
  $("sync").classList.add("is-paused");
  $("syncState").textContent = "Sync paused";
  $("sync").title = error.message || "Could not reach GroupCart";
};
refresh().catch((error) => { $("mode").innerHTML = chip("Offline", "warning", "alert"); showSyncError(error); });
setInterval(() => refresh().catch(showSyncError), 2500);
`;

// --- One-off lists tab (src/ui/listsPanel.ts) ---
import { withListsTabs } from "./listsPanel.js";
// --- end One-off lists tab ---
import { withKitchenTabs } from "./mealsPanel.js"; // Kitchen: Pantry and Meals tabs

export function renderCartPage(): string {
  return renderPage(withKitchenTabs(withListsTabs({ title: "Kitchen", active: "groceries", body, styles, actions, script })));
}
