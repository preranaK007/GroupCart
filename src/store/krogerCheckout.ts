import type { KrogerCartAvailabilityIssue } from "../kroger.js";
import { money } from "../cart.js";
import type { StoreContext, StoreModules } from "./context.js";
import { currentPriceCents } from "./pricing.js";
import type { CartSnapshot, PendingKrogerCheckout } from "./types.js";

/**
 * Sending an approved cart to a member's Kroger cart: availability precheck,
 * explicit replacements, account choice, OAuth, and the final add. Never places an order.
 */
export class KrogerCheckout {
  constructor(private readonly ctx: StoreContext, private readonly m: StoreModules) {}

  getPendingKrogerCheckout(): { requesterId: string; revision: number; selectedMemberId: string | null; status: string } | undefined {
    const row = this.ctx.db.prepare(
      "SELECT requester_id, revision, selected_member_id, status FROM pending_kroger_checkouts WHERE household_id = ?",
    ).get(this.ctx.householdId) as { requester_id: string; revision: number; selected_member_id: string | null; status: string } | undefined;
    return row ? { requesterId: row.requester_id, revision: row.revision, selectedMemberId: row.selected_member_id, status: row.status } : undefined;
  }

  async startKrogerCheckout(
    messageId: string,
    memberId: string,
    locationId?: string,
    checkCartAvailability?: (items: Array<{ id: string; name: string; upc: string; quantity: number }>) => Promise<KrogerCartAvailabilityIssue[]>,
  ): Promise<string> {
    const snapshot = this.m.cart.snapshot();
    if (!snapshot.items.length) return this.ctx.saveAndReturnReply(messageId, "There isn’t a cart to send to Kroger yet.");
    const pendingApprovals = snapshot.members.filter((member) => !member.approved).map((member) => member.name);
    if (pendingApprovals.length) {
      return this.ctx.saveAndReturnReply(messageId, `Checkout is waiting for approval from: ${pendingApprovals.join(", ")}. Nothing was sent to Kroger.`);
    }
    const missingUpc = snapshot.items.find((item) => !item.upc);
    if (missingUpc) {
      return this.ctx.saveAndReturnReply(messageId, `“${missingUpc.name}” is a sample item without a Kroger UPC. Replace sample items with live Kroger selections before sending this list to Kroger.`);
    }
    const pending = this.getPendingKrogerCheckout();
    if (pending && pending.requesterId !== memberId) {
      const name = this.ctx.getMembers().find((member) => member.id === pending.requesterId)?.name ?? "another member";
      return this.ctx.saveAndReturnReply(messageId, `Kroger checkout is already being prepared by ${name}. Ask them to finish or text “cancel checkout”.`);
    }
    if (pending?.status === "awaiting_oauth" && pending.selectedMemberId) {
      const chosen = this.ctx.getMembers().find((member) => member.id === pending.selectedMemberId);
      const reply = chosen
        ? `${chosen.name}’s Kroger account is selected. Sign in using this link to add the approved list: ${this.krogerSignInUrl(chosen.id)}. This only adds items; it does not place an order.`
        : "The selected Kroger account is unavailable. Text “checkout” to start again.";
      return this.ctx.saveAndReturnReply(messageId, reply);
    }
    if (pending?.status === "replacement_review") {
      const reply = this.krogerReplacementPrompt();
      return this.ctx.saveAndReturnReply(messageId, reply);
    }
    if (pending?.status === "adding") {
      return this.ctx.saveAndReturnReply(messageId, "The approved list is currently being sent to Kroger. Please wait for the result.");
    }
    if (checkCartAvailability) {
      let issues: KrogerCartAvailabilityIssue[];
      try {
        issues = await checkCartAvailability(snapshot.items.map((item) => ({
          id: item.id,
          name: item.name,
          upc: item.upc!,
          quantity: item.quantity,
        })));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Kroger availability lookup failed.";
        return this.ctx.saveAndReturnReply(messageId, `I couldn’t verify store availability (${detail}). Nothing was sent to Kroger. Check that GroupCart’s configured store matches the pickup/delivery store in the Kroger account, then try “checkout” again.`);
      }
      if (issues.length) {
        const storedIssues = issues.map((issue) => ({ ...issue, resolved: false }));
        this.ctx.db.exec("BEGIN IMMEDIATE");
        try {
          this.ctx.db.prepare("INSERT INTO pending_kroger_checkouts (household_id, requester_id, revision, selected_member_id, status, created_at) VALUES (?, ?, ?, NULL, 'replacement_review', ?) ON CONFLICT(household_id) DO UPDATE SET requester_id = excluded.requester_id, revision = excluded.revision, selected_member_id = NULL, status = 'replacement_review', created_at = excluded.created_at")
            .run(this.ctx.householdId, memberId, snapshot.revision, new Date().toISOString());
          this.ctx.db.prepare("INSERT INTO pending_kroger_replacements (household_id, issues_json) VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET issues_json = excluded.issues_json")
            .run(this.ctx.householdId, JSON.stringify(storedIssues));
          const reply = this.formatKrogerReplacementSuggestions(storedIssues, locationId);
          this.ctx.recordReply(messageId, reply);
          this.ctx.db.exec("COMMIT");
          return reply;
        } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
      }
    }
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      this.ctx.db.prepare("INSERT INTO pending_kroger_checkouts (household_id, requester_id, revision, selected_member_id, status, created_at) VALUES (?, ?, ?, NULL, 'choosing_account', ?) ON CONFLICT(household_id) DO UPDATE SET requester_id = excluded.requester_id, revision = excluded.revision, selected_member_id = NULL, status = 'choosing_account', created_at = excluded.created_at")
        .run(this.ctx.householdId, memberId, snapshot.revision, new Date().toISOString());
      const options = this.ctx.getMembers().map((member, index) => `${index + 1}) ${member.name}`).join("\n");
      const reply = `Everyone approved revision ${snapshot.revision}. Which household member’s Kroger account should receive the items?\n${options}\nReply with a number, or “cancel checkout”. You’ll sign in to Kroger to authorize adding the items. GroupCart will not place an order or charge anyone.`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }

  handleKrogerAccountChoice(
    messageId: string,
    memberId: string,
    text: string,
    pending: { requesterId: string; revision: number; selectedMemberId: string | null; status: string },
  ): string {
    if (/^(cancel|cancel checkout|never mind|nevermind)$/i.test(text)) {
      return this.cancelKrogerCheckout(messageId, memberId);
    }
    if (pending.status === "awaiting_oauth" && pending.selectedMemberId) {
      const chosen = this.ctx.getMembers().find((member) => member.id === pending.selectedMemberId);
      const reply = chosen
        ? `Sign in to ${chosen.name}’s Kroger account using this link: ${this.krogerSignInUrl(chosen.id)}. After consent, the approved items will be added to its cart; no order will be placed.`
        : "The selected Kroger account is unavailable. Text “checkout” to start again.";
      return this.ctx.saveAndReturnReply(messageId, reply);
    }
    const selection = text.match(/^\s*(\d{1,2})\s*$/);
    const members = this.ctx.getMembers();
    const index = Number(selection?.[1]) - 1;
    if (!selection || index < 0 || index >= members.length) {
      const options = members.map((member, i) => `${i + 1}) ${member.name}`).join("; ");
      return this.ctx.saveAndReturnReply(messageId, `Choose one of these Kroger accounts by number: ${options}. Reply “cancel checkout” to stop.`);
    }
    const chosen = members[index]!;
    const snapshot = this.m.cart.snapshot();
    if (snapshot.revision !== pending.revision || !snapshot.items.length || snapshot.members.some((member) => !member.approved)) {
      this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
      return this.ctx.saveAndReturnReply(messageId, "The cart changed or approvals expired. Nothing was sent to Kroger; review the cart and get fresh approvals before checkout.");
    }
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      this.ctx.db.prepare("UPDATE pending_kroger_checkouts SET selected_member_id = ?, status = 'awaiting_oauth' WHERE household_id = ?")
        .run(chosen.id, this.ctx.householdId);
      const reply = `Selected ${chosen.name}’s Kroger account. Sign in and approve access here: ${this.krogerSignInUrl(chosen.id)}. After consent, GroupCart will add the approved items to that cart only; it will not place an order or charge anyone.`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }

  cancelKrogerCheckout(messageId: string, memberId: string): string {
    const pending = this.getPendingKrogerCheckout();
    if (!pending) return this.ctx.saveAndReturnReply(messageId, "There isn’t a pending Kroger checkout to cancel.");
    if (pending.requesterId !== memberId) return this.ctx.saveAndReturnReply(messageId, "Only the member who started this checkout can cancel it.");
    this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ? AND status <> 'adding'").run(this.ctx.householdId);
    this.ctx.db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.ctx.householdId);
    return this.ctx.saveAndReturnReply(messageId, "Cancelled Kroger cart setup. GroupCart and Kroger carts were left unchanged.");
  }

  formatKrogerReplacementSuggestions(
    issues: Array<KrogerCartAvailabilityIssue & { resolved?: boolean }>,
    locationId?: string,
  ): string {
    const lines = issues.map((issue, index) => {
      const suggestions = issue.alternatives.length
        ? issue.alternatives.map((product, optionIndex) => {
          const price = currentPriceCents(product);
          return `   ${optionIndex + 1}) ${product.description}${product.size ? ` · ${product.size}` : ""}${price === null ? "" : ` — ${money(price)}`}`;
        }).join("\n")
        : "   No in-stock alternatives were returned. Cancel checkout, then remove or search for another product.";
      return `${index + 1}) ${issue.resolved ? "Resolved" : "Unavailable"}: ${issue.name}${locationId ? ` at store ${locationId}` : " at the configured store"}\n${issue.resolved ? "   Replacement selected by a household member." : suggestions}`;
    });
    const storeDescription = locationId ? `store ${locationId}` : "the configured store";
    return `Before checkout, Kroger’s availability check found ${issues.length} unavailable item${issues.length === 1 ? "" : "s"}. Suggested alternatives are not added automatically:\n${lines.join("\n")}\nTo choose one, text “replace 1 with 2” (unavailable-item number, then suggestion number). I’ll update GroupCart only after that explicit choice, and everyone must approve the changed cart again. Confirm the Kroger account uses the same store as GroupCart (${storeDescription}). Nothing has been sent to Kroger. Text “cancel checkout” to leave the cart unchanged.`;
  }

  krogerReplacementPrompt(): string {
    const row = this.ctx.db.prepare("SELECT issues_json FROM pending_kroger_replacements WHERE household_id = ?")
      .get(this.ctx.householdId) as { issues_json: string } | undefined;
    if (!row) return "Kroger replacement suggestions expired. Text “checkout” to run the availability check again.";
    const issues = JSON.parse(row.issues_json) as Array<KrogerCartAvailabilityIssue & { resolved?: boolean }>;
    return this.formatKrogerReplacementSuggestions(issues);
  }

  handleKrogerReplacementChoice(messageId: string, memberId: string, itemNumber: number, optionNumber: number): string {
    const pending = this.getPendingKrogerCheckout();
    const row = this.ctx.db.prepare("SELECT issues_json FROM pending_kroger_replacements WHERE household_id = ?")
      .get(this.ctx.householdId) as { issues_json: string } | undefined;
    if (!pending || pending.status !== "replacement_review" || !row) {
      return this.ctx.saveAndReturnReply(messageId, "There isn’t an active Kroger replacement review. Text “checkout” to check the current cart.");
    }
    const current = this.m.cart.snapshot();
    if (current.revision !== pending.revision) {
      this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
      this.ctx.db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.ctx.householdId);
      return this.ctx.saveAndReturnReply(messageId, "The cart changed during the availability review. I discarded those suggestions and left the cart as-is; everyone must approve the current cart before a fresh checkout check.");
    }
    const issues = JSON.parse(row.issues_json) as Array<KrogerCartAvailabilityIssue & { resolved?: boolean }>;
    const issue = issues[itemNumber - 1];
    const product = issue?.alternatives[optionNumber - 1];
    if (!issue || issue.resolved || !product) {
      return this.ctx.saveAndReturnReply(messageId, `That choice doesn’t match an unresolved item and its suggestions. Use “replace item-number with option-number” (for example “replace 1 with 2”).`);
    }
    const price = currentPriceCents(product);
    if (price === null || !product.upc) {
      return this.ctx.saveAndReturnReply(messageId, "Kroger didn’t return a current price and UPC for that suggestion, so I didn’t replace anything. Choose another option or cancel checkout.");
    }
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.ctx.db.prepare("SELECT id FROM cart_items WHERE id = ? AND household_id = ?")
        .get(issue.itemId, this.ctx.householdId) as { id: string } | undefined;
      if (!item) {
        this.ctx.db.exec("ROLLBACK");
        return this.ctx.saveAndReturnReply(messageId, "That item is no longer in GroupCart. Nothing was replaced; text “checkout” to check the current list.");
      }
      const undoSnapshot = this.m.cart.captureCartItems();
      this.ctx.db.prepare("UPDATE cart_items SET product_id = ?, product_name = ?, unit_price_cents = ?, price_source = 'kroger', upc = ? WHERE id = ?")
        .run(`kroger:${product.productId}`, product.description, price, product.upc, issue.itemId);
      this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?").run(this.ctx.householdId);
      this.m.cart.recordUndo(memberId, `replace unavailable ${issue.name} with ${product.description}`, undoSnapshot);
      issue.resolved = true;
      this.ctx.db.prepare("UPDATE pending_kroger_replacements SET issues_json = ? WHERE household_id = ?")
        .run(JSON.stringify(issues), this.ctx.householdId);
      const revision = this.m.cart.snapshot().revision;
      this.ctx.db.prepare("UPDATE pending_kroger_checkouts SET revision = ? WHERE household_id = ?")
        .run(revision, this.ctx.householdId);
      const allResolved = issues.every((entry) => entry.resolved);
      if (allResolved) {
        this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
        this.ctx.db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.ctx.householdId);
      }
      const reply = allResolved
        ? `You chose ${product.description}${product.size ? ` · ${product.size}` : ""} at ${money(price)}. I updated GroupCart only because you explicitly selected it. The cart changed, so everyone must approve revision ${revision} before checkout.\n${this.m.cart.formatSummary(memberId)}`
        : `You chose ${product.description}${product.size ? ` · ${product.size}` : ""} at ${money(price)}. I updated GroupCart only because you explicitly selected it. Choose the remaining suggested replacements:\n${this.formatKrogerReplacementSuggestions(issues)}`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }

  krogerSignInUrl(memberId: string): string {
    return `${this.ctx.dashboardUrl.replace(/\/$/, "")}/api/kroger/oauth/start?memberId=${encodeURIComponent(memberId)}`;
  }

  async completeKrogerCartCheckout(
    memberId: string,
    addItemsToCart: (items: Array<{ upc: string; quantity: number }>) => Promise<void>,
  ): Promise<{ ok: boolean; message: string }> {
    this.ctx.db.exec("BEGIN IMMEDIATE");
    let snapshot: CartSnapshot;
    try {
      const pending = this.getPendingKrogerCheckout();
      if (!pending || pending.status !== "awaiting_oauth" || pending.selectedMemberId !== memberId) {
        this.ctx.db.exec("ROLLBACK");
        return { ok: false, message: "This Kroger authorization no longer matches the pending checkout. Text “checkout” in the group to start again." };
      }
      snapshot = this.m.cart.snapshot();
      if (!snapshot.items.length || snapshot.revision !== pending.revision || snapshot.members.some((member) => !member.approved)) {
        this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
        this.ctx.db.exec("COMMIT");
        return { ok: false, message: "The cart changed or approvals expired while Kroger sign-in was open. The Kroger cart was not changed; review GroupCart and get fresh approvals." };
      }
      const missingUpc = snapshot.items.find((item) => !item.upc);
      if (missingUpc) {
        this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
        this.ctx.db.exec("COMMIT");
        return { ok: false, message: `“${missingUpc.name}” has no Kroger UPC, so I did not send any items. Replace sample items with selected Kroger products and try again.` };
      }
      this.ctx.db.prepare("UPDATE pending_kroger_checkouts SET status = 'adding' WHERE household_id = ?").run(this.ctx.householdId);
      this.ctx.db.exec("COMMIT");
    } catch (error) {
      this.ctx.db.exec("ROLLBACK");
      throw error;
    }

    try {
      await addItemsToCart(snapshot.items.map((item) => ({ upc: item.upc!, quantity: item.quantity })));
    } catch (error) {
      this.ctx.db.exec("BEGIN IMMEDIATE");
      try {
        this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
        this.ctx.db.exec("COMMIT");
      } catch (dbError) { this.ctx.db.exec("ROLLBACK"); throw dbError; }
      const detail = error instanceof Error ? error.message : "Kroger request failed.";
      return { ok: false, message: `Kroger did not confirm adding the items (${detail}). GroupCart is unchanged. Check your Kroger cart before trying again, in case Kroger received the request but the response was lost.` };
    }

    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.m.cart.snapshot();
      if (current.revision !== snapshot.revision) {
        this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
        this.ctx.db.exec("COMMIT");
        return { ok: false, message: "The approved items were sent to Kroger, but GroupCart changed during the transfer. I left the current GroupCart untouched; review both carts before trying again." };
      }
      const accountName = this.ctx.getMembers().find((member) => member.id === memberId)?.name ?? "the selected member";
      this.ctx.db.prepare("DELETE FROM cart_items WHERE household_id = ?").run(this.ctx.householdId);
      this.m.cart.clearPendingCartIntents();
      this.ctx.db.prepare("DELETE FROM cart_undo_history WHERE household_id = ?").run(this.ctx.householdId);
      this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = ? WHERE id = ?")
        .run(snapshot.revision, this.ctx.householdId);
      this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
      this.ctx.db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.ctx.householdId);
      const message = `Added ${snapshot.items.length} item${snapshot.items.length === 1 ? "" : "s"} to ${accountName}’s Kroger cart. No order was placed or payment charged. Open Kroger to review the cart and finish checkout there.`;
      // Splitwise: Kroger confirmed, so log the checkout (savepoint-isolated), then send it after commit.
      const checkoutKey = this.m.splitwise.recordCheckout(snapshot, memberId, "kroger");
      this.ctx.db.exec("COMMIT");
      const splitwiseNote = await this.m.splitwise.finishCheckoutLog(checkoutKey);
      return { ok: true, message: splitwiseNote ? `${message}\n\n${splitwiseNote}` : message };
    } catch (error) {
      this.ctx.db.exec("ROLLBACK");
      throw error;
    }
  }
}
