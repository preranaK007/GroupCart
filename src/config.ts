import type { MemberConfig } from "./store.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Canonical form for comparing iMessage handles: emails are lowercased; phone
 * numbers lose spaces, dashes, parentheses, and dots, and bare 10-digit (or
 * 11-digit leading-1) US numbers become E.164 (+1XXXXXXXXXX).
 */
export function normalizeHandle(raw: string): string {
  const handle = raw.trim();
  if (handle.includes("@")) return handle.toLowerCase();
  const compact = handle.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return handle;
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  return compact;
}

/** Log- and chat-safe hint for a handle: phone last 4 digits or the email's first letter and domain. */
export function maskHandle(raw: string): string {
  const handle = normalizeHandle(raw);
  const at = handle.lastIndexOf("@");
  if (at > 0) return `email ${handle[0]}***@${handle.slice(at + 1)}`;
  const digits = handle.replace(/\D/g, "");
  return digits.length >= 4 ? `phone ending in ${digits.slice(-4)}` : "an unrecognized handle";
}

/** Finds the configured member owning a handle (any of its listed handles), after normalization. */
export function findMember(members: MemberConfig[], handle: string): MemberConfig | undefined {
  const normalized = normalizeHandle(handle);
  return members.find((member) => member.handle === normalized || member.aliases?.includes(normalized));
}

// Entries are comma-separated `handle=Name`; one member may list several handles as `+15551234567|me@icloud.com=Name`.
export function parseMembers(value: string | undefined): MemberConfig[] {
  if (!value?.trim()) return [];
  const claimed = new Set<string>();
  return value.split(",").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) return [];
    const name = entry.slice(separator + 1).trim();
    if (!name) return [];
    const handles = entry.slice(0, separator).split("|").map(normalizeHandle).filter((handle) => {
      if (!handle) return false;
      if (claimed.has(handle)) {
        console.warn(`GROUP_CART_MEMBERS lists ${maskHandle(handle)} more than once; only its first entry is used.`);
        return false;
      }
      claimed.add(handle);
      return true;
    });
    const [handle, ...aliases] = handles;
    if (!handle) return [];
    return [aliases.length ? { handle, name, aliases } : { handle, name }];
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

export function validateSpectrumConfig(): void {
  const hasProjectId = Boolean(config.spectrumProjectId);
  const hasProjectSecret = Boolean(config.spectrumProjectSecret);
  if (hasProjectId !== hasProjectSecret) {
    throw new Error("Set both PROJECT_ID and PROJECT_SECRET to connect Spectrum Cloud.");
  }
  if (hasProjectId && !config.allowedMembers.length) {
    throw new Error("Set GROUP_CART_MEMBERS (handle=name entries; use handle1|handle2=name for several handles) to allow household members in the group chat.");
  }
}
