// Pay-back links: one-tap Venmo, Cash App, and PayPal.me links with the amount (and, for Venmo, a note)
// already filled in, built from the payment handles on each member's profile.
//
// GroupCart never moves money and never learns whether a payment happened: a link only opens the payment
// app. After paying, the member taps "Mark paid" (or texts "paid Alex $20"), which records the payback
// through the bills ledger like any other payment.
//
// Handles live in the profile's payment field as plain text ("Venmo @alex-k · Cash App $alexk · PayPal.me/alexk"),
// so the profile page, the get_profile/update_my_profile tools, and older free-text values keep working.
// parsePayHandles() reads that text; formatPayHandles() writes it back from the edit dialog's three fields.

export type PayProvider = "venmo" | "cashapp" | "paypal";
export type PayHandles = { venmo?: string; cashapp?: string; paypal?: string; /** Unrecognized text, kept as-is. */ rest: string };
export type PayOption = { provider: PayProvider; label: string; handle: string; url: string; appUrl?: string };

export const PROVIDER_LABEL: Record<PayProvider, string> = { venmo: "Venmo", cashapp: "Cash App", paypal: "PayPal" };
export const DEFAULT_PAY_NOTE = "GroupCart settle-up";

// Allowed handle characters per service (anything else is never put in a URL).
const VENMO_USER = /^[A-Za-z0-9_-]{2,30}$/;
const CASHTAG = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const PAYPAL_ME = /^[A-Za-z0-9]{2,20}$/;

/** 2667 → "26.67" (the format all three services accept in a URL). */
export function amountText(cents: number): string {
  const safe = Math.max(0, Math.round(cents));
  return `${Math.floor(safe / 100)}.${String(safe % 100).padStart(2, "0")}`;
}

/** https://venmo.com/<user>?txn=pay&amount=26.67&note=… (opens the Venmo app on phones that have it). */
export function venmoLink(user: string, cents: number, note = DEFAULT_PAY_NOTE): string {
  if (!VENMO_USER.test(user)) throw new Error("Not a Venmo username.");
  return `https://venmo.com/${encodeURIComponent(user)}?txn=pay&amount=${amountText(cents)}&note=${encodeURIComponent(note)}`;
}

/** venmo://paycharge?txn=pay&recipients=<user>&amount=…&note=… (the app's own scheme; only works where Venmo is installed). */
export function venmoAppLink(user: string, cents: number, note = DEFAULT_PAY_NOTE): string {
  if (!VENMO_USER.test(user)) throw new Error("Not a Venmo username.");
  return `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(user)}&amount=${amountText(cents)}&note=${encodeURIComponent(note)}`;
}

/** https://cash.app/$<tag>/26.67 */
export function cashAppLink(tag: string, cents: number): string {
  if (!CASHTAG.test(tag)) throw new Error("Not a Cash App $cashtag.");
  return `https://cash.app/$${encodeURIComponent(tag)}/${amountText(cents)}`;
}

/** https://paypal.me/<user>/26.67 */
export function paypalLink(user: string, cents: number): string {
  if (!PAYPAL_ME.test(user)) throw new Error("Not a PayPal.me name.");
  return `https://paypal.me/${encodeURIComponent(user)}/${amountText(cents)}`;
}

// ---------------------------------------------------------------------------
// Handles <-> profile text
// ---------------------------------------------------------------------------

const SEPARATORS = /^[\s·•|,;/&+-]+|[\s·•|,;/&+-]+$/g;
const STOP_WORDS = new Set(["or", "and", "me", "is", "at", "on", "to", "for", "please", "pls", "app", "cash"]);

/**
 * Reads payment handles from free text: "Venmo @alex-k", "venmo.com/u/alex-k", "Cash App $alexk", "$alexk",
 * "cash.app/$alexk", "PayPal.me/alexk", "paypal @alexk", or several joined with "·", ",", "|", "/".
 * A bare "@name" counts as Venmo. Text it doesn't recognize is returned in `rest`.
 */
export function parsePayHandles(text: string): PayHandles {
  let work = ` ${String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ")} `;
  const found: PayHandles = { rest: "" };
  const take = (provider: PayProvider, patterns: RegExp[], valid: RegExp) => {
    for (const pattern of patterns) {
      if (found[provider]) return;
      const match = pattern.exec(work);
      if (!match) continue;
      const handle = match[match.length - 1]!;
      if (!valid.test(handle) || STOP_WORDS.has(handle.toLowerCase())) continue;
      found[provider] = handle;
      work = `${work.slice(0, match.index)} ${work.slice(match.index + match[0].length)}`;
    }
  };
  // Links first, then labeled handles, then bare $cashtag / @venmo.
  take("paypal", [/(?:https?:\/\/)?(?:www\.)?paypal\.me\/([A-Za-z0-9]+)\/?/i, /\bpay\s?pal\b(?:\.me)?\s*[:\-–]?\s*@?([A-Za-z0-9]+)/i], PAYPAL_ME);
  take("cashapp", [/(?:https?:\/\/)?(?:www\.)?cash\.app\/\$([A-Za-z0-9_-]+)\/?/i, /\bcash\s?app\b\s*[:\-–]?\s*\$?([A-Za-z][A-Za-z0-9_-]*)/i, /(?<=[\s,;|·•/(])\$([A-Za-z][A-Za-z0-9_-]*)/], CASHTAG);
  take("venmo", [/(?:https?:\/\/)?(?:www\.|account\.)?venmo\.com\/(?:u\/)?@?([A-Za-z0-9_-]+)\/?/i, /\bvenmo\b\s*[:\-–]?\s*@?([A-Za-z0-9_-]+)/i, /(?<=[\s,;|·•/(])@([A-Za-z0-9_-]+)/], VENMO_USER);
  found.rest = work.replace(/\s+/g, " ").replace(SEPARATORS, "").replace(/^(?:or|and)\s+|\s+(?:or|and)$/gi, "").trim();
  return found;
}

/** Canonical profile text for a set of handles, e.g. "Venmo @alex-k · Cash App $alexk · PayPal.me/alexk". */
export function formatPayHandles(handles: Partial<PayHandles>): string {
  const parts: string[] = [];
  const venmo = cleanHandle(handles.venmo, "@");
  const cash = cleanHandle(handles.cashapp, "$");
  const paypal = cleanHandle(handles.paypal, "paypal.me/");
  if (venmo && VENMO_USER.test(venmo)) parts.push(`Venmo @${venmo}`);
  if (cash && CASHTAG.test(cash)) parts.push(`Cash App $${cash}`);
  if (paypal && PAYPAL_ME.test(paypal)) parts.push(`PayPal.me/${paypal}`);
  const rest = String(handles.rest ?? "").trim();
  if (rest) parts.push(rest);
  return parts.join(" · ");
}

function cleanHandle(value: string | undefined, prefix: string): string {
  let handle = String(value ?? "").trim();
  if (handle.toLowerCase().startsWith(prefix.toLowerCase())) handle = handle.slice(prefix.length);
  return handle.replace(/^[@$]/, "").replace(/\/+$/, "").trim();
}

/** Payment links (amount and note filled in) for a member's handles, Venmo first. */
export function payOptions(handles: PayHandles, cents: number, note = DEFAULT_PAY_NOTE): PayOption[] {
  if (!Number.isFinite(cents) || cents <= 0) return [];
  const options: PayOption[] = [];
  if (handles.venmo) options.push({ provider: "venmo", label: PROVIDER_LABEL.venmo, handle: `@${handles.venmo}`, url: venmoLink(handles.venmo, cents, note), appUrl: venmoAppLink(handles.venmo, cents, note) });
  if (handles.cashapp) options.push({ provider: "cashapp", label: PROVIDER_LABEL.cashapp, handle: `$${handles.cashapp}`, url: cashAppLink(handles.cashapp, cents) });
  if (handles.paypal) options.push({ provider: "paypal", label: PROVIDER_LABEL.paypal, handle: `paypal.me/${handles.paypal}`, url: paypalLink(handles.paypal, cents) });
  return options;
}

/** Profile links without an amount (the "Pay" row on /people/<id>). */
export function profilePayLinks(handles: PayHandles): Array<{ provider: PayProvider; label: string; handle: string; url: string }> {
  const links: Array<{ provider: PayProvider; label: string; handle: string; url: string }> = [];
  if (handles.venmo) links.push({ provider: "venmo", label: PROVIDER_LABEL.venmo, handle: `@${handles.venmo}`, url: `https://venmo.com/u/${encodeURIComponent(handles.venmo)}` });
  if (handles.cashapp) links.push({ provider: "cashapp", label: PROVIDER_LABEL.cashapp, handle: `$${handles.cashapp}`, url: `https://cash.app/$${encodeURIComponent(handles.cashapp)}` });
  if (handles.paypal) links.push({ provider: "paypal", label: PROVIDER_LABEL.paypal, handle: `paypal.me/${handles.paypal}`, url: `https://paypal.me/${encodeURIComponent(handles.paypal)}` });
  return links;
}

// ---------------------------------------------------------------------------
// Household lookups (installed by setupMoneyPoints from the profiles service)
// ---------------------------------------------------------------------------

let handleSource: ((memberId: string) => string) | null = null;

/** memberId → that member's profile payment text. */
export function setPayHandleSource(source: ((memberId: string) => string) | null): void {
  handleSource = source;
}

export function handlesFor(memberId: string): PayHandles {
  try {
    return parsePayHandles(handleSource?.(memberId) ?? "");
  } catch {
    return { rest: "" };
  }
}

/** Links for paying `memberId` back `cents` (empty when they haven't added a handle). */
export function payOptionsFor(memberId: string, cents: number, note = DEFAULT_PAY_NOTE): PayOption[] {
  return payOptions(handlesFor(memberId), cents, note);
}

/** One chat line for a debt, e.g. "💳 Pay Alex $26.67 on Venmo: https://venmo.com/alex-k?…", or null without a handle. */
export function payLinkLine(toId: string, toName: string, cents: number): string | null {
  const option = payOptionsFor(toId, cents)[0];
  if (!option) return null;
  return `💳 Pay ${toName.split(/\s+/)[0]} $${amountText(cents)} on ${option.label}: ${option.url}`;
}
