import { extractCartRequests } from "../cart.js";
import type { BatchRequest, Member } from "./types.js";

// Pure text parsing for inbound messages. Functions that strip member names
// take the household roster as their first argument.

/** Exact cart commands; anything matching is never treated as a product search. */
export const CART_COMMAND_PATTERN = /^(cart|show cart|review cart|dashboard|open dashboard|cart page|approve|approve cart|confirm cart|checkout|finish checkout|cancel checkout|clear mine|clear my items|clear my stuff|clear my groceries|clear everything for me|clear all|clear everything|clear cart|clear entire cart|empty cart|clear shared list|clear entire shared list|confirm clear all|cancel clear all|yes clear all|undo|undo last|revert|revert last change)$/i;
/**
 * Checkout-review removals: “remove 1”, “remove 1, 3”, “drop 2 and 3”, or
 * “remove unavailable” / “remove all unavailable items”.
 */
export function parseUnavailableRemoval(text: string): number[] | "all" | undefined {
  const normalized = text.trim().replace(/[.!?]+$/, "").trim();
  if (/^(?:remove|drop|delete|skip)\s+(?:all\s+)?(?:the\s+)?unavailable(?:\s+(?:items?|ones?))?$/i.test(normalized)) return "all";
  const match = normalized.match(/^(?:remove|drop|delete|skip)\s+(?:#|items?\s+|number\s+)?(\d{1,2}(?:\s*(?:,|&|and)\s*#?\d{1,2})*)$/i);
  if (!match) return undefined;
  return match[1]!.split(/\s*(?:,|&|and)\s*/i).map((part) => Number(part.replace("#", "")));
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
