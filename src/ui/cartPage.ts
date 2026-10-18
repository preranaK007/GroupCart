import { chip, icon, infoTip, renderPage } from "./shell.js";

/**
 * Groceries page (route "/groceries"): the shared cart. Rendered once; all data comes from GET /api/cart,
 * polled every 2.5 s. Demo-only controls (sample requests, catalog search,
 * approve, mock checkout) are hidden in live mode, and the server rejects
 * them there as well.
 */

const body = `
<div class="cart-banner" id="liveNote" hidden>
  ${icon("lock", { size: 18 })}
  <span><strong>View only.</strong> Add, remove, approve, and check out in the iMessage group.</span>
</div>

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

    <section class="gc-card" aria-labelledby="itemsTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="itemsTitle">Items</h2>
        <span class="gc-spacer"></span>
        ${infoTip("Sample prices are estimates. Kroger prices are store-specific quotes. Every change creates a new revision.")}
      </div>
      <ul class="gc-list" id="items"></ul>
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
          <input class="gc-input" id="request" placeholder="2 bananas, pasta for everyone" autocomplete="off" aria-label="Request" />
          <button class="gc-btn" id="send" type="button">${icon("send", { size: 18 })}<span class="gc-hide-sm">Add</span><span class="gc-sr">Add request</span></button>
        </div>
      </div>
      <p class="gc-status" id="status" role="status" aria-live="polite"></p>
    </section>

    <section class="gc-card" id="catalogPanel" hidden aria-labelledby="catalogTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="catalogTitle">Kroger catalog</h2>
        <span id="krogerMode"></span>
        <span class="gc-spacer"></span>
        ${infoTip("Live Kroger listings. Store prices appear when a store is configured. Searching never changes a Kroger cart.")}
      </div>
      <div class="gc-field-row">
        <input class="gc-input" id="krogerQuery" placeholder="Search milk, eggs…" autocomplete="off" aria-label="Search Kroger catalog" />
        <button class="gc-btn gc-btn-tonal" id="krogerSearch" type="button">${icon("search", { size: 18 })}<span class="gc-hide-sm">Search</span><span class="gc-sr">Search catalog</span></button>
      </div>
      <p class="gc-status" id="krogerStatus" role="status" aria-live="polite"></p>
      <ul class="gc-list" id="krogerResults"></ul>
    </section>
  </div>

  <div class="gc-stack">
    <section class="gc-card" id="approvalsPanel" aria-labelledby="splitTitle">
      <div class="gc-card-head">
        <h2 class="gc-card-title" id="splitTitle">Split</h2>
        <span class="gc-meta">Pre-tax</span>
        <span class="gc-spacer"></span>
        ${infoTip("Estimated share per person. Any cart edit resets approvals.")}
      </div>
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
          <li><span class="gc-step-icon">${icon("message", { size: 16 })}</span><div><strong>Text the group</strong>“2 bananas” or “eggs shared with Maya”. Text “help” for more.</div></li>
          <li><span class="gc-step-icon">${icon("users", { size: 16 })}</span><div><strong>Everyone approves</strong>Any change resets approvals.</div></li>
          <li><span class="gc-step-icon">${icon("store", { size: 16 })}</span><div><strong>Send to Kroger</strong>Items go to one member’s Kroger cart. They place the order on Kroger.</div></li>
        </ol>
        <p class="cart-how-note" id="howMode"></p>
        <p class="cart-how-note">Stock checks are point-in-time. This page refreshes every few seconds.</p>
      </div>
    </details>
  </div>
</div>`;

const styles = `
.cart-banner { display:flex; align-items:center; gap:var(--gc-space-2); padding:var(--gc-space-3) var(--gc-space-4); margin-bottom:var(--gc-space-4); border-radius:var(--gc-radius-md); background:var(--gc-surface-2); border:1px solid var(--gc-border); color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.cart-banner strong { color:var(--gc-text); font-weight:600; }
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
.cart-price-sub { font-size:var(--gc-fs-xs); color:var(--gc-muted); text-align:right; font-weight:400; }
@media (max-width: 760px) {
  .cart-compose { grid-template-columns:minmax(0,1fr); }
  .gc-stat .gc-track { margin-top:4px; }
}`;

const actions = `
<span id="mode">${chip("Loading", "neutral")}</span>
<span class="gc-sync gc-hide-sm" id="sync"><span class="gc-dot"></span><span id="syncState">Connecting…</span></span>`;

const script = `
const { esc, dollars, chip, icon } = window.GC;
const $ = (id) => document.getElementById(id);
let latest = null;
let allIds = [];
const avatar = (member, size) => window.GC.avatar(member, allIds, size);
const memberName = (id) => (latest && latest.members.find((member) => member.id === id) || {}).name || "a member";

function renderItems() {
  const items = latest.items;
  $("itemCount").textContent = items.length ? items.length + (items.length === 1 ? " item" : " items") : "No items";
  $("items").innerHTML = items.length ? items.map((item) => {
    const people = item.participantIds.map((id, index) => ({ id, name: item.participantNames[index] || "" }));
    const shared = people.length > 1;
    const who = shared ? "Shared · " + item.participantNames.join(", ") : item.ownerName;
    const source = item.priceSource === "kroger"
      ? '<span class="gc-chip gc-chip-accent" title="Store-specific Kroger quote">Kroger</span>'
      : '<span class="gc-chip gc-chip-neutral" title="Sample price, estimate only">Estimate</span>';
    return '<li class="gc-list-item"><span class="gc-avatars">' + people.map((person) => avatar(person, 28)).join("") + '</span>'
      + '<div class="gc-list-main"><div class="gc-list-title">' + esc(item.name) + '</div>'
      + '<div class="gc-list-sub">' + source + '<span>' + esc(who) + '</span></div></div>'
      + '<div class="gc-amount">' + dollars(item.totalCents) + '<div class="cart-price-sub">' + item.quantity + ' × ' + dollars(item.unitPriceCents) + '</div></div></li>';
  }).join("") : '<li class="gc-empty">' + icon("cart") + '<p class="gc-empty-title">Cart is empty</p><p class="gc-empty-text">' + (latest.demoMode ? "Try a request below." : "Text an item to the group.") + '</p></li>';
}

function renderBudget() {
  const within = latest.totalCents <= latest.budgetCents;
  const pct = latest.budgetCents > 0 ? latest.totalCents / latest.budgetCents * 100 : 0;
  $("budgetText").textContent = dollars(Math.abs(latest.budgetCents - latest.totalCents));
  $("budgetAmounts").textContent = (within ? "left of " : "over ") + dollars(latest.budgetCents);
  $("budget").title = "Sample budget: " + dollars(latest.totalCents) + " of " + dollars(latest.budgetCents);
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
    const status = member.approved ? chip("Approved", "success", "check") : chip("Waiting", "neutral", "clock");
    const approveButton = demo && !member.approved
      ? '<button class="gc-btn gc-btn-outline gc-btn-sm" type="button" data-approve="' + esc(member.id) + '"' + (latest.items.length ? "" : " disabled") + '>Approve</button>'
      : "";
    return '<li class="gc-list-item cart-person">' + avatar(member, 32)
      + '<div class="gc-list-main"><div class="gc-list-title">' + esc(member.name) + '</div><div class="gc-list-sub">' + status + '</div></div>'
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
  const pending = latest.krogerCheckout;
  let checkout;
  if (pending && pending.status === "awaiting_oauth" && pending.selectedMemberId) {
    checkout = chip("Waiting for " + memberName(pending.selectedMemberId), "warning", "clock")
      + '<a class="gc-btn gc-btn-tonal gc-btn-sm" href="/api/kroger/oauth/start?memberId=' + encodeURIComponent(pending.selectedMemberId) + '">Sign in</a>';
  } else if (pending && pending.status === "choosing_account") {
    checkout = chip("Choosing account", "warning", "clock");
  } else if (pending && pending.status === "replacement_review") {
    checkout = chip("Review swaps in chat", "warning", "alert");
  } else if (pending && pending.status === "adding") {
    checkout = chip("Sending to Kroger", "accent", "sync");
  } else if (latest.demoMode) {
    checkout = chip("Simulated", "neutral");
  } else {
    checkout = chip("Not started", "neutral");
  }
  const last = latest.checkedOutRevision ? chip("Rev " + latest.checkedOutRevision, "neutral") : '<span class="gc-muted">None yet</span>';
  $("krogerFacts").innerHTML = '<dt>Store</dt><dd>' + store + '</dd><dt>Checkout</dt><dd>' + checkout + '</dd><dt>Last checkout</dt><dd>' + last + '</dd>';
}

function renderMemberSelect() {
  const select = $("member");
  const selected = select.value;
  select.innerHTML = latest.members.map((member) => '<option value="' + esc(member.id) + '">' + esc(member.name) + '</option>').join("");
  if (latest.members.some((member) => member.id === selected)) select.value = selected;
}

async function refresh() {
  const response = await fetch("/api/cart");
  if (!response.ok) throw new Error("Could not load cart");
  latest = await response.json();
  allIds = latest.members.map((member) => member.id);
  const demo = latest.demoMode;
  $("mode").innerHTML = demo ? chip("Demo", "neutral") : chip("Live · View only", "accent", "lock");
  $("sync").classList.remove("is-paused");
  $("syncState").textContent = "Synced " + window.GC.time();
  $("liveNote").hidden = demo;
  $("demoPanel").hidden = !demo;
  $("catalogPanel").hidden = !demo;
  $("demoActions").hidden = !demo;
  $("send").disabled = !demo;
  $("request").disabled = !demo;
  $("howMode").textContent = demo
    ? "Demo mode: requests, prices, approvals, and checkout are simulated. No payment is taken."
    : "Live mode: this page is view only. Approve and check out in the iMessage group. GroupCart never places an order or takes payment.";
  $("total").textContent = dollars(latest.totalCents);
  $("revision").textContent = "Revision " + latest.revision;
  renderBudget();
  renderItems();
  renderPeople();
  renderKroger();
  renderMemberSelect();
}

async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok && !result.message) throw new Error(result.error || "Request failed");
  return result;
}

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
      return '<li class="gc-list-item"><div class="gc-list-main"><div class="gc-list-title">' + esc(product.description) + '</div><div class="gc-list-sub">' + esc(sub) + '</div></div><div class="gc-amount">' + esc(priceText) + '</div></li>';
    }).join("") || '<li class="gc-empty"><p class="gc-empty-text">No matching products.</p></li>';
  } catch (error) { status.textContent = error.message; }
});
$("krogerQuery").addEventListener("keydown", (event) => { if (event.key === "Enter") $("krogerSearch").click(); });

$("people").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-approve]");
  if (!button || button.disabled) return;
  button.disabled = true;
  try { const result = await post("/api/approve", { memberId: button.getAttribute("data-approve") }); $("approvalStatus").textContent = result.message; await refresh(); }
  catch (error) { $("approvalStatus").textContent = error.message; button.disabled = false; }
});

$("checkout").addEventListener("click", async () => {
  try { const result = await post("/api/checkout", {}); $("approvalStatus").textContent = result.message; await refresh(); }
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

// --- Lists & staples tabs (src/ui/listsPanel.ts) ---
import { withListsTabs } from "./listsPanel.js";
// --- end Lists & staples tabs ---

export function renderCartPage(): string {
  return renderPage(withListsTabs({ title: "Groceries", active: "groceries", body, styles, actions, script }));
}
