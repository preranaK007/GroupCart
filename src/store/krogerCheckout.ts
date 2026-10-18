import type { KrogerCartAvailabilityIssue, KrogerProduct } from "../kroger.js";
import { money } from "../cart.js";
import type { StoreContext, StoreModules } from "./context.js";
import type { ReviewCommand } from "./parsing.js";
import { currentPriceCents } from "./pricing.js";
import type { CartSnapshot, KrogerCartSent, KrogerReviewItem, PendingKrogerCheckout } from "./types.js";

/** What the group chose for one unavailable item. Nothing is applied until every item has a choice. */
type ReviewChoice = { kind: "replace"; option: number } | { kind: "remove" };
/**
 * An unavailable item in a checkout review. `resolved`/`resolution` only appear on reviews stored by an older
 * version, which applied each choice immediately; those items are already settled in the cart.
 */
type ReviewIssue = KrogerCartAvailabilityIssue & { choice?: ReviewChoice; resolved?: boolean; resolution?: "replaced" | "removed" };
type Review = { pending: PendingKrogerCheckout; issues: ReviewIssue[]; locationId: string | undefined };

/** How long after a review ends a late “remove 2” / “replace 1 with 2” still gets “that review is finished”. */
const RECENT_REVIEW_MS = 30 * 60_000;
/** Words that say nothing about which item someone means (“remove it”, “cancel all”, “the unavailable one”). */
const VAGUE_WORDS = new Set(["it", "them", "that", "this", "those", "these", "one", "ones", "all", "the", "a", "an", "item", "items", "thing", "things", "stuff", "unavailable", "please", "whole", "everything"]);

/**
 * Sending an approved cart to a member's Kroger cart: availability precheck,
 * the group's review of unavailable items, account choice, OAuth, and the final add. Never places an order.
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
    // The availability review belongs to the whole group: anyone's “checkout” shows it.
    if (this.getPendingKrogerCheckout()?.status === "replacement_review") {
      return this.ctx.transactReply(messageId, () => {
        const review = this.#loadReview();
        if (!review) return "There isn’t a checkout review open. Text “checkout” again to check availability.";
        return this.#staleReviewReply(review) ?? this.#formatReview(review);
      }) ?? "";
    }
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
        const storedIssues: ReviewIssue[] = issues.map((issue) => ({ ...issue }));
        return this.ctx.transactReply(messageId, () => {
          this.ctx.db.prepare("INSERT INTO pending_kroger_checkouts (household_id, requester_id, revision, selected_member_id, status, created_at) VALUES (?, ?, ?, NULL, 'replacement_review', ?) ON CONFLICT(household_id) DO UPDATE SET requester_id = excluded.requester_id, revision = excluded.revision, selected_member_id = NULL, status = 'replacement_review', created_at = excluded.created_at")
            .run(this.ctx.householdId, memberId, snapshot.revision, new Date().toISOString());
          this.ctx.db.prepare("INSERT INTO pending_kroger_replacements (household_id, issues_json, location_id) VALUES (?, ?, ?) ON CONFLICT(household_id) DO UPDATE SET issues_json = excluded.issues_json, location_id = excluded.location_id")
            .run(this.ctx.householdId, JSON.stringify(storedIssues), locationId ?? null);
          return this.#formatReview({ pending: this.getPendingKrogerCheckout()!, issues: storedIssues, locationId });
        }) ?? "";
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
    if (pending.status === "adding") {
      return this.ctx.saveAndReturnReply(messageId, "GroupCart is already sending the approved list to Kroger, and that can’t be stopped now. I’ll report the result here; check the Kroger cart afterwards.");
    }
    if (pending.status === "replacement_review") {
      // The availability review is about the shared cart, so anyone can back out of it. Choices are only applied
      // once every item has one, so cancelling really does leave GroupCart as it was.
      return this.ctx.transactReply(messageId, () => {
        const review = this.#loadReview();
        const chosen = review?.issues.some((issue) => issue.choice) ?? false;
        this.#endReview();
        return `Cancelled the checkout review. GroupCart is unchanged${chosen ? " (the swaps and removals chosen so far were discarded)" : ""}, and nothing was sent to Kroger. To fix an unavailable item yourself, remove it or search for a substitute, then text “checkout” again.`;
      }) ?? "";
    }
    // Account choice and sign-in belong to the requester's Kroger account.
    if (pending.requesterId !== memberId) {
      return this.ctx.saveAndReturnReply(messageId, "Only the member who started this checkout can cancel it.");
    }
    this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
    this.ctx.db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.ctx.householdId);
    return this.ctx.saveAndReturnReply(messageId, "Cancelled Kroger cart setup. GroupCart and Kroger carts were left unchanged.");
  }

  /** True while the group is reviewing unavailable items. */
  hasOpenReview(): boolean {
    return this.getPendingKrogerCheckout()?.status === "replacement_review";
  }

  /** True shortly after a review ended, so late review commands get “that review is finished”. */
  reviewRecentlyEnded(): boolean {
    const row = this.ctx.db.prepare("SELECT value FROM app_state WHERE key = ?")
      .get(`kroger_review_ended:${this.ctx.householdId}`) as { value: string } | undefined;
    return row !== undefined && this.ctx.now().getTime() - Date.parse(row.value) < RECENT_REVIEW_MS;
  }

  /** Apply one review command (“replace 1 with 2”, “remove 1, 2”, …) from any member. */
  handleReviewCommand(messageId: string, memberId: string, command: ReviewCommand): string | null {
    return this.ctx.transactReply(messageId, () => {
      const review = this.#loadReview();
      if (!review) {
        return this.reviewRecentlyEnded()
          ? "That checkout review is already finished, so nothing was changed. Text “cart” to see the current cart, or “checkout” to check availability again."
          : "There isn’t a checkout review open, so nothing was changed. Text “checkout” to check availability.";
      }
      const stale = this.#staleReviewReply(review);
      if (stale) return stale;
      const { issues } = review;
      const undecided = this.#undecided(issues);
      const label = (number: number): string => `${number}) ${issues[number - 1]!.name}`;

      let noted: string;
      if (command.kind === "replace") {
        const issue = issues[command.item - 1];
        if (!issue) return `There’s no unavailable item ${command.item}. ${this.#nudgeText(review)}`;
        if (issue.resolved) return `${label(command.item)} was already settled. ${this.#nudgeText(review)}`;
        if (!issue.alternatives.length) {
          return `Kroger didn’t return any in-stock alternatives for ${issue.name}. Text “remove ${command.item}” to drop it from GroupCart, or “cancel checkout” to stop and look for a substitute yourself. Nothing was changed.`;
        }
        const product = issue.alternatives[command.option - 1];
        if (!product) {
          return `${issue.name} has ${issue.alternatives.length} suggestion${issue.alternatives.length === 1 ? "" : "s"}; text “replace ${command.item} with 1”${issue.alternatives.length > 1 ? ` (up to ${issue.alternatives.length})` : ""}. Nothing was changed.`;
        }
        if (currentPriceCents(product) === null || !product.upc) {
          return `Kroger didn’t return a current price and UPC for ${product.description}, so it can’t be used. Choose another suggestion, “remove ${command.item}”, or “cancel checkout”.`;
        }
        issue.choice = { kind: "replace", option: command.option };
        noted = `swap ${issue.name} for ${this.#productLabel(product)}`;
      } else {
        let numbers: number[];
        if (command.which === "all") {
          numbers = undecided;
          if (!numbers.length) return `Every unavailable item already has a choice. ${this.#nudgeText(review)}`;
        } else if (command.which === "single") {
          const open = undecided.length ? undecided : issues.flatMap((issue, index) => issue.resolved ? [] : [index + 1]);
          if (open.length !== 1) {
            return `More than one item is unavailable: ${open.map(label).join("; ")}. Text “remove” with the number (for example “remove ${open[0]}”), or “remove all unavailable”. Nothing was changed.`;
          }
          numbers = open;
        } else {
          numbers = [...new Set(command.which)];
          const invalid = numbers.filter((number) => !issues[number - 1] || issues[number - 1]!.resolved);
          if (invalid.length) {
            const valid = issues.flatMap((issue, index) => issue.resolved ? [] : [index + 1]);
            return `${this.ctx.joinNames(invalid.map(String))} ${invalid.length === 1 ? "isn’t one of the unavailable items" : "aren’t unavailable items"} (choose from ${this.ctx.joinNames(valid.map(String))}). Nothing was changed.`;
          }
        }
        for (const number of numbers) issues[number - 1]!.choice = { kind: "remove" };
        noted = `remove ${this.ctx.joinNames(numbers.map((number) => issues[number - 1]!.name))} for everyone`;
      }

      if (this.#undecided(issues).length) {
        this.ctx.db.prepare("UPDATE pending_kroger_replacements SET issues_json = ? WHERE household_id = ?")
          .run(JSON.stringify(issues), this.ctx.householdId);
        const remaining = this.#undecided(issues);
        return `Noted: ${noted}. Nothing in GroupCart changes until every unavailable item has a choice. Still to decide: ${remaining.map((number) => `${label(number)} (${this.#choiceHint(issues, number)})`).join("; ")}. Send a new choice to change one, or ${this.#cancelHint()}.`;
      }
      return this.#applyReview(memberId, review);
    });
  }

  /** Short reply for other messages while the review is open. */
  reviewNudge(messageId: string): string {
    return this.ctx.transactReply(messageId, () => {
      const review = this.#loadReview();
      if (!review) return "There isn’t a checkout review open. Text “checkout” to check availability.";
      return this.#staleReviewReply(review) ?? `Checkout is paused on unavailable items. ${this.#nudgeText(review)}`;
    }) ?? "";
  }

  /**
   * When a removal-like message names an open unavailable item by whole words (“remove the hooks”), point at its
   * number instead of acting: names in chat are too easy to misread (“drop it”, “don't remove the eggs”).
   */
  reviewNameHint(messageId: string, query: string): string | undefined {
    const review = this.#loadReview();
    if (!review) return undefined;
    const words = query.toLocaleLowerCase().split(/[^\p{L}\p{N}%]+/u).filter((word) => word && !VAGUE_WORDS.has(word));
    if (!words.length) return undefined;
    const singular = (word: string): string => word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
    const matches = review.issues.flatMap((issue, index) => {
      if (issue.resolved) return [];
      const nameWords = new Set(issue.name.toLocaleLowerCase().split(/[^\p{L}\p{N}%]+/u).filter(Boolean).map(singular));
      return words.every((word) => nameWords.has(singular(word))) ? [index + 1] : [];
    });
    if (!matches.length) return undefined;
    const listed = matches.map((number) => `${number}) ${review.issues[number - 1]!.name}`).join("; ");
    return this.ctx.saveAndReturnReply(messageId, `During the checkout review, unavailable items are handled by number so chat can’t change the cart by accident: ${listed}. To drop ${matches.length === 1 ? "it" : "one"} for everyone, text “remove ${matches[0]}”${matches.length > 1 ? " (or the other number)" : ""}. Nothing was changed.`);
  }

  krogerReplacementPrompt(): string {
    const review = this.#loadReview();
    if (!review) return "Kroger replacement suggestions expired. Text “checkout” to run the availability check again.";
    return this.#formatReview(review);
  }

  /** The open review's items for the Groceries page, numbered as the group's review commands use them. */
  reviewItems(): KrogerReviewItem[] | null {
    const review = this.#loadReview();
    if (!review) return null;
    return review.issues.map((issue, index) => ({
      number: index + 1,
      name: issue.name,
      quantity: issue.quantity,
      choice: issue.resolved ? { kind: "settled" } : issue.choice ?? null,
      alternatives: issue.alternatives.map((product, optionIndex) => ({
        option: optionIndex + 1,
        description: product.description,
        size: product.size,
        priceCents: currentPriceCents(product),
      })),
    }));
  }

  /** The last list added to a member's Kroger cart (recorded by completeKrogerCartCheckout), or null. */
  lastSentCart(): KrogerCartSent | null {
    const row = this.ctx.db.prepare("SELECT value FROM app_state WHERE key = ?").get(this.#sentCartKey()) as { value: string } | undefined;
    if (!row) return null;
    const sent = JSON.parse(row.value) as Omit<KrogerCartSent, "memberName">;
    const memberName = this.ctx.getMembers().find((member) => member.id === sent.memberId)?.name ?? "a former member";
    return { ...sent, memberName };
  }

  #sentCartKey(): string {
    return `kroger_cart_sent:${this.ctx.householdId}`;
  }

  #loadReview(): Review | undefined {
    const pending = this.getPendingKrogerCheckout();
    if (pending?.status !== "replacement_review") return undefined;
    const row = this.ctx.db.prepare("SELECT issues_json, location_id FROM pending_kroger_replacements WHERE household_id = ?")
      .get(this.ctx.householdId) as { issues_json: string; location_id: string | null } | undefined;
    if (!row) return undefined;
    return { pending, issues: JSON.parse(row.issues_json) as ReviewIssue[], locationId: row.location_id ?? undefined };
  }

  /** If the cart changed since the precheck, end the review and say so; otherwise undefined. Caller holds the transaction. */
  #staleReviewReply(review: Review): string | undefined {
    const { revision } = this.ctx.db.prepare("SELECT revision FROM households WHERE id = ?").get(this.ctx.householdId) as { revision: number };
    if (revision === review.pending.revision) return undefined;
    this.#endReview();
    return "The cart changed during the availability review, so I discarded that review and any choices in it; nothing else was changed. Everyone must approve the current cart, then text “checkout” for a fresh availability check.";
  }

  #endReview(): void {
    this.ctx.db.prepare("DELETE FROM pending_kroger_checkouts WHERE household_id = ?").run(this.ctx.householdId);
    this.ctx.db.prepare("DELETE FROM pending_kroger_replacements WHERE household_id = ?").run(this.ctx.householdId);
    this.ctx.db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`kroger_review_ended:${this.ctx.householdId}`, this.ctx.now().toISOString());
  }

  /** Numbers (1-based) of items that still need a choice. */
  #undecided(issues: ReviewIssue[]): number[] {
    return issues.flatMap((issue, index) => issue.resolved || issue.choice ? [] : [index + 1]);
  }

  /** Apply every choice as one cart change and end the review. Caller holds the transaction. */
  #applyReview(memberId: string, review: Review): string {
    const done: string[] = [];
    const missing: string[] = [];
    const revision = this.m.cart.commitChange(memberId, "", () => {
      for (const issue of review.issues) {
        if (issue.resolved || !issue.choice) continue;
        const exists = this.ctx.db.prepare("SELECT 1 FROM cart_items WHERE id = ? AND household_id = ?").get(issue.itemId, this.ctx.householdId);
        if (!exists) { missing.push(issue.name); continue; }
        if (issue.choice.kind === "remove") {
          this.ctx.db.prepare("DELETE FROM cart_items WHERE id = ? AND household_id = ?").run(issue.itemId, this.ctx.householdId);
          done.push(`removed ${issue.name} for everyone`);
        } else {
          const product = issue.alternatives[issue.choice.option - 1]!;
          this.ctx.db.prepare("UPDATE cart_items SET product_id = ?, product_name = ?, unit_price_cents = ?, price_source = 'kroger', upc = ? WHERE id = ? AND household_id = ?")
            .run(`kroger:${product.productId}`, product.description, currentPriceCents(product), product.upc, issue.itemId, this.ctx.householdId);
          done.push(`swapped ${issue.name} for ${this.#productLabel(product)}`);
        }
      }
    });
    // Label the undo step now that we know what changed.
    this.ctx.db.prepare("UPDATE cart_undo_history SET action = ? WHERE id = (SELECT id FROM cart_undo_history WHERE household_id = ? ORDER BY rowid DESC LIMIT 1)")
      .run(`checkout review: ${done.join("; ") || "no changes"}`, this.ctx.householdId);
    this.#endReview();
    const missingNote = missing.length ? ` (${this.ctx.joinNames(missing)} had already left the cart.)` : "";
    const next = this.m.cart.isEmpty()
      ? "The cart is now empty, so there’s nothing to check out."
      : `The cart changed, so everyone must approve revision ${revision}, then text “checkout” again.`;
    return `Checkout review done: ${done.join("; ") || "nothing to change"}.${missingNote} That’s one change; “undo” reverts it. ${next}\n${this.m.cart.formatSummary(memberId)}`;
  }

  #productLabel(product: KrogerProduct): string {
    const price = currentPriceCents(product);
    return `${product.description}${product.size ? ` · ${product.size}` : ""}${price === null ? "" : ` (${money(price)})`}`;
  }

  #choiceHint(issues: ReviewIssue[], number: number): string {
    return issues[number - 1]!.alternatives.length
      ? `“replace ${number} with 1” or “remove ${number}”`
      : `Kroger didn’t return any alternatives; “remove ${number}”`;
  }

  #cancelHint(): string {
    return "“cancel checkout” to discard these choices and search for a substitute";
  }

  #storeLabel(locationId: string | undefined): string {
    return locationId ? `store ${locationId}` : "the configured store";
  }

  /** One-line status: what still needs a choice and how to give it. */
  #nudgeText(review: Review): string {
    const undecided = this.#undecided(review.issues);
    const open = undecided.slice(0, 2).map((number) => {
      const issue = review.issues[number - 1]!;
      const count = issue.alternatives.length;
      const name = issue.name.length > 35 ? `${issue.name.slice(0, 32)}…` : issue.name;
      return `${number}) ${name} (${count ? `${count} suggestion${count === 1 ? "" : "s"}` : "none returned"})`;
    });
    if (undecided.length > open.length) open.push(`${undecided.length - open.length} more`);
    const first = undecided[0];
    const example = first === undefined ? "" : `“${review.issues[first - 1]!.alternatives.length ? `replace ${first} with 1` : `remove ${first}`}”, `;
    return `${open.length ? `Still to decide: ${open.join("; ")}. ` : ""}Text ${example}“checkout” for the full list, or ${this.#cancelHint()}.`;
  }

  #formatReview(review: Review): string {
    const { issues, locationId } = review;
    const lines = issues.map((issue, index) => {
      const number = index + 1;
      if (issue.resolved) return `${number}) ${issue.name}: already settled (${issue.resolution === "removed" ? "removed" : "replaced"}).`;
      if (issue.choice?.kind === "remove") return `${number}) ${issue.name}: will be removed for everyone.`;
      if (issue.choice?.kind === "replace") return `${number}) ${issue.name}: will be swapped for ${this.#productLabel(issue.alternatives[issue.choice.option - 1]!)}.`;
      const suggestions = issue.alternatives.length
        ? issue.alternatives.map((product, optionIndex) => `   ${optionIndex + 1}) ${this.#productLabel(product)}`).join("\n")
        : "   Kroger didn’t return any in-stock alternatives.";
      return `${number}) Unavailable: ${issue.name}\n${suggestions}`;
    });
    const undecided = this.#undecided(issues);
    const withAlternatives = undecided.find((number) => issues[number - 1]!.alternatives.length);
    const firstOpen = undecided[0];
    const choices = [
      withAlternatives !== undefined ? `“replace ${withAlternatives} with 1” to swap in a suggestion (item number, then suggestion number)` : "",
      firstOpen !== undefined ? `“remove ${firstOpen}” to drop an item for everyone${undecided.length > 1 ? " (“remove all unavailable” for every open one)" : ""}` : "",
      `${this.#cancelHint()} (GroupCart stays unchanged)`,
    ].filter(Boolean);
    return `Kroger’s availability check at ${this.#storeLabel(locationId)} found ${issues.length} unavailable item${issues.length === 1 ? "" : "s"}. Checkout is paused until each has a choice, and nothing in GroupCart changes until then:\n${lines.join("\n")}\nAnyone in the group can text ${choices.join("; ")}. Applying the choices changes the cart, so everyone approves again before checkout. Confirm the Kroger account uses ${this.#storeLabel(locationId)}. Nothing has been sent to Kroger.`;
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
      const sent: Omit<KrogerCartSent, "memberName"> = { memberId, revision: snapshot.revision, itemCount: snapshot.items.length, at: this.ctx.now().toISOString() };
      this.ctx.db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(this.#sentCartKey(), JSON.stringify(sent));
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
