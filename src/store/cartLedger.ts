import { randomUUID } from "node:crypto";
import {
  CATALOG,
  extractCartRequests,
  isGenericMilkRequest,
  money,
  resolveMilkChoice,
  unsupportedBrandedRequest,
  type Product,
} from "../cart.js";
import type { StoreContext, StoreModules } from "./context.js";
import type { CartSnapshot, ItemRow } from "./types.js";

/** The shared cart: items, splits, undo history, clearing, removal, approvals, and demo catalog adds. */
export class CartLedger {
  constructor(private readonly ctx: StoreContext, private readonly m: StoreModules) {}

  snapshot(): CartSnapshot {
    const household = this.ctx.db.prepare(
      "SELECT revision, budget_cents, checked_out_revision FROM households WHERE id = ?",
    ).get(this.ctx.householdId) as { revision: number; budget_cents: number; checked_out_revision: number | null };
    const members = this.ctx.getMembers();
    const products = new Map(CATALOG.map((product) => [product.id, product]));
    const memberNames = new Map(members.map((member) => [member.id, member.name]));
    const rows = this.ctx.db.prepare(
      "SELECT id, product_id, quantity, owner_id, participants_json, product_name, unit_price_cents, price_source, upc FROM cart_items WHERE household_id = ? ORDER BY created_at, id",
    ).all(this.ctx.householdId) as ItemRow[];
    const shares = new Map(members.map((member) => [member.id, 0]));
    let totalCents = 0;
    const items = rows.flatMap((row) => {
      const product = products.get(row.product_id);
      const productName = row.product_name ?? product?.name;
      const unitPriceCents = row.unit_price_cents ?? product?.priceCents;
      if (!productName || unitPriceCents === undefined) return [];
      const itemTotal = unitPriceCents * row.quantity;
      totalCents += itemTotal;
      const participantIds = JSON.parse(row.participants_json) as string[];
      this.split(itemTotal, participantIds).forEach((amount, id) => {
        shares.set(id, (shares.get(id) ?? 0) + amount);
      });
      return [{
        id: row.id,
        productId: row.product_id,
        name: productName,
        quantity: row.quantity,
        unitPriceCents,
        totalCents: itemTotal,
        priceSource: row.price_source === "kroger" ? "kroger" as const : "sample" as const,
        upc: row.upc,
        ownerId: row.owner_id,
        ownerName: memberNames.get(row.owner_id) ?? "Member",
        participantIds,
        participantNames: participantIds.map((id) => memberNames.get(id) ?? "Member")
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
      }];
    });
    const approved = new Set((this.ctx.db.prepare(
      "SELECT member_id FROM approvals WHERE household_id = ? AND revision = ?",
    ).all(this.ctx.householdId, household.revision) as Array<{ member_id: string }>).map((row) => row.member_id));

    return {
      householdId: this.ctx.householdId,
      revision: household.revision,
      budgetCents: household.budget_cents,
      totalCents,
      items,
      members: members.map((member) => ({
        ...member,
        shareCents: shares.get(member.id) ?? 0,
        approved: approved.has(member.id),
      })),
      sharingSessions: this.m.sharing.activeSessions().map((session) => ({
        id: session.id,
        participantIds: session.participantIds,
        participantNames: session.participantIds.map((id) => memberNames.get(id) ?? "Member")
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
        startedAt: session.startedAt,
      })),
      checkedOutRevision: household.checked_out_revision,
    };
  }

  split(totalCents: number, participantIds: string[]): Map<string, number> {
    const unique = [...new Set(participantIds)].sort();
    const result = new Map<string, number>();
    if (unique.length === 0) return result;
    const base = Math.floor(totalCents / unique.length);
    let remainder = totalCents - base * unique.length;
    for (const id of unique) {
      result.set(id, base + (remainder > 0 ? 1 : 0));
      remainder -= remainder > 0 ? 1 : 0;
    }
    return result;
  }

  formatSummary(memberId: string, addedNames: string[] = [], participantIds: string[] = [memberId]): string {
    const snapshot = this.snapshot();
    const mine = snapshot.members.find((member) => member.id === memberId);
    const lines = snapshot.items.slice(-8).map((item) =>
      `• ${item.quantity} × ${item.name} — ${money(item.totalCents)} (${item.priceSource === "kroger" ? "Kroger" : "sample"}; ${item.participantNames.length > 1 ? `shared: ${item.participantNames.join(", ")}` : `for ${item.ownerName}`})`,
    );
    const shares = snapshot.members.map((member) => `${member.name}: ${money(member.shareCents)}`).join(" · ");
    const prefix = addedNames.length
      ? `Added ${addedNames.join(", ")} ${participantIds.length > 1 ? this.m.sharing.assignmentPhrase(participantIds) : `for ${mine?.name ?? "you"}`}.\n`
      : "";
    const session = this.m.sharing.activeSessionFor(memberId);
    const sessionNote = session
      ? `\nSharing session on: ${this.ctx.joinNames(this.ctx.memberNames(session.participantIds))}. Text “stop sharing” to end it.`
      : "";
    const budgetNote = snapshot.totalCents > snapshot.budgetCents
      ? `\nOver the ${money(snapshot.budgetCents)} sample budget by ${money(snapshot.totalCents - snapshot.budgetCents)}.`
      : `\nWithin the ${money(snapshot.budgetCents)} sample budget.`;
    const priceNote = snapshot.items.some((item) => item.priceSource === "kroger")
      ? "Kroger prices are store-specific when a location is configured; sample items are marked."
      : "sample catalog prices";
    return `${prefix}Cart revision ${snapshot.revision} · ${priceNote}\n${lines.join("\n")}\nTotal: ${money(snapshot.totalCents)}\n${shares}${budgetNote}${sessionNote}\nText “cart”, “approve”, or “checkout”.`;
  }

  captureCartItems(): string {
    const items = this.ctx.db.prepare(
      "SELECT id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc FROM cart_items WHERE household_id = ? ORDER BY created_at, id",
    ).all(this.ctx.householdId);
    return JSON.stringify(items);
  }

  /**
   * Apply `mutate` as one cart change: snapshot for undo, change the lines, bump the revision (which voids
   * approvals), and record one undo step. Returns the new revision. Caller holds the transaction.
   */
  commitChange(memberId: string, action: string, mutate: () => void): number {
    const undoSnapshot = this.captureCartItems();
    mutate();
    this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?").run(this.ctx.householdId);
    this.recordUndo(memberId, action, undoSnapshot);
    return (this.ctx.db.prepare("SELECT revision FROM households WHERE id = ?").get(this.ctx.householdId) as { revision: number }).revision;
  }

  /** True when the household cart has no lines. */
  isEmpty(): boolean {
    return !this.ctx.db.prepare("SELECT 1 FROM cart_items WHERE household_id = ? LIMIT 1").get(this.ctx.householdId);
  }

  recordUndo(memberId: string, action: string, itemsJson: string): void {
    const row = this.ctx.db.prepare("SELECT revision FROM households WHERE id = ?")
      .get(this.ctx.householdId) as { revision: number };
    this.ctx.db.prepare(
      "INSERT INTO cart_undo_history (id, household_id, actor_id, action, revision_after, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), this.ctx.householdId, memberId, action, row.revision, itemsJson, new Date().toISOString());
    this.ctx.db.prepare(
      "DELETE FROM cart_undo_history WHERE id IN (SELECT id FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT -1 OFFSET 20)",
    ).run(this.ctx.householdId);
  }

  addRequests(memberId: string, requests: Array<{ product: Product; quantity: number }>): string[] {
    const member = this.ctx.db.prepare(
      "SELECT id FROM members WHERE household_id = ? AND id = ?",
    ).get(this.ctx.householdId, memberId);
    if (!member) throw new Error("Sender is not a configured household member.");

    const undoSnapshot = this.captureCartItems();
    const participantIds = this.m.sharing.participantsFor(memberId);
    const newRevision = this.snapshot().revision + 1;
    const insert = this.ctx.db.prepare(
      "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const request of requests) {
      insert.run(randomUUID(), this.ctx.householdId, request.product.id, request.quantity, memberId, JSON.stringify(participantIds), new Date().toISOString());
    }
    this.ctx.db.prepare(
      "UPDATE households SET revision = ?, checked_out_revision = NULL WHERE id = ?",
    ).run(newRevision, this.ctx.householdId);
    this.recordUndo(memberId, `add ${requests.map(({ product }) => product.name).join(", ")}`, undoSnapshot);
    return participantIds;
  }

  clearMemberItems(memberId: string): string {
    const snapshot = this.snapshot();
    const mine = snapshot.items.filter((item) => item.participantIds.includes(memberId));
    if (!mine.length) return "You don’t have any items or shares in the cart to clear.";
    const undoSnapshot = this.captureCartItems();
    for (const item of mine) {
      if (item.participantIds.length <= 1) {
        this.ctx.db.prepare("DELETE FROM cart_items WHERE id = ?").run(item.id);
      } else {
        const remaining = item.participantIds.filter((id) => id !== memberId);
        const ownerId = item.ownerId === memberId ? remaining[0]! : item.ownerId;
        this.ctx.db.prepare("UPDATE cart_items SET participants_json = ?, owner_id = ? WHERE id = ?")
          .run(JSON.stringify(remaining), ownerId, item.id);
      }
    }
    this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
      .run(this.ctx.householdId);
    const memberName = this.ctx.getMembers().find((member) => member.id === memberId)?.name ?? "your";
    this.recordUndo(memberId, `clear ${memberName}'s items and shares`, undoSnapshot);
    return `Cleared ${mine.length} item${mine.length === 1 ? "" : "s"} assigned to you. Other members’ shares remain.\n${this.formatSummary(memberId)}`;
  }

  hasPendingClearAll(memberId: string): boolean {
    return Boolean(this.ctx.db.prepare("SELECT 1 FROM pending_cart_clears WHERE member_id = ?")
      .get(memberId));
  }

  requestClearAll(memberId: string): string {
    const snapshot = this.snapshot();
    if (!snapshot.items.length) return "The shared cart is already empty.";
    this.ctx.db.prepare(
      "INSERT INTO pending_cart_clears (member_id, requested_revision, created_at) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET requested_revision = excluded.requested_revision, created_at = excluded.created_at",
    ).run(memberId, snapshot.revision, new Date().toISOString());
    return `This will clear all ${snapshot.items.length} item lines (${money(snapshot.totalCents)}) for everyone. Reply “confirm clear all” to proceed, or “cancel clear all” to leave it unchanged. You can “undo” afterward.`;
  }

  confirmClearAll(memberId: string): string {
    const pending = this.ctx.db.prepare(
      "SELECT requested_revision FROM pending_cart_clears WHERE member_id = ?",
    ).get(memberId) as { requested_revision: number } | undefined;
    if (!pending) return "There isn’t a pending clear-all request. Text “clear all” first if you want to empty the shared cart.";
    const snapshot = this.snapshot();
    if (pending.requested_revision !== snapshot.revision) {
      this.ctx.db.prepare("UPDATE pending_cart_clears SET requested_revision = ?, created_at = ? WHERE member_id = ?")
        .run(snapshot.revision, new Date().toISOString(), memberId);
      return `The cart changed since you asked. It now has ${snapshot.items.length} item lines totaling ${money(snapshot.totalCents)}. Reply “confirm clear all” again to clear this updated cart, or “cancel clear all”.`;
    }
    this.ctx.db.prepare("DELETE FROM pending_cart_clears WHERE member_id = ?").run(memberId);
    if (!snapshot.items.length) return "The shared cart is already empty.";
    const undoSnapshot = this.captureCartItems();
    this.clearPendingCartIntents();
    this.ctx.db.prepare("DELETE FROM cart_items WHERE household_id = ?").run(this.ctx.householdId);
    this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
      .run(this.ctx.householdId);
    this.recordUndo(memberId, "clear the shared cart", undoSnapshot);
    return `Cleared the shared cart for everyone. Text “undo” to restore it.\n${this.formatSummary(memberId)}`;
  }

  undoLastCartChange(memberId: string): string {
    const last = this.ctx.db.prepare(
      "SELECT id, actor_id, action, revision_after, items_json FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(this.ctx.householdId) as { id: string; actor_id: string; action: string; revision_after: number; items_json: string } | undefined;
    if (!last) return "There isn’t a recent cart change to undo.";
    const current = this.snapshot();
    if (last.revision_after !== current.revision) {
      return "I can’t safely undo that because the cart changed afterward. Make a new change and you can undo that latest change instead.";
    }
    const items = JSON.parse(last.items_json) as Array<{
      id: string; household_id: string; product_id: string; quantity: number; owner_id: string;
      participants_json: string; created_at: string; product_name: string | null;
      unit_price_cents: number | null; price_source: string | null; upc: string | null;
    }>;
    this.ctx.db.prepare("DELETE FROM cart_items WHERE household_id = ?").run(this.ctx.householdId);
    const insert = this.ctx.db.prepare(
      "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of items) {
      insert.run(item.id, item.household_id, item.product_id, item.quantity, item.owner_id,
        item.participants_json, item.created_at, item.product_name, item.unit_price_cents,
        item.price_source, item.upc);
    }
    this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
      .run(this.ctx.householdId);
    const nextRevision = this.snapshot().revision;
    this.ctx.db.prepare("DELETE FROM cart_undo_history WHERE id = ?").run(last.id);
    this.m.lists.revertListLoad(last.id);
    this.ctx.db.prepare(
      "UPDATE cart_undo_history SET revision_after = ? WHERE id = (SELECT id FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT 1)",
    ).run(nextRevision, this.ctx.householdId);
    const actorName = this.ctx.getMembers().find((member) => member.id === last.actor_id)?.name ?? "a household member";
    return `Undid ${actorName}’s last change (${last.action}).\n${this.formatSummary(memberId)}`;
  }

  clearPendingCartIntents(): void {
    const memberIds = "SELECT id FROM members WHERE household_id = ?";
    this.ctx.db.prepare(`DELETE FROM pending_product_choices WHERE member_id IN (${memberIds})`).run(this.ctx.householdId);
    this.ctx.db.prepare(`DELETE FROM pending_product_batches WHERE member_id IN (${memberIds})`).run(this.ctx.householdId);
    this.ctx.db.prepare(`DELETE FROM pending_item_cancellations WHERE member_id IN (${memberIds})`).run(this.ctx.householdId);
    this.ctx.db.prepare(`DELETE FROM pending_clarifications WHERE member_id IN (${memberIds})`).run(this.ctx.householdId);
    this.ctx.db.prepare(`DELETE FROM pending_cart_clears WHERE member_id IN (${memberIds})`).run(this.ctx.householdId);
  }

  startItemCancellation(messageId: string, memberId: string, query: string): string {
    const snapshot = this.snapshot();
    const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matching = snapshot.items.filter((item) => {
      const name = item.name.toLocaleLowerCase();
      return tokens.every((token) => name.includes(token));
    });
    const eligible = matching.filter((item) => item.participantIds.includes(memberId));
    if (!eligible.length) {
      const reply = matching.length
        ? "That item is in the cart, but it isn’t assigned to you, so I left it unchanged. Ask the person who added it to remove it or change the share."
        : `I couldn’t find “${query}” in the cart, so nothing was removed. Text “cart” to review the current items.`;
      this.ctx.saveMessageReply(messageId, reply);
      return reply;
    }
    if (eligible.length > 1) {
      this.ctx.db.exec("BEGIN IMMEDIATE");
      try {
        this.ctx.db.prepare(
          "INSERT INTO pending_item_cancellations (member_id, item_ids_json, query, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET item_ids_json = excluded.item_ids_json, query = excluded.query, created_at = excluded.created_at",
        ).run(memberId, JSON.stringify(eligible.map((item) => item.id)), query, new Date().toISOString());
        this.ctx.db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
        const options = eligible.map((item, index) => `${index + 1}) ${item.name} — ${money(item.totalCents)} (${item.participantNames.length > 1 ? `shared by ${item.participantNames.join(", ")}` : `for ${item.ownerName}`})`);
        const reply = `Which “${query}” would you like to remove?\n${options.join("\n")}\nReply 1-${eligible.length}, or “cancel”. For a shared item, this removes only your share.`;
        this.ctx.recordReply(messageId, reply);
        this.ctx.db.exec("COMMIT");
        return reply;
      } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
    }
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      this.ctx.db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
      const result = this.removeParticipant(eligible[0]!.id, memberId);
      const reply = `${result}\n${this.formatSummary(memberId)}`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }

  removeParticipant(itemId: string, memberId: string): string {
    const row = this.ctx.db.prepare(
      "SELECT id, product_name, product_id, owner_id, participants_json FROM cart_items WHERE id = ? AND household_id = ?",
    ).get(itemId, this.ctx.householdId) as { id: string; product_name: string | null; product_id: string; owner_id: string; participants_json: string } | undefined;
    if (!row) return "That cart item is no longer there; nothing else was changed.";
    const participants = JSON.parse(row.participants_json) as string[];
    if (!participants.includes(memberId)) return "Your share was already removed; the cart is unchanged.";
    const productName = row.product_name ?? CATALOG.find((product) => product.id === row.product_id)?.name ?? "item";
    const undoSnapshot = this.captureCartItems();
    if (participants.length <= 1) {
      this.ctx.db.prepare("DELETE FROM cart_items WHERE id = ?").run(itemId);
      this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?").run(this.ctx.householdId);
      this.recordUndo(memberId, `remove ${productName}`, undoSnapshot);
      return `Removed ${productName} from your cart.`;
    }
    const remaining = participants.filter((id) => id !== memberId);
    const newOwnerId = row.owner_id === memberId ? remaining[0]! : row.owner_id;
    this.ctx.db.prepare("UPDATE cart_items SET participants_json = ?, owner_id = ? WHERE id = ?")
      .run(JSON.stringify(remaining), newOwnerId, itemId);
    this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?").run(this.ctx.householdId);
    this.recordUndo(memberId, `withdraw your share of ${productName}`, undoSnapshot);
    const names = this.ctx.getMembers().filter((member) => remaining.includes(member.id)).map((member) => member.name);
    return `Removed your share of ${productName}; ${names.join(" and ")} still ${names.length === 1 ? "has" : "have"} it.`;
  }

  clearClarification(memberId: string): void {
    this.ctx.db.prepare("DELETE FROM pending_clarifications WHERE member_id = ?").run(memberId);
  }

  approveCurrentRevision(memberId: string): string {
    const snapshot = this.snapshot();
    if (!snapshot.items.length) return "There isn’t a cart to approve yet. Text a grocery request first.";
    if (!snapshot.members.some((member) => member.id === memberId)) return "That member isn’t in this household cart.";
    this.ctx.db.prepare(
      "INSERT OR IGNORE INTO approvals (household_id, revision, member_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(this.ctx.householdId, snapshot.revision, memberId, new Date().toISOString());
    const updated = this.snapshot();
    const pending = updated.members.filter((member) => !member.approved).map((member) => member.name);
    return pending.length
      ? `Your approval is saved for cart revision ${updated.revision}. Waiting for: ${pending.join(", ")}. Any cart change will require approvals again.`
      : this.ctx.krogerCartEnabled
        ? this.m.checkout.hasOpenReview()
          ? `Everyone approved cart revision ${updated.revision}. The availability review is still open; text “checkout” to see the choices. Applying them will require fresh approvals.`
          : `Everyone approved cart revision ${updated.revision}. Text “checkout” to check store availability before choosing a Kroger account.`
        : `Everyone approved cart revision ${updated.revision}. Text “checkout” to finish a simulated checkout.`;
  }

  completeMockCheckout(payerMemberId?: string): string {
    const snapshot = this.snapshot();
    if (!snapshot.items.length) return "There isn’t a cart to check out yet.";
    const pending = snapshot.members.filter((member) => !member.approved).map((member) => member.name);
    if (pending.length) return `Checkout is waiting for approval from: ${pending.join(", ")}. No payment has been made.`;
    this.ctx.db.prepare("DELETE FROM cart_items WHERE household_id = ?").run(this.ctx.householdId);
    this.clearPendingCartIntents();
    // Checkout closes this list rather than leaving it as the starting point for
    // the next trip. Old approvals and undo entries must not carry forward.
    this.ctx.db.prepare("DELETE FROM cart_undo_history WHERE household_id = ?").run(this.ctx.householdId);
    this.ctx.db.prepare(
      "UPDATE households SET revision = revision + 1, checked_out_revision = ? WHERE id = ?",
    ).run(snapshot.revision, this.ctx.householdId);
    const reply = `Mock checkout complete for ${money(snapshot.totalCents)}. No payment was charged. The cart is cleared for your next list.`;
    // Splitwise: demo checkouts are always simulated (no network), so the summary is ready now.
    const splitwiseNote = this.m.splitwise.summary(this.m.splitwise.recordCheckout(snapshot, payerMemberId, "mock"));
    return splitwiseNote ? `${reply}\n\n${splitwiseNote}` : reply;
  }

  /** Reply to a pending “which one should I remove?” question. */
  continueItemCancellation(
    messageId: string,
    memberId: string,
    normalized: string,
    pendingCancellation: { item_ids_json: string; query: string },
  ): string {
    if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
      this.ctx.db.exec("BEGIN IMMEDIATE");
      try {
        this.ctx.db.prepare("DELETE FROM pending_item_cancellations WHERE member_id = ?").run(memberId);
        const reply = "Okay, I left the cart unchanged.";
        this.ctx.recordReply(messageId, reply);
        this.ctx.db.exec("COMMIT");
        return reply;
      } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
    }
    const selection = normalized.match(/^\s*(\d{1,2})\s*$/);
    const itemIds = JSON.parse(pendingCancellation.item_ids_json) as string[];
    const index = Number(selection?.[1]) - 1;
    if (!selection || index < 0 || index >= itemIds.length) {
      return `Please reply with a number from 1 to ${itemIds.length}, or “cancel”. Nothing has been removed yet.`;
    }
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      this.ctx.db.prepare("DELETE FROM pending_item_cancellations WHERE member_id = ?").run(memberId);
      const result = this.removeParticipant(itemIds[index]!, memberId);
      const reply = `${result}\n${this.formatSummary(memberId)}`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }

  /** Demo mode: add sample-catalog items, asking which milk first when needed. Caller holds the transaction. */
  catalogItemText(memberId: string, normalized: string): string {
    let reply: string;
    const pending = this.ctx.db.prepare(
      "SELECT kind, original_text FROM pending_clarifications WHERE member_id = ?",
    ).get(memberId) as { kind: string; original_text: string } | undefined;
    if (pending?.kind === "milk") {
      if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
        this.clearClarification(memberId);
        reply = "Okay, I didn’t add any milk.";
      } else if (unsupportedBrandedRequest(normalized)) {
        const productName = unsupportedBrandedRequest(normalized)!;
        this.clearClarification(memberId);
        reply = `I heard “${productName}”, but live product lookup isn’t connected yet. I didn’t add a substitute or invent a live price.`;
      } else {
        const product = resolveMilkChoice(normalized);
        if (!product) {
          reply = "Which kind? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond milk. You can also say “cancel”. After you choose, I’ll look up matching store products if live search is configured.";
        } else {
          this.clearClarification(memberId);
          const companionRequests = extractCartRequests(pending.original_text);
          const requests = [{ product, quantity: 1 }, ...companionRequests];
          const participantIds = this.addRequests(memberId, requests);
          reply = this.formatSummary(memberId, requests.map(({ product: added }) => added.name), participantIds);
        }
      }
    } else if (unsupportedBrandedRequest(normalized)) {
      const productName = unsupportedBrandedRequest(normalized)!;
      reply = `I heard “${productName}”, but live product lookup isn’t connected yet. I didn’t substitute generic eggs or a made-up live price. Reply “generic eggs” to add the sample catalog item, or leave it for now.`;
    } else if (isGenericMilkRequest(normalized)) {
      this.ctx.db.prepare(
        "INSERT INTO pending_clarifications (member_id, kind, original_text, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET kind = excluded.kind, original_text = excluded.original_text, created_at = excluded.created_at",
      ).run(memberId, "milk", normalized, new Date().toISOString());
      reply = "What kind of milk? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond. You can also type the kind you want, and I’ll look up matching store products.";
    } else {
      const requests = extractCartRequests(normalized);
      if (requests.length === 0) {
        reply = `I couldn’t match that to our sample catalog. Try milk, oat milk, eggs, bananas, pasta, tomato sauce, parmesan, bread, apples, or peanut butter. Text “help” to see examples and commands, or “cart” to review your basket.`;
      } else {
        const participantIds = this.addRequests(memberId, requests);
        reply = `${this.formatSummary(memberId, requests.map(({ product }) => product.name), participantIds)}${this.m.sharing.legacyShareHint(normalized, memberId)}`;
      }
    }
    return reply;
  }
}
