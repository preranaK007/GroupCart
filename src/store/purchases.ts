import { randomUUID } from "node:crypto";
import { money } from "../cart.js";
import type { StoreContext, StoreModules } from "./context.js";
import type { CartSnapshot } from "./types.js";

export const PURCHASE_COMMAND_PATTERN = /^(?:purchases?(?:[.!?]*$|\s)|(?:confirm|cancel) purchase(?:\s|$))/i;
type Purchase = {
  id: string; payer_member_id: string; snapshot_json: string;
  status: "awaiting_total" | "awaiting_confirmation" | "confirmed" | "cancelled";
  total_cents: number | null;
};

/** Allocate from exact per-item shares, rounding only the final receipt so earlier residual cents do not grow. */
export function receiptShares(snapshot: CartSnapshot, total: number): Map<string, number> {
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(snapshot.totalCents) || snapshot.totalCents <= 0) {
    throw new Error("A purchase needs a positive receipt total and quoted total.");
  }
  if (snapshot.members.some((member) => !Number.isSafeInteger(member.shareCents) || member.shareCents < 0)
    || snapshot.members.reduce((sum, member) => sum + member.shareCents, 0) !== snapshot.totalCents) {
    throw new Error("The quoted shares do not match the quoted total.");
  }
  const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;
  const participants = snapshot.items.map((item) => [...new Set(item.participantIds)]);
  const memberIds = new Set(snapshot.members.map((member) => member.id));
  if (snapshot.items.reduce((sum, item) => sum + item.totalCents, 0) !== snapshot.totalCents
    || snapshot.items.some((item) => !Number.isSafeInteger(item.totalCents) || item.totalCents < 0)
    || participants.some((ids) => !ids.length || ids.some((id) => !memberIds.has(id)))) {
    throw new Error("The saved grocery items do not match the quoted total or participants.");
  }
  const scale = participants.reduce((multiple, ids) => {
    const count = BigInt(ids.length);
    return multiple / gcd(multiple, count) * count;
  }, 1n);
  const weights = new Map(snapshot.members.map((member) => [member.id, 0n]));
  for (const [index, item] of snapshot.items.entries()) {
    const ids = participants[index]!;
    const share = BigInt(item.totalCents) * scale / BigInt(ids.length);
    for (const id of ids) weights.set(id, weights.get(id)! + share);
  }
  const denominator = BigInt(snapshot.totalCents) * scale;
  const rows = snapshot.members.map((member) => {
    const weighted = BigInt(total) * weights.get(member.id)!;
    return { id: member.id, cents: Number(weighted / denominator), remainder: weighted % denominator };
  });
  let remaining = total - rows.reduce((sum, row) => sum + row.cents, 0);
  rows.sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
  for (const row of rows) if (remaining > 0) { row.cents++; remaining--; }
  return new Map(rows.map((row) => [row.id, row.cents]));
}

/** A cart transfer is only a draft. Only the shopper can confirm an actual paid total for Splitwise. */
export class Purchases {
  constructor(private readonly ctx: StoreContext, private readonly m: StoreModules) {}

  /** Caller holds the transfer transaction. No money is logged here. */
  stage(snapshot: CartSnapshot, payerId: string): string {
    const purchaseId = randomUUID().slice(0, 8);
    this.ctx.db.prepare("INSERT INTO grocery_purchases (id, household_id, revision, payer_member_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(purchaseId, this.ctx.householdId, snapshot.revision, payerId, JSON.stringify(snapshot), this.ctx.now().toISOString());
    return `Purchase ${purchaseId} is awaiting the actual paid total; nothing was logged to Splitwise. After ordering in Kroger, the shopper texts “purchase ${purchaseId} total $12.34” with the receipt total, then reviews and confirms the split. If you do not order, text “cancel purchase ${purchaseId}”.`;
  }

  status(): string {
    const rows = this.ctx.db.prepare("SELECT * FROM grocery_purchases WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10")
      .all(this.ctx.householdId) as Purchase[];
    if (!rows.length) return "No grocery purchases yet. Sending a cart to Kroger creates a draft; only a confirmed paid total creates an expense.";
    return rows.map((row) => {
      const snapshot = JSON.parse(row.snapshot_json) as CartSnapshot;
      const payer = snapshot.members.find((member) => member.id === row.payer_member_id)?.name ?? "the shopper";
      const total = row.total_cents === null ? `quote ${money(snapshot.totalCents)}` : `receipt ${money(row.total_cents)}`;
      return `Purchase ${row.id} · ${payer} · ${total} · ${row.status.replaceAll("_", " ")}`;
    }).join("\n") + '\nThe shopper enters “purchase <id> total $12.34”, then “confirm purchase <id>”. “cancel purchase <id>” discards an unconfirmed draft.';
  }

  async handle(messageId: string, memberId: string, text: string): Promise<string | null> {
    const existing = this.ctx.existingReply(messageId);
    if (existing !== undefined) return existing;
    let checkoutKey: string | undefined;
    const reply = this.ctx.transactReply(messageId, () => {
      if (/^purchases?[.!?]*$/i.test(text)) return this.status();
      const totalMatch = text.match(/^purchase\s+([a-f0-9]{8})\s+total\s+\$(\d{1,6})(?:\.(\d{2}))?[.!?]*$/i);
      const actionMatch = text.match(/^(confirm|cancel) purchase\s+([a-f0-9]{8})[.!?]*$/i);
      if (!totalMatch && !actionMatch) return 'Use “purchases”, “purchase <id> total $12.34”, “confirm purchase <id>”, or “cancel purchase <id>”.';
      const id = (totalMatch?.[1] ?? actionMatch?.[2])!.toLowerCase();
      const row = this.ctx.db.prepare("SELECT * FROM grocery_purchases WHERE id = ? AND household_id = ?").get(id, this.ctx.householdId) as Purchase | undefined;
      if (!row) return "That purchase was not found. Text “purchases” for the saved drafts.";
      if (row.payer_member_id !== memberId) return "Only the shopper whose Kroger account received this cart can enter or confirm its paid total.";
      if (row.status === "confirmed" || row.status === "cancelled") return `Purchase ${id} is already ${row.status}; nothing was changed.`;
      if (actionMatch?.[1]?.toLowerCase() === "cancel") {
        this.ctx.db.prepare("UPDATE grocery_purchases SET status = 'cancelled' WHERE id = ?").run(id);
        return `Discarded purchase ${id}. No expense was recorded. This does not cancel or refund an order in Kroger.`;
      }
      const snapshot = JSON.parse(row.snapshot_json) as CartSnapshot;
      if (totalMatch) {
        if (snapshot.totalCents <= 0) return "This draft has no positive quoted shares to scale. Record the receipt as a bill with the correct split instead.";
        const total = Number(totalMatch[2]) * 100 + Number(totalMatch[3] ?? 0);
        if (total <= 0) return "Enter the actual positive amount paid, including any fees, taxes, and discounts.";
        const shares = receiptShares(snapshot, total);
        this.ctx.db.prepare("UPDATE grocery_purchases SET total_cents = ?, status = 'awaiting_confirmation' WHERE id = ?").run(total, id);
        const split = snapshot.members.filter((member) => shares.get(member.id)).map((member) => `${member.name} ${money(shares.get(member.id)!)}`).join(" / ");
        return `Purchase ${id}: actual paid total ${money(total)}. Split: ${split}. This scales the approved grocery shares proportionally, including fees, taxes, and discounts. If substitutions changed who owes what, cancel this draft and record the receipt as a bill with the correct split. Nothing is logged yet. To confirm you paid this amount and accept this split, text “confirm purchase ${id}”.`;
      }
      if (row.status !== "awaiting_confirmation" || row.total_cents === null) return `Enter “purchase ${id} total $12.34” with the actual receipt total first.`;
      const shares = receiptShares(snapshot, row.total_cents);
      const confirmed: CartSnapshot = {
        ...snapshot, totalCents: row.total_cents,
        // Receipt detail is deliberately a total, rather than presenting quoted products as purchased lines.
        items: [],
        members: snapshot.members.map((member) => ({ ...member, shareCents: shares.get(member.id)! })),
      };
      checkoutKey = this.m.splitwise.recordCheckout(confirmed, memberId, "kroger");
      this.ctx.db.prepare("UPDATE grocery_purchases SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(this.ctx.now().toISOString(), id);
      return `Confirmed purchase ${id}: ${money(row.total_cents)} actually paid. ${checkoutKey ? "The receipt split is saved for Splitwise." : "The purchase is saved locally; Splitwise logging is not available."}`;
    });
    const note = await this.m.splitwise.finishCheckoutLog(checkoutKey);
    return note ? `${reply}\n${note}` : reply;
  }
}
