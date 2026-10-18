// Bill split math (pure, integer cents). Every split returns shares that sum to the
// total exactly. Rounding is deterministic: leftover cents go to members in sorted-id
// order (equal split, same rule as CartStore) or by largest remainder (weighted).
// CLIENT_SPLIT_JS mirrors computeSplit() for the /bills page's live preview; the
// server always recomputes and validates on save.

export type SplitMode = "equal" | "percent" | "exact" | "item";
export type Share = { memberId: string; cents: number };
export type BillItem = { description: string; cents: number; memberIds?: string[] };
export type SplitSpec = {
  mode: SplitMode;
  /** Participants in display order (equal / percent / exact; default members for unassigned items). */
  memberIds: string[];
  /** percent mode: percentages or share counts per member (proportional). */
  weights?: Record<string, number>;
  /** exact mode: cents per member. */
  amounts?: Record<string, number>;
  /** item mode: line items (cents) with the members sharing each (empty = all participants). */
  items?: BillItem[];
};
export type SplitResult = { ok: true; shares: Share[] } | { ok: false; error: string };
export type Transfer = { from: string; to: string; cents: number };

export const MAX_BILL_CENTS = 100_000_000; // $1,000,000
const WEIGHT_SCALE = 10_000;
const MAX_WEIGHT = 10_000;

export function dollars(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Equal split; leftover cents go to the first members in sorted-id order (like CartStore). Output keeps input order. */
export function splitEqual(totalCents: number, memberIds: readonly string[]): Share[] {
  const ids = unique(memberIds);
  if (!ids.length) return [];
  const base = Math.floor(totalCents / ids.length);
  let remainder = totalCents - base * ids.length;
  const extra = new Map<string, number>();
  for (const id of [...ids].sort()) {
    extra.set(id, remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return ids.map((id) => ({ memberId: id, cents: base + (extra.get(id) ?? 0) }));
}

/** Proportional split by weights (percentages or shares) using the largest-remainder method. */
export function splitWeighted(totalCents: number, weights: ReadonlyArray<{ memberId: string; weight: number }>): SplitResult {
  const seen = new Set<string>();
  const scaled: Array<{ memberId: string; w: number }> = [];
  for (const entry of weights) {
    if (seen.has(entry.memberId)) continue;
    seen.add(entry.memberId);
    if (!Number.isFinite(entry.weight) || entry.weight < 0 || entry.weight > MAX_WEIGHT) {
      return { ok: false, error: "Each share must be a number between 0 and 10,000." };
    }
    scaled.push({ memberId: entry.memberId, w: Math.round(entry.weight * WEIGHT_SCALE) });
  }
  const sum = scaled.reduce((total, entry) => total + entry.w, 0);
  if (!scaled.length || sum <= 0) return { ok: false, error: "Give at least one person a share." };
  const rows = scaled.map((entry) => {
    const product = totalCents * entry.w; // < 2^53 for totals up to $1M and weights up to 10,000
    return { memberId: entry.memberId, cents: Math.floor(product / sum), rem: product % sum };
  });
  let leftover = totalCents - rows.reduce((total, row) => total + row.cents, 0);
  const order = [...rows].sort((a, b) => b.rem - a.rem || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
  for (const row of order) {
    if (leftover <= 0) break;
    row.cents += 1;
    leftover -= 1;
  }
  return { ok: true, shares: rows.map(({ memberId, cents }) => ({ memberId, cents })) };
}

/** Exact amounts; must add up to the total to the cent. */
export function splitExact(totalCents: number, memberIds: readonly string[], amounts: Record<string, number>): SplitResult {
  const ids = unique(memberIds);
  const shares: Share[] = [];
  for (const id of ids) {
    const cents = amounts[id] ?? 0;
    if (!Number.isSafeInteger(cents) || cents < 0) return { ok: false, error: "Amounts must be zero or more, in cents." };
    shares.push({ memberId: id, cents });
  }
  const sum = shares.reduce((total, share) => total + share.cents, 0);
  if (sum !== totalCents) {
    return { ok: false, error: sum < totalCents ? `Amounts are ${dollars(totalCents - sum)} short of ${dollars(totalCents)}.` : `Amounts are ${dollars(sum - totalCents)} over ${dollars(totalCents)}.` };
  }
  return { ok: true, shares };
}

/**
 * By item: each item is split equally among its members (all participants when none
 * are set). Any difference from the total (tax, fees, discounts) is shared in
 * proportion to each member's item subtotal.
 */
export function splitByItem(totalCents: number, participantIds: readonly string[], items: readonly BillItem[]): SplitResult {
  if (!items.length) return { ok: false, error: "This bill has no line items to split." };
  const participants = unique(participantIds);
  const subtotals = new Map<string, number>();
  let itemSum = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.cents) || item.cents < 0) return { ok: false, error: "Item amounts must be zero or more." };
    const members = unique(item.memberIds?.length ? item.memberIds : participants);
    if (!members.length) return { ok: false, error: `Pick who shares “${item.description}”.` };
    itemSum += item.cents;
    for (const share of splitEqual(item.cents, members)) subtotals.set(share.memberId, (subtotals.get(share.memberId) ?? 0) + share.cents);
  }
  if (itemSum > totalCents) return { ok: false, error: `Items add up to ${dollars(itemSum)}, more than the ${dollars(totalCents)} total.` };
  const order = unique([...participants, ...subtotals.keys()]);
  const extra = totalCents - itemSum;
  const extraShares = new Map<string, number>();
  if (extra > 0) {
    const weighted = itemSum > 0
      ? splitWeighted(extra, order.filter((id) => (subtotals.get(id) ?? 0) > 0).map((id) => ({ memberId: id, weight: (subtotals.get(id) ?? 0) / itemSum * 100 })))
      : { ok: true as const, shares: splitEqual(extra, participants) };
    if (!weighted.ok) return weighted;
    for (const share of weighted.shares) extraShares.set(share.memberId, share.cents);
  }
  return { ok: true, shares: order.map((id) => ({ memberId: id, cents: (subtotals.get(id) ?? 0) + (extraShares.get(id) ?? 0) })) };
}

export function computeSplit(totalCents: number, spec: SplitSpec): SplitResult {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return { ok: false, error: "Enter the bill total first." };
  if (totalCents > MAX_BILL_CENTS) return { ok: false, error: "That total is too large." };
  let result: SplitResult;
  switch (spec.mode) {
    case "equal":
      if (!spec.memberIds.length) return { ok: false, error: "Pick at least one person to split with." };
      result = { ok: true, shares: splitEqual(totalCents, spec.memberIds) };
      break;
    case "percent":
      result = splitWeighted(totalCents, unique(spec.memberIds).map((id) => ({ memberId: id, weight: spec.weights?.[id] ?? 0 })));
      break;
    case "exact":
      result = splitExact(totalCents, spec.memberIds, spec.amounts ?? {});
      break;
    case "item":
      result = splitByItem(totalCents, spec.memberIds, spec.items ?? []);
      break;
    default:
      return { ok: false, error: "Unknown split mode." };
  }
  if (result.ok) {
    const sum = result.shares.reduce((total, share) => total + share.cents, 0);
    if (sum !== totalCents) return { ok: false, error: "Shares don’t add up to the total." };
  }
  return result;
}

/**
 * Fewest practical transfers that settle net balances (+ is owed money, − owes).
 * Exact opposite pairs settle first; then the largest debtor pays the largest
 * creditor. Deterministic (ties by member id). At most n−1 transfers.
 */
export function simplifyDebts(net: ReadonlyArray<{ memberId: string; cents: number }>): Transfer[] {
  const byId = (a: { memberId: string }, b: { memberId: string }) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);
  const creditors = net.filter((entry) => entry.cents > 0).map((entry) => ({ ...entry })).sort(byId);
  const debtors = net.filter((entry) => entry.cents < 0).map((entry) => ({ memberId: entry.memberId, cents: -entry.cents })).sort(byId);
  const transfers: Transfer[] = [];
  for (const debtor of debtors) {
    const match = creditors.find((creditor) => creditor.cents === debtor.cents && creditor.cents > 0);
    if (match && debtor.cents > 0) {
      transfers.push({ from: debtor.memberId, to: match.memberId, cents: debtor.cents });
      match.cents = 0;
      debtor.cents = 0;
    }
  }
  for (;;) {
    const debtor = debtors.filter((entry) => entry.cents > 0).sort((a, b) => b.cents - a.cents || byId(a, b))[0];
    const creditor = creditors.filter((entry) => entry.cents > 0).sort((a, b) => b.cents - a.cents || byId(a, b))[0];
    if (!debtor || !creditor) break;
    const cents = Math.min(debtor.cents, creditor.cents);
    transfers.push({ from: debtor.memberId, to: creditor.memberId, cents });
    debtor.cents -= cents;
    creditor.cents -= cents;
  }
  return transfers;
}

/** Browser copy of computeSplit (plain JS, same rounding). Defines window.BillSplit. */
export const CLIENT_SPLIT_JS = String.raw`
(function () {
  function uniq(ids) { return Array.from(new Set(ids)); }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function equal(total, ids) {
    ids = uniq(ids);
    if (!ids.length) return [];
    var base = Math.floor(total / ids.length), rem = total - base * ids.length, extra = {};
    ids.slice().sort().forEach(function (id) { extra[id] = rem > 0 ? 1 : 0; if (rem > 0) rem -= 1; });
    return ids.map(function (id) { return { memberId: id, cents: base + extra[id] }; });
  }
  function weighted(total, weights) {
    var seen = {}, scaled = [];
    for (var i = 0; i < weights.length; i += 1) {
      var e = weights[i];
      if (seen[e.memberId]) continue;
      seen[e.memberId] = true;
      if (!isFinite(e.weight) || e.weight < 0 || e.weight > 10000) return { ok: false, error: "Each share must be a number between 0 and 10,000." };
      scaled.push({ memberId: e.memberId, w: Math.round(e.weight * 10000) });
    }
    var sum = scaled.reduce(function (t, e) { return t + e.w; }, 0);
    if (!scaled.length || sum <= 0) return { ok: false, error: "Give at least one person a share." };
    var rows = scaled.map(function (e) { var p = total * e.w; return { memberId: e.memberId, cents: Math.floor(p / sum), rem: p % sum }; });
    var left = total - rows.reduce(function (t, r) { return t + r.cents; }, 0);
    rows.slice().sort(function (a, b) { return b.rem - a.rem || cmp(a.memberId, b.memberId); }).forEach(function (r) { if (left > 0) { r.cents += 1; left -= 1; } });
    return { ok: true, shares: rows.map(function (r) { return { memberId: r.memberId, cents: r.cents }; }) };
  }
  function exact(total, ids, amounts) {
    ids = uniq(ids);
    var shares = [];
    for (var i = 0; i < ids.length; i += 1) {
      var c = amounts[ids[i]] || 0;
      if (!Number.isSafeInteger(c) || c < 0) return { ok: false, error: "Amounts must be zero or more." };
      shares.push({ memberId: ids[i], cents: c });
    }
    var sum = shares.reduce(function (t, s) { return t + s.cents; }, 0);
    if (sum !== total) return { ok: false, error: sum < total ? "short" : "over", diff: total - sum, shares: shares };
    return { ok: true, shares: shares };
  }
  function byItem(total, ids, items) {
    if (!items.length) return { ok: false, error: "This bill has no line items to split." };
    var participants = uniq(ids), sub = {}, order = participants.slice(), itemSum = 0;
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i], members = uniq(it.memberIds && it.memberIds.length ? it.memberIds : participants);
      if (!members.length) return { ok: false, error: "Pick who shares " + it.description + "." };
      itemSum += it.cents;
      equal(it.cents, members).forEach(function (s) { if (!(s.memberId in sub)) sub[s.memberId] = 0; sub[s.memberId] += s.cents; if (order.indexOf(s.memberId) < 0) order.push(s.memberId); });
    }
    if (itemSum > total) return { ok: false, error: "Items add up to more than the total." };
    var extra = total - itemSum, extraShares = {};
    if (extra > 0) {
      var w = itemSum > 0
        ? weighted(extra, order.filter(function (id) { return (sub[id] || 0) > 0; }).map(function (id) { return { memberId: id, weight: (sub[id] || 0) / itemSum * 100 }; }))
        : { ok: true, shares: equal(extra, participants) };
      if (!w.ok) return w;
      w.shares.forEach(function (s) { extraShares[s.memberId] = s.cents; });
    }
    return { ok: true, shares: order.map(function (id) { return { memberId: id, cents: (sub[id] || 0) + (extraShares[id] || 0) }; }) };
  }
  function compute(total, spec) {
    if (!Number.isSafeInteger(total) || total <= 0) return { ok: false, error: "Enter the bill total first." };
    if (spec.mode === "equal") return spec.memberIds.length ? { ok: true, shares: equal(total, spec.memberIds) } : { ok: false, error: "Pick at least one person." };
    if (spec.mode === "percent") return weighted(total, uniq(spec.memberIds).map(function (id) { return { memberId: id, weight: (spec.weights || {})[id] || 0 }; }));
    if (spec.mode === "exact") return exact(total, spec.memberIds, spec.amounts || {});
    if (spec.mode === "item") return byItem(total, spec.memberIds, spec.items || []);
    return { ok: false, error: "Unknown split mode." };
  }
  window.BillSplit = { compute: compute, equal: equal };
})();
`;
