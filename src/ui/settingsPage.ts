import { appearanceCard, avatarHtml, button, chip, escapeHtml, icon, infoTip, renderPage, sectionHeader, type IconName, type Tone } from "./shell.js";
import { coordinatorCard } from "../agent/setup.js"; // household coordinator (one Claude for the apartment)
import { claudeConnectorCard } from "./connectorCard.js"; // AI assistants (Claude, ChatGPT, Grok) connector card
import { billsAnthropicCard, billsSplitwiseCard } from "./billsHome.js";

/**
 * Settings / Connections page (route "/settings"). Server-rendered on each
 * request from non-secret status flags only (never handles, tokens, or keys).
 */

export type SettingsContext = {
  demoMode: boolean;
  householdId: string;
  members: Array<{ id: string; name: string }>;
  kroger: {
    configured: boolean;
    locationConfigured: boolean;
    checkout: { status: string; selectedMemberId: string | null } | null;
  };
};

export type IntegrationCard = {
  id: string;
  name: string;
  icon: IconName;
  /** One short line under the name. */
  summary: string;
  status: { label: string; tone: Tone };
  /** Optional label/value rows. Values are HTML (escape text yourself). */
  facts?: Array<{ label: string; html: string }>;
  /** Optional HTML for buttons/links in the card footer. */
  actions?: string;
  /** Optional tooltip text (setup hint). */
  tip?: string;
};

/** One integration card. Exported so other integrations render the same way. */
export function renderIntegrationCard(card: IntegrationCard): string {
  const facts = card.facts?.length
    ? `<dl class="set-facts">${card.facts.map((fact) => `<dt>${escapeHtml(fact.label)}</dt><dd>${fact.html}</dd>`).join("")}</dl>`
    : "";
  return `<section class="gc-card set-card" id="integration-${escapeHtml(card.id)}" aria-labelledby="integration-${escapeHtml(card.id)}-title">
  <div class="set-head">
    <span class="set-icon">${icon(card.icon, { size: 22 })}</span>
    <div class="set-name"><h2 class="gc-card-title" id="integration-${escapeHtml(card.id)}-title">${escapeHtml(card.name)}</h2><p class="gc-meta">${escapeHtml(card.summary)}</p></div>
    ${chip(card.status.label, card.status.tone)}${card.tip ? infoTip(card.tip, "Setup") : ""}
  </div>
  ${facts}
  ${card.actions ? `<div class="set-actions">${card.actions}</div>` : ""}
</section>`;
}

function checkoutLabel(context: SettingsContext): string {
  const pending = context.kroger.checkout;
  if (!pending) return context.demoMode ? chip("Simulated", "neutral") : chip("Not started", "neutral");
  const name = context.members.find((member) => member.id === pending.selectedMemberId)?.name;
  switch (pending.status) {
    case "awaiting_oauth":
      return chip(`Waiting for ${name ?? "sign-in"}`, "warning", "clock")
        + (pending.selectedMemberId ? button({ label: "Sign in", variant: "tonal", size: "sm", href: `/api/kroger/oauth/start?memberId=${encodeURIComponent(pending.selectedMemberId)}` }) : "");
    case "choosing_account": return chip("Choosing account", "warning", "clock");
    case "replacement_review": return chip("Review swaps in chat", "warning", "alert");
    case "adding": return chip("Sending to Kroger", "accent", "sync");
    default: return chip(pending.status.replace(/_/g, " "), "neutral");
  }
}

function krogerCard(context: SettingsContext): IntegrationCard {
  const { configured, locationConfigured } = context.kroger;
  return {
    id: "kroger",
    name: "Kroger",
    icon: "store",
    summary: "Product search and cart transfer",
    status: !configured
      ? { label: "Not configured", tone: "neutral" }
      : locationConfigured ? { label: "Connected", tone: "success" } : { label: "No store set", tone: "warning" },
    facts: [
      { label: "Store prices", html: configured && locationConfigured ? chip("On", "success", "check") : chip("Off", "neutral") },
      { label: "Checkout", html: checkoutLabel(context) },
    ],
    actions: button({ label: "Open Kroger", variant: "outline", size: "sm", href: "https://www.kroger.com", external: true }),
    tip: configured
      ? "Each shopper signs in to their own Kroger account at checkout. GroupCart adds items only; you place the order on Kroger."
      : "Add Kroger app credentials and a store ID to .env, then restart GroupCart.",
  };
}

function imessageCard(context: SettingsContext): IntegrationCard {
  return {
    id: "imessage",
    name: "iMessage group",
    icon: "message",
    summary: "Where the household edits the cart",
    status: context.demoMode ? { label: "Demo", tone: "neutral" } : { label: "Live", tone: "success" },
    facts: [{ label: "Household", html: escapeHtml(context.householdId) }, { label: "Members", html: `<span class="set-members">${context.members.map((member) => `<span class="set-member">${avatarHtml(member, { allMemberIds: context.members.map((m) => m.id), size: 24 })}${escapeHtml(member.name)}</span>`).join("") || '<span class="gc-muted">None</span>'}</span>` }],
    tip: context.demoMode
      ? "Spectrum is not configured, so GroupCart runs a local demo. No messages are sent."
      : "Only allowlisted members in the group can change the cart.",
  };
}

// --- Placeholders: replaced on merge by feature/google-calendar, feature/splitwise,
// --- and the Claude connector branch. Each is one self-contained function.

function googleCalendarCard(): IntegrationCard {
  return {
    id: "google-calendar",
    name: "Google Calendar",
    icon: "calendar",
    summary: "Find times everyone is free",
    status: { label: "Not configured", tone: "neutral" },
    actions: button({ label: "Connect", variant: "outline", size: "sm", disabled: true }),
  };
}

// Bills branch: real Splitwise status (configured / simulated, last result) from src/bills.ts.
function splitwiseCard(): IntegrationCard {
  return billsSplitwiseCard();
}

// --- AI assistants connector (Claude, ChatGPT & dots, Grok): tokens, OAuth apps, setup tabs (src/ui/connectorCard.ts) ---
function claudeCard(): IntegrationCard {
  return claudeConnectorCard();
}
// --- end AI assistants connector ---

const styles = `
.set-wrap { max-width:760px; margin:0 auto; display:grid; gap:var(--gc-space-4); }
.set-head { display:flex; align-items:center; gap:var(--gc-space-3); min-width:0; }
.set-icon { width:40px; height:40px; flex:none; display:grid; place-items:center; border-radius:var(--gc-radius-md); background:var(--gc-surface-2); border:1px solid var(--gc-border); color:var(--gc-text-2); }
.set-name { flex:1; min-width:0; }
.set-facts { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--gc-space-3) var(--gc-space-4); margin:var(--gc-space-4) 0 0; padding-top:var(--gc-space-3); border-top:1px solid var(--gc-border); align-items:center; }
.set-facts dt { color:var(--gc-muted); font-size:var(--gc-fs-sm); }
.set-facts dd { margin:0; display:flex; flex-wrap:wrap; gap:6px; align-items:center; justify-content:flex-end; min-width:0; }
.set-actions { display:flex; align-items:center; gap:var(--gc-space-2); margin-top:var(--gc-space-4); }
.set-members { display:flex; flex-wrap:wrap; gap:var(--gc-space-2) var(--gc-space-3); justify-content:flex-end; }
.set-member { display:inline-flex; align-items:center; gap:6px; }
/* Phones: the one-line summaries crowd the title next to the status chip; the info tip keeps the detail. */
@media (max-width: 760px) { .set-name .gc-meta { display:none; } }
`;

export function renderSettingsPage(context: SettingsContext): string {
  const body = `<div class="set-wrap">
  ${appearanceCard()}
  ${sectionHeader("Connections", { flavor: "settings.connections" })}
  ${[coordinatorCard(), imessageCard(context), krogerCard(context), googleCalendarCard(), splitwiseCard(), billsAnthropicCard(), claudeCard()].filter((card): card is IntegrationCard => card !== null).map(renderIntegrationCard).join("\n")}
</div>`;
  return renderPage({
    title: "Settings",
    active: "settings",
    body,
    styles,
    actions: context.demoMode ? chip("Demo", "neutral") : chip("Live", "accent", "lock"),
  });
}
