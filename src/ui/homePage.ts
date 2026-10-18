import { balancesCard, choresDueCard, upcomingCard } from "./placeholders.js";
import { button, card, chip, renderPage } from "./shell.js";
import { choresHomeCard } from "./choresPage.js"; // Chores: live "Chores due" card (replaces the placeholder)
import { chatPreviewCard } from "./chatPage.js"; // profiles & chat

/**
 * Home (route "/"): a calm "today" overview. Groceries and People come from
 * GET /api/cart (polled every 2.5 s). Chores, Upcoming, and Balances are
 * placeholder cards from ./placeholders.ts that later branches replace.
 */

const groceriesCard = card({
  id: "homeGroceries",
  title: "Groceries",
  icon: "cart",
  actions: button({ label: "Open", variant: "text", size: "sm", href: "/groceries" }),
  body: `
  <div class="home-total"><span class="home-big" id="homeTotal">–</span><span class="gc-meta" id="homeCount"></span></div>
  <div class="gc-track" role="progressbar" aria-label="Budget used" aria-valuemin="0" aria-valuemax="100" id="homeBudgetTrack"><div class="gc-fill" id="homeBudget" style="width:0%"></div></div>
  <div class="home-budget-row"><span class="gc-meta" id="homeBudgetText"></span><span id="homeApprovals"></span></div>
  <ul class="gc-list home-items" id="homeItems"></ul>`,
});

const peopleCard = card({
  id: "homePeople",
  title: "People",
  icon: "users",
  meta: "Grocery shares",
  actions: button({ label: "Profiles", variant: "text", size: "sm", href: "/people" }), // profiles & chat
  body: `<ul class="gc-list" id="homePeopleList"></ul>`,
});

const body = `
<div class="home-hello">
  <p class="home-date" id="homeDate"></p>
  <p class="gc-meta" id="homeSummary"></p>
</div>
<div class="gc-cards">
  ${groceriesCard}
  ${chatPreviewCard()}
  ${peopleCard}
  ${choresHomeCard()}
  ${upcomingCard()}
  ${balancesCard()}
</div>`;

const styles = `
.home-hello { margin:0 0 var(--gc-space-5); }
.home-date { font-size:var(--gc-fs-2xl); font-weight:400; letter-spacing:-.01em; }
.home-total { display:flex; align-items:baseline; gap:var(--gc-space-2); }
.home-big { font-size:var(--gc-fs-2xl); font-weight:400; font-variant-numeric:tabular-nums; }
.home-budget-row { display:flex; align-items:center; justify-content:space-between; gap:var(--gc-space-2); margin-top:var(--gc-space-2); flex-wrap:wrap; }
.home-items { margin-top:var(--gc-space-3); }
.home-items .gc-list-item { padding:var(--gc-space-2) 0; }
.home-more { color:var(--gc-muted); font-size:var(--gc-fs-xs); padding-top:var(--gc-space-2); }
.gc-cards .gc-empty { padding:var(--gc-space-4) var(--gc-space-3); }
@media (max-width: 760px) { .home-hello { margin-bottom:var(--gc-space-4); } .home-date { font-size:var(--gc-fs-xl); } }
`;

const actions = `
<span id="mode">${chip("Loading", "neutral")}</span>
<span class="gc-sync gc-hide-sm" id="sync"><span class="gc-dot"></span><span id="syncState">Connecting…</span></span>`;

const script = `
const { esc, dollars, chip } = window.GC;
const $ = (id) => document.getElementById(id);
$("homeDate").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

async function refresh() {
  const response = await fetch("/api/cart");
  if (!response.ok) throw new Error("Could not load cart");
  const cart = await response.json();
  const allIds = cart.members.map((member) => member.id);
  const approved = cart.members.filter((member) => member.approved).length;
  $("mode").innerHTML = cart.demoMode ? chip("Demo", "neutral") : chip("Live", "accent", "lock");
  $("sync").classList.remove("is-paused");
  $("syncState").textContent = "Synced " + window.GC.time();

  $("homeTotal").textContent = dollars(cart.totalCents);
  $("homeCount").textContent = cart.items.length ? cart.items.length + (cart.items.length === 1 ? " item" : " items") : "Cart is empty";
  const within = cart.totalCents <= cart.budgetCents;
  const pct = cart.budgetCents > 0 ? Math.min(100, cart.totalCents / cart.budgetCents * 100) : 0;
  $("homeBudget").style.width = pct + "%";
  $("homeBudget").classList.toggle("is-over", !within);
  $("homeBudgetTrack").setAttribute("aria-valuenow", String(Math.round(pct)));
  $("homeBudgetText").textContent = within
    ? dollars(cart.budgetCents - cart.totalCents) + " left of " + dollars(cart.budgetCents)
    : dollars(cart.totalCents - cart.budgetCents) + " over " + dollars(cart.budgetCents);
  $("homeApprovals").innerHTML = !cart.items.length || !cart.members.length ? ""
    : approved === cart.members.length ? chip("All approved", "success", "check")
    : chip(approved + " of " + cart.members.length + " approved", "neutral", "clock");

  const shown = cart.items.slice(0, 4);
  $("homeItems").innerHTML = shown.map((item) => {
    // participantNames is sorted by name (not aligned with participantIds), so look names up by id.
    const people = item.participantIds.map((id) => ({ id, name: (cart.members.find((member) => member.id === id) || {}).name || "" }));
    return window.GC.listRow({
      leading: '<span class="gc-avatars">' + people.map((person) => window.GC.avatar(person, allIds, 24)).join("") + '</span>',
      title: item.name,
      trailing: '<span class="gc-amount">' + dollars(item.totalCents) + '</span>',
    });
  }).join("") + (cart.items.length > shown.length ? '<li class="home-more">+' + (cart.items.length - shown.length) + ' more</li>' : "");

  $("homePeopleList").innerHTML = cart.members.map((member) => window.GC.listRow({
    leading: window.GC.avatar(member, allIds, 32),
    title: member.name,
    sub: cart.items.length ? (member.approved ? chip("Approved", "success", "check") : chip("Waiting", "neutral", "clock")) : "",
    trailing: '<span class="gc-amount">' + dollars(member.shareCents) + '</span>',
  })).join("") || '<li class="gc-empty"><p class="gc-empty-text">No members yet.</p></li>';

  $("homeSummary").textContent = cart.items.length
    ? (approved === cart.members.length ? "Groceries are approved and ready." : (cart.members.length - approved) + " waiting to approve groceries.")
    : "Nothing on the grocery list.";
}
const showSyncError = (error) => {
  $("sync").classList.add("is-paused");
  $("syncState").textContent = "Sync paused";
  $("sync").title = error.message || "Could not reach GroupCart";
};
refresh().catch((error) => { $("mode").innerHTML = chip("Offline", "warning", "alert"); showSyncError(error); });
setInterval(() => refresh().catch(showSyncError), 2500);
`;

export function renderHomePage(): string {
  return renderPage({ title: "Home", active: "home", body, styles, actions, script });
}
