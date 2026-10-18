import type { MemberConfig } from "./store.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMembers(value: string | undefined): MemberConfig[] {
  if (!value?.trim()) return [];
  return value.split(",").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) return [];
    const handle = entry.slice(0, separator).trim();
    const name = entry.slice(separator + 1).trim();
    if (!handle || !name) return [];
    return [{ handle: handle.includes("@") ? handle.toLocaleLowerCase() : handle, name }];
  });
}

const members = parseMembers(process.env.GROUP_CART_MEMBERS);
const port = positiveInteger(process.env.PORT, 3000);
const dashboardPublicUrl = (process.env.GROUP_CART_PUBLIC_URL?.trim() || `http://127.0.0.1:${port}`).replace(/\/$/, "");
const configuredCartModality = process.env.KROGER_CART_MODALITY?.trim().toLocaleUpperCase();

export const config = {
  spectrumProjectId: process.env.PROJECT_ID?.trim(),
  spectrumProjectSecret: process.env.PROJECT_SECRET?.trim(),
  allowedMembers: members,
  householdId: process.env.GROUP_CART_HOUSEHOLD?.trim() || "apartment-4b",
  databasePath: process.env.GROUP_CART_DB?.trim() || "./data/groupcart.sqlite",
  budgetCents: positiveInteger(process.env.GROUP_CART_BUDGET_CENTS, 5000),
  port,
  dashboardPublicUrl,
  krogerClientId: process.env.KROGER_CLIENT_ID?.trim(),
  krogerClientSecret: process.env.KROGER_CLIENT_SECRET?.trim(),
  krogerLocationId: process.env.KROGER_LOCATION_ID?.trim(),
  krogerRedirectUri: process.env.KROGER_REDIRECT_URI?.trim() || `${dashboardPublicUrl}/api/kroger/oauth/callback`,
  krogerCartModality: configuredCartModality === "DELIVERY" ? "DELIVERY" as const : "PICKUP" as const,
};

// --- Google Calendar (per-member free/busy) --------------------------------
// Unset client ID/secret = the /calendar page shows generated sample schedules.
export const googleCalendarConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID?.trim() || undefined,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
  redirectUri: process.env.GOOGLE_REDIRECT_URI?.trim() || `${dashboardPublicUrl}/api/google/oauth/callback`,
};
// --- end Google Calendar ------------------------------------------------------

export function validateSpectrumConfig(): void {
  const hasProjectId = Boolean(config.spectrumProjectId);
  const hasProjectSecret = Boolean(config.spectrumProjectSecret);
  if (hasProjectId !== hasProjectSecret) {
    throw new Error("Set both PROJECT_ID and PROJECT_SECRET to connect Spectrum Cloud.");
  }
  if (hasProjectId && !config.allowedMembers.length) {
    throw new Error("Set GROUP_CART_MEMBERS (handle=name entries) to allow household members in the group chat.");
  }
}
