import {
  extractCartRequests,
  isGenericMilkRequest,
  money,
  resolveMilkChoice,
  unsupportedBrandedRequest,
  type Product,
} from "../cart.js";
import type { KrogerProduct } from "../kroger.js";
import { LIST_COMMAND_NAMES, LIST_LABELS, parseListCommand, type ListCommand, type ListKey } from "../lists.js";
import type { StoreContext, StoreModules } from "./context.js";
import {
  CART_COMMAND_PATTERN,
  PRICE_LIMIT_PATTERN,
  isHelpRequest,
  milkSearchQuery,
  parsePriceLimit,
  quantityFromText,
  retailerQuery,
} from "./parsing.js";
import { currentPriceCents, meetsPriceLimit } from "./pricing.js";
import type { BatchProductResult, ListRequest, PendingListSelection, ProductQuote, ProductQuoter } from "./types.js";

/** Recurring-list conversation: command routing, adding items (catalog or Kroger search), and pending selections. */
export class ListCommands {
  constructor(private readonly ctx: StoreContext, private readonly m: StoreModules) {}

  pendingListSelection(memberId: string): PendingListSelection | undefined {
    const row = this.ctx.db.prepare(
      "SELECT list_key, requests_json, results_json FROM pending_list_selections WHERE member_id = ?",
    ).get(memberId) as { list_key: ListKey; requests_json: string; results_json: string | null } | undefined;
    if (!row) return undefined;
    return {
      listKey: row.list_key,
      requests: JSON.parse(row.requests_json) as ListRequest[],
      results: row.results_json ? JSON.parse(row.results_json) as BatchProductResult[] : null,
    };
  }

  savePendingListSelection(memberId: string, selection: PendingListSelection): void {
    this.ctx.db.prepare(
      "INSERT INTO pending_list_selections (member_id, list_key, requests_json, results_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET list_key = excluded.list_key, requests_json = excluded.requests_json, results_json = excluded.results_json, created_at = excluded.created_at",
    ).run(memberId, selection.listKey, JSON.stringify(selection.requests), selection.results ? JSON.stringify(selection.results) : null, new Date().toISOString());
  }

  /**
   * One unfinished selection per member: starting a list selection discards any
   * unfinished cart selection so numbered replies can never go to the wrong place.
   */
  replaceOtherPendingSelections(memberId: string): string {
    const tables = ["pending_product_choices", "pending_product_batches", "pending_clarifications", "pending_item_cancellations"];
    let hadPending = false;
    for (const table of tables) {
      const result = this.ctx.db.prepare(`DELETE FROM ${table} WHERE member_id = ?`).run(memberId);
      if (Number(result.changes) > 0) hadPending = true;
    }
    return hadPending ? "(I discarded your unfinished cart selection.)\n" : "";
  }

  hasOtherPendingIntent(memberId: string): boolean {
    const tables = ["pending_product_choices", "pending_product_batches", "pending_clarifications", "pending_item_cancellations", "pending_list_selections"];
    if (tables.some((table) => this.ctx.db.prepare(`SELECT 1 FROM ${table} WHERE member_id = ?`).get(memberId))) return true;
    const checkout = this.m.checkout.getPendingKrogerCheckout();
    return checkout?.requesterId === memberId
      && (checkout.status === "choosing_account" || checkout.status === "awaiting_oauth");
  }

  /** Parse a list command, including bare “yes”/“cancel” replies to a pending list clear. */
  listCommandFor(memberId: string, text: string): ListCommand | undefined {
    const command = parseListCommand(text);
    if (command) return command;
    const bare = text.trim().replace(/[.!?]+$/, "").trim();
    if (!/^(yes|confirm|cancel|never mind|nevermind)$/i.test(bare)) return undefined;
    if (!this.ctx.db.prepare("SELECT 1 FROM pending_list_clears WHERE member_id = ?").get(memberId)) return undefined;
    if (this.m.cart.hasPendingClearAll(memberId) || this.hasOtherPendingIntent(memberId)) return undefined;
    return /^(yes|confirm)$/i.test(bare) ? { kind: "confirmClear" } : { kind: "cancelClear" };
  }

  /** Demo / sample-catalog mode. Runs inside processIncomingText's transaction. */
  catalogListTurn(memberId: string, text: string): string | undefined {
    const command = this.listCommandFor(memberId, text);
    if (command) return this.runListCommand(memberId, command, "catalog");
    const pending = this.pendingListSelection(memberId);
    if (!pending) return undefined;
    if (CART_COMMAND_PATTERN.test(text) || isHelpRequest(text) || (/^yes$/i.test(text) && this.m.cart.hasPendingClearAll(memberId))) {
      return undefined;
    }
    const label = LIST_LABELS[pending.listKey];
    if (/^(cancel|never mind|nevermind)$/i.test(text)) {
      this.ctx.db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
      return `Okay, nothing was added to the ${label} list.`;
    }
    if (pending.results) return this.saveListSelections(memberId, pending, text);
    const milk = resolveMilkChoice(text);
    if (!milk) {
      return `For the ${label} list: which kind of milk? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond, or “cancel”.`;
    }
    this.ctx.db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
    return this.saveCatalogListRequests(memberId, pending.listKey, pending.requests, milk);
  }

  async handleLiveListCommand(
    messageId: string,
    memberId: string,
    command: ListCommand,
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
    quoteProduct?: ProductQuoter,
  ): Promise<string | null> {
    if (command.kind === "add") {
      return this.liveListAdd(messageId, memberId, command.list, command.itemText, searchProducts, locationId);
    }
    if (command.kind === "load") {
      let quotes: Map<string, ProductQuote> | undefined;
      if (quoteProduct && !this.m.lists.listLoadBlocker(command.list, command.force)) {
        quotes = await this.m.lists.quoteListItems(command.list, quoteProduct);
      }
      return this.ctx.transactReply(messageId, () => this.m.lists.loadListIntoCart(memberId, command.list, command.force, quotes, Boolean(quoteProduct)));
    }
    return this.ctx.transactReply(messageId, () => this.runListCommand(memberId, command, "live"));
  }

  /** Synchronous list commands shared by demo and live mode; caller holds the transaction. */
  runListCommand(memberId: string, command: ListCommand, mode: "catalog" | "live"): string {
    switch (command.kind) {
      case "overview": return this.m.listText.formatListsOverview();
      case "setup": return this.m.listText.listSetupPrompt(mode);
      case "view": return this.m.listText.formatListView(command.list);
      case "add":
        if (mode === "live") throw new Error("Live list additions must use the Kroger search flow.");
        return this.catalogListAdd(memberId, command.list, command.itemText);
      case "remove": return this.m.lists.removeFromList(command.list, command.itemText);
      case "quantity": return this.m.lists.setListQuantity(command.list, command.itemText, command.quantity);
      case "clear": return this.m.lists.requestListClear(memberId, command.list);
      case "confirmClear": return this.m.lists.confirmListClear(memberId, command.list);
      case "cancelClear": return this.m.lists.cancelListClear(memberId, command.list);
      case "load": return this.m.lists.loadListIntoCart(memberId, command.list, command.force, undefined, false);
      case "start": return this.m.lists.startList(command.list);
      case "scheduleWeekday": return this.m.lists.setListWeekday(command.list, command.weekday);
      case "scheduleMonthDay": return this.m.lists.setListMonthDay(command.list, command.dayOfMonth);
      case "reminders": return this.m.lists.setListReminders(command.list, command.enabled);
    }
  }

  parseListRequests(list: ListKey, itemText: string): ListRequest[] | string {
    const label = LIST_LABELS[list];
    const segments = itemText.split(/\s*(?:,|;|\n)\s*|\s+and\s+|\s+&\s+/i)
      .map((segment) => segment.trim().replace(/^(?:and|&)\s+/i, "").replace(/[.!?]+$/g, "").trim())
      .filter(Boolean);
    if (!segments.length) return `Tell me what to add to the ${label} list, for example “${LIST_COMMAND_NAMES[list]}: milk, eggs, bread”.`;
    if (segments.length > 5) {
      return `I can save up to 5 items from one message. Nothing was added to the ${label} list; split it into smaller batches.`;
    }
    const requests = segments.map((segment): ListRequest => {
      const priceLimit = parsePriceLimit(segment);
      const itemPart = segment.replace(PRICE_LIMIT_PATTERN, " ").replace(/\s+/g, " ").trim();
      const extracted = extractCartRequests(itemPart);
      return {
        query: retailerQuery(this.ctx.getMembers(), itemPart),
        quantity: extracted.length === 1 ? extracted[0]!.quantity : quantityFromText(itemPart),
        ...(priceLimit ? { maxPriceCents: priceLimit.cents, maxPriceInclusive: priceLimit.inclusive } : {}),
      };
    });
    if (requests.some((request) => request.query.length < 2)) {
      return `I couldn’t tell which items to add. Nothing was added to the ${label} list. Try “${LIST_COMMAND_NAMES[list]}: milk, eggs, bread”.`;
    }
    return requests;
  }

  catalogListAdd(memberId: string, list: ListKey, itemText: string): string {
    const label = LIST_LABELS[list];
    const branded = unsupportedBrandedRequest(itemText);
    if (branded) {
      return `I heard “${branded}”, but live product lookup isn’t connected, so I didn’t save a substitute to the ${label} list.`;
    }
    const parsed = this.parseListRequests(list, itemText);
    if (typeof parsed === "string") return parsed;
    if (parsed.some((request) => isGenericMilkRequest(request.query))) {
      const replaced = this.replaceOtherPendingSelections(memberId);
      this.savePendingListSelection(memberId, { listKey: list, requests: parsed, results: null });
      return `${replaced}For the ${label} list: which kind of milk? Reply 1 for whole, 2 for 2%, 3 for oat, or 4 for almond, or “cancel”.`;
    }
    return this.saveCatalogListRequests(memberId, list, parsed);
  }

  saveCatalogListRequests(memberId: string, list: ListKey, requests: ListRequest[], milk?: Product): string {
    const label = LIST_LABELS[list];
    const resolved = requests.map((request) => ({
      request,
      product: milk && isGenericMilkRequest(request.query) ? milk : extractCartRequests(request.query)[0]?.product,
    }));
    const unmatched = resolved.filter((entry) => !entry.product).map((entry) => `“${entry.request.query}”`);
    if (unmatched.length) {
      return `I couldn’t match ${unmatched.join(" and ")} to the sample catalog, so nothing was saved to the ${label} list. Try milk, oat milk, eggs, bananas, pasta, tomato sauce, parmesan, bread, apples, or peanut butter.`;
    }
    const overCap = resolved.filter(({ request, product }) => request.maxPriceCents !== undefined
      && !(request.maxPriceInclusive ? product!.priceCents <= request.maxPriceCents : product!.priceCents < request.maxPriceCents));
    if (overCap.length) {
      return `${overCap.map(({ product, request }) => `${product!.name} (${money(product!.priceCents)} sample estimate) isn’t ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents!)}`).join("; ")}. Nothing was saved to the ${label} list.`;
    }
    const lines = resolved.map(({ request, product }) => {
      const outcome = this.m.lists.upsertListItem(list, memberId, {
        productId: product!.id,
        name: product!.name,
        quantity: request.quantity,
        unitPriceCents: product!.priceCents,
        priceSource: "sample",
        upc: null,
        size: null,
      });
      return `• ${request.quantity} × ${product!.name} — ${money(product!.priceCents * request.quantity)} sample estimate${outcome === "updated" ? " (updated the existing entry)" : ""}`;
    });
    return this.listSavedReply(list, lines);
  }

  async liveListAdd(
    messageId: string,
    memberId: string,
    list: ListKey,
    itemText: string,
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
  ): Promise<string | null> {
    const label = LIST_LABELS[list];
    const parsed = this.parseListRequests(list, itemText);
    if (typeof parsed === "string") return this.ctx.transactReply(messageId, () => parsed);
    if (parsed.some((request) => isGenericMilkRequest(request.query))) {
      return this.ctx.transactReply(messageId, () => {
        const replaced = this.replaceOtherPendingSelections(memberId);
        this.savePendingListSelection(memberId, { listKey: list, requests: parsed, results: null });
        const rest = parsed.length > 1 ? "; then I’ll show Kroger choices for every item" : "";
        return `${replaced}For the ${label} list: which kind of milk? Reply whole, 2%, oat, or almond${rest}. Or say “cancel”.`;
      });
    }
    return this.searchListRequests(messageId, memberId, list, parsed, searchProducts, locationId);
  }

  async searchListRequests(
    messageId: string,
    memberId: string,
    list: ListKey,
    requests: ListRequest[],
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
  ): Promise<string | null> {
    const label = LIST_LABELS[list];
    const optionLimit = requests.length === 1 ? 5 : 3;
    let results: BatchProductResult[];
    try {
      results = await Promise.all(requests.map(async (request) => {
        const result = await searchProducts(request.query);
        const matching = result.products.filter((product) => meetsPriceLimit(product, request.maxPriceCents, request.maxPriceInclusive ?? false));
        return { total: matching.length, products: matching.slice(0, optionLimit) };
      }));
    } catch (error) {
      return this.ctx.transactReply(messageId, () => {
        this.ctx.db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
        return `I couldn’t reach Kroger’s product search just now (${error instanceof Error ? error.message : "request failed"}). Nothing was saved to the ${label} list; please try again.`;
      });
    }
    const missing = requests.flatMap((request, index) => results[index]!.products.length ? [] : [
      request.maxPriceCents === undefined
        ? `“${request.query}”`
        : `“${request.query}” ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)}`,
    ]);
    if (missing.length) {
      return this.ctx.transactReply(messageId, () => {
        this.ctx.db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
        return `I couldn’t find Kroger products for ${missing.join(" and ")} at the configured store. Nothing was saved to the ${label} list. Try a more specific description or raise the item budget.`;
      });
    }
    return this.ctx.transactReply(messageId, () => {
      const replaced = this.replaceOtherPendingSelections(memberId);
      this.savePendingListSelection(memberId, { listKey: list, requests, results });
      const storeNote = locationId ? ` at the selected Kroger store (${locationId})` : "; choose a store to get local prices";
      const option = (product: KrogerProduct, index: number, indent: string): string => {
        const cents = currentPriceCents(product);
        return `${indent}${index + 1}) ${product.description}${product.size ? ` · ${product.size}` : ""} — ${cents === null ? "price unavailable" : money(cents)}`;
      };
      if (requests.length === 1) {
        const request = requests[0]!;
        const products = results[0]!.products;
        const cap = request.maxPriceCents === undefined ? "" : ` (showing options ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)} each)`;
        return `${replaced}For the ${label} list, Kroger found ${products.length} matching options${cap} for “${request.query}”${storeNote}:\n${products.map((product, index) => option(product, index, "")).join("\n")}\nReply 1-${products.length} to save your choice to the ${label} list, or “cancel”.`;
      }
      const sections = requests.map((request, index) => {
        const cap = request.maxPriceCents === undefined ? "" : ` · ${request.maxPriceInclusive ? "up to" : "under"} ${money(request.maxPriceCents)} each`;
        return `${index + 1}. ${request.quantity > 1 ? `${request.quantity} × ` : ""}${request.query}${cap} (${results[index]!.total} options)\n${results[index]!.products.map((product, optionIndex) => option(product, optionIndex, "   ")).join("\n")}`;
      });
      return `${replaced}For the ${label} list, I found options for your ${requests.length} items${storeNote}:\n${sections.join("\n")}\nReply with one choice number per item in order, separated by commas (for example “1, 2, 1”). Nothing is saved until all choices are selected. Reply “cancel” to discard this search.`;
    });
  }

  async continueLiveListSelection(
    messageId: string,
    memberId: string,
    text: string,
    pending: PendingListSelection,
    searchProducts: (query: string) => Promise<{ total: number; products: KrogerProduct[] }>,
    locationId?: string,
  ): Promise<string | null> {
    const label = LIST_LABELS[pending.listKey];
    if (/^(cancel|never mind|nevermind)$/i.test(text)) {
      return this.ctx.transactReply(messageId, () => {
        this.ctx.db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
        return `Okay, nothing was added to the ${label} list.`;
      });
    }
    if (!pending.results) {
      const milk = milkSearchQuery(this.ctx.getMembers(), text);
      if (!milk) {
        return this.ctx.transactReply(messageId, () => `For the ${label} list: which kind of milk? Reply whole, 2%, oat, or almond, or “cancel”.`);
      }
      const requests = pending.requests.map((request) => isGenericMilkRequest(request.query) ? { ...request, query: milk } : request);
      return this.searchListRequests(messageId, memberId, pending.listKey, requests, searchProducts, locationId);
    }
    return this.ctx.transactReply(messageId, () => this.saveListSelections(memberId, pending, text));
  }

  /** Save numbered Kroger choices from a pending selection to its list; caller holds the transaction. */
  saveListSelections(memberId: string, pending: PendingListSelection, text: string): string {
    const label = LIST_LABELS[pending.listKey];
    const results = pending.results ?? [];
    const numbers = text.match(/^\s*\d+(?:\s*(?:,|\s)\s*\d+)*\s*$/)?.[0].trim().split(/[\s,]+/).map(Number);
    const valid = numbers !== undefined
      && numbers.length === pending.requests.length
      && numbers.every((number, index) => Number.isInteger(number) && number >= 1 && number <= (results[index]?.products.length ?? 0));
    if (!valid) {
      return pending.requests.length === 1
        ? `Please reply with a number from 1 to ${results[0]?.products.length ?? 1}, or “cancel”. I’m still waiting to save your choice to the ${label} list.`
        : `Reply with one result number for each item, in order (for example “1, 2, 1”), or “cancel”. Nothing has been saved to the ${label} list yet.`;
    }
    this.ctx.db.prepare("DELETE FROM pending_list_selections WHERE member_id = ?").run(memberId);
    const lines = pending.requests.map((request, index) => {
      const product = results[index]!.products[numbers![index]! - 1]!;
      const cents = currentPriceCents(product);
      const outcome = this.m.lists.upsertListItem(pending.listKey, memberId, {
        productId: `kroger:${product.productId}`,
        name: product.description,
        quantity: request.quantity,
        unitPriceCents: cents,
        priceSource: "kroger",
        upc: product.upc,
        size: product.size,
      });
      const price = cents === null ? "no current store price (I’ll re-quote when the list is loaded)" : `${money(cents * request.quantity)} Kroger quote`;
      return `• ${request.quantity} × ${product.description}${product.size ? ` · ${product.size}` : ""} — ${price}${outcome === "updated" ? " (updated the existing entry)" : ""}`;
    });
    return this.listSavedReply(pending.listKey, lines);
  }

  listSavedReply(list: ListKey, lines: string[]): string {
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const activation = this.m.lists.activateList(list);
    const items = this.m.lists.listItems(list);
    const estimate = this.m.lists.listEstimate(items);
    return [
      `Saved to the household’s ${label} list:`,
      ...lines,
      `The ${label} list now has ${items.length} item${items.length === 1 ? "" : "s"} (about ${money(estimate.cents)}${estimate.unpriced ? `, plus ${estimate.unpriced} unpriced` : ""}).${activation ? ` ${activation}` : ""}`,
      `Text “${command} list” to review it or “load ${command} list” to add it to the cart.`,
    ].join("\n");
  }
}
