import { button, card, emptyState, renderPage } from "./shell.js";

/**
 * Temporary pages and Home cards for sections other branches will build.
 *
 * MERGE NOTE: each function below is self-contained. Replace one function (or
 * its route in src/dashboard.ts) with the real feature and delete it here.
 * Nothing else depends on this file.
 *   renderCalendarPlaceholder → feature/google-calendar week view (/calendar)
 *   renderBillsPlaceholder    → bills / Splitwise page (/bills; /expenses redirects here)
 *   renderChoresPlaceholder   → chores with rotations (/chores)
 *   choresDueCard / upcomingCard / balancesCard → live cards on Home (/)
 * Real pages should call renderPage({ title, active, body, script, styles })
 * from ./shell.js so they keep the shared app bar and navigation.
 */

function placeholderPage(options: { title: string; active: "calendar" | "bills" | "chores"; icon: "calendar" | "receipt" | "chores"; heading: string; text: string }): string {
  return renderPage({
    title: options.title,
    active: options.active,
    body: `<section class="gc-card gc-placeholder">${emptyState({
      icon: options.icon,
      title: options.heading,
      text: options.text,
      action: button({ label: "Connections", variant: "outline", href: "/settings" }),
    })}</section>`,
  });
}

export function renderCalendarPlaceholder(): string {
  return placeholderPage({ title: "Calendar", active: "calendar", icon: "calendar", heading: "Calendar is coming", text: "See when everyone is free." });
}

export function renderBillsPlaceholder(): string {
  return placeholderPage({ title: "Bills", active: "bills", icon: "receipt", heading: "Bills are coming", text: "Snap a bill, split it, log it to Splitwise." });
}

export function renderChoresPlaceholder(): string {
  return placeholderPage({ title: "Chores", active: "chores", icon: "chores", heading: "Chores are coming", text: "Weekly, monthly, and one-off chores that rotate." });
}

// --- Home cards (server-rendered HTML; ids are stable hooks for later branches) ---

export function choresDueCard(): string {
  return card({
    id: "homeChores",
    title: "Chores due",
    icon: "chores",
    actions: button({ label: "Open", variant: "text", size: "sm", href: "/chores" }),
    body: emptyState({ icon: "checkCircle", title: "Nothing due", text: "Chores will show up here." }),
  });
}

export function upcomingCard(): string {
  return card({
    id: "homeUpcoming",
    title: "Upcoming",
    icon: "calendar",
    actions: button({ label: "Open", variant: "text", size: "sm", href: "/calendar" }),
    body: emptyState({ icon: "clock", title: "No events", text: "Household events will show up here." }),
  });
}

export function balancesCard(): string {
  return card({
    id: "homeBalances",
    title: "Balances",
    icon: "wallet",
    actions: button({ label: "Open", variant: "text", size: "sm", href: "/bills" }),
    body: emptyState({ icon: "receipt", title: "No bills yet", text: "Bill splits will show up here." }),
  });
}
