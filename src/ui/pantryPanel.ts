import { emptyState, icon, infoTip } from "./shell.js";
import { registerFlavor } from "./themes.js";

/**
 * Groceries › Pantry tab (#pantry). A compact grid of item chips grouped Out / Low / In stock; tapping a chip
 * cycles In stock → Low → Out. Low and Out items get an "add to cart" button (demo; in live mode the group chat
 * does it: “out of eggs” → “yes”). Items that run out regularly show the recurring-list command to text.
 * Rendered by window.GCKitchen (src/ui/mealsPanel.ts) from GET /api/kitchen; changes are JSON POSTs to
 * /api/kitchen/pantry/* (src/kitchen.ts).
 */

registerFlavor({
  "groceries.tab.pantry": { classic: "Pantry", minecraft: "Barrel", cyberpunk: "Fridge.exe" },
  "kitchen.out": { classic: "Out", minecraft: "Empty", cyberpunk: "Depleted" },
  "kitchen.low": { classic: "Low", minecraft: "Running low", cyberpunk: "Low charge" },
  "kitchen.stock": { classic: "In stock", minecraft: "Stacked", cyberpunk: "Cached" },
  "empty.pantry.title": { classic: "Pantry is empty", minecraft: "Barrel is empty", cyberpunk: "Fridge.exe: no data" },
});

/** Inline SVG (24px grid, stroke) used for the tab icon. */
export const PANTRY_ICON = '<svg class="gc-icon gl-tab-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8.5 3.5h7"/><path d="M8 6.5h8"/><path d="M8 6.5c-1.6 1.2-2.5 2.7-2.5 4.6V19a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-7.9c0-1.9-.9-3.4-2.5-4.6"/><path d="M5.5 13h13"/></svg>';

export const PANTRY_VIEW = `
<div class="gl-view kp" id="glView-pantry" role="tabpanel" aria-labelledby="glTab-pantry" data-gl-view="pantry" hidden>
  <div class="kp-head">
    <form class="kp-add" id="kpAdd" autocomplete="off">${icon("plus", { size: 18 })}<input class="kp-add-input" id="kpAddInput" name="item" maxlength="40" placeholder="Add item" aria-label="Add a pantry item" /></form>
    <span class="gc-spacer"></span>
    ${infoTip("Tap an item to cycle In stock → Low → Out. In the group: “out of eggs”, “low on rice”, “restocked eggs”.")}
  </div>
  <div class="kp-suggest" id="kpSuggest" hidden></div>
  <div class="kp-groups" id="kpGroups"></div>
  <section class="gc-card" id="kpEmpty" hidden>${emptyState({ icon: "cart", title: "Pantry is empty", text: "Add what you keep at home, or text “out of eggs”.", flavor: "empty.pantry" })}</section>
</div>`;

export const PANTRY_STYLES = `
.kp-head { display:flex; align-items:center; gap:var(--gc-space-2); margin-bottom:var(--gc-space-3); }
.kp-add { display:flex; align-items:center; gap:8px; height:40px; padding:0 14px 0 12px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); background:var(--gc-surface); color:var(--gc-accent); min-width:0; width:min(280px, 100%); }
.kp-add:focus-within { outline:2px solid var(--gc-focus); outline-offset:-1px; border-color:transparent; color:var(--gc-text); }
.kp-add-input { flex:1; min-width:0; height:100%; border:0; background:transparent; color:var(--gc-text); font:var(--gc-fs-md) var(--gc-font); }
.kp-add-input::placeholder { color:var(--gc-accent); }
.kp-add-input:focus { outline:none; }
.kp-suggest { display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px; margin-bottom:var(--gc-space-3); padding:8px 14px; border-radius:var(--gc-radius-md); background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:var(--gc-fs-sm); color:var(--gc-text-2); }
.kp-copy { height:28px; padding:0 10px; border-radius:var(--gc-radius-sm); background:var(--gc-surface); border:1px solid var(--gc-border); color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:copy; }
.kp-copy:hover { border-color:var(--gc-accent); color:var(--gc-accent); }
.kp-groups { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:var(--gc-space-4); align-items:start; }
.kp-group.is-stock, .kp-group.is-alone { grid-column:1 / -1; }
.kp-group .gc-card-head { margin-bottom:var(--gc-space-2); }
.kp-group .gc-card-title { font-size:var(--gc-fs-md); }
.kp-count { color:var(--gc-muted); font-size:var(--gc-fs-sm); font-variant-numeric:tabular-nums; }
.kp-dot { width:10px; height:10px; flex:none; border-radius:50%; background:var(--kp-c); }
.kp-group.is-out, .kp-chip.is-out { --kp-c:var(--gc-danger); --kp-soft:var(--gc-danger-soft); }
.kp-group.is-low, .kp-chip.is-low { --kp-c:var(--gc-warning); --kp-soft:var(--gc-warning-soft); }
.kp-group.is-stock, .kp-chip.is-stock { --kp-c:var(--gc-success); --kp-soft:var(--gc-success-soft); }
.kp-chips { display:flex; flex-wrap:wrap; gap:8px; }
.kp-item { display:inline-flex; align-items:stretch; max-width:100%; border-radius:var(--gc-radius-pill); }
.kp-chip { display:inline-flex; align-items:center; gap:7px; min-width:0; max-width:100%; height:34px; padding:0 12px 0 10px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); background:var(--gc-surface); color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; transition:background-color .15s ease, border-color .15s ease; }
.kp-chip:hover { background:var(--gc-hover); }
.kp-chip.is-out, .kp-chip.is-low { background:var(--kp-soft); border-color:transparent; }
.kp-chip.is-out:hover, .kp-chip.is-low:hover { filter:brightness(.97); }
.kp-item.has-cart .kp-chip { border-top-right-radius:0; border-bottom-right-radius:0; padding-right:10px; }
.kp-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kp-mini { display:inline-flex; align-items:center; gap:2px; color:var(--gc-muted); font-size:11px; font-weight:500; white-space:nowrap; }
.kp-chip.is-out .kp-mini, .kp-chip.is-low .kp-mini { color:var(--kp-c); }
.kp-mini .gc-icon { width:13px; height:13px; }
.kp-cart { display:inline-grid; place-items:center; width:34px; height:34px; padding:0; border:0; border-left:1px solid color-mix(in srgb, var(--kp-c) 30%, transparent); border-radius:0 var(--gc-radius-pill) var(--gc-radius-pill) 0; background:var(--kp-soft); color:var(--kp-c); cursor:pointer; }
.kp-item.is-out .kp-cart { --kp-c:var(--gc-danger); --kp-soft:var(--gc-danger-soft); }
.kp-item.is-low .kp-cart { --kp-c:var(--gc-warning); --kp-soft:var(--gc-warning-soft); }
.kp-cart:hover { filter:brightness(.94); }
.kp-cart .gc-icon { width:17px; height:17px; }
.kp-x { display:none; width:24px; height:24px; margin:5px 0 0 -4px; padding:0; place-items:center; border:0; border-radius:50%; background:transparent; color:var(--gc-muted); cursor:pointer; }
.kp-x .gc-icon { width:14px; height:14px; }
@media (hover:hover) { .kp-item:hover .kp-x, .kp-x:focus-visible { display:inline-grid; } .kp-x:hover { background:var(--gc-hover); color:var(--gc-text); } }
.kp-none { color:var(--gc-muted); font-size:var(--gc-fs-sm); }
@media (max-width: 760px) {
  .kp-groups { grid-template-columns:minmax(0, 1fr); gap:var(--gc-space-3); }
  .kp-add { width:100%; }
  .kp-chip { height:36px; }
  .kp-cart { width:36px; height:36px; }
}`;

/** Defines GCKitchen.pantry.render(state) and its event handlers; the shared loader lives in mealsPanel.ts. */
export const PANTRY_SCRIPT = `
(() => {
  const GC = window.GC;
  const K = window.GCKitchen;
  const $ = (id) => document.getElementById(id);
  const esc = GC.esc;
  const NEXT = { stock: "low", low: "out", out: "stock" };
  const GROUPS = [["out", "Out", "kitchen.out"], ["low", "Low", "kitchen.low"], ["stock", "In stock", "kitchen.stock"]];
  const cadence = (days) => days >= 6 && days <= 8 ? "1w" : days >= 12 && days <= 16 ? "2w" : days >= 26 && days <= 35 ? "1mo" : Math.round(days) + "d";

  function chip(item, demo) {
    const marks = (item.inCart ? '<span class="kp-mini" title="In the cart">' + GC.icon("cart") + '</span>' : "")
      + (item.cadenceDays ? '<span class="kp-mini" title="Runs out about every ' + Math.round(item.cadenceDays) + ' days">↻ ' + cadence(item.cadenceDays) + '</span>' : "");
    const cart = demo && item.status !== "stock" && !item.inCart
      ? '<button class="kp-cart" type="button" data-kp-cart="' + esc(item.id) + '" aria-label="Add ' + esc(item.name) + ' to cart" title="Add to cart">' + GC.icon("plus") + '</button>' : "";
    return '<span class="kp-item is-' + item.status + (cart ? " has-cart" : "") + '">'
      + '<button class="kp-chip is-' + item.status + '" type="button" data-kp-cycle="' + esc(item.id) + '" aria-label="' + esc(item.name) + ': ' + (item.status === "stock" ? "in stock" : item.status) + '. Tap to change." title="Tap: ' + (NEXT[item.status] === "stock" ? "in stock" : NEXT[item.status]) + '">'
      + '<span class="kp-dot" aria-hidden="true"></span><span class="kp-name">' + esc(item.name) + '</span>' + marks + '</button>'
      + cart + '<button class="kp-x" type="button" data-kp-del="' + esc(item.id) + '" aria-label="Remove ' + esc(item.name) + '">' + GC.icon("close") + '</button></span>';
  }

  function render(state) {
    const items = state.pantry.items;
    const demo = state.demoMode;
    $("kpEmpty").hidden = items.length > 0;
    const groups = GROUPS.map(([status, label, flavor]) => ({ status, label, flavor, items: items.filter((item) => item.status === status) }));
    const urgent = groups.filter((group) => group.status !== "stock" && group.items.length);
    $("kpGroups").innerHTML = items.length ? groups.filter((group) => group.items.length || group.status === "stock").map((group) => {
      const addable = group.items.filter((item) => !item.inCart);
      const action = demo && group.status !== "stock" && addable.length
        ? '<button class="gc-btn gc-btn-tonal gc-btn-sm" type="button" data-kp-cart-all="' + group.status + '">' + GC.icon("cart") + 'Add ' + addable.length + '</button>' : "";
      const alone = group.status !== "stock" && urgent.length === 1 ? " is-alone" : "";
      return '<section class="gc-card kp-group is-' + group.status + alone + '" aria-label="' + group.label + '"><div class="gc-card-head"><span class="kp-dot" aria-hidden="true"></span>'
        + '<h3 class="gc-card-title" data-flavor="' + group.flavor + '">' + group.label + '</h3><span class="kp-count">' + group.items.length + '</span><span class="gc-spacer"></span>' + action + '</div>'
        + (group.items.length ? '<div class="kp-chips">' + group.items.map((item) => chip(item, demo)).join("") + '</div>' : '<p class="kp-none">Nothing yet.</p>') + '</section>';
    }).join("") : "";
    const tip = items.find((item) => item.suggestion);
    $("kpSuggest").hidden = !tip;
    $("kpSuggest").innerHTML = tip ? '<span>↻ <strong>' + esc(tip.name) + '</strong> runs out ' + esc(tip.suggestion.label) + '.</span><button class="kp-copy" type="button" data-kp-copy="' + esc(tip.suggestion.command) + '" title="Copy, then send it in the group to add it to the recurring list">' + esc(tip.suggestion.command) + '</button>' : "";
    if (GC.applyFlavor) GC.applyFlavor($("kpGroups"));
  }

  async function addToCart(ids) {
    const result = await K.post("/api/kitchen/pantry/to-cart", { itemIds: ids });
    if (result) { K.toast(result.message || "Added to the cart"); if (result.status === "added") GC.celebrate && GC.celebrate("Added to the cart"); }
  }

  $("kpGroups").addEventListener("click", async (event) => {
    const cycle = event.target.closest("[data-kp-cycle]");
    if (cycle) {
      const item = K.state.pantry.items.find((entry) => entry.id === cycle.dataset.kpCycle);
      if (!item) return;
      const next = NEXT[item.status];
      item.status = next;
      render(K.state);
      const done = await K.post("/api/kitchen/pantry/status", { itemId: item.id, status: next });
      if (done && next === "stock" && GC.celebrate) GC.celebrate(item.name + " restocked");
      return K.load(true);
    }
    const cart = event.target.closest("[data-kp-cart]");
    if (cart) { cart.disabled = true; await addToCart([cart.dataset.kpCart]); return K.load(true); }
    const all = event.target.closest("[data-kp-cart-all]");
    if (all) {
      all.disabled = true;
      await addToCart(K.state.pantry.items.filter((item) => item.status === all.dataset.kpCartAll && !item.inCart).map((item) => item.id));
      return K.load(true);
    }
    const del = event.target.closest("[data-kp-del]");
    if (del) { await K.post("/api/kitchen/pantry/delete", { itemId: del.dataset.kpDel }); return K.load(true); }
  });
  $("kpSuggest").addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-kp-copy]");
    if (!copy) return;
    try { await navigator.clipboard.writeText(copy.dataset.kpCopy); K.toast("Copied. Paste it in the group."); } catch (error) { K.toast("Text “" + copy.dataset.kpCopy + "” in the group."); }
  });
  $("kpAdd").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("kpAddInput");
    const name = input.value.trim();
    if (!name) return;
    input.value = "";
    await K.post("/api/kitchen/pantry/add", { name, status: "stock" });
    await K.load(true);
    input.focus();
  });

  K.pantry = { render };
})();
`;
