import { extractCartRequests } from "../cart.js";
import type { BatchRequest, Member } from "./types.js";

// Pure text parsing for inbound messages. Functions that strip member names
// take the household roster as their first argument.

/** Exact cart commands; anything matching is never treated as a product search. */
export const CART_COMMAND_PATTERN = /^(cart|show cart|review cart|dashboard|open dashboard|cart page|approve|approve cart|confirm cart|checkout|finish checkout|cancel checkout|clear mine|clear my items|clear my stuff|clear my groceries|clear everything for me|clear all|clear everything|clear cart|clear entire cart|empty cart|clear shared list|clear entire shared list|confirm clear all|cancel clear all|yes clear all|undo|undo last|revert|revert last change)$/i;
/** A bare reply to the sender's own question, or to the group review when they have none. */
export const CANCEL_REPLY_PATTERN = /^(?:cancel|never mind|nevermind)[.!?]*$/i;
export function normalizeCancelReply(text: string): string {
  const trimmed = text.trim();
  return CANCEL_REPLY_PATTERN.test(trimmed) ? "cancel" : trimmed;
}
/** A choice for the checkout availability review. Items are only ever named by number. */
export type ReviewCommand =
  | { kind: "replace"; item: number; option: number }
  | { kind: "remove"; which: number[] | "all" | "single" };

/** Lowercase, NFKC, without trailing punctuation or polite wrappers (“ok”, “please”, “can you …?”). */
function stripReviewFiller(text: string): string {
  let t = text.normalize("NFKC").toLocaleLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  let previous: string;
  do {
    previous = t;
    t = t.replace(/[.!?]+$/, "").trim()
      .replace(/^(?:ok(?:ay)?|yes|yeah|yep|sure|alright|so|and|please|pls|plz|go ahead and|let'?s|lets)\b[\s,]*/, "")
      .replace(/^(?:can|could|would|will) (?:you|we|u) (?:please |pls )?/, "")
      .replace(/[\s,]*\b(?:please|pls|plz|thanks|thank you|thx|ty)$/, "")
      .replace(/\s+(?:from|off) (?:the |our |my )?(?:cart|basket|list|order|checkout|review)$/, "")
      .trim();
  } while (t !== previous);
  return t;
}

/**
 * Checkout-review commands: “replace 1 with 2” / “swap item #1 for 2”, “remove 1”, “ok remove 1, 2, and 3
 * please”, “remove items 1 and 2”, “remove all unavailable”, and “remove the unavailable item” (one item; the
 * caller asks which number when more than one is open). Anything else is not a review command; names are never
 * matched, so chat about an item can't change the cart.
 */
export function parseReviewCommand(text: string): ReviewCommand | undefined {
  const t = stripReviewFiller(text);
  const replace = t.match(/^(?:replace|swap)\s+(?:item\s+|number\s+)?#?(\d{1,2})\s+(?:with|for)\s+(?:option\s+|suggestion\s+|number\s+)?#?(\d{1,2})$/);
  if (replace) return { kind: "replace", item: Number(replace[1]), option: Number(replace[2]) };
  const verb = t.match(/^(?:remove|drop|delete|skip)\s+(.+)$/);
  if (!verb) return undefined;
  const target = verb[1]!.trim();
  if (/^all (?:of )?(?:the )?unavailable(?: (?:items|ones|things|stuff))?$/.test(target)) {
    return { kind: "remove", which: "all" };
  }
  if (/^(?:the )?unavailable(?: (?:item|one|thing))?$/.test(target)) return { kind: "remove", which: "single" };
  const numberRef = String.raw`(?:(?:items?|numbers?|no\.?)\s*)?#?\d{1,2}`;
  if (!new RegExp(`^${numberRef}(?:\\s*(?:,|&|\\+|\\band\\b|\\s)\\s*(?:and\\s+)?${numberRef})*$`).test(target)) return undefined;
  return { kind: "remove", which: (target.match(/\d+/g) ?? []).map(Number) };
}

export const PRICE_LIMIT_PATTERN = /\b(?:under|below|less than|at most|no more than|up to)\s+\$?\s*\d+(?:\.\d{1,2})?\s*(?:dollars?)?\b/gi;

export function retailerQuery(members: Member[], text: string): string {
  let query = text.toLocaleLowerCase();
  query = query.replace(/\b(?:that\s+)?i\s+(?:also\s+)?want\s+to\s+share\b.*$/i, " ");
  query = query.replace(/\b(?:can|could)\s+i\s+(?:please\s+)?get\b|\bi\s+(?:would\s+like|want)\b|\bwe\s+need\b|\bplease\s+(?:get|add)\b|\badd\b/gi, " ");
  query = query.replace(/\b(?:under|below|less than|at most|no more than|up to)\s+\$?\s*\d+(?:\.\d{1,2})?\s*(?:dollars?)?\b/gi, " ");
  // Old per-item sharing phrases no longer change the split, but they would
  // still pollute product searches. Only strip “with …” after a share verb so
  // descriptions like “pasta with pesto” keep their meaning.
  query = query.replace(/\b(?:shared?|split)\s+(?:with|between|among)\b.*$/i, " ");
  query = query.replace(/\b(?:for everyone|for all of us|for us|for me|shared|share|please|thanks|thx)\b/gi, " ");
  for (const member of members) {
    const names = new Set([member.name, member.name.split(/\s+/)[0] ?? member.name]);
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query = query.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "giu"), " ");
    }
  }
  query = query.replace(/\bfor\s*$/i, " ");
  query = query.replace(/^\s*\d+(?!\s*(?:%|percent\b))\s*(?:(?:x|×)\s*|\s+)/i, " ").replace(/\b(?:and|with|to)\b/gi, " ");
  return query.replace(/[.,!?;:]+/g, " ").replace(/\s+/g, " ").trim();
}

export function cancellationQuery(members: Member[], text: string): string | undefined {
  const normalizedText = text.replace(/[’‘]/g, "'");
  if (/^cancel clear all$/i.test(normalizedText.trim())) return undefined;
  const patterns = [
    /\b(?:i|we)\s+(?:do\s+not|don't|dont)\s+(?:want|need)\s+(?:the\s+)?(.+?)(?:\s+(?:anymore|any\s+more|please))?(?:[.!?]|$)/i,
    /\b(?:remove|cancel|delete|drop)\s+(?:(?:the|my|our)\s+)?(.+?)(?:\s+from\s+(?:the\s+)?(?:cart|basket)|\s+please)?(?:[.!?]|$)/i,
    /\btake\s+(?:(?:the|my|our)\s+)?(.+?)\s+off(?:\s+(?:the\s+)?(?:cart|basket))?(?:[.!?]|$)/i,
  ];
  let target: string | undefined;
  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    if (match?.[1]) { target = match[1]; break; }
  }
  if (!target) return undefined;
  const query = retailerQuery(members, target)
    .replace(/\b(?:anymore|any more|now|item|items|thing|things)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  return query.length >= 2 ? query : undefined;
}

export function milkSearchQuery(members: Member[], text: string): string | undefined {
  const normalized = text.trim().toLocaleLowerCase();
  if (/^(?:1|whole(?:\s+milk)?|dairy(?:\s+milk)?)$/i.test(normalized)) return "whole milk";
  if (/^(?:2|2\s*(?:%|percent)(?:\s+milk)?|two\s+percent(?:\s+milk)?|reduced\s+fat(?:\s+milk)?)$/i.test(normalized)) return "2% milk";
  if (/^(?:3|oat(?:\s+milk)?)$/i.test(normalized)) return "oat milk";
  if (/^(?:4|almond(?:\s+milk)?)$/i.test(normalized)) return "almond milk";
  const branded = retailerQuery(members, text);
  return /\bmilk\b/i.test(branded) ? branded : undefined;
}

export function multiItemRequests(members: Member[], text: string): BatchRequest[] {
  let body = text.trim().replace(/^[\s,;]*(?:hi|hello|hey)[,:\s]+/i, "");
  body = body.replace(/^\s*(?:(?:can|could|may)\s+i\s+(?:please\s+)?(?:get|have|add)|(?:i|we)\s+(?:would\s+like|want|need)|please\s+(?:add|get)|add)\s+/i, "");
  // Drop old per-item sharing phrases (they no longer share) before splitting,
  // so “bread shared with Maya and Jordan” doesn't turn “Jordan” into an item.
  body = body.replace(/\s*\b(?:shared?|split)\s+(?:with|between|among)\b[^,;\n]*/gi, "");
  const segments = body.split(/\s*(?:,|;|\n)\s*|\s+and\s+/i)
    .map((segment) => segment.trim().replace(/^[,;\s]+|[.!?]+$/g, ""))
    .filter(Boolean);
  if (segments.length < 2) return [];
  const requests = segments.map((segment) => {
    const priceLimit = parsePriceLimit(segment);
    const itemText = segment
      .replace(/\b(?:under|below|less than|at most|no more than|up to)\s+\$?\s*\d+(?:\.\d{1,2})?\s*(?:dollars?)?\b/gi, " ")
      .trim();
    const extracted = extractCartRequests(itemText);
    return {
      query: retailerQuery(members, itemText),
      quantity: extracted.length === 1 ? extracted[0]!.quantity : quantityFromText(itemText),
      maxPriceCents: priceLimit?.cents,
      maxPriceInclusive: priceLimit?.inclusive,
    };
  });
  return requests.every((request) => request.query.length >= 2) ? requests : [];
}

export function parsePriceLimit(text: string): { cents: number; inclusive: boolean } | undefined {
  const match = text.match(/\b(under|below|less than|at most|no more than|up to)\s+\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:dollars?)?\b/i);
  if (!match) return undefined;
  const dollars = Number(match[2]);
  if (!Number.isFinite(dollars) || dollars <= 0) return undefined;
  return {
    cents: Math.round(dollars * 100),
    inclusive: /^(?:at most|no more than|up to)$/i.test(match[1]!),
  };
}

// Group-chat chatter that never names groceries: laughter, thanks, reactions, acknowledgements. Every word of a
// banter message is in this set ("haha ok thanks 👍"); greetings stay out because "hi" answers with help.
const BANTER_WORDS = new Set([
  "lol", "lmao", "lmfao", "rofl", "haha", "hahaha", "hah", "hehe", "omg", "wow", "ooh", "oh", "ah", "aw", "aww", "oops", "yay", "woo",
  "nice", "cool", "great", "awesome", "sweet", "perfect", "dope", "lit", "love", "it", "this", "that", "same", "true", "fr", "ikr", "bet", "word",
  "thanks", "thank", "you", "thx", "ty", "tysm", "np", "no", "problem", "sorry", "ok", "okay", "k", "kk", "yes", "yeah", "yep", "yup",
  "nope", "nah", "sure", "sounds", "good", "got", "will", "do", "on", "my", "way", "brb", "gn", "night", "gm", "morning",
]);

/**
 * True for banter like “lol”, “👍”, “thanks!”, or “ok” — text with no digits whose words are all chatter (emoji-only
 * counts). The store stays quiet on these when it has nothing pending for the member.
 */
export function isBanter(text: string): boolean {
  const lowered = text.trim().toLowerCase().replace(/[’']/g, "");
  if (!lowered || /\d/.test(lowered)) return false;
  const words = lowered.split(/[^\p{L}]+/u).filter(Boolean);
  return words.every((word) => BANTER_WORDS.has(word) || /^(?:ha)+h?$|^(?:he)+$|^lo+l$|^lma+o+$/.test(word));
}

export function isHelpRequest(text: string): boolean {
  return /^(?:(?:hi|hello|hey)(?: there)?|help|commands|menu|start|show commands|what can you do)[!.?]*$/i.test(text.trim());
}

export function quantityFromText(text: string): number {
  const match = text.match(/^\s*(\d+)(?!\s*(?:%|percent\b))\s*(?:x|×)?\s+\S/i);
  const amount = Number(match?.[1] ?? 1);
  return Number.isSafeInteger(amount) ? Math.min(Math.max(amount, 1), 99) : 1;
}

export function parseSharingCommand(text: string): { action: "start" | "stop"; names: string } | undefined {
  const match = text.trim().match(/^(start|stop)\s+sharing\b([\s\S]*)$/i);
  if (!match) return undefined;
  const rest = match[2]!.trim().replace(/[.!?]+$/, "").trim();
  return {
    action: match[1]!.toLocaleLowerCase() === "start" ? "start" : "stop",
    names: rest.replace(/^with\b/i, "").trim(),
  };
}
