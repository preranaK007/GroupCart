import { button, dialog, icon, infoTip, type PageOptions } from "./shell.js";
import { registerFlavor } from "./themes.js";
import { PANTRY_ICON, PANTRY_SCRIPT, PANTRY_STYLES, PANTRY_VIEW } from "./pantryPanel.js";

/**
 * Groceries › Meals tab (#meals) and the kitchen tabs wrapper.
 *
 *   KITCHEN_TABS          the Pantry and Meals buttons for the Groceries tab bar (src/ui/listsPanel.ts adds them
 *                         after Cart | Lists, so the bar reads Cart | Lists | Pantry | Meals).
 *   withKitchenTabs(page) adds both views (Pantry from ./pantryPanel.ts), their dialogs, styles, and scripts to the
 *                         Groceries page (src/ui/cartPage.ts). One loader (window.GCKitchen) fetches GET /api/kitchen
 *                         and renders whichever kitchen view is open; changes are JSON POSTs to /api/kitchen/*.
 *   HOME_TONIGHT          one line for Home's Groceries card: “Tonight: 🌮 Tacos · Maya cooks”.
 *
 * Meals: a Mon–Sun week strip (Google Calendar style) with a card per planned dinner (emoji, name, cook avatar,
 * diet tags, a ⚠ chip when it doesn't suit someone), "Plan my week" (a suggestion to keep, shuffle, or discard),
 * a recipe picker per night, and "Shop" with a preview of what goes in the cart.
 */

registerFlavor({
  "groceries.tab.meals": { classic: "Meals", minecraft: "Recipes", cyberpunk: "Chow" },
  "kitchen.plan": { classic: "Plan my week", minecraft: "Craft a menu", cyberpunk: "Run menu.exe" },
  "kitchen.shop": { classic: "Shop", minecraft: "Trade", cyberpunk: "Buy" },
  "kitchen.tonight": { classic: "Tonight", minecraft: "Tonight", cyberpunk: "Tonight" },
  "kitchen.suggested": { classic: "Suggested plan", minecraft: "Recipe preview", cyberpunk: "Menu draft" },
  "empty.meals.title": { classic: "No dinners yet", minecraft: "Nothing crafted", cyberpunk: "No chow queued" },
});

export const MEALS_ICON = '<svg class="gc-icon gl-tab-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 3.5v6.5a2 2 0 0 0 4 0V3.5"/><path d="M9 10v10.5"/><path d="M17 20.5V3.5c-2.1 1.3-3.2 3.6-3.2 6.8V14H17"/></svg>';
const CHEVRON_LEFT = '<svg class="gc-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14.5 6.5L9 12l5.5 5.5"/></svg>';

/** Tab buttons in the Groceries tab bar (same markup as listsPanel's Cart and Lists tabs). */
export const KITCHEN_TABS = `<button class="gl-tab" type="button" role="tab" id="glTab-pantry" data-gl-tab="pantry" aria-selected="false" aria-controls="glView-pantry">${icon("check", { size: 18, className: "gl-tab-check" })}${PANTRY_ICON}<span data-flavor="groceries.tab.pantry">Pantry</span><span class="gl-count" id="kTabPantryCount"></span></button><button class="gl-tab" type="button" role="tab" id="glTab-meals" data-gl-tab="meals" aria-selected="false" aria-controls="glView-meals">${icon("check", { size: 18, className: "gl-tab-check" })}${MEALS_ICON}<span data-flavor="groceries.tab.meals">Meals</span></button>`;

const MEALS_VIEW = `
<div class="gl-view km" id="glView-meals" role="tabpanel" aria-labelledby="glTab-meals" data-gl-view="meals" hidden>
  <div class="km-toolbar">
    <button type="button" class="gc-btn gc-btn-outline gc-btn-sm" id="kmToday">Today</button>
    <button type="button" class="gc-icon-btn" id="kmPrev" aria-label="Previous week">${CHEVRON_LEFT}</button>
    <button type="button" class="gc-icon-btn" id="kmNext" aria-label="Next week">${icon("chevronRight", { size: 22 })}</button>
    <h2 class="km-range" id="kmRange" aria-live="polite"></h2>
    <span class="gc-spacer"></span>
    <span class="gc-hide-sm">${infoTip("VG vegan · V vegetarian · GF gluten-free · DF dairy-free · NF nut-free. ⚠ means it doesn't suit someone's dietary notes (from profiles). In the group: “plan dinners”, “what’s for dinner”, “I’ll cook tonight”, “shop for meals”.")}</span>
    <button type="button" class="gc-btn gc-btn-tonal gc-btn-sm km-plan" id="kmPlan">${icon("spark", { size: 18 })}<span data-flavor="kitchen.plan">Plan my week</span></button>
    <button type="button" class="gc-btn gc-btn-outline gc-btn-sm" id="kmShop">${icon("cart", { size: 18 })}<span data-flavor="kitchen.shop">Shop</span></button>
  </div>
  <div class="km-draftbar" id="kmDraftBar" hidden>
    ${icon("spark", { size: 18 })}<span class="km-draft-label" data-flavor="kitchen.suggested">Suggested plan</span>
    <span class="gc-spacer"></span>
    ${button({ label: "Shuffle", variant: "text", size: "sm", id: "kmShuffle", icon: "sync" })}
    ${button({ label: "Discard", variant: "text", size: "sm", id: "kmDiscard" })}
    ${button({ label: "Keep", size: "sm", id: "kmKeep", icon: "check" })}
  </div>
  <section class="gc-card km-weekcard" aria-label="Dinners this week"><div class="km-week" id="kmWeek"></div></section>
  <p class="km-hint" id="kmHint" hidden></p>
</div>`;

const MEALS_DIALOGS = dialog({
  id: "kmNight",
  title: "Dinner",
  body: `
  <div class="km-form">
    <div><span class="km-label">Cook</span><div class="km-cooks" id="kmCooks" role="radiogroup" aria-label="Cook"></div></div>
    <div><span class="km-label">Recipe</span><div class="km-tiles" id="kmTiles" role="radiogroup" aria-label="Recipe"></div></div>
    <details class="km-new" id="kmNew">
      <summary>${icon("plus", { size: 16 })}New recipe</summary>
      <div class="km-new-body">
        <input class="gc-input" id="kmNewName" maxlength="40" placeholder="Tacos" autocomplete="off" aria-label="Recipe name" />
        <textarea class="gc-input km-textarea" id="kmNewIngredients" rows="2" placeholder="Tortillas, ground beef, salsa, cheese" aria-label="Ingredients"></textarea>
        ${button({ label: "Save recipe", variant: "tonal", size: "sm", id: "kmNewSave" })}
      </div>
    </details>
    <p class="gc-status" id="kmNightStatus" role="status" aria-live="polite"></p>
  </div>`,
  actions: `${button({ label: "No dinner", variant: "text", id: "kmOff" })}<span class="gc-spacer"></span>${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Save", id: "kmNightSave" })}`,
}) + dialog({
  id: "kmShopDialog",
  title: "Shop for meals",
  body: `<div id="kmShopBody"></div>`,
  actions: `${button({ label: "Cancel", variant: "text", attrs: "data-gc-close" })}${button({ label: "Add to cart", id: "kmShopGo", icon: "cart" })}`,
});

const MEALS_STYLES = `
.km-toolbar { display:flex; align-items:center; gap:var(--gc-space-2); margin-bottom:var(--gc-space-3); min-height:40px; flex-wrap:wrap; }
.km-range { font-size:var(--gc-fs-xl); font-weight:400; margin-left:var(--gc-space-1); white-space:nowrap; }
.km-draftbar { display:flex; align-items:center; gap:var(--gc-space-2); margin-bottom:var(--gc-space-3); padding:6px 8px 6px 14px; border-radius:var(--gc-radius-md); background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); }
.km-draft-label { font-weight:500; }
.km-draftbar .gc-btn-text { color:var(--gc-on-accent-soft); }
.km-weekcard { padding:0; overflow:hidden; }
.km-week { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); }
.km-day { min-height:208px; min-width:0; display:flex; flex-direction:column; gap:6px; padding:var(--gc-space-2) 6px var(--gc-space-3); border-left:1px solid var(--gc-border); }
.km-day:first-child { border-left:0; }
.km-dayhead { display:flex; flex-direction:column; align-items:center; gap:2px; padding-bottom:4px; }
.km-dow { font-size:11px; font-weight:500; letter-spacing:.08em; text-transform:uppercase; color:var(--gc-muted); }
.km-date { width:40px; height:40px; display:grid; place-items:center; border-radius:50%; font-size:22px; line-height:1; color:var(--gc-text); }
.km-day.is-today .km-dow { color:var(--gc-accent); }
.km-day.is-today .km-date { background:var(--gc-accent); color:var(--gc-on-accent); font-weight:500; }
.km-day.is-past .km-date { color:var(--gc-muted); }
.km-slot { flex:1; display:flex; flex-direction:column; min-width:0; }
.km-meal { position:relative; display:grid; justify-items:start; gap:4px; width:100%; min-width:0; padding:10px 10px 9px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-md); background:var(--gc-surface); color:var(--gc-text); font:inherit; text-align:left; cursor:pointer; transition:background-color .15s ease, border-color .15s ease; }
.km-meal:hover { background:var(--gc-hover); }
.km-meal.is-draft { border:1.5px dashed var(--gc-accent); background:color-mix(in srgb, var(--gc-accent-soft) 45%, var(--gc-surface)); }
.km-day.is-past .km-meal { opacity:.6; }
.km-emoji { font-size:26px; line-height:1.1; }
.km-name { font-size:var(--gc-fs-sm); font-weight:600; line-height:1.3; overflow-wrap:anywhere; }
.km-cook { display:flex; align-items:center; gap:5px; min-width:0; max-width:100%; color:var(--gc-text-2); font-size:12px; }
.km-cook > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.km-tags { display:flex; flex-wrap:wrap; gap:3px; }
.km-tag { display:inline-grid; place-items:center; min-width:22px; height:18px; padding:0 4px; border-radius:5px; background:var(--gc-success-soft); color:var(--gc-success); font-size:10px; font-weight:600; letter-spacing:.02em; }
.km-warn { display:inline-flex; align-items:center; gap:3px; height:20px; padding:0 6px; border-radius:6px; background:var(--gc-warning-soft); color:var(--gc-warning); font-size:11px; font-weight:600; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.km-empty { flex:1; min-height:72px; width:100%; display:grid; place-items:center; border:1.5px dashed var(--gc-border-strong); border-radius:var(--gc-radius-md); background:transparent; color:var(--gc-muted); cursor:pointer; }
.km-empty:hover { border-color:var(--gc-accent); color:var(--gc-accent); background:var(--gc-hover); }
.km-empty.is-off { border-color:transparent; opacity:0; }
.km-empty.is-off:hover, .km-empty.is-off:focus-visible { opacity:1; border-color:var(--gc-border-strong); }
.km-hint { margin-top:var(--gc-space-3); color:var(--gc-muted); font-size:var(--gc-fs-sm); text-align:center; }

.km-form { display:grid; gap:var(--gc-space-4); }
.km-label { display:block; margin-bottom:6px; color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; }
.km-cooks { display:flex; flex-wrap:wrap; gap:6px; }
.km-cooks button { display:inline-flex; align-items:center; gap:6px; height:34px; padding:0 12px 0 3px; border:1px solid var(--gc-border-strong); border-radius:var(--gc-radius-pill); background:transparent; color:var(--gc-text); font:500 var(--gc-fs-sm) var(--gc-font); cursor:pointer; }
.km-cooks button[aria-checked="true"] { background:var(--gc-accent-soft); border-color:transparent; color:var(--gc-on-accent-soft); }
.km-cooks button:disabled { opacity:.45; cursor:not-allowed; }
.km-tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(132px, 1fr)); gap:8px; max-height:min(46vh, 380px); overflow:auto; padding:2px; }
.km-tile { display:grid; justify-items:start; align-content:start; gap:4px; min-width:0; padding:10px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-md); background:var(--gc-surface); color:var(--gc-text); font:inherit; text-align:left; cursor:pointer; }
.km-tile:hover { background:var(--gc-hover); }
.km-tile[aria-checked="true"] { border-color:var(--gc-accent); box-shadow:inset 0 0 0 1px var(--gc-accent); background:color-mix(in srgb, var(--gc-accent-soft) 40%, var(--gc-surface)); }
.km-tile.is-warn { opacity:.75; }
.km-new > summary { display:inline-flex; align-items:center; gap:6px; color:var(--gc-accent); font-weight:500; cursor:pointer; list-style:none; }
.km-new > summary::-webkit-details-marker { display:none; }
.km-new-body { display:grid; gap:var(--gc-space-2); margin-top:var(--gc-space-2); }
.km-new-body .gc-btn { justify-self:start; }
.km-textarea { height:auto; min-height:56px; padding:10px 12px; resize:vertical; font:var(--gc-fs-md)/1.4 var(--gc-font); }
#kmNight .gc-dialog-actions { align-items:center; }
#kmOff { color:var(--gc-danger); }

.km-shop-list { list-style:none; margin:0; padding:0; }
.km-shop-list li { display:flex; align-items:center; gap:10px; min-height:38px; border-top:1px solid var(--gc-border); }
.km-shop-list li:first-child { border-top:0; }
.km-shop-name { flex:1; min-width:0; font-weight:500; }
.km-shop-qty { color:var(--gc-muted); font-variant-numeric:tabular-nums; }
.km-shop-for { color:var(--gc-muted); font-size:13px; letter-spacing:1px; white-space:nowrap; }
.km-shop-skip { display:flex; flex-wrap:wrap; gap:6px; margin-top:var(--gc-space-3); align-items:center; color:var(--gc-muted); font-size:var(--gc-fs-sm); }
.km-shop-sub { margin:0 0 var(--gc-space-2); color:var(--gc-muted); font-size:var(--gc-fs-sm); }

@media (max-width: 760px) {
  .km-toolbar { gap:4px; }
  .km-range { font-size:var(--gc-fs-lg); margin-right:auto; }
  .km-toolbar > .gc-spacer { display:none; }
  .km-toolbar .km-plan { margin-left:auto; }
  .km-week { grid-template-columns:minmax(0, 1fr); }
  .km-day { flex-direction:row; align-items:stretch; min-height:0; gap:var(--gc-space-3); padding:10px 12px; border-left:0; border-top:1px solid var(--gc-border); }
  .km-day:first-child { border-top:0; }
  .km-day.is-past { display:none; }
  .km-day.is-today, .km-week > .km-day:not(.is-past) ~ .km-day { border-top:1px solid var(--gc-border); }
  .km-week > .km-day:not(.is-past) { border-top:0; }
  .km-week > .km-day:not(.is-past) ~ .km-day:not(.is-past) { border-top:1px solid var(--gc-border); }
  .km-dayhead { width:44px; flex:none; padding:0; }
  .km-meal { grid-template-columns:auto minmax(0, 1fr); column-gap:10px; align-items:center; }
  .km-meal .km-emoji { grid-row:span 3; font-size:28px; }
  .km-empty { min-height:48px; }
  .km-empty.is-off { opacity:1; border-color:transparent; justify-items:start; padding-left:4px; }
  .km-tiles { grid-template-columns:repeat(2, minmax(0, 1fr)); }
}`;

/** Shared loader (window.GCKitchen) plus the Meals view. */
const KITCHEN_SCRIPT = `
(() => {
  const GC = window.GC;
  const K = window.GCKitchen = window.GCKitchen || {};
  K.state = null;
  K.week = null;
  let lastJson = "";
  const visible = () => ["pantry", "meals"].find((view) => { const panel = document.querySelector('[data-gl-view="' + view + '"]'); return panel && !panel.hidden; });
  K.toast = (text) => {
    const node = document.getElementById("glToast");
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
    clearTimeout(K.toastTimer);
    K.toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
  };
  K.post = async (path, body) => {
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || result.message || "Something went wrong.");
      return result;
    } catch (error) { K.toast(error.message); return null; }
  };
  K.load = async (force) => {
    try {
      const response = await fetch("/api/kitchen" + (K.week ? "?week=" + encodeURIComponent(K.week) : ""));
      if (!response.ok) return;
      const text = await response.text();
      if (!force && text === lastJson) return;
      lastJson = text;
      K.state = JSON.parse(text);
      const out = K.state.pantry.items.filter((item) => item.status !== "stock").length;
      const count = document.getElementById("kTabPantryCount");
      if (count) count.textContent = out ? String(out) : "";
      if (K.pantry) K.pantry.render(K.state);
      if (K.meals) K.meals.render(K.state);
    } catch (error) { /* offline; the cart view shows sync status */ }
  };
  document.addEventListener("gl:view", (event) => { if (event.detail === "pantry" || event.detail === "meals") K.load(true); });
  setInterval(() => { if (document.visibilityState === "visible" && visible()) K.load(false); }, 5000);
  setTimeout(() => K.load(true), 0);
})();
${PANTRY_SCRIPT}
(() => {
  const GC = window.GC;
  const K = window.GCKitchen;
  const $ = (id) => document.getElementById(id);
  const esc = GC.esc;
  const TAG_ORDER = [["vegan", "VG"], ["vegetarian", "V"], ["gluten-free", "GF"], ["dairy-free", "DF"], ["nut-free", "NF"]];
  let editing = null;
  const ids = () => K.state.members.map((member) => member.id);
  const member = (id) => K.state.members.find((entry) => entry.id === id);
  const addDays = (date, days) => { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const longDate = (date) => new Date(date + "T12:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const tags = (recipe, max) => {
    const own = recipe.tags.slice();
    const shown = TAG_ORDER.filter(([tag]) => own.includes(tag) && !(tag === "vegetarian" && own.includes("vegan")) && !(tag === "dairy-free" && own.includes("vegan"))).slice(0, max);
    return shown.length ? '<span class="km-tags">' + shown.map(([tag, short]) => '<span class="km-tag" title="' + tag + '">' + short + '</span>').join("") + '</span>' : "";
  };
  const warn = (recipe) => recipe.conflicts.length
    ? '<span class="km-warn" title="' + esc(recipe.conflicts.map((conflict) => conflict.name + ": " + conflict.labels.join(", ")).join(" · ")) + '">⚠ ' + esc(recipe.conflicts.map((conflict) => conflict.name.split(" ")[0]).join(", ")) + '</span>' : "";

  function days(state) {
    const meals = state.meals;
    const draft = meals.draft && meals.draft.weekStart === meals.weekStart ? meals.draft : null;
    return meals.days.map((day, index) => {
      const proposed = draft && draft.days[index] && draft.days[index].planned ? draft.days[index] : null;
      return proposed ? Object.assign({}, proposed, { draft: true }) : Object.assign({}, day, { draft: false });
    });
  }

  function mealCard(day) {
    const cook = day.cookId && member(day.cookId);
    const recipe = day.recipe;
    const label = (recipe ? recipe.name : "Dinner") + (cook ? ", " + cook.name + " cooks" : "") + (day.draft ? " (suggested)" : "");
    return '<button type="button" class="km-meal' + (day.draft ? " is-draft" : "") + '" data-km-night="' + day.date + '" aria-label="' + esc(day.dow + " " + day.day + ": " + label) + '">'
      + '<span class="km-emoji" aria-hidden="true">' + esc(recipe ? recipe.emoji : "🍽️") + '</span>'
      + '<span class="km-name">' + esc(recipe ? recipe.name : "Pick a recipe") + '</span>'
      + (cook ? '<span class="km-cook">' + GC.avatar(cook, ids(), 18) + '<span>' + esc(cook.name.split(" ")[0]) + '</span></span>' : "")
      + (recipe ? tags(recipe, 2) + warn(recipe) : "") + '</button>';
  }

  function render(state) {
    const meals = state.meals;
    const list = days(state);
    const isDraftWeek = Boolean(meals.draft && meals.draft.weekStart === meals.weekStart);
    $("kmRange").textContent = meals.weekLabel;
    $("kmToday").disabled = meals.weekStart === meals.thisWeek;
    $("kmDraftBar").hidden = !isDraftWeek;
    const lastDay = addDays(meals.weekStart, 6);
    const nightsLeft = list.some((day) => day.date >= state.today && meals.nights.includes(new Date(day.date + "T12:00:00Z").getUTCDay()));
    $("kmPlan").disabled = !nightsLeft;
    $("kmPlan").title = nightsLeft ? "" : "No dinner nights left this week";
    $("kmPlan").hidden = isDraftWeek;
    $("kmWeek").innerHTML = list.map((day) => {
      const usual = meals.nights.includes(new Date(day.date + "T12:00:00Z").getUTCDay());
      const slot = day.planned
        ? mealCard(day)
        : day.isPast ? "" : '<button type="button" class="km-empty' + (usual ? "" : " is-off") + '" data-km-night="' + day.date + '" aria-label="Plan dinner ' + esc(day.dow + " " + day.day) + '">' + GC.icon("plus") + '</button>';
      return '<div class="km-day' + (day.isToday ? " is-today" : "") + (day.isPast && !day.isToday ? " is-past" : "") + '" role="group" aria-label="' + esc(day.dow + " " + day.day) + '">'
        + '<div class="km-dayhead" aria-hidden="true"><span class="km-dow">' + esc(day.dow) + '</span><span class="km-date">' + day.day + '</span></div>'
        + '<div class="km-slot">' + slot + '</div></div>';
    }).join("");
    const planned = list.filter((day) => day.planned).length;
    $("kmHint").hidden = planned > 0 || lastDay < state.today;
    $("kmHint").textContent = "Tap a day, or let GroupCart plan the week.";
    $("kmShop").disabled = !state.shopping.dinners;
    if (GC.applyFlavor) GC.applyFlavor(document.getElementById("glView-meals"));
    if (editing && document.getElementById("kmNight").open) renderNight();
  }

  // --- Night editor ---------------------------------------------------------
  function renderNight() {
    const state = K.state;
    const day = days(state).find((entry) => entry.date === editing.date) || { date: editing.date };
    document.getElementById("kmNight-title").textContent = longDate(editing.date);
    $("kmCooks").innerHTML = state.members.map((m) => '<button type="button" role="radio" aria-checked="' + (editing.cookId === m.id) + '" data-km-cook="' + esc(m.id) + '"' + (m.away && editing.date === state.today ? ' disabled title="Away"' : "") + '>' + GC.avatar(m, ids(), 26) + esc(m.name.split(" ")[0]) + '</button>').join("");
    const recipes = state.recipes.slice().sort((a, b) => a.conflicts.length - b.conflicts.length);
    $("kmTiles").innerHTML = recipes.map((recipe) => '<button type="button" role="radio" class="km-tile' + (recipe.conflicts.length ? " is-warn" : "") + '" aria-checked="' + (editing.recipeId === recipe.id) + '" data-km-recipe="' + esc(recipe.id) + '" title="' + esc(recipe.ingredients.join(", ")) + '">'
      + '<span class="km-emoji" aria-hidden="true">' + esc(recipe.emoji) + '</span><span class="km-name">' + esc(recipe.name) + '</span>' + tags(recipe, 3) + warn(recipe) + '</button>').join("");
    $("kmOff").hidden = !day.planned;
  }
  function openNight(date) {
    const day = days(K.state).find((entry) => entry.date === date);
    editing = { date, recipeId: day && day.recipe ? day.recipe.id : null, cookId: day ? day.cookId : null };
    $("kmNightStatus").textContent = "";
    $("kmNew").open = false;
    renderNight();
    GC.openDialog("kmNight");
  }
  $("kmWeek").addEventListener("click", (event) => {
    const night = event.target.closest("[data-km-night]");
    if (night) openNight(night.dataset.kmNight);
  });
  $("kmCooks").addEventListener("click", (event) => {
    const cook = event.target.closest("[data-km-cook]");
    if (!cook || cook.disabled) return;
    editing.cookId = editing.cookId === cook.dataset.kmCook ? null : cook.dataset.kmCook;
    renderNight();
  });
  $("kmTiles").addEventListener("click", (event) => {
    const tile = event.target.closest("[data-km-recipe]");
    if (!tile) return;
    editing.recipeId = tile.dataset.kmRecipe;
    renderNight();
  });
  $("kmNightSave").addEventListener("click", async () => {
    if (!editing.recipeId) { $("kmNightStatus").textContent = "Pick a recipe."; return; }
    const body = { date: editing.date, recipeId: editing.recipeId };
    if (editing.cookId) body.cookId = editing.cookId;
    const result = await K.post("/api/kitchen/meals/night", body);
    if (!result) return;
    GC.closeDialog("kmNight");
    await K.load(true);
  });
  $("kmOff").addEventListener("click", async () => {
    const result = await K.post("/api/kitchen/meals/night", { date: editing.date, off: true });
    if (!result) return;
    GC.closeDialog("kmNight");
    await K.load(true);
  });
  $("kmNewSave").addEventListener("click", async () => {
    const name = $("kmNewName").value.trim();
    const ingredients = $("kmNewIngredients").value.trim();
    if (!name || !ingredients) { $("kmNightStatus").textContent = "Add a name and ingredients."; return; }
    const result = await K.post("/api/kitchen/recipes", { name, ingredients });
    if (!result) return;
    $("kmNewName").value = "";
    $("kmNewIngredients").value = "";
    $("kmNew").open = false;
    editing.recipeId = result.recipe.id;
    await K.load(true);
    renderNight();
  });

  // --- Week, plan, shop ---------------------------------------------------------
  const go = (week) => { K.week = week; K.load(true); };
  $("kmPrev").addEventListener("click", () => go(addDays(K.state.meals.weekStart, -7)));
  $("kmNext").addEventListener("click", () => go(addDays(K.state.meals.weekStart, 7)));
  $("kmToday").addEventListener("click", () => go(K.state.meals.thisWeek));
  $("kmPlan").addEventListener("click", async () => {
    $("kmPlan").disabled = true;
    const result = await K.post("/api/kitchen/meals/plan", { weekStart: K.state.meals.weekStart });
    $("kmPlan").disabled = false;
    if (result) { K.week = K.state.meals.weekStart; await K.load(true); }
  });
  $("kmShuffle").addEventListener("click", async () => { if (await K.post("/api/kitchen/meals/plan", { weekStart: K.state.meals.weekStart })) K.load(true); });
  $("kmDiscard").addEventListener("click", async () => { if (await K.post("/api/kitchen/meals/discard", {})) K.load(true); });
  $("kmKeep").addEventListener("click", async () => {
    if (!(await K.post("/api/kitchen/meals/accept", {}))) return;
    if (GC.celebrate) GC.celebrate("Dinners planned");
    K.load(true);
  });

  function renderShop() {
    const state = K.state;
    const lines = state.shopping.lines;
    const buy = lines.filter((line) => line.status === "add");
    const skip = lines.filter((line) => line.status !== "add");
    const emojiFor = (name) => (state.recipes.find((recipe) => recipe.name === name) || {}).emoji || "";
    document.getElementById("kmShopDialog-title").textContent = "Shop for " + state.shopping.dinners + (state.shopping.dinners === 1 ? " dinner" : " dinners");
    $("kmShopBody").innerHTML = (buy.length
      ? '<p class="km-shop-sub">' + (state.mode === "kroger" ? "Goes on “Dinners this week” to pick products" : "Adds to the cart as you") + '</p><ul class="km-shop-list">' + buy.map((line) => '<li><span class="km-shop-name">' + esc(line.name) + '</span>' + (line.quantity > 1 ? '<span class="km-shop-qty">×' + line.quantity + '</span>' : "") + '<span class="km-shop-for" title="' + esc(line.meals.join(", ")) + '">' + line.meals.map(emojiFor).join("") + '</span></li>').join("") + '</ul>'
      : '<p class="km-shop-sub">Everything is in the pantry or the cart.</p>')
      + (skip.length ? '<div class="km-shop-skip">' + GC.icon("check") + skip.map((line) => '<span class="gc-chip gc-chip-neutral" title="' + (line.status === "pantry" ? "In the pantry" : "Already in the cart") + '">' + esc(line.name) + '</span>').join("") + '</div>' : "");
    const goButton = $("kmShopGo");
    goButton.disabled = !buy.length;
    goButton.lastChild.textContent = buy.length ? (state.mode === "kroger" ? "Add " + buy.length + " to list" : "Add " + buy.length + " to cart") : "Add to cart";
  }
  $("kmShop").addEventListener("click", async () => { await K.load(true); renderShop(); GC.openDialog("kmShopDialog"); });
  $("kmShopGo").addEventListener("click", async () => {
    $("kmShopGo").disabled = true;
    const result = await K.post("/api/kitchen/meals/shop", {});
    if (!result) { $("kmShopGo").disabled = false; return; }
    GC.closeDialog("kmShopDialog");
    // Kroger: everything went on the one-off list, which the Lists tab sends to the cart to pick products.
    K.toast(result.status === "listed" && K.state.mode === "kroger" ? "📝 Put " + result.listed.length + " on “Dinners this week”. Tap To cart on the Lists tab to pick the products." : result.message);
    if (result.status === "added" && GC.celebrate) GC.celebrate("Ingredients in the cart");
    K.load(true);
  });

  K.meals = { render };
  if (K.state) render(K.state);
})();
`;

/** Adds the Pantry and Meals views to the Groceries page (its tab bar comes from src/ui/listsPanel.ts). */
export function withKitchenTabs(page: PageOptions): PageOptions {
  return {
    ...page,
    body: `${page.body}${PANTRY_VIEW}${MEALS_VIEW}${MEALS_DIALOGS}`,
    styles: `${page.styles ?? ""}${PANTRY_STYLES}${MEALS_STYLES}
@media (max-width: 420px) { .gl-tab { gap:4px; padding:0 6px; } .gl-tab .gl-tab-icon { display:none; } .gl-tab .gl-count { min-width:18px; padding:0 4px; } }`,
    script: `${page.script ?? ""}\n${KITCHEN_SCRIPT}`,
  };
}

// ---------------------------------------------------------------------------
// Home: one line in the Groceries card

export const HOME_TONIGHT = {
  html: `<a class="home-tonight" id="homeTonight" href="/groceries#meals" hidden></a>`,
  styles: `
.home-tonight { display:flex; align-items:center; gap:8px; margin-top:var(--gc-space-3); padding-top:var(--gc-space-3); border-top:1px solid var(--gc-border); color:var(--gc-text); text-decoration:none; font-size:var(--gc-fs-sm); min-width:0; }
.home-tonight:hover .home-tonight-meal { text-decoration:underline; }
.home-tonight-label { color:var(--gc-muted); font-weight:500; flex:none; }
.home-tonight-meal { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.home-tonight-cook { display:inline-flex; align-items:center; gap:5px; margin-left:auto; flex:none; color:var(--gc-text-2); }`,
  script: `
(() => {
  const node = document.getElementById("homeTonight");
  if (!node) return;
  async function load() {
    try {
      const response = await fetch("/api/kitchen/tonight");
      if (!response.ok) return;
      const { tonight, memberIds } = await response.json();
      node.hidden = !tonight;
      if (!tonight) return;
      const label = window.GC.t ? window.GC.t("kitchen.tonight", "Tonight") : "Tonight";
      node.innerHTML = '<span class="home-tonight-label">' + window.GC.esc(label) + '</span>'
        + '<span class="home-tonight-meal">' + window.GC.esc(tonight.recipe ? tonight.recipe.emoji + " " + tonight.recipe.name : "Dinner") + '</span>'
        + (tonight.cook ? '<span class="home-tonight-cook">' + window.GC.avatar(tonight.cook, memberIds, 20) + window.GC.esc(tonight.cook.name) + ' cooks</span>' : "");
    } catch (error) { /* offline */ }
  }
  load();
  setInterval(load, 60000);
})();
`,
};

