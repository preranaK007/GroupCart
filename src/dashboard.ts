import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { CartStore, type CartSnapshot } from "./store.js";
import { KrogerClient } from "./kroger.js";
import { splitwiseDashboardView } from "./splitwise.js";

// --- Splitwise status panel (self-contained: styles, markup, script) -------
// Reads GET /api/splitwise. Kept separate so it can move to another page as-is.
const SPLITWISE_PANEL_STYLES = `
    .sw-pill { display:inline-block; padding:3px 9px; border-radius:999px; font-size:12px; font-weight:650; background:#f0f2ee; color:var(--muted); }
    .sw-pill.logged { background:var(--mint); color:var(--green); } .sw-pill.failed { background:#fff2e8; color:#865022; }
    .sw-total { display:flex; justify-content:space-between; font-weight:650; margin-bottom:8px; }
    .sw-debts { display:grid; gap:6px; font-size:13px; } .sw-debt { display:flex; justify-content:space-between; gap:8px; }
    .sw-note { margin-top:10px; color:var(--muted); font-size:12px; } .sw-note.error { color:#865022; }
    .sw-link { display:inline-block; margin-top:10px; color:var(--green); font-size:13px; font-weight:650; }`;

const SPLITWISE_PANEL_HTML = `
        <div class="card" id="splitwisePanel">
          <div class="card-title"><h2>Splitwise</h2><span class="sw-pill" id="splitwiseState">Loading…</span></div>
          <div id="splitwiseBody"><p class="empty">Checking the latest checkout…</p></div>
        </div>`;

const SPLITWISE_PANEL_SCRIPT = `
  <script>
    (() => {
      const swEsc = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
      const swDollars = (cents) => new Intl.NumberFormat("en-US", {style:"currency",currency:"USD"}).format(cents / 100);
      const labels = { none:"No checkout yet", logged:"Logged", simulated:"Simulated", failed:"Failed", pending:"Sending…", sending:"Sending…" };
      async function refreshSplitwise() {
        const response = await fetch("/api/splitwise");
        if (!response.ok) throw new Error("Could not load Splitwise status");
        const data = await response.json();
        const pill = document.getElementById("splitwiseState");
        pill.textContent = labels[data.state] || data.state;
        pill.className = "sw-pill " + data.state;
        const body = document.getElementById("splitwiseBody");
        if (data.state === "none") {
          body.innerHTML = '<p class="empty">After checkout, the total is logged as one Splitwise expense paid by the shopper.</p>';
          return;
        }
        const debts = (data.debts || []).map((debt) => '<div class="sw-debt"><span>' + swEsc(debt.name) + ' owes ' + swEsc(debt.owesTo) + '</span><strong>' + swDollars(debt.cents) + '</strong></div>').join("");
        const link = data.expenseUrl && /^https:\/\/secure\.splitwise\.com\//.test(data.expenseUrl)
          ? '<a class="sw-link" href="' + swEsc(data.expenseUrl) + '" target="_blank" rel="noopener noreferrer">View expense #' + swEsc(data.expenseId) + ' in Splitwise</a>' : "";
        const note = data.state === "failed" ? '<p class="sw-note error">' + swEsc(data.error) + ' Text “splitwise retry” in the group to try again.</p>'
          : data.note ? '<p class="sw-note">' + swEsc(data.note) + '</p>' : "";
        body.innerHTML = '<div class="sw-total"><span>Revision ' + swEsc(data.revision) + ' · paid by ' + swEsc(data.payerName || "unknown") + '</span><span>' + swDollars(data.totalCents) + '</span></div>'
          + '<div class="sw-debts">' + (debts || '<p class="muted">No one else owes anything.</p>') + '</div>' + link + note;
      }
      const fail = (error) => { document.getElementById("splitwiseState").textContent = "Unavailable"; };
      refreshSplitwise().catch(fail);
      setInterval(() => refreshSplitwise().catch(fail), 2500);
    })();
  </script>`;
// --- end Splitwise status panel ---------------------------------------------
import { handleCalendarRequest } from "./calendarPage.js";
import type { CalendarService } from "./googleCalendar.js";

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GroupCart · Shared basket</title>
  <style>
    :root { color-scheme: light; --ink:#18221f; --muted:#63716a; --line:#e4e9e4; --green:#0b6b50; --mint:#e7f5ed; --cream:#fbfaf6; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--cream); color:var(--ink); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(980px, calc(100% - 32px)); margin:32px auto 60px; }
    header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:24px; }
    .brand { display:flex; align-items:center; gap:12px; }
    .logo { width:42px; height:42px; display:grid; place-items:center; border-radius:14px; background:var(--green); color:white; font-size:22px; }
    h1,h2,p { margin:0; } h1 { font-size:23px; letter-spacing:-.03em; } h2 { font-size:17px; }
    .sub,.muted { color:var(--muted); } .sub { font-size:13px; }
    .badge { border:1px solid #cfe4d7; background:var(--mint); color:var(--green); padding:6px 10px; border-radius:999px; font-size:12px; font-weight:650; }
    .layout { display:grid; grid-template-columns:minmax(0,1.65fr) minmax(250px,.85fr); gap:18px; align-items:start; }
    .card { background:white; border:1px solid var(--line); border-radius:18px; padding:20px; box-shadow:0 8px 28px #1c30200a; }
    .card + .card { margin-top:16px; }
    .card-title { display:flex; justify-content:space-between; align-items:baseline; gap:10px; margin-bottom:15px; }
    .items { display:grid; gap:10px; }
    .item { display:flex; justify-content:space-between; gap:12px; border-bottom:1px solid #f0f2ee; padding:10px 0; }
    .item:last-child { border-bottom:0; }
    .item-name { font-weight:650; } .detail { color:var(--muted); font-size:12px; margin-top:2px; }
    .price { text-align:right; white-space:nowrap; font-weight:650; }
    .total { display:flex; justify-content:space-between; border-top:1px solid var(--line); padding-top:14px; margin-top:8px; font-weight:750; font-size:18px; }
    .budget { margin-top:12px; padding:12px; border-radius:12px; background:#f3f6f2; color:var(--muted); font-size:13px; }
    .budget-track,.share-track { height:7px; overflow:hidden; border-radius:99px; background:#e7ece7; }
    .budget-fill,.share-fill { height:100%; border-radius:inherit; background:#56a47d; transition:width .25s ease; }
    .budget.over { background:#fff2e8; color:#865022; } .budget.over .budget-fill { background:#d78342; }
    .budget-label { display:flex; justify-content:space-between; gap:8px; margin-bottom:8px; }
    .people { display:grid; gap:10px; }
    .person { display:grid; grid-template-columns:1fr auto; gap:6px 8px; align-items:center; }
    .person-left { display:flex; align-items:center; gap:9px; }
    .share-track { grid-column:1/-1; height:5px; }
    .avatar { width:30px; height:30px; border-radius:50%; display:grid; place-items:center; background:#e9eee8; color:#39584a; font-size:12px; font-weight:700; }
    .approval { color:var(--muted); font-size:11px; }
    button { border:0; border-radius:11px; padding:11px 14px; background:var(--green); color:white; font:inherit; font-weight:700; cursor:pointer; }
    button.secondary { background:#edf2ed; color:var(--ink); }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:16px; }
    .demo { display:grid; gap:10px; }
    .demo-row { display:flex; gap:8px; }
    .product-results { display:grid; gap:8px; margin-top:10px; }
    .product-result { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; border:1px solid var(--line); border-radius:12px; padding:10px 12px; }
    .product-brand { color:var(--muted); font-size:12px; }
    .product-price { white-space:nowrap; font-weight:700; text-align:right; }
    select,input { min-width:0; border:1px solid #dce3dc; border-radius:10px; padding:10px 11px; font:inherit; background:white; }
    select { width:100%; } input { flex:1; }
    .status { min-height:20px; margin-top:8px; color:var(--green); font-size:13px; }
    .empty { color:var(--muted); padding:16px 0; }
    .footer { margin-top:18px; color:var(--muted); font-size:12px; }
    .sync { color:var(--muted); font-size:12px; margin-top:4px; }
    .live-note { padding:14px 16px; border-radius:14px; background:#edf7f0; border:1px solid #d8ecdf; color:#355c46; font-size:13px; margin-bottom:16px; }
    .live-note strong { display:block; margin-bottom:3px; color:#234a35; }
    [hidden] { display:none !important; }${SPLITWISE_PANEL_STYLES}
    .header-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
    .calendar-link { border:1px solid var(--line); background:white; color:var(--ink); padding:6px 12px; border-radius:999px; font-size:12px; font-weight:650; text-decoration:none; white-space:nowrap; }
    .calendar-link:hover { border-color:#cfe4d7; background:var(--mint); color:var(--green); }
    @media(max-width:720px) { main{margin-top:18px}.layout{grid-template-columns:1fr}header{align-items:flex-start}.badge{max-width:150px;text-align:center} }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand"><div class="logo" aria-hidden="true">🛒</div><div><h1>GroupCart</h1><p class="sub">One shared cart for your group</p><p class="sync" id="syncState">Connecting to the cart…</p></div></div>
      <div class="header-actions"><a class="calendar-link" href="/calendar">📅 Calendar</a><span class="badge" id="mode">Loading cart…</span></div>
    </header>
    <div class="live-note" id="liveNote" hidden><strong>Live iMessage cart · view only</strong>This page reads the same cart, item shares, prices, and revision the agent reports in your group. Changes made in iMessage appear here automatically. To add, remove, clear, undo, or approve, message the GroupCart number in the group chat.</div>
    <div class="layout">
      <section>
        <div class="card">
          <div class="card-title"><h2>Your shared basket</h2><span class="muted" id="revision"></span></div>
          <div class="items" id="items"></div>
          <div class="total"><span>Basket total</span><span id="total">$0.00</span></div>
          <div class="budget" id="budget"><div class="budget-label"><span id="budgetText"></span><span id="budgetAmounts"></span></div><div class="budget-track"><div class="budget-fill" id="budgetProgress"></div></div></div>
        </div>
        <div class="card" id="demoPanel">
          <div class="card-title"><h2>Send a sample request</h2><span class="sub">Local demo</span></div>
          <div class="demo">
            <select id="member" aria-label="Choose who is sending"></select>
            <div class="demo-row"><input id="request" placeholder="e.g. 2 bananas, pasta for everyone" /><button id="send">Add</button></div>
          </div>
          <p class="status" id="status" role="status" aria-live="polite"></p>
        </div>
        <div class="card" id="catalogPanel">
          <div class="card-title"><h2>Live Kroger catalog</h2><span class="sub" id="krogerMode">Checking connection…</span></div>
          <div class="demo-row"><input id="krogerQuery" placeholder="Search milk, Vital Farms eggs…" /><button id="krogerSearch">Search</button></div>
          <p class="status" id="krogerStatus" role="status" aria-live="polite"></p>
          <div class="product-results" id="krogerResults"></div>
          <p class="footer">Live product listings from Kroger. Location-specific prices appear when a store ID is configured. This search does not modify a Kroger cart.</p>
        </div>
      </section>
      <aside>
        <div class="card" id="approvalsPanel">
          <div class="card-title"><h2>Cost split</h2><span class="sub">Pre-tax estimate</span></div>
          <div class="people" id="people"></div>
          <div class="actions"><button class="secondary" id="approve">Approve my share</button><button id="checkout">Mock checkout</button></div>
          <p class="status" id="approvalStatus" role="status" aria-live="polite"></p>
          <p class="footer" id="approvalFooter">Every cart edit creates a new revision and resets approvals. Checkout is simulated; no payment is taken.</p>
        </div>${SPLITWISE_PANEL_HTML}
      </aside>
    </div>
  </main>
  <script>
    const esc = (value) => String(value).replace(/[&<>\"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    const dollars = (cents) => new Intl.NumberFormat("en-US", {style:"currency",currency:"USD"}).format(cents / 100);
    let latest = null;
    async function refresh() {
      const response = await fetch("/api/cart");
      if (!response.ok) throw new Error("Could not load cart");
      latest = await response.json();
      const demoMode = latest.demoMode;
      document.getElementById("mode").textContent = demoMode ? "Local demo" : "iMessage · live sync";
      document.getElementById("syncState").textContent = "Synced " + new Date().toLocaleTimeString([], {hour:"numeric",minute:"2-digit",second:"2-digit"}) + " · refreshes automatically";
      document.getElementById("liveNote").hidden = demoMode;
      document.getElementById("demoPanel").hidden = !demoMode;
      document.getElementById("catalogPanel").hidden = !demoMode;
      document.querySelector("#approvalsPanel .actions").hidden = !demoMode;
      document.getElementById("approvalFooter").textContent = demoMode
        ? "Every cart edit creates a new revision and resets approvals. Checkout is simulated; no payment is taken."
        : "Approval status comes from the current cart revision. Approve and checkout in the iMessage group chat; checkout is simulated and takes no payment.";
      document.getElementById("revision").textContent = "Revision " + latest.revision;
      document.getElementById("total").textContent = dollars(latest.totalCents);
      const budget = document.getElementById("budget");
      const withinBudget = latest.totalCents <= latest.budgetCents;
      budget.classList.toggle("over", !withinBudget);
      document.getElementById("budgetText").textContent = withinBudget ? "Within sample budget" : "Over sample budget";
      document.getElementById("budgetAmounts").textContent = dollars(latest.totalCents) + " / " + dollars(latest.budgetCents);
      document.getElementById("budgetProgress").style.width = Math.min(100, latest.budgetCents > 0 ? latest.totalCents / latest.budgetCents * 100 : 0) + "%";
      document.getElementById("items").innerHTML = latest.items.length ? latest.items.map((item) => {
        const assignment = item.participantNames.length > 1 ? "Shared by " + item.participantNames.join(", ") : "For " + item.ownerName;
        const detail = (item.priceSource === "kroger" ? "Kroger price · " : "Sample price · ") + item.quantity + " × " + dollars(item.unitPriceCents) + " each · " + assignment;
        return '<div class="item"><div><div class="item-name">' + esc(item.name) + '</div><div class="detail">' + esc(detail) + '</div></div><div class="price">' + dollars(item.totalCents) + '</div></div>';
      }).join("") : '<p class="empty">Your shared basket is empty. Add an item in the iMessage group chat.</p>';
      const memberMax = Math.max(1, ...latest.members.map((member) => member.shareCents));
      document.getElementById("people").innerHTML = latest.members.map((member) => '<div class="person"><div class="person-left"><span class="avatar">' + esc(member.name.slice(0,1).toUpperCase()) + '</span><div><strong>' + esc(member.name) + '</strong><div class="approval">' + (member.approved ? "Approved revision " + latest.revision : "Awaiting approval") + '</div></div></div><strong>' + dollars(member.shareCents) + '</strong><div class="share-track"><div class="share-fill" style="width:' + Math.round(member.shareCents / memberMax * 100) + '%"></div></div></div>').join("") || '<p class="empty">Add members to GROUP_CART_MEMBERS.</p>';
      const select = document.getElementById("member");
      const selected = select.value;
      select.innerHTML = latest.members.map((member) => '<option value="' + esc(member.id) + '">' + esc(member.name) + '</option>').join("");
      if (latest.members.some((member) => member.id === selected)) select.value = selected;
      const myMember = latest.members.find((member) => member.id === select.value);
      document.getElementById("approve").disabled = !demoMode || !myMember || myMember.approved || !latest.items.length;
      document.getElementById("checkout").disabled = !demoMode || !latest.items.length || latest.members.some((member) => !member.approved);
      document.getElementById("send").disabled = !demoMode;
      document.getElementById("request").disabled = !demoMode;
      document.getElementById("krogerMode").textContent = latest.krogerConfigured ? (latest.krogerLocationConfigured ? "Store prices enabled" : "Connected · choose a store for prices") : "Not connected";
      document.getElementById("krogerSearch").disabled = !latest.krogerConfigured;
    }
    async function post(path, body) {
      const response = await fetch(path, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const result = await response.json();
      if (!response.ok && !result.message) throw new Error(result.error || "Request failed");
      return result;
    }
    document.getElementById("send").addEventListener("click", async () => {
      const input = document.getElementById("request");
      const text = input.value.trim();
      if (!text) return;
      try {
        const result = await post("/api/demo-message", {memberId:document.getElementById("member").value,text});
        document.getElementById("status").textContent = result.message;
        input.value = "";
        await refresh();
      } catch (error) { document.getElementById("status").textContent = error.message; }
    });
    document.getElementById("request").addEventListener("keydown", (event) => { if (event.key === "Enter") document.getElementById("send").click(); });
    document.getElementById("krogerSearch").addEventListener("click", async () => {
      const query = document.getElementById("krogerQuery").value.trim();
      if (!query) return;
      const status = document.getElementById("krogerStatus");
      const results = document.getElementById("krogerResults");
      status.textContent = "Searching Kroger…";
      results.innerHTML = "";
      try {
        const response = await fetch("/api/kroger/products?q=" + encodeURIComponent(query));
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Search failed.");
        status.textContent = data.total + " matching catalog items found";
        results.innerHTML = data.products.map((product) => {
          const price = product.promoPriceCents !== null && product.promoPriceCents > 0 ? product.promoPriceCents : product.regularPriceCents;
          const priceText = price === null ? "Select a store for price" : dollars(price);
          const size = product.size ? " · " + product.size : "";
          const brand = product.brand ? esc(product.brand) : "Kroger catalog";
          return '<div class="product-result"><div><strong>' + esc(product.description) + '</strong><div class="product-brand">' + brand + esc(size) + '</div></div><div class="product-price">' + esc(priceText) + '</div></div>';
        }).join("") || '<p class="empty">No matching products.</p>';
      } catch (error) { status.textContent = error.message; }
    });
    document.getElementById("krogerQuery").addEventListener("keydown", (event) => { if (event.key === "Enter") document.getElementById("krogerSearch").click(); });
    document.getElementById("approve").addEventListener("click", async () => {
      try { const result = await post("/api/approve", {memberId:document.getElementById("member").value}); document.getElementById("approvalStatus").textContent = result.message; await refresh(); }
      catch (error) { document.getElementById("approvalStatus").textContent = error.message; }
    });
    document.getElementById("checkout").addEventListener("click", async () => {
      try { const result = await post("/api/checkout", {memberId:document.getElementById("member").value}); document.getElementById("approvalStatus").textContent = result.message; await refresh(); }
      catch (error) { document.getElementById("approvalStatus").textContent = error.message; }
    });
    const showSyncError = (error) => { document.getElementById("syncState").textContent = "Sync paused · " + (error.message || "could not reach GroupCart"); };
    refresh().catch((error) => { document.getElementById("mode").textContent = error.message; showSyncError(error); });
    setInterval(() => refresh().catch(showSyncError), 2500);
  </script>${SPLITWISE_PANEL_SCRIPT}
</body>
</html>`;

function safeSnapshot(snapshot: CartSnapshot): Omit<CartSnapshot, "members"> & {
  members: Array<Omit<CartSnapshot["members"][number], "handle">>;
} {
  const { members, ...rest } = snapshot;
  return { ...rest, members: members.map(({ handle: _handle, ...member }) => member) };
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 8_192) reject(new Error("Request body is too large."));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) as Record<string, unknown> : {}); }
      catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}

function sendJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export function startDashboard(store: CartStore, port: number, demoMode: boolean, krogerClient?: KrogerClient, calendar?: CalendarService): Server {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Google Calendar: /calendar page, /api/calendar, and /api/google/* OAuth routes.
    if (calendar && await handleCalendarRequest(calendar, request, response, url)) return;
    if (request.method === "GET" && url.pathname === "/api/kroger/oauth/start") {
      if (!krogerClient) return sendJson(response, 503, { error: "Kroger credentials are not configured." });
      const memberId = url.searchParams.get("memberId");
      const pending = store.pendingKrogerCheckout();
      if (!memberId || !pending || pending.status !== "awaiting_oauth" || pending.selectedMemberId !== memberId) {
        return sendJson(response, 409, { error: "No matching approved Kroger checkout is waiting for sign-in. Start checkout in the iMessage group first." });
      }
      const authorization = krogerClient.createUserAuthorization(memberId);
      response.writeHead(302, { location: authorization.url, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/kroger/oauth/callback") {
      if (!krogerClient) return sendJson(response, 503, { error: "Kroger credentials are not configured." });
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (url.searchParams.has("error")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end("<!doctype html><title>Kroger sign-in cancelled</title><p>Kroger sign-in was cancelled. GroupCart was not changed. Return to the iMessage group to retry or text “cancel checkout”.</p>");
        return;
      }
      if (!code || !state) return sendJson(response, 400, { error: "Kroger did not return a sign-in code. Return to the group and start checkout again." });
      try {
        const authorization = await krogerClient.completeUserAuthorization(code, state);
        const result = await store.completeKrogerCartCheckout(
          authorization.memberId,
          (items) => krogerClient.addItemsToCart(authorization.accessToken, items),
        );
        const safeMessage = result.message.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
        response.writeHead(result.ok ? 200 : 409, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>GroupCart · Kroger</title><body style="font:16px system-ui;max-width:640px;margin:4rem auto;padding:0 1rem"><h1>${result.ok ? "Kroger cart ready" : "Checkout needs attention"}</h1><p>${safeMessage}</p><p><a href="https://www.kroger.com">Open Kroger</a></p></body></html>`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Kroger sign-in failed.";
        const safeDetail = detail.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
        response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>GroupCart · Kroger</title><body style="font:16px system-ui;max-width:640px;margin:4rem auto;padding:0 1rem"><h1>Kroger sign-in did not finish</h1><p>${safeDetail}</p><p>Return to the iMessage group to try again. GroupCart has not cleared the approved list.</p></body></html>`);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/cart") {
      sendJson(response, 200, {
        ...safeSnapshot(store.snapshot()),
        demoMode,
        krogerConfigured: Boolean(krogerClient),
        krogerLocationConfigured: Boolean(krogerClient?.hasLocation),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/splitwise") {
      // Splitwise status of the latest checkout (names and amounts only).
      return sendJson(response, 200, splitwiseDashboardView(store.latestSplitwiseExpense()));
    }
    if (request.method === "GET" && url.pathname === "/api/kroger/products") {
      if (!krogerClient) return sendJson(response, 503, { error: "Kroger API credentials are not configured in .env." });
      try {
        const result = await krogerClient.searchProducts(url.searchParams.get("q") ?? "");
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 502, { error: error instanceof Error ? error.message : "Kroger search failed." });
      }
    }
    if (request.method !== "POST") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }

    try {
      const body = await readJson(request);
      if (!demoMode && (url.pathname === "/api/approve" || url.pathname === "/api/checkout")) {
        return sendJson(response, 403, { error: "In live mode, approve and checkout by messaging GroupCart from your configured Spectrum group." });
      }
      if (url.pathname === "/api/demo-message") {
        if (!demoMode) return sendJson(response, 403, { error: "Demo messages are disabled while Spectrum is connected." });
        if (typeof body.memberId !== "string" || typeof body.text !== "string" || !body.text.trim()) {
          return sendJson(response, 400, { error: "Choose a member and enter a message." });
        }
        const member = store.getMembers().find((candidate) => candidate.id === body.memberId);
        if (!member) return sendJson(response, 404, { error: "Member not found." });
        // Google Calendar: answer the "calendar" command before cart processing.
        const calendarReply = calendar ? await calendar.replyToCommand(`demo:${randomUUID()}`, body.text) : null;
        if (calendarReply) return sendJson(response, 200, { message: calendarReply });
      const reply = krogerClient
        ? await store.processLiveIncomingText(
          `demo:${randomUUID()}`,
          member.id,
          body.text,
          (query) => krogerClient.searchProducts(query),
          krogerClient.selectedLocationId,
        )
        : store.processIncomingText(`demo:${randomUUID()}`, member.id, body.text);
        return sendJson(response, 200, { message: reply ?? "No response." });
      }
      if (url.pathname === "/api/approve") {
        if (typeof body.memberId !== "string") return sendJson(response, 400, { error: "Choose a member." });
        const result = store.approveForMember(body.memberId);
        return sendJson(response, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/checkout") {
        const result = store.completeMockCheckout(typeof body.memberId === "string" ? body.memberId : undefined);
        return sendJson(response, result.ok ? 200 : 400, result);
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Request failed." });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`GroupCart dashboard available at http://127.0.0.1:${port}`);
  });
  return server;
}
