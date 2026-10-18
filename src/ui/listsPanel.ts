import { button, dialog, icon, type PageOptions } from "./shell.js";

/**
 * Groceries tabs (Cart | Lists) for /groceries. `withListsTabs(page)` wraps the
 * existing cart page body as the "Cart" view and adds the one-off named Lists
 * view (party run, event snack lists), its dialog, styles, and a self-contained
 * script (data from GET /api/named-lists, changes via JSON POSTs to
 * /api/named-lists/*). The tab is kept in the URL hash (#lists) so other pages
 * can link straight to it.
 */

const tabs = `
<div class="gl-tabs" role="tablist" aria-label="Groceries views">
  <button class="gl-tab" type="button" role="tab" id="glTab-cart" data-gl-tab="cart" aria-selected="true" aria-controls="glView-cart">${icon("check", { size: 18, className: "gl-tab-check" })}${icon("cart", { size: 18, className: "gl-tab-icon" })}<span>Cart</span></button>
  <button class="gl-tab" type="button" role="tab" id="glTab-lists" data-gl-tab="lists" aria-selected="false" aria-controls="glView-lists">${icon("check", { size: 18, className: "gl-tab-check" })}${icon("chores", { size: 18, className: "gl-tab-icon" })}<span>Lists</span><span class="gl-count" id="glListsCount"></span></button>
</div>`;

const listsView = `
<div class="gl-view" id="glView-lists" role="tabpanel" aria-labelledby="glTab-lists" data-gl-view="lists" hidden>
  <div class="gc-section-head gl-lists-head">
    <span class="gc-meta" id="glListsMeta"></span>
    <span class="gc-spacer"></span>
    ${button({ label: "New list", variant: "tonal", size: "sm", icon: "plus", attrs: 'data-gl-new="list"' })}
  </div>
  <div class="gl-lists" id="glLists"></div>
</div>`;

const dialogs = dialog({
  id: "glListDialog",
  title: "New list",
  body: `
  <div class="gl-form">
    <label class="gl-field"><span class="gl-label">Name</span><input class="gc-input" id="glListName" placeholder="Party run" maxlength="48" autocomplete="off" /></label>
    <label class="gl-field"><span class="gl-label">Items</span><textarea class="gc-input gl-textarea" id="glListItems" rows="3" placeholder="Chips, soda, cups"></textarea></label>
    <p class="gc-status" id="glListStatus" role="status" aria-live="polite"></p>
  </div>`,
  actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Create", id: "glListSave" })}`,
}) + `<div class="gl-toast" id="glToast" role="status" aria-live="polite" hidden></div>`;

const styles = `
.gl-tabs { display:inline-flex; margin-bottom:var(--gc-space-4); border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); overflow:hidden; background:var(--gc-surface); }
.gl-tab { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:40px; padding:0 20px 0 16px; border:0; background:transparent; color:var(--gc-text-2); font:500 var(--gc-fs-md)/1 var(--gc-font); cursor:pointer; white-space:nowrap; transition:background-color .15s ease; }
.gl-tab + .gl-tab { border-left:1px solid var(--gc-border-strong); }
.gl-tab:hover:not([aria-selected="true"]) { background:var(--gc-hover); }
.gl-tab[aria-selected="true"] { background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.gl-tab .gl-tab-check { display:none; }
.gl-tab[aria-selected="true"] .gl-tab-check { display:block; }
.gl-tab[aria-selected="true"] .gl-tab-icon { display:none; }
.gl-count { min-width:20px; height:20px; padding:0 6px; border-radius:10px; background:var(--gc-surface-2); border:1px solid var(--gc-border); color:var(--gc-text-2); font-size:11px; line-height:18px; text-align:center; }
.gl-count:empty { display:none; }
.gl-tab[aria-selected="true"] .gl-count { background:transparent; border-color:currentColor; color:inherit; }



.gl-lists-head { margin-bottom:var(--gc-space-3); }
.gl-lists { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap:var(--gc-space-4); align-items:start; }
.gl-card { padding-bottom:var(--gc-space-3); }
.gl-card .gc-card-head { margin-bottom:var(--gc-space-2); }
.gl-card .gc-card-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.gl-emoji { width:32px; height:32px; flex:none; display:grid; place-items:center; border-radius:10px; background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:18px; line-height:1; }
.gl-head-main { flex:1; min-width:0; }
.gl-head-sub { color:var(--gc-muted); font-size:var(--gc-fs-xs); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gl-event { color:var(--gc-accent); font-weight:500; text-decoration:none; }
.gl-event:hover { text-decoration:underline; }
.gl-items { list-style:none; margin:0; padding:0; }
.gl-item { display:flex; align-items:center; gap:10px; min-height:40px; padding:2px 0; border-top:1px solid var(--gc-border); }
.gl-item:first-child { border-top:0; }
.gl-check { width:22px; height:22px; flex:none; display:grid; place-items:center; padding:0; border-radius:50%; border:2px solid var(--gc-border-strong); background:transparent; color:transparent; cursor:pointer; transition:background-color .15s ease, border-color .15s ease; }
.gl-check:hover { border-color:var(--gc-accent); color:var(--gc-accent); }
.gl-check[aria-checked="true"] { background:var(--gc-accent); border-color:var(--gc-accent); color:var(--gc-on-accent); }
.gl-name { flex:1; min-width:0; overflow-wrap:anywhere; }
.gl-item.is-done .gl-name { color:var(--gc-muted); text-decoration:line-through; }
.gl-tag { display:inline-flex; align-items:center; gap:3px; color:var(--gc-muted); font-size:11px; }
.gl-x { width:28px; height:28px; flex:none; display:grid; place-items:center; border:0; border-radius:50%; background:transparent; color:var(--gc-muted); cursor:pointer; opacity:0; transition:opacity .12s ease; }
.gl-item:hover .gl-x, .gl-x:focus-visible { opacity:1; }
.gl-x:hover { background:var(--gc-hover); color:var(--gc-text); }
@media (hover:none) { .gl-x { opacity:1; } }
.gl-done-toggle { display:flex; align-items:center; gap:6px; width:100%; margin-top:var(--gc-space-1); padding:6px 0; border:0; border-top:1px solid var(--gc-border); background:transparent; color:var(--gc-muted); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; text-align:left; }
.gl-done-toggle .gc-icon { transition:transform .15s ease; }
.gl-done-toggle[aria-expanded="true"] .gc-icon { transform:rotate(180deg); }
.gl-add { display:flex; align-items:center; gap:10px; margin-top:var(--gc-space-1); padding-top:var(--gc-space-2); border-top:1px solid var(--gc-border); color:var(--gc-accent); }
.gl-add-input { flex:1; min-width:0; height:32px; border:0; background:transparent; color:var(--gc-text); font:var(--gc-fs-md) var(--gc-font); }
.gl-add-input::placeholder { color:var(--gc-accent); }
.gl-add-input:focus { outline:none; }
.gl-add:focus-within { color:var(--gc-text); }

.gl-form { display:grid; gap:var(--gc-space-4); }
.gl-field { display:grid; gap:6px; min-width:0; }
.gl-label { font-size:var(--gc-fs-xs); font-weight:500; color:var(--gc-muted); }
.gl-textarea { height:auto; min-height:72px; padding:10px 12px; resize:vertical; font:var(--gc-fs-md)/1.4 var(--gc-font); }

.gl-toast { position:fixed; left:50%; bottom:24px; z-index:40; transform:translateX(-50%); max-width:min(560px, calc(100vw - 32px)); padding:12px 16px; border-radius:var(--gc-radius-sm); background:var(--gc-tooltip-bg); color:var(--gc-tooltip-text); font-size:var(--gc-fs-sm); box-shadow:0 2px 8px rgba(0,0,0,.2); white-space:pre-line; }
@media (max-width: 420px) { .gl-hide-xs { display:none; } .gl-card .gc-btn-sm { padding:0 10px; } }
@media (max-width: 760px) {
  .gl-tabs { display:flex; }
  .gl-tab { flex:1; padding:0 8px; }
  .gl-toast { bottom:calc(var(--gc-bottomnav-h) + 24px); }
}`;

const script = `
(() => {
  const GC = window.GC;
  const $ = (id) => document.getElementById(id);
  const esc = GC.esc;
  let data = null;
  let lastJson = "";
  let allIds = [];
  const openDone = new Set();
  const views = ["cart", "lists"];

  function show(view, push) {
    if (!views.includes(view)) view = "cart";
    document.querySelectorAll("[data-gl-tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.glTab === view)));
    document.querySelectorAll("[data-gl-view]").forEach((panel) => { panel.hidden = panel.dataset.glView !== view; });
    if (push) history.replaceState(null, "", view === "cart" ? location.pathname + location.search : "#" + view);
    if (view !== "cart") refresh(true);
  }
  document.querySelector(".gl-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-gl-tab]");
    if (tab) show(tab.dataset.glTab, true);
  });
  document.querySelector(".gl-tabs").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const current = views.indexOf(document.querySelector('[data-gl-tab][aria-selected="true"]').dataset.glTab);
    const next = views[(current + (event.key === "ArrowRight" ? 1 : views.length - 1)) % views.length];
    show(next, true);
    document.querySelector('[data-gl-tab="' + next + '"]').focus();
  });
  window.addEventListener("hashchange", () => show(location.hash.slice(1), false));

  let toastTimer = 0;
  function toast(text) {
    const node = $("glToast");
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
  }

  async function post(path, body) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || "Something went wrong.");
    return result;
  }

  const member = (id) => (data.members.find((m) => m.id === id) || { id, name: "someone" });
  function renderLists() {
    const lists = data.lists;
    $("glListsCount").textContent = lists.length ? String(lists.length) : "";
    const cards = lists.map((list) => {
      const open = list.items.filter((item) => !item.checked);
      const done = list.items.filter((item) => item.checked);
      const showDone = openDone.has(list.id);
      const row = (item) => '<li class="gl-item' + (item.checked ? " is-done" : "") + '">'
        + '<button class="gl-check" type="button" role="checkbox" aria-checked="' + item.checked + '" data-toggle="' + esc(item.id) + '" aria-label="' + esc(item.name) + '">' + GC.icon("check") + '</button>'
        + '<span class="gl-name">' + esc(item.name) + '</span>'
        + (item.carted ? '<span class="gl-tag" title="Moved to the cart">' + GC.icon("cart") + 'In cart</span>' : "")
        + '<button class="gl-x" type="button" data-del-item="' + esc(item.id) + '" aria-label="Remove ' + esc(item.name) + '">' + GC.icon("close") + '</button></li>';
      const cartButton = data.demoMode
        ? '<button class="gc-btn gc-btn-tonal gc-btn-sm" type="button" data-to-cart="' + esc(list.id) + '"' + (open.length ? "" : " disabled") + '>' + GC.icon("cart") + '<span class="gl-hide-xs">To cart</span></button>'
        : '<button class="gc-btn gc-btn-tonal gc-btn-sm" type="button" disabled title="Text “' + esc(list.name.toLowerCase()) + ' to cart” in the group">' + GC.icon("cart") + '<span class="gl-hide-xs">To cart</span></button>';
      return '<section class="gc-card gl-card" data-list="' + esc(list.id) + '">'
        + '<div class="gc-card-head"><span class="gl-emoji" aria-hidden="true">' + (list.emoji ? esc(list.emoji) : GC.icon("chores")) + '</span>'
        + '<div class="gl-head-main"><h2 class="gc-card-title" title="' + esc(list.name) + '">' + esc(list.name) + '</h2>'
        + '<div class="gl-head-sub">' + (open.length ? open.length + " left" : "Done") + ' · '
        + (list.event ? '<a class="gl-event" href="/calendar?event=' + encodeURIComponent(list.event.id) + '">' + esc(list.event.label ? list.event.title + " " + list.event.label : list.event.title) + '</a>' : esc("By " + member(list.createdBy).name)) + '</div></div>'
        + cartButton
        + '<button class="gc-icon-btn" type="button" data-del-list="' + esc(list.id) + '" aria-label="Delete ' + esc(list.name) + '" title="Delete list">' + GC.icon("close") + '</button></div>'
        + '<ul class="gl-items">' + open.map(row).join("") + '</ul>'
        + (done.length ? '<button class="gl-done-toggle" type="button" data-done="' + esc(list.id) + '" aria-expanded="' + showDone + '">' + GC.icon("chevronDown") + 'Done (' + done.length + ')</button>'
          + (showDone ? '<ul class="gl-items">' + done.map(row).join("") + '</ul>' : "") : "")
        + '<form class="gl-add" data-add="' + esc(list.id) + '">' + GC.icon("plus") + '<input class="gl-add-input" name="item" placeholder="Add item" maxlength="60" autocomplete="off" aria-label="Add item to ' + esc(list.name) + '" /></form>'
        + '</section>';
    });
    const left = lists.reduce((sum, list) => sum + list.remaining, 0);
    $("glListsMeta").textContent = lists.length ? lists.length + (lists.length === 1 ? " list · " : " lists · ") + left + " to buy" : "";
    $("glLists").innerHTML = cards.length ? cards.join("") : '<section class="gc-card">' + '<div class="gc-empty">' + GC.icon("chores") + '<p class="gc-empty-title">No lists yet</p><p class="gc-empty-text">Party run, pasta night, road trip…</p></div></section>';
  }

  function render() {
    allIds = data.members.map((m) => m.id);
    const active = document.activeElement;
    const typing = active && active.classList && active.classList.contains("gl-add-input") && active.value;
    if (!typing) {
      const focusedList = active && active.classList && active.classList.contains("gl-add-input") ? active.closest("[data-add]").dataset.add : null;
      renderLists();
      if (focusedList) { const input = document.querySelector('[data-add="' + focusedList + '"] input'); if (input) input.focus(); }
    }
  }

  async function refresh(force) {
    try {
      const response = await fetch("/api/named-lists");
      if (!response.ok) return;
      const text = await response.text();
      if (!force && text === lastJson) return;
      lastJson = text;
      data = JSON.parse(text);
      render();
    } catch (error) { /* offline; the cart view shows sync status */ }
  }

  async function act(path, body, message) {
    try {
      const result = await post(path, body);
      if (message) toast(typeof message === "function" ? message(result) : message);
      await refresh(true);
      return result;
    } catch (error) { toast(error.message); return null; }
  }

  $("glLists").addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-toggle]");
    if (toggle) { toggle.setAttribute("aria-checked", String(toggle.getAttribute("aria-checked") !== "true")); return act("/api/named-lists/items/toggle", { itemId: toggle.dataset.toggle, checked: toggle.getAttribute("aria-checked") === "true" }); }
    const delItem = event.target.closest("[data-del-item]");
    if (delItem) return act("/api/named-lists/items/delete", { itemId: delItem.dataset.delItem });
    const doneToggle = event.target.closest("[data-done]");
    if (doneToggle) { const id = doneToggle.dataset.done; if (openDone.has(id)) openDone.delete(id); else openDone.add(id); return renderLists(); }
    const toCart = event.target.closest("[data-to-cart]");
    if (toCart) { toCart.disabled = true; return act("/api/named-lists/to-cart", { listId: toCart.dataset.toCart }, (r) => r.message || "Moved to the cart"); }
    const delList = event.target.closest("[data-del-list]");
    if (delList) {
      const list = data.lists.find((l) => l.id === delList.dataset.delList);
      if (list && confirm("Delete " + list.name + "?")) act("/api/named-lists/delete", { listId: list.id }, "List deleted");
    }
  });
  $("glLists").addEventListener("submit", (event) => {
    const form = event.target.closest("[data-add]");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input");
    const name = input.value.trim();
    if (!name) return;
    input.value = "";
    act("/api/named-lists/items", { listId: form.dataset.add, name }).then(() => { const again = document.querySelector('[data-add="' + form.dataset.add + '"] input'); if (again) again.focus(); });
  });

  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-gl-new]");
    if (!opener || !data) return;
    $("glListName").value = "";
    $("glListItems").value = "";
    $("glListStatus").textContent = "";
    GC.openDialog("glListDialog");
    setTimeout(() => $("glListName").focus(), 30);
  });
  $("glListSave").addEventListener("click", async () => {
    const body = { name: $("glListName").value.trim(), items: $("glListItems").value };
    if (!body.name) { $("glListStatus").textContent = "Name the list."; return; }
    try {
      await post("/api/named-lists/new", body);
      GC.closeDialog("glListDialog");
      show("lists", true);
      refresh(true);
    } catch (error) { $("glListStatus").textContent = error.message; }
  });
  $("glListName").addEventListener("keydown", (event) => { if (event.key === "Enter") $("glListItems").focus(); });

  show(location.hash.slice(1) || "cart", false);
  refresh(true);
  setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, 4000);
})();
`;

/** Wraps the cart page in Cart | Lists tabs. */
export function withListsTabs(page: PageOptions): PageOptions {
  return {
    ...page,
    body: `${tabs}<div class="gl-view" id="glView-cart" role="tabpanel" aria-labelledby="glTab-cart" data-gl-view="cart">${page.body}</div>${listsView}${dialogs}`,
    styles: `${page.styles ?? ""}${styles}`,
    script: `${page.script ?? ""}\n${script}`,
  };
}
