import { randomUUID } from "node:crypto";
import { extractCartRequests, isGenericMilkRequest, money } from "../cart.js";
import type { KrogerProduct } from "../kroger.js";
import type { StoreContext, StoreModules } from "./context.js";
import { milkSearchQuery, multiItemRequests, parsePriceLimit, quantityFromText, retailerQuery } from "./parsing.js";
import { currentPriceCents, isCurrentPromo, meetsPriceLimit } from "./pricing.js";
import type { BatchProductResult, BatchRequest, PendingRetailerChoice, ProductSearchFn } from "./types.js";

/** Live Kroger product search: single-item and multi-item searches with numbered choices. */
export class ProductSearch {
  constructor(private readonly ctx: StoreContext, private readonly m: StoreModules) {}

  async searchBatchAndPrompt(
    messageId: string,
    memberId: string,
    requests: BatchRequest[],
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
    sourceText = "",
  ): Promise<string> {
    let results: BatchProductResult[];
    try {
      results = await Promise.all(requests.map(async (request) => {
        const result = await searchProducts(request.query);
        const matchingProducts = result.products.filter((product) => meetsPriceLimit(
          product,
          request.maxPriceCents,
          request.maxPriceInclusive ?? false,
        ));
        return { total: matchingProducts.length, products: matchingProducts.slice(0, 3) };
      }));
    } catch (error) {
      const reply = `I couldn’t search the full list just now (${error instanceof Error ? error.message : "request failed"}). Nothing was added. Please retry the item list, or text “help”.`;
      this.ctx.saveMessageReply(messageId, reply);
      return reply;
    }
    const missing = requests.flatMap((request, index) => results[index]!.products.length ? [] : [
      request.maxPriceCents === undefined
        ? `“${request.query}”`
        : `“${request.query}” under ${money(request.maxPriceCents)}`,
    ]);
    if (missing.length) {
      const reply = `I couldn’t find Kroger products for ${missing.join(" and ")}. Nothing from this list was added. Try a more specific description or raise the item budget, then resend the list.`;
      this.ctx.saveMessageReply(messageId, reply);
      return reply;
    }
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      this.ctx.db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
      this.ctx.db.prepare("INSERT INTO pending_product_batches (member_id, requests_json, results_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET requests_json = excluded.requests_json, results_json = excluded.results_json, created_at = excluded.created_at")
        .run(memberId, JSON.stringify(requests), JSON.stringify(results), new Date().toISOString());
      const sections = requests.map((request, index) => {
        const result = results[index]!;
        const options = result.products.map((product, optionIndex) => {
          const cents = currentPriceCents(product);
          const price = cents === null ? "price unavailable" : money(cents);
          return `   ${optionIndex + 1}) ${product.description}${product.size ? ` · ${product.size}` : ""} — ${price}`;
        });
        const priceLimit = request.maxPriceCents === undefined
          ? ""
          : ` · ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)} each`;
        return `${index + 1}. ${request.quantity > 1 ? `${request.quantity} × ` : ""}${request.query}${priceLimit} (${result.total} options)\n${options.join("\n")}`;
      });
      const storeNote = locationId ? ` at selected store ${locationId}` : " at the configured Kroger-family store";
      const reply = `I found options for your ${requests.length} items${storeNote}:\n${sections.join("\n")}\nReply with one choice number per item in order, separated by commas (for example “1, 2, 1”). Nothing is added until all choices are selected. Reply “cancel” to discard this search.${this.m.sharing.sharingNote(this.m.sharing.participantsFor(memberId))}${this.m.sharing.legacyShareHint(sourceText, memberId)}`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }

  addBatchSelections(
    messageId: string,
    memberId: string,
    requests: BatchRequest[],
    results: BatchProductResult[],
    selections: number[],
  ): string {
    const chosen = results.map((result, index) => result.products[selections[index]! - 1]!);
    const missingPrice = chosen.find((product) => currentPriceCents(product) === null);
    if (missingPrice) {
      const reply = `Kroger didn’t return a price for ${missingPrice.description} at this store, so I didn’t add any items. Send the list again after configuring local store pricing.`;
      this.ctx.saveMessageReply(messageId, reply);
      return reply;
    }
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      this.ctx.db.prepare("DELETE FROM pending_product_batches WHERE member_id = ?").run(memberId);
      const undoSnapshot = this.m.cart.captureCartItems();
      const chosenLines: string[] = [];
      const participantIds = this.m.sharing.participantsFor(memberId);
      for (let index = 0; index < chosen.length; index += 1) {
        const product = chosen[index]!;
        const request = requests[index]!;
        const price = currentPriceCents(product)!;
        const productId = `kroger:${product.productId}`;
        this.ctx.db.prepare(
          "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(randomUUID(), this.ctx.householdId, productId, request.quantity, memberId,
          JSON.stringify(participantIds), new Date().toISOString(), product.description,
          price, "kroger", product.upc);
        chosenLines.push(product.description);
      }
      this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
        .run(this.ctx.householdId);
      this.m.cart.recordUndo(memberId, `add ${chosenLines.join(", ")}`, undoSnapshot);
      const reply = `Added all ${chosenLines.length} selected items to GroupCart ${this.m.sharing.assignmentPhrase(participantIds)}.\n${this.m.cart.formatSummary(memberId)}`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }

  /** Reply to a pending multi-item search: a milk kind first if needed, then one number per item. */
  async continueBatch(
    messageId: string,
    memberId: string,
    normalized: string,
    pendingBatchRow: { requests_json: string; results_json: string | null },
    searchProducts: ProductSearchFn,
    locationId?: string,
  ): Promise<string> {
    if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
      this.ctx.db.exec("BEGIN IMMEDIATE");
      try {
        this.ctx.db.prepare("DELETE FROM pending_product_batches WHERE member_id = ?").run(memberId);
        const reply = "Cancelled the multi-item search; nothing was added.";
        this.ctx.recordReply(messageId, reply);
        this.ctx.db.exec("COMMIT");
        return reply;
      } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
    }
    const requests = JSON.parse(pendingBatchRow.requests_json) as BatchRequest[];
    if (!pendingBatchRow.results_json) {
      const milkChoice = milkSearchQuery(this.ctx.getMembers(), normalized);
      if (!milkChoice) {
        const reply = "Which kind of milk? Reply whole, 2%, oat, or almond, and I’ll continue searching the rest of your list. Or say “cancel”.";
        this.ctx.saveMessageReply(messageId, reply);
        return reply;
      }
      const milkRequest = requests.find((request) => isGenericMilkRequest(request.query));
      if (!milkRequest) {
        const reply = "I lost the pending multi-item search. Please send your item list again.";
        this.ctx.saveMessageReply(messageId, reply);
        return reply;
      }
      milkRequest.query = milkChoice;
      return this.searchBatchAndPrompt(messageId, memberId, requests, searchProducts, locationId);
    }
    const results = JSON.parse(pendingBatchRow.results_json) as BatchProductResult[];
    const numbers = normalized.match(/^\s*\d+(?:\s*(?:,|\s)\s*\d+)*\s*$/)?.[0].trim().split(/[\s,]+/).map(Number);
    if (!numbers || numbers.length !== requests.length || numbers.some((number, index) => !Number.isInteger(number) || number < 1 || number > (results[index]?.products.length ?? 0))) {
      const reply = `Reply with one result number for each item, in order (for example “1, 2, 1”), or “cancel”. Nothing has been added yet.`;
      this.ctx.saveMessageReply(messageId, reply);
      return reply;
    }
    return this.addBatchSelections(messageId, memberId, requests, results, numbers);
  }

  /** Start a multi-item search when the message lists 2+ items; `undefined` when it doesn't. */
  async startBatch(
    messageId: string,
    memberId: string,
    normalized: string,
    searchProducts: ProductSearchFn,
    locationId?: string,
  ): Promise<string | undefined> {
    const batchRequests = multiItemRequests(this.ctx.getMembers(), normalized);
    if (batchRequests.length > 1) {
      if (batchRequests.length > 5) {
        const reply = "I can search up to 5 grocery items from one message. Nothing was added; split the list into smaller batches or text “help”.";
        this.ctx.saveMessageReply(messageId, reply);
        return reply;
      }
      const genericMilk = batchRequests.some((request) => isGenericMilkRequest(request.query));
      if (genericMilk) {
        this.ctx.db.exec("BEGIN IMMEDIATE");
        try {
          this.ctx.db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
          this.ctx.db.prepare("INSERT INTO pending_product_batches (member_id, requests_json, results_json, created_at) VALUES (?, ?, NULL, ?) ON CONFLICT(member_id) DO UPDATE SET requests_json = excluded.requests_json, results_json = NULL, created_at = excluded.created_at")
            .run(memberId, JSON.stringify(batchRequests), new Date().toISOString());
          const reply = "I’ll look up the items together. First, which kind of milk? Reply whole, 2%, oat, or almond; then I’ll show choices for the full list. Or say “cancel”.";
          this.ctx.recordReply(messageId, reply);
          this.ctx.db.exec("COMMIT");
          return reply;
        } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
      }
      return this.searchBatchAndPrompt(messageId, memberId, batchRequests, searchProducts, locationId, normalized);
    }
    return undefined;
  }

  /** Reply to a pending single-item product choice with a number (or “cancel”). */
  choosePending(
    messageId: string,
    memberId: string,
    normalized: string,
    pendingChoiceRow: { query: string; quantity: number; products_json: string },
  ): string {
    if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
      this.ctx.db.exec("BEGIN IMMEDIATE");
      try {
        this.ctx.db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
        this.ctx.recordReply(messageId, "Cancelled that product selection; nothing was added.");
        this.ctx.db.exec("COMMIT");
        return "Cancelled that product selection; nothing was added.";
      } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
    }
    const pending: PendingRetailerChoice = {
      query: pendingChoiceRow.query,
      quantity: pendingChoiceRow.quantity,
      products: JSON.parse(pendingChoiceRow.products_json) as KrogerProduct[],
    };
    const selection = normalized.match(/^\s*(\d{1,2})\s*$/);
    const index = Number(selection?.[1]) - 1;
    if (!selection || index < 0 || index >= pending.products.length) {
      return `Please reply with a number from 1 to ${pending.products.length}, or “cancel”. I’m still waiting for you to choose a product.`;
    }
    const chosen = pending.products[index]!;
    const priceCents = currentPriceCents(chosen);
    if (priceCents === null) {
      return `Kroger didn’t return a price for ${chosen.description} at the configured store, so I didn’t add it. Choose another numbered option or set a store with local pricing.`;
    }
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      this.ctx.db.prepare("DELETE FROM pending_product_choices WHERE member_id = ?").run(memberId);
      const undoSnapshot = this.m.cart.captureCartItems();
      const itemId = `kroger:${chosen.productId}`;
      // Sharing is decided when the item is actually added: whatever session
      // the sender is in at choice time, not at search time.
      const participantIds = this.m.sharing.participantsFor(memberId);
      this.ctx.db.prepare(
        "INSERT INTO cart_items (id, household_id, product_id, quantity, owner_id, participants_json, created_at, product_name, unit_price_cents, price_source, upc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(), this.ctx.householdId, itemId, pending.quantity, memberId,
        JSON.stringify(participantIds), new Date().toISOString(), chosen.description,
        priceCents, "kroger", chosen.upc,
      );
      this.ctx.db.prepare("UPDATE households SET revision = revision + 1, checked_out_revision = NULL WHERE id = ?")
        .run(this.ctx.householdId);
      this.m.cart.recordUndo(memberId, `add ${chosen.description}`, undoSnapshot);
      const reply = `Added ${chosen.description} ${this.m.sharing.assignmentPhrase(participantIds)} at ${money(priceCents)}${chosen.size ? ` (${chosen.size})` : ""}.\n${this.m.cart.formatSummary(memberId)}`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }

  /**
   * Search Kroger for one item (or the answer to a milk question) and offer numbered options.
   * Returns `undefined` when the text isn't a live search, so the caller falls back to the catalog flow.
   */
  async searchSingle(
    messageId: string,
    memberId: string,
    normalized: string,
    searchProducts: ProductSearchFn,
    locationId?: string,
  ): Promise<string | undefined> {
    const pendingMilk = this.ctx.db.prepare(
      "SELECT kind, original_text FROM pending_clarifications WHERE member_id = ?",
    ).get(memberId) as { kind: string; original_text: string } | undefined;
    let query: string | undefined;
    let contextText = normalized;
    let quantity = 1;
    let maxPriceCents: number | undefined;
    let maxPriceInclusive = false;

    if (pendingMilk?.kind === "milk") {
      if (/^(cancel|never mind|nevermind)$/i.test(normalized)) {
        return undefined;
      }
      const milkChoice = milkSearchQuery(this.ctx.getMembers(), normalized);
      if (!milkChoice) {
        return undefined;
      }
      query = milkChoice;
      contextText = pendingMilk.original_text;
      quantity = quantityFromText(pendingMilk.original_text);
      const priceLimit = parsePriceLimit(pendingMilk.original_text);
      maxPriceCents = priceLimit?.cents;
      maxPriceInclusive = priceLimit?.inclusive ?? false;
    } else if (isGenericMilkRequest(normalized)) {
      if (extractCartRequests(normalized).length > 0) {
        const reply = "I couldn’t separate those items safely. Send a clear comma-separated list (for example “milk, bread, eggs”), and I’ll search them together. For milk by itself, I’ll ask which kind.";
        this.ctx.saveMessageReply(messageId, reply);
        return reply;
      }
      return undefined;
    } else {
      const requests = extractCartRequests(normalized);
      if (requests.length > 1) {
        const reply = "I couldn’t separate those items safely. Send a clear comma-separated list (for example “milk, bread, eggs”). I haven’t added anything.";
        this.ctx.saveMessageReply(messageId, reply);
        return reply;
      }
      query = retailerQuery(this.ctx.getMembers(), normalized);
      quantity = requests[0]?.quantity ?? quantityFromText(normalized);
      const priceLimit = parsePriceLimit(normalized);
      maxPriceCents = priceLimit?.cents;
      maxPriceInclusive = priceLimit?.inclusive ?? false;
    }

    // A bare number list (e.g. a stray “1, 1” with nothing pending) is not a product search.
    if (!query || query.length < 2 || !/\p{L}/u.test(query)) return undefined;

    let result: { total: number; products: KrogerProduct[] };
    try {
      result = await searchProducts(query);
    } catch (error) {
      const reply = `I couldn’t reach Kroger’s product search just now (${error instanceof Error ? error.message : "request failed"}). Nothing was added; please try again in a moment. Text “help” for available actions.`;
      this.ctx.saveMessageReply(messageId, reply);
      return reply;
    }

    const matchingProducts = result.products.filter((product) => meetsPriceLimit(product, maxPriceCents, maxPriceInclusive));
    const products = matchingProducts.slice(0, 5);
    this.ctx.db.exec("BEGIN IMMEDIATE");
    try {
      if (pendingMilk) this.m.cart.clearClarification(memberId);
      if (!products.length) {
        const cap = maxPriceCents === undefined ? "" : ` within your ${maxPriceInclusive ? "up-to" : "under"} ${money(maxPriceCents)} item budget`;
        const reply = `I couldn’t find matching products${cap} at the configured Kroger-family store for “${query}”. Try a different description or raise the item budget. Nothing was added. Text “help” for examples and available actions.`;
        this.ctx.recordReply(messageId, reply);
        this.ctx.db.exec("COMMIT");
        return reply;
      }

      // participant_ids_json is an informational snapshot only; the add uses
      // the sender's sharing session at the moment they pick a number.
      const participantIds = this.m.sharing.participantsFor(memberId);
      this.ctx.db.prepare(
        "INSERT INTO pending_product_choices (member_id, query, quantity, participant_ids_json, products_json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET query = excluded.query, quantity = excluded.quantity, participant_ids_json = excluded.participant_ids_json, products_json = excluded.products_json, created_at = excluded.created_at",
      ).run(memberId, query, quantity, JSON.stringify(participantIds), JSON.stringify(products), new Date().toISOString());
      const lines = products.map((product, index) => {
        const currentPrice = currentPriceCents(product);
        const price = currentPrice === null ? "price unavailable" : money(currentPrice);
        const sale = isCurrentPromo(product) && product.regularPriceCents !== null && product.promoPriceCents !== null && product.promoPriceCents < product.regularPriceCents
          ? ` (regular ${money(product.regularPriceCents)}${product.promoExpiresAt && !product.promoExpiresAt.startsWith("9999") ? `; sale ends ${product.promoExpiresAt.slice(0, 10)}` : ""})` : "";
        return `${index + 1}) ${product.description}${product.size ? ` · ${product.size}` : ""} — ${price}${sale}`;
      });
      const storeNote = locationId ? ` at the selected Kroger store (${locationId})` : "; choose a store to get local prices";
      const cap = maxPriceCents === undefined ? "" : ` (showing options ${maxPriceInclusive ? "up to" : "under"} ${money(maxPriceCents)} each)`;
      const reply = `Kroger found ${products.length} matching options${cap} for “${query}”${storeNote}:\n${lines.join("\n")}\nReply 1-${products.length} to add your choice to GroupCart, or “cancel”.${this.m.sharing.sharingNote(participantIds)}${this.m.sharing.legacyShareHint(contextText, memberId)}`;
      this.ctx.recordReply(messageId, reply);
      this.ctx.db.exec("COMMIT");
      return reply;
    } catch (error) { this.ctx.db.exec("ROLLBACK"); throw error; }
  }
}
