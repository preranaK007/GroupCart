import { button, card, chip, emptyState, escapeHtml } from "./shell.js";
import type { IntegrationCard } from "./settingsPage.js";

/**
 * Bills pieces shown outside /bills: the Home "Balances" card (id homeBalances,
 * self-contained: it fetches /api/bills/summary itself) and the Settings cards for
 * Splitwise and bill reading. Status comes from the bills service via a provider set
 * at startup (src/bills.ts → setBillsIntegrationStatus), so these stay pure UI.
 */

export type BillsIntegrationStatus = {
  splitwise: {
    configured: boolean;
    live: boolean;
    warnings: string[];
    lastBill: { vendor: string; status: string; at: string } | null;
    lastCheckout: Record<string, unknown>;
  };
  anthropic: { configured: boolean; model: string };
};

let statusProvider: (() => BillsIntegrationStatus) | null = null;

export function setBillsIntegrationStatus(provider: (() => BillsIntegrationStatus) | null): void {
  statusProvider = provider;
}

function currentStatus(): BillsIntegrationStatus | null {
  try { return statusProvider ? statusProvider() : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Home: Balances card
// ---------------------------------------------------------------------------

const HOME_STYLES = `
.hb-people { list-style:none; margin:0; padding:0; display:grid; gap:2px; }
.hb-person { display:flex; align-items:center; gap:var(--gc-space-3); padding:6px 0; }
.hb-name { flex:1; min-width:0; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hb-amt { font-variant-numeric:tabular-nums; font-weight:500; white-space:nowrap; }
.hb-pos { color:var(--gc-success); }
.hb-neg { color:var(--gc-danger); }
.hb-zero { color:var(--gc-muted); font-weight:400; font-size:var(--gc-fs-sm); }
.hb-next { display:flex; align-items:center; gap:var(--gc-space-3); margin-top:var(--gc-space-3); padding-top:var(--gc-space-3); border-top:1px solid var(--gc-border); text-decoration:none; color:inherit; }
.hb-next:hover .hb-next-title { text-decoration:underline; }
.hb-emoji { width:32px; height:32px; flex:none; display:grid; place-items:center; border-radius:10px; background:var(--gc-surface-2); border:1px solid var(--gc-border); font-size:17px; }
.hb-next-main { flex:1; min-width:0; }
.hb-next-title { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hb-wait { margin-top:var(--gc-space-2); }
`;

const HOME_SCRIPT = `
document.addEventListener("DOMContentLoaded", function () {
  var GC = window.GC, root = document.getElementById("homeBalancesBody");
  if (!GC || !root) return;
  function due(iso, today) {
    var days = Math.round((Date.parse(iso + "T12:00:00") - Date.parse(today + "T12:00:00")) / 86400000);
    if (days < 0) return { label: "Overdue", tone: "danger" };
    if (days === 0) return { label: "Due today", tone: "warning" };
    if (days === 1) return { label: "Tomorrow", tone: "warning" };
    if (days <= 3) return { label: "In " + days + " days", tone: "warning" };
    return { label: new Date(iso + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" }), tone: "neutral" };
  }
  function render(data) {
    var ids = data.members.map(function (m) { return m.id; });
    var byId = {};
    data.members.forEach(function (m) { byId[m.id] = m; });
    var active = data.net.some(function (e) { return e.cents !== 0; });
    var html = "";
    if (!active && !data.nextBill) {
      html = '<div class="gc-empty"><p class="gc-empty-title">All square</p><p class="gc-empty-text">Bill splits will show up here.</p></div>';
    } else {
      html += '<ul class="hb-people">' + data.net.slice().sort(function (a, b) { return b.cents - a.cents; }).map(function (e) {
        var m = byId[e.memberId] || { id: e.memberId, name: e.name };
        var amt = e.cents > 0 ? '<span class="hb-amt hb-pos">+' + GC.dollars(e.cents) + '</span>'
          : e.cents < 0 ? '<span class="hb-amt hb-neg">\\u2212' + GC.dollars(-e.cents) + '</span>'
          : '<span class="hb-amt hb-zero">Even</span>';
        return '<li class="hb-person">' + GC.avatar(m, ids, 28) + '<span class="hb-name">' + GC.esc(m.name) + '</span>' + amt + '</li>';
      }).join("") + '</ul>';
      if (data.nextBill) {
        var b = data.nextBill, d = due(b.dueDate, data.today);
        html += '<a class="hb-next" href="/bills"><span class="hb-emoji" aria-hidden="true">' + GC.esc(b.emoji) + '</span><span class="hb-next-main"><span class="hb-next-title">' + GC.esc(b.vendor || "Next bill") + '</span><span class="gc-meta"> \\u00b7 ' + GC.dollars(b.totalCents) + '</span></span>' + GC.chip(d.label, d.tone, "clock") + '</a>';
      }
    }
    if (data.waiting) html += '<div class="hb-wait">' + GC.chip(data.waiting + (data.waiting === 1 ? " bill" : " bills") + " to review", "accent", "receipt") + '</div>';
    root.innerHTML = html;
  }
  function load() {
    fetch("/api/bills/summary").then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) render(d); }).catch(function () {});
  }
  load();
  setInterval(load, 10000);
});
`;

/** Home card (id homeBalances): net balance per person and the next bill due. */
export function homeBalancesCard(): string {
  return card({
    id: "homeBalances",
    title: "Balances",
    icon: "wallet",
    flavor: "home.balances", // [themes]
    actions: button({ label: "Open", variant: "text", size: "sm", href: "/bills" }),
    body: `<style>${HOME_STYLES}</style><div id="homeBalancesBody">${emptyState({ icon: "receipt", title: "No bills yet", text: "Bill splits will show up here.", flavor: "empty.bills" })}</div><script>${HOME_SCRIPT}</script>`,
  });
}

// ---------------------------------------------------------------------------
// Settings: Splitwise and bill reading
// ---------------------------------------------------------------------------

function swStatusChip(status: string | undefined): string {
  switch (status) {
    case "logged": return chip("Logged", "success", "check");
    case "simulated": return chip("Simulated", "neutral");
    case "failed": return chip("Failed", "danger", "alert");
    case "pending":
    case "sending": return chip("Sending", "accent", "sync");
    default: return '<span class="gc-muted">None yet</span>';
  }
}

export function billsSplitwiseCard(): IntegrationCard {
  const status = currentStatus();
  const sw = status?.splitwise;
  const lastCheckout = sw?.lastCheckout as { state?: string; totalCents?: number } | undefined;
  return {
    id: "splitwise",
    name: "Splitwise",
    icon: "receipt",
    summary: "Logs saved bills and grocery checkouts",
    status: !sw ? { label: "Not configured", tone: "neutral" }
      : sw.live ? { label: "Connected", tone: "success" }
      : sw.configured ? { label: "Simulated (demo)", tone: "neutral" }
      : { label: "Simulated", tone: "neutral" },
    facts: sw ? [
      { label: "Mode", html: sw.live ? chip("Live", "accent", "lock") : chip("Nothing sent", "neutral") },
      { label: "Last bill", html: sw.lastBill ? `${escapeHtml(sw.lastBill.vendor || "Bill")} ${swStatusChip(sw.lastBill.status)}` : swStatusChip(undefined) },
      { label: "Last checkout", html: lastCheckout && lastCheckout.state && lastCheckout.state !== "none" ? `${typeof lastCheckout.totalCents === "number" ? escapeHtml(`$${(lastCheckout.totalCents / 100).toFixed(2)}`) : ""} ${swStatusChip(lastCheckout.state)}` : swStatusChip(undefined) },
      ...(sw.warnings.length ? [{ label: "Setup", html: chip(`${sw.warnings.length} warning${sw.warnings.length === 1 ? "" : "s"}`, "warning", "alert") }] : []),
    ] : undefined,
    actions: button({ label: "Bills", variant: "outline", size: "sm", href: "/bills" })
      + (sw?.live ? button({ label: "Open Splitwise", variant: "text", size: "sm", href: "https://secure.splitwise.com", external: true }) : ""),
    tip: sw?.live
      ? "Each saved bill becomes one Splitwise expense paid by the payer, with everyone’s share."
      : "Set SPLITWISE_API_KEY, SPLITWISE_GROUP_ID, and SPLITWISE_MEMBERS in .env and restart. Until then, logging is simulated.",
  };
}

export function billsAnthropicCard(): IntegrationCard {
  const status = currentStatus();
  const anthropic = status?.anthropic;
  return {
    id: "anthropic",
    name: "Anthropic (bill reading)",
    icon: "spark",
    summary: "Reads bill photos, screenshots, and PDFs",
    status: anthropic?.configured ? { label: "Connected", tone: "success" } : { label: "Optional", tone: "neutral" },
    facts: [
      anthropic?.configured
        ? { label: "Model", html: escapeHtml(anthropic.model) }
        : { label: "Without a key", html: `${chip("Your Claude reads them", "accent", "spark")}` },
    ],
    tip: anthropic?.configured
      ? "Bill images are sent to the Claude API to read the vendor, total, and due date. You confirm before anything is saved."
      : "Optional: set ANTHROPIC_API_KEY (and ANTHROPIC_MODEL) in .env. Without it, bill images wait as “needs reading” for a member’s Claude (GroupCart connector) or typed details.",
  };
}
