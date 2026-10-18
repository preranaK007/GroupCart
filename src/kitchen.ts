// Kitchen: the pantry (src/pantry.ts) and weekly dinner plans (src/meals.ts) in the group chat, the Groceries page's
// Pantry and Meals tabs (/api/kitchen*), and AI assistants (connector tools). index.ts calls setupKitchen(...) once.
//
// Boundaries with the rest of GroupCart:
//   - Cart changes go through the store's normal member request path (store.processIncomingText /
//     processLiveIncomingText as that member), so sharing sessions decide splits and undo/approvals work as usual.
//     With live Kroger search, items that need a product choice go on a one-off list ("Dinners this week",
//     src/namedLists.ts) instead of guessing; members send it to the cart with “dinners this week to cart”.
//   - The store's phrases (cart, sharing, recurring lists) never reach this module (index.ts routes them to the
//     store). Recurring lists are never written here; the pantry suggests the store command (“biweekly: olive oil”).
//   - A bare “yes”/“ok”/“no” is only claimed when this member's newest open question is a kitchen one: a pantry
//     cart offer or a dinner plan suggestion asked after any other feature's question (the pending-question
//     registry in src/platform.ts). Otherwise it falls through to the other features.
//   - Checkouts are observed, not hooked (the Splitwise service owns the store's checkout hooks): the cart is
//     remembered by revision, and when that revision is checked out its items become In stock in the pantry.
//   - Away status comes from the chores feature (read only); dietary notes from profiles (read only).
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { addDays, dayOfWeek, isDateString, mondayOf } from "./availability.js";
import { isGenericMilkRequest } from "./cart.js";
import { registerSummaryProvider } from "./coreTools.js";
import { CalendarService } from "./googleCalendar.js";
import type { KrogerClient } from "./kroger.js";
import { DIET_TAGS, MealsService, TAG_SHORT, WEEKDAY_SHORT, assignCooks, parseMealCommand, parseRecipeText, type DayRef, type MealCommand, type MealDay, type MealDraft, type RecipeView } from "./meals.js";
import { NamedListsService, cartRequestText } from "./namedLists.js";
import { PANTRY_STATUSES, PantryService, STATUS_LABEL, catalogProduct, itemKey, parsePantryCommand, splitItemNames, type PantryCommand, type PantryItem, type PantryStatus } from "./pantry.js";
import { notifyGroup, otherPendingQuestionAt, registerCommand, registerHelp, registerPendingQuestion, registerRoute, registerTools, requestMember, scheduleEvery, type CommandContext, type ToolCaller, type ToolSpec } from "./platform.js";
import { avatarFor } from "./profiles.js";
import type { CartStore } from "./store.js";

export type KitchenOptions = {
  store: CartStore;
  demoMode: boolean;
  /** Live Kroger product search (items that need a product choice go on a one-off list). */
  kroger?: KrogerClient;
  now?: () => number;
  timeZone?: string;
};

export type CartAddResult = {
  /** added: in the cart; choosing: the member was asked to pick products; listed: put on a one-off list only. */
  status: "added" | "choosing" | "listed" | "blocked" | "none";
  message: string;
  added: string[];
  listed: string[];
};

const AFFIRM = /^(?:y|ya|yes|yeah|yep|yup|sure|ok|okay|k|kk|yes please|sounds good|looks good|do it|go ahead|add it|add them|save it|lgtm|👍|✅)[!. ]*$/i;
const DECLINE = /^(?:n|no|nope|nah|no thanks|not now|nvm|never ?mind|cancel|don'?t)[!. ]*$/i;
/** A plan suggestion's “ok” window: the proposer for 12 hours, everyone else for 30 minutes after it was posted. */
const PROPOSER_WINDOW_MS = 12 * 3_600_000;
const OTHERS_WINDOW_MS = 30 * 60_000;
const DINNERS_LIST = "Dinners this week";
const RESTOCK_LIST = "Pantry restock";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** "Out of eggs", "Running low on rice", "Eggs back in stock" (no "eggs is out" agreement problems). */
const statusLine = (status: PantryStatus, label: string) => status === "out" ? `Out of ${label}` : status === "low" ? `Running low on ${label}` : `${capitalize(label)} back in stock`;
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export class Kitchen {
  readonly store: CartStore;
  readonly meals: MealsService;
  readonly pantry: PantryService;
  readonly lists: NamedListsService;
  readonly demoMode: boolean;
  readonly kroger: KrogerClient | undefined;

  constructor(options: KitchenOptions) {
    const timeZone = options.timeZone ?? CalendarService.serverTimeZone();
    this.store = options.store;
    this.demoMode = options.demoMode;
    this.kroger = options.kroger;
    this.pantry = new PantryService(options.store, { now: options.now });
    this.meals = new MealsService(options.store, { timeZone, now: options.now });
    this.meals.inStockKeys = () => this.pantry.inStockKeys();
    // One-off lists (src/namedLists.ts) for items that need a product choice; same tables as the Lists tab.
    this.lists = new NamedListsService(options.store, { timeZone, kroger: options.kroger, now: options.now });
    // A pantry cart offer or a dinner plan suggestion waits for a bare “yes”/“no”.
    registerPendingQuestion("kitchen", (memberId, kind) => kind === "ok" ? this.kitchenQuestion(memberId)?.at ?? null : null);
  }

  get mode(): "sample" | "kroger" {
    return this.kroger ? "kroger" : "sample";
  }

  #memberName(id: string): string {
    return this.meals.memberName(id);
  }

  // -------------------------------------------------------------------------
  // Checkout → pantry

  /**
   * Remembers the cart by revision; when that revision is checked out (the store's checked-out revision or the
   * checkout log), its items become In stock. Returns the pantry items that were restocked.
   */
  watchCheckouts(): string[] {
    const snapshot = this.store.snapshot();
    const logged = this.store.latestSplitwiseExpense()?.revision ?? 0;
    const done = Math.max(snapshot.checkedOutRevision ?? 0, logged);
    const seenValue = this.pantry.meta("checkout_seen");
    let restocked: string[] = [];
    if (seenValue === undefined) {
      this.pantry.setMeta("checkout_seen", String(done));
    } else if (done > Number(seenValue)) {
      const cache = JSON.parse(this.pantry.meta("cart_cache") ?? "null") as { revision: number; names: string[] } | null;
      if (cache && cache.revision === done) restocked = this.pantry.purchased(cache.names);
      this.pantry.setMeta("checkout_seen", String(done));
    }
    if (snapshot.items.length) {
      const cached = JSON.parse(this.pantry.meta("cart_cache") ?? "null") as { revision: number } | null;
      if (cached?.revision !== snapshot.revision) {
        this.pantry.setMeta("cart_cache", JSON.stringify({ revision: snapshot.revision, names: snapshot.items.map((item) => item.name) }));
      }
    }
    return restocked;
  }

  // -------------------------------------------------------------------------
  // Group chat

  /** Replies to kitchen commands, or null so the message continues to other features and the cart. */
  async handle(context: CommandContext): Promise<string | null> {
    const text = context.text.trim();
    if (!text) return null;
    const meal = parseMealCommand(text);
    if (meal) return this.#once(context, () => this.#meal(meal, context));
    const pantry = parsePantryCommand(text);
    if (pantry) return this.#once(context, () => this.#pantry(pantry, context));
    if (AFFIRM.test(text) || DECLINE.test(text)) {
      // A redelivered reply gets the reply it got the first time (whichever feature answered it).
      const recorded = this.store.recordedReply(context.messageId);
      if (recorded) return recorded;
      return this.#answer(context, AFFIRM.test(text));
    }
    return null;
  }

  async #once(context: CommandContext, produce: () => Promise<string | null> | string | null): Promise<string | null> {
    const recorded = this.store.recordedReply(context.messageId);
    if (recorded !== undefined) return recorded;
    this.watchCheckouts();
    const reply = await produce();
    if (reply) this.store.recordCommandReply(context.messageId, reply);
    return reply;
  }

  /** The kitchen question a bare yes/no from this member would answer: their cart offer or a plan suggestion. */
  kitchenQuestion(memberId: string): { kind: "pantry" | "plan"; at: string } | null {
    const candidates: Array<{ kind: "pantry" | "plan"; at: string }> = [];
    const offer = this.pantry.pendingOffer(memberId);
    if (offer) candidates.push({ kind: "pantry", at: offer.createdAt });
    const draft = this.meals.draft();
    if (draft) {
      const age = this.meals.now() - Date.parse(draft.createdAt);
      if (age < (draft.proposerId === memberId ? PROPOSER_WINDOW_MS : OTHERS_WINDOW_MS)) candidates.push({ kind: "plan", at: draft.createdAt });
    }
    return candidates.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  }

  async #answer(context: CommandContext, yes: boolean): Promise<string | null> {
    const question = this.kitchenQuestion(context.memberId);
    if (!question) return null;
    const other = otherPendingQuestionAt("kitchen", context.memberId, "ok");
    if (other && other >= question.at) return null; // a newer grocery, bill, or house question owns this reply
    return this.#once(context, async () => {
      if (question.kind === "plan") {
        if (!yes) { this.meals.discardDraft(); return "Okay, dropped that plan. “plan dinners” for another."; }
        const result = this.meals.acceptDraft(context.memberId);
        return result.ok ? this.savedPlanText(result.weekStart, result.days) : result.error;
      }
      if (!yes) { this.pantry.clearOffer(context.memberId); return "Okay, not adding it."; }
      const offer = this.pantry.pendingOffer(context.memberId)!;
      const result = await this.addToCart(context.memberId, this.pantry.namesFor(offer.keys).map((name) => ({ name, quantity: 1 })), `kitchen:${context.messageId}`, RESTOCK_LIST);
      if (result.status !== "blocked") this.pantry.clearOffer(context.memberId);
      return result.message;
    });
  }

  #date(day: DayRef): string {
    const today = this.meals.today();
    if (day.kind === "today") return today;
    if (day.kind === "tomorrow") return addDays(today, 1);
    const inDraft = this.meals.draftDate(day.weekday);
    if (inDraft && inDraft >= today) return inDraft;
    return addDays(today, (day.weekday - dayOfWeek(today) + 7) % 7);
  }

  #dayName(date: string): string {
    const today = this.meals.today();
    if (date === today) return "tonight";
    if (date === addDays(today, 1)) return "tomorrow";
    return WEEKDAY_SHORT[dayOfWeek(date)]!;
  }

  #findMember(name: string): { id: string; name: string } | null {
    const wanted = name.toLowerCase();
    const members = this.meals.members();
    return members.find((member) => member.name.toLowerCase() === wanted)
      ?? members.find((member) => firstName(member.name).toLowerCase() === wanted)
      ?? (members.filter((member) => member.name.toLowerCase().startsWith(wanted)).length === 1 ? members.find((member) => member.name.toLowerCase().startsWith(wanted))! : null);
  }

  async #meal(command: MealCommand, context: CommandContext): Promise<string | null> {
    const memberId = context.memberId;
    const meals = this.meals;
    switch (command.kind) {
      case "show": return this.upcomingText();
      case "plan": {
        const thisWeek = mondayOf(meals.today());
        const weekStart = command.week === "this" ? thisWeek : command.week === "next" ? addDays(thisWeek, 7) : undefined;
        const result = meals.propose({ weekStart, weekdays: command.weekdays, proposerId: memberId });
        return result.ok ? this.draftText(result.draft) : result.error;
      }
      case "tonight": return this.nightText(this.#date(command.day));
      case "addRecipe": {
        const parsed = parseRecipeText(command.body);
        const result = meals.addRecipe({ ...parsed, createdBy: memberId });
        if (!result.ok) return result.error;
        const recipe = result.recipe;
        const warn = recipe.conflicts.length ? `\n⚠ Not for ${recipe.conflicts.map((conflict) => `${firstName(conflict.name)} (${conflict.labels.join(", ")})`).join(", ")}.` : "";
        return `📖 ${result.updated ? "Updated" : "Saved"} ${recipe.emoji} ${recipe.name}: ${recipe.ingredients.join(", ")}.${warn}`;
      }
      case "recipes": {
        const recipes = meals.recipes();
        return `📖 ${recipes.length} recipes: ${recipes.map((recipe) => `${recipe.emoji} ${recipe.name}`).join(", ")}.\nAdd yours: “add recipe tacos: tortillas, ground beef, salsa”.`;
      }
      case "deleteRecipe": {
        const recipe = meals.findRecipe(command.name);
        if (!recipe) return `I couldn’t find a recipe called “${command.name}”.`;
        if (recipe.builtin) return `${recipe.emoji} ${recipe.name} is built in, so it stays. The planner skips it if it doesn’t suit everyone.`;
        meals.deleteRecipe(recipe.id);
        return `Deleted ${recipe.emoji} ${recipe.name}.`;
      }
      case "cook": {
        const date = this.#date(command.day);
        const who = command.who === "me" ? { id: memberId, name: this.#memberName(memberId) } : this.#findMember(command.who);
        if (!who) return `Who’s “${command.who}”? Cooks: ${meals.members().map((member) => firstName(member.name)).join(", ")}.`;
        const result = meals.setCook(date, who.id, memberId);
        if (!result.ok) return result.error;
        const recipe = result.day.recipe ? `: ${result.day.recipe.emoji} ${result.day.recipe.name}` : ". No recipe yet; “swap " + (date === meals.today() ? "tonight" : WEEKDAY_SHORT[dayOfWeek(date)]!.toLowerCase()) + "” picks one";
        const was = result.previous && result.previous !== who.id ? ` (was ${firstName(this.#memberName(result.previous))})` : "";
        return `👩‍🍳 ${firstName(who.name)} cooks ${this.#dayName(date)}${recipe}${was}.`;
      }
      case "swap": {
        const date = this.#date(command.day);
        const result = meals.swap(date, { recipeQuery: command.recipe, actorId: memberId });
        if (!result.ok) return result.error;
        const line = this.dayLine(result.day);
        return result.inDraft ? `${line}\nReply “ok” to save the plan, or swap again.` : `Updated: ${line}`;
      }
      case "off": {
        const date = this.#date(command.day);
        meals.setNight(date, { off: true }, memberId);
        return `${capitalize(this.#dayName(date))}: no dinner planned.`;
      }
      case "shop": return (await this.shopForMeals(memberId, `kitchen:${context.messageId}`)).message;
      case "accept": {
        const result = meals.acceptDraft(memberId);
        return result.ok ? this.savedPlanText(result.weekStart, result.days) : result.error;
      }
    }
  }

  #pantry(command: PantryCommand, context: CommandContext): string | null {
    const pantry = this.pantry;
    if (command.kind === "show") return this.pantryText();
    const known = pantry.knownKeys();
    const names = splitItemNames(command.text, known);
    if (!names.length) return null;
    // "got eggs" counts only for things we track (or sample-catalog groceries), so "got it" isn't an item.
    if (!command.explicit && !names.every((name) => known.has(itemKey(name)) || pantry.find(name) || catalogProduct(name))) return null;
    const items = names.map((name) => pantry.set(name, command.status, context.memberId).item);
    const label = joinNames(items.map((item) => item.name.toLowerCase()));
    if (command.status === "stock") {
      pantry.clearOffer(context.memberId, items.map((item) => item.key));
      return `✓ ${statusLine("stock", label)}.`;
    }
    const inCart = pantry.cartKeys();
    const offer = items.filter((item) => !inCart.has(item.key));
    const already = items.filter((item) => inCart.has(item.key));
    let line = `🫙 ${statusLine(command.status, label)}.`;
    if (offer.length) {
      pantry.offer(context.memberId, offer.map((item) => item.key), context.messageId);
      line += ` Add ${offer.length === 1 ? (already.length ? offer[0]!.name.toLowerCase() : "it") : "them"} to the cart? Reply “yes”.`;
    }
    if (already.length) line += already.length === items.length ? " Already in the cart." : ` Already in the cart: ${joinNames(already.map((item) => item.name.toLowerCase()))}.`;
    const suggestions = items.map((item) => pantry.chatSuggestion(item)).filter((value): value is string => Boolean(value));
    return [line, ...suggestions].join("\n");
  }

  // -------------------------------------------------------------------------
  // Cart (always through the store's member request path)

  async #send(messageId: string, memberId: string, text: string): Promise<string> {
    const kroger = this.kroger;
    const reply = kroger
      ? await this.store.processLiveIncomingText(messageId, memberId, text, (query) => kroger.searchProducts(query), kroger.selectedLocationId)
      : this.store.processIncomingText(messageId, memberId, text);
    return reply ?? "";
  }

  #appendToList(listName: string, names: readonly string[], memberId: string | null): string[] {
    if (!names.length) return [];
    let list = this.lists.findList(listName);
    if (!list) {
      const created = this.lists.createList({ name: listName, items: [], createdBy: memberId, emoji: listName === DINNERS_LIST ? "🍽️" : "🫙" });
      if (!created.ok) return [];
      list = created.list;
    }
    this.lists.addItems(list.id, [...names], memberId);
    return [...names];
  }

  /**
   * Adds groceries to the shared cart as `memberId`, as if they had texted them: sample-catalog items in one
   * request (one cart revision and undo step, split by their sharing session); live Kroger search asks the member
   * to pick products (up to five per message). Anything else goes on the one-off list `listName`.
   */
  async addToCart(memberId: string, entries: ReadonlyArray<{ name: string; quantity: number }>, messageId: string, listName: string): Promise<CartAddResult> {
    const blocked = (message: string): CartAddResult => ({ status: "blocked", message, added: [], listed: [] });
    if (!entries.length) return { status: "none", message: "Nothing to add.", added: [], listed: [] };
    if (this.store.pendingKrogerCheckout()) return blocked("The cart is locked while a Kroger checkout is in progress. Try again after it finishes.");
    if (this.store.pendingQuestionAt(memberId)) return blocked(`${firstName(this.#memberName(memberId))}, answer your open grocery question first (or text “cancel”), then try again.`);
    const before = this.store.snapshot();
    const listedNote = (names: readonly string[]) => names.length ? `📝 On “${listName}”: ${names.map((name) => name.toLowerCase()).join(", ")}.` : "";

    if (this.kroger) {
      const batch = entries.slice(0, 5);
      const rest = entries.slice(5).map((entry) => entry.name);
      const text = `add ${batch.map((entry) => cartRequestText(`${entry.quantity > 1 ? `${entry.quantity} ` : ""}${entry.name.toLowerCase()}`).replace(/^add /, "")).join(", ")}`;
      const reply = await this.#send(messageId, memberId, text);
      const listed = this.#appendToList(listName, rest, memberId);
      const added = this.store.snapshot().revision !== before.revision;
      this.watchCheckouts();
      return { status: added ? "added" : "choosing", message: [reply, listedNote(listed)].filter(Boolean).join("\n"), added: added ? batch.map((entry) => entry.name) : [], listed };
    }

    const matched: Array<{ text: string; name: string }> = [];
    const unmatched: string[] = [];
    for (const entry of entries) {
      const product = catalogProduct(entry.name);
      if (product && !isGenericMilkRequest(entry.name)) matched.push({ text: `${entry.quantity > 1 ? `${entry.quantity} ` : ""}${product.aliases[0]}`, name: product.name });
      else unmatched.push(entry.name);
    }
    let addedLine = "";
    let added: string[] = [];
    if (matched.length) {
      const reply = await this.#send(messageId, memberId, `add ${matched.map((entry) => entry.text).join(", ")}`);
      const after = this.store.snapshot();
      const fresh = after.items.filter((item) => !before.items.some((old) => old.id === item.id));
      if (fresh.length) {
        added = fresh.map((item) => item.name);
        const people = fresh[0]!.participantNames;
        addedLine = `🛒 Added ${fresh.length}: ${fresh.map((item) => `${item.quantity > 1 ? `${item.quantity} ` : ""}${item.name.toLowerCase()}`).join(", ")} (${people.length > 1 ? `shared: ${people.map(firstName).join(", ")}` : `for ${firstName(people[0] ?? this.#memberName(memberId))}`}).`;
      } else {
        unmatched.push(...matched.map((entry) => entry.name));
        if (reply && !unmatched.length) addedLine = reply;
      }
    }
    const listed = this.#appendToList(listName, unmatched, memberId);
    this.watchCheckouts();
    const message = [addedLine, listedNote(listed)].filter(Boolean).join("\n") || "Nothing could be added.";
    return { status: added.length ? "added" : listed.length ? "listed" : "none", message, added, listed };
  }

  /** Ingredients for the next week's saved dinners, minus pantry In stock and what's already in the cart. */
  shoppingPreview(): { dinners: MealDay[]; lines: ReturnType<MealsService["shoppingList"]>["lines"] } {
    return this.meals.shoppingList({ inStock: this.pantry.inStockKeys(), inCart: this.pantry.cartKeys() });
  }

  /** “shop for meals”: adds the week's ingredients as `memberId` (live Kroger: onto “Dinners this week”). */
  async shopForMeals(memberId: string, messageId: string): Promise<CartAddResult & { dinners: number; skipped: string[] }> {
    const { dinners, lines } = this.shoppingPreview();
    const skipped = lines.filter((line) => line.status === "pantry").map((line) => line.name);
    const done = (result: CartAddResult) => ({ ...result, dinners: dinners.length, skipped });
    if (!dinners.length) return done({ status: "none", message: "No dinners planned for the next week. Text “plan dinners” first.", added: [], listed: [] });
    const toAdd = lines.filter((line) => line.status === "add");
    const skipNote = skipped.length ? `Skipped (in the pantry): ${skipped.map((name) => name.toLowerCase()).join(", ")}.` : "";
    if (!toAdd.length) return done({ status: "none", message: `✓ Everything for ${dinners.length} dinner${dinners.length === 1 ? "" : "s"} is in the pantry or the cart.`, added: [], listed: [] });
    if (this.kroger) {
      const listed = this.#appendToList(DINNERS_LIST, toAdd.map((line) => line.quantity > 1 ? `${line.quantity} ${line.name.toLowerCase()}` : line.name), memberId);
      return done({ status: "listed", message: [`📝 Put ${listed.length} on “${DINNERS_LIST}” for ${dinners.length} dinners. Text “${DINNERS_LIST.toLowerCase()} to cart” to pick products.`, skipNote].filter(Boolean).join("\n"), added: [], listed });
    }
    const result = await this.addToCart(memberId, toAdd.map((line) => ({ name: line.name, quantity: line.quantity })), messageId, DINNERS_LIST);
    return done({ ...result, message: [result.message, result.status === "blocked" ? "" : skipNote].filter(Boolean).join("\n") });
  }

  // -------------------------------------------------------------------------
  // Reply text

  weekLabel(weekStart: string): string {
    const format = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
    const end = addDays(weekStart, 6);
    return weekStart.slice(5, 7) === end.slice(5, 7)
      ? `${format(weekStart, { month: "short", day: "numeric" })}–${format(end, { day: "numeric" })}`
      : `${format(weekStart, { month: "short", day: "numeric" })} – ${format(end, { month: "short", day: "numeric" })}`;
  }

  dayLine(day: MealDay): string {
    const recipe = day.recipe ? `${day.recipe.emoji} ${day.recipe.name}` : "(no recipe yet)";
    const cook = day.cookId ? ` · ${firstName(this.#memberName(day.cookId))}` : "";
    const warn = day.recipe?.conflicts.length ? ` ⚠ ${day.recipe.conflicts.map((conflict) => firstName(conflict.name)).join(", ")}` : "";
    return `${day.dow} ${recipe}${cook}${warn}${day.isToday ? " (tonight)" : ""}`;
  }

  draftText(draft: MealDraft): string {
    const lines = draft.days.filter((day) => day.planned).map((day) => this.dayLine(day));
    const example = draft.days.find((day) => day.planned && !day.isToday) ?? draft.days.find((day) => day.planned);
    return `🍽️ Suggested dinners, ${this.weekLabel(draft.weekStart)}:\n${lines.join("\n")}\nReply “ok” to save, or “swap ${(example?.dow ?? "tue").toLowerCase()}”.`;
  }

  savedPlanText(weekStart: string, days: readonly MealDay[]): string {
    const lines = days.filter((day) => day.planned).map((day) => this.dayLine(day));
    return `✓ Saved dinners, ${this.weekLabel(weekStart)}:\n${lines.join("\n")}\n“shop for meals” adds the ingredients to the cart.`;
  }

  upcomingText(): string {
    const today = this.meals.today();
    const days = Array.from({ length: 7 }, (_, offset) => this.meals.night(addDays(today, offset))).filter((day) => day.planned);
    const draft = this.meals.draft();
    const parts: string[] = [];
    if (days.length) parts.push(`🍽️ Next dinners:\n${days.map((day) => this.dayLine(day)).join("\n")}`);
    if (draft) parts.push(this.draftText(draft));
    if (!parts.length) return "No dinners planned. Text “plan dinners” for a suggested week.";
    return parts.join("\n\n");
  }

  nightText(date: string): string {
    const day = this.meals.night(date);
    const when = this.#dayName(date);
    if (!day.planned || (!day.recipe && !day.cookId)) {
      const next = Array.from({ length: 7 }, (_, offset) => this.meals.night(addDays(date, offset + 1))).find((entry) => entry.recipe);
      return `Nothing planned ${when}.${next ? ` Next: ${this.dayLine(next)}.` : ""} Text “plan dinners” or “I’ll cook ${when === "tonight" ? "tonight" : when.toLowerCase()}”.`;
    }
    const cook = day.cookId ? ` · ${firstName(this.#memberName(day.cookId))} cooks` : "";
    const recipe = day.recipe ? `${day.recipe.emoji} ${day.recipe.name}` : "No recipe yet";
    const status = this.pantry.statusByKey();
    const short = day.recipe ? day.recipe.ingredients.filter((ingredient) => { const value = status.get(itemKey(ingredient)); return value === "out" || value === "low"; }) : [];
    const warn = day.recipe?.conflicts.length ? `\n⚠ Not for ${day.recipe.conflicts.map((conflict) => `${firstName(conflict.name)} (${conflict.labels.join(", ")})`).join(", ")}.` : "";
    return `🍽️ ${capitalize(when)}: ${recipe}${cook}.${short.length ? ` Low/out: ${short.join(", ")}.` : ""}${warn}`;
  }

  pantryText(): string {
    const items = this.pantry.items();
    if (!items.length) return "🫙 The pantry is empty. Tell me when you run out: “out of olive oil”, “low on rice”.";
    const by = (status: PantryStatus) => items.filter((item) => item.status === status).map((item) => item.name.toLowerCase());
    const out = by("out");
    const low = by("low");
    const stock = by("stock");
    return [
      "🫙 Pantry",
      out.length ? `Out: ${out.join(", ")}` : "",
      low.length ? `Low: ${low.join(", ")}` : "",
      stock.length ? `In stock: ${stock.length > 8 ? `${stock.slice(0, 8).join(", ")} +${stock.length - 8}` : stock.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  }

  // -------------------------------------------------------------------------
  // JSON for the web app and tools

  recipeJson(recipe: RecipeView) {
    return { id: recipe.id, name: recipe.name, emoji: recipe.emoji, ingredients: recipe.ingredients, builtin: recipe.builtin, tags: recipe.tags, contains: recipe.contains, conflicts: recipe.conflicts };
  }

  dayJson(day: MealDay) {
    return { date: day.date, dow: day.dow, day: day.day, isToday: day.isToday, isPast: day.isPast, planned: day.planned, cookId: day.cookId, recipe: day.recipe ? this.recipeJson(day.recipe) : null };
  }

  state(weekParam?: string | null) {
    this.watchCheckouts();
    const meals = this.meals;
    const today = meals.today();
    const people = meals.people();
    const draft = meals.draft(people);
    const fallbackWeek = draft?.weekStart ?? (meals.week(mondayOf(today), people).some((day) => day.planned && !day.isPast) ? mondayOf(today) : meals.targetWeek());
    const weekStart = weekParam && isDateString(weekParam) ? mondayOf(weekParam) : fallbackWeek;
    const away = meals.awayUntil();
    const preview = this.shoppingPreview();
    return {
      demoMode: this.demoMode,
      mode: this.mode,
      today,
      members: meals.members().map((member) => ({ ...member, ...avatarFor(member.id), away: meals.isAway(member.id, today, away), diet: people.find((person) => person.id === member.id)?.notes ?? "" })),
      pantry: { items: this.pantry.list() },
      meals: {
        weekStart,
        weekLabel: this.weekLabel(weekStart),
        thisWeek: mondayOf(today),
        targetWeek: meals.targetWeek(),
        nights: meals.nights(),
        days: meals.week(weekStart, people).map((day) => this.dayJson(day)),
        draft: draft ? { weekStart: draft.weekStart, weekLabel: this.weekLabel(draft.weekStart), proposerId: draft.proposerId, days: draft.days.map((day) => this.dayJson(day)) } : null,
      },
      recipes: meals.recipes(people).map((recipe) => this.recipeJson(recipe)),
      tags: DIET_TAGS.map((tag) => ({ tag, short: TAG_SHORT[tag] })),
      shopping: { dinners: preview.dinners.length, lines: preview.lines },
    };
  }

  tonight() {
    const day = this.meals.night(this.meals.today());
    if (!day.planned || (!day.recipe && !day.cookId)) return null;
    return {
      date: day.date,
      recipe: day.recipe ? { name: day.recipe.name, emoji: day.recipe.emoji } : null,
      cook: day.cookId ? { id: day.cookId, name: firstName(this.#memberName(day.cookId)), ...avatarFor(day.cookId) } : null,
    };
  }

  // -------------------------------------------------------------------------
  // Demo seed (demo mode only, once per database)

  seedDemo(): boolean {
    const { pantry, meals, store } = this;
    if (pantry.meta("demo_seeded")) return false;
    const members = store.getMembers();
    if (members.length < 2) return false;
    if (pantry.items().length || meals.week(mondayOf(meals.today())).some((day) => day.planned)) {
      pantry.setMeta("demo_seeded", "skipped");
      return false;
    }
    pantry.setMeta("demo_seeded", new Date(meals.now()).toISOString());
    // Cast from the roster in order (any names); with two members the third role repeats the first.
    const cast = (index: number) => members[index % members.length]!.id;
    const [one, two, three] = [cast(0), cast(1), cast(2)];
    const ago = (days: number) => new Date(meals.now() - days * 86_400_000).toISOString();

    // Pantry: what's at home, plus run-out history so cadence suggestions show (olive oil ~2 weeks, coffee weekly).
    for (const name of ["Garlic", "Onions", "Pasta", "Tomato sauce", "Soy sauce", "Peanut butter", "Butter", "Black beans", "Tortillas", "Curry paste", "Frozen peas", "Chili powder", "Bread", "Salsa", "Carrots", "Salt"]) pantry.set(name, "stock", one);
    pantry.set("Rice", "low", three);
    pantry.set("Olive oil", "low", two);
    for (const name of ["Eggs", "Coffee", "Avocados"]) pantry.set(name, "out", three);
    for (const days of [42, 28, 14]) { pantry.logEvent(itemKey("olive oil"), "out", ago(days), three); pantry.logEvent(itemKey("olive oil"), "purchase", ago(days - 2)); }
    for (const days of [21, 14, 7]) { pantry.logEvent(itemKey("coffee"), "out", ago(days), one); pantry.logEvent(itemKey("coffee"), "purchase", ago(days - 1)); }

    // Meals: this week planned every night with recipes that suit everyone; tacos tonight, cooked by the third member.
    const today = meals.today();
    const monday = mondayOf(today);
    const dates = Array.from({ length: 7 }, (_, offset) => addDays(monday, offset));
    const order = ["b:lentil-soup", "b:veggie-fried-rice", "b:chickpea-curry", "b:tofu-stir-fry", "b:peanut-noodles", "b:black-bean-tacos", "b:shakshuka"];
    const shift = (order.indexOf("b:black-bean-tacos") - dates.indexOf(today) + 7) % 7;
    const sunday = dates[6]!;
    const cooks = assignCooks({ dates, memberIds: members.map((member) => member.id), history: [], fixed: new Map([[today, three], ...(sunday !== today ? [[sunday, one] as [string, string]] : [])]) });
    dates.forEach((date, index) => meals.setNight(date, { recipeId: order[(index + shift) % 7]!, cookId: cooks.get(date) ?? null }, one));
    return true;
  }

  // -------------------------------------------------------------------------
  // Connector tools

  tools(): ToolSpec[] {
    const meals = this.meals;
    const pantry = this.pantry;
    const via = (caller: ToolCaller) => `${caller.memberName} via ${caller.via ?? "AI assistant"}`;
    const weekFrom = (value: unknown): string | undefined => {
      const today = meals.today();
      if (value === "this") return mondayOf(today);
      if (value === "next") return addDays(mondayOf(today), 7);
      return typeof value === "string" && isDateString(value) ? mondayOf(value) : undefined;
    };
    const weekdaysFrom = (value: unknown): number[] | null => {
      if (!Array.isArray(value)) return null;
      const days = value.map((entry) => WEEKDAY_SHORT.findIndex((name) => String(entry).toLowerCase().startsWith(name.toLowerCase()))).filter((day) => day >= 0);
      return days.length ? days : null;
    };
    const dayOut = (day: MealDay) => ({ date: day.date, day: day.dow, recipe: day.recipe?.name ?? null, emoji: day.recipe?.emoji ?? null, cook: day.cookId ? this.#memberName(day.cookId) : null, notFor: day.recipe?.conflicts.map((conflict) => `${conflict.name} (${conflict.labels.join(", ")})`) ?? [] });
    const statusFrom = (value: unknown): PantryStatus | null => value === "in_stock" || value === "stock" ? "stock" : value === "low" ? "low" : value === "out" ? "out" : null;
    return [
      {
        name: "get_meal_plan",
        description: "Show the household's dinner plan for a week (recipe and cook per night, with dietary warnings), tonight's dinner, any suggested plan waiting for an \"ok\", and the shopping list for the next week's dinners.",
        inputSchema: { type: "object", properties: { week: { type: "string", description: "\"this\", \"next\", or a YYYY-MM-DD date in that week. Default: this week." } } },
        handler: (args) => {
          const weekStart = weekFrom(args.week) ?? mondayOf(meals.today());
          const draft = meals.draft();
          const preview = this.shoppingPreview();
          return {
            week: this.weekLabel(weekStart), weekStart,
            nights: meals.week(weekStart).filter((day) => day.planned).map(dayOut),
            tonight: this.tonight(),
            suggestedPlan: draft ? { week: this.weekLabel(draft.weekStart), nights: draft.days.filter((day) => day.planned).map(dayOut) } : null,
            shoppingList: preview.lines.map((line) => ({ item: line.name, quantity: line.quantity, for: line.meals, status: line.status === "add" ? "to buy" : line.status === "pantry" ? "in pantry" : "in cart" })),
          };
        },
      },
      {
        name: "plan_week_meals",
        description: "Suggest dinners for a week: picks recipes that suit everyone's dietary notes (using what's in the pantry) and rotates cooks fairly, skipping anyone away. Saves only with save=true (and announces it to the group); otherwise it's a suggestion members accept by replying \"ok\" in the group. With save=true and no other options, an existing suggestion is saved as is.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            week: { type: "string", description: "\"this\", \"next\", or a YYYY-MM-DD date. Default: this week while two or more planned nights remain, else next week." },
            nights: { type: "array", items: { type: "string" }, description: "Weekdays to plan, e.g. [\"mon\",\"tue\",\"thu\"]. Default: the household's usual nights." },
            save: { type: "boolean", default: false },
          },
        },
        handler: async (args, caller) => {
          const weekdays = weekdaysFrom(args.nights);
          const existing = meals.draft();
          if (args.save === true && existing && !weekdays && args.week === undefined) {
            const accepted = meals.acceptDraft(caller.memberId);
            if (!accepted.ok) return { ok: false, error: accepted.error };
            await notifyGroup(`${via(caller)}: ${this.savedPlanText(accepted.weekStart, accepted.days)}`);
            return { ok: true, saved: true, week: this.weekLabel(accepted.weekStart), nights: accepted.days.filter((day) => day.planned).map(dayOut) };
          }
          const result = meals.propose({ weekStart: weekFrom(args.week), weekdays, proposerId: caller.memberId });
          if (!result.ok) return { ok: false, error: result.error };
          if (args.save !== true) return { ok: true, saved: false, week: this.weekLabel(result.draft.weekStart), nights: result.draft.days.filter((day) => day.planned).map(dayOut), note: "Suggestion only. Call again with save=true, or a member replies \"ok\" in the group." };
          const accepted = meals.acceptDraft(caller.memberId);
          if (!accepted.ok) return { ok: false, error: accepted.error };
          await notifyGroup(`${via(caller)}: ${this.savedPlanText(accepted.weekStart, accepted.days)}`);
          return { ok: true, saved: true, week: this.weekLabel(accepted.weekStart), nights: accepted.days.filter((day) => day.planned).map(dayOut) };
        },
      },
      {
        name: "add_recipe",
        description: "Save a household recipe (name and ingredient list) for the meal planner. Diet tags (vegan, vegetarian, gluten-free, dairy-free, nut-free) and conflicts with members' dietary notes are worked out from the ingredients. Saving a recipe with an existing household recipe's name updates it.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "e.g. \"Tacos\"." },
            ingredients: { type: "array", items: { type: "string" }, minItems: 1, description: "Grocery names, e.g. [\"tortillas\", \"ground beef\", \"salsa\", \"cheese\"]." },
            emoji: { type: "string" },
          },
          required: ["name", "ingredients"],
        },
        handler: (args, caller) => {
          const ingredients = Array.isArray(args.ingredients) ? args.ingredients.filter((value): value is string => typeof value === "string") : [];
          const result = meals.addRecipe({ name: String(args.name ?? ""), ingredients, emoji: typeof args.emoji === "string" ? args.emoji : null, createdBy: caller.memberId });
          if (!result.ok) return { ok: false, error: result.error };
          return { ok: true, updated: result.updated, recipe: { name: result.recipe.name, emoji: result.recipe.emoji, ingredients: result.recipe.ingredients, tags: result.recipe.tags, notFor: result.recipe.conflicts.map((conflict) => `${conflict.name} (${conflict.labels.join(", ")})`) } };
        },
      },
      {
        name: "shop_for_meals",
        description: "Add the ingredients for the next week's planned dinners to the shared cart as the calling member, exactly as if they had texted them (their sharing session decides the split), skipping what's In stock in the pantry or already in the cart. With live Kroger search, items go on the one-off list \"Dinners this week\" for the member to pick products. dryRun=true only returns the list.",
        mutates: true,
        inputSchema: { type: "object", properties: { dryRun: { type: "boolean", default: false } } },
        handler: async (args, caller) => {
          if (args.dryRun === true) {
            const preview = this.shoppingPreview();
            return { dinners: preview.dinners.length, items: preview.lines.map((line) => ({ item: line.name, quantity: line.quantity, for: line.meals, status: line.status === "add" ? "to buy" : line.status === "pantry" ? "in pantry" : "in cart" })) };
          }
          const result = await this.shopForMeals(caller.memberId, `claude:${randomUUID()}`);
          if (result.status === "added" || result.status === "listed" || result.status === "choosing") await notifyGroup(`${via(caller)}: ${result.message}`);
          return { ok: result.status !== "blocked" && result.status !== "none", ...result };
        },
      },
      {
        name: "get_pantry",
        description: "List the household pantry: items that are out, low, and in stock, which are already in the cart, how often items run out, and suggested recurring-list commands for items that run out regularly.",
        inputSchema: { type: "object", properties: {} },
        handler: () => {
          const items = pantry.list();
          const shape = (status: PantryStatus) => items.filter((item) => item.status === status).map((item) => ({ item: item.name, inCart: item.inCart, runsOutEveryDays: item.cadenceDays, suggestion: item.suggestion ? `Text “${item.suggestion.command}” to add it to the recurring list.` : null }));
          return { out: shape("out"), low: shape("low"), inStock: shape("stock") };
        },
      },
      {
        name: "mark_pantry_item",
        description: "Mark a pantry item in_stock, low, or out as the calling member (adds it to the pantry if new). With addToCart=true (low/out only), also adds it to the shared cart as the member, as if they had texted it.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            item: { type: "string", description: "e.g. \"olive oil\"." },
            status: { type: "string", enum: ["in_stock", "low", "out"] },
            addToCart: { type: "boolean", default: false },
          },
          required: ["item", "status"],
        },
        handler: async (args, caller) => {
          const status = statusFrom(args.status);
          const name = typeof args.item === "string" ? args.item.trim().slice(0, 40) : "";
          if (!status || !name) return { ok: false, error: "Give an item and a status (in_stock, low, or out)." };
          const { item } = pantry.set(name, status, caller.memberId);
          const cadence = pantry.cadence(item.key);
          const suggestion = status === "stock" ? null : pantry.chatSuggestion(item);
          let cart: CartAddResult | null = null;
          if (args.addToCart === true && status !== "stock") {
            cart = await this.addToCart(caller.memberId, [{ name: item.name, quantity: 1 }], `claude:${randomUUID()}`, RESTOCK_LIST);
            if (cart.status === "added" || cart.status === "listed") await notifyGroup(`${via(caller)}: 🫙 ${statusLine(status, item.name.toLowerCase())}. ${cart.message}`);
          }
          return { ok: true, item: item.name, status: STATUS_LABEL[status], runsOutEveryDays: cadence?.days ?? null, suggestion, cart };
        },
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// HTTP routes (loopback dashboard; POSTs are JSON-only and same-origin)

function sendJson(response: ServerResponse, status: number, value: unknown): true {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
  return true;
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 16_384) { reject(new Error("Request body is too large.")); request.destroy(); }
    });
    request.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {});
      } catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}

/** Rejects cross-site browser POSTs: require JSON (forces a CORS preflight) and a same-host Origin when present. */
function isSameOriginJson(request: IncomingMessage): boolean {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

const str = (value: unknown, max = 200): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

export async function handleKitchenRoutes(kitchen: Kitchen, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/api/kitchen" && !path.startsWith("/api/kitchen/")) return false;
  if (request.method === "GET") {
    if (path === "/api/kitchen") return sendJson(response, 200, kitchen.state(url.searchParams.get("week")));
    if (path === "/api/kitchen/tonight") return sendJson(response, 200, { tonight: kitchen.tonight(), memberIds: kitchen.meals.members().map((member) => member.id) });
    return false;
  }
  if (request.method !== "POST") return false;
  if (!isSameOriginJson(request)) return sendJson(response, 403, { error: "Use the GroupCart page to make changes." });
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." }); }
  const members = kitchen.meals.members();
  const viewerId = requestMember(request)?.memberId;
  const viewer = viewerId && members.some((member) => member.id === viewerId) ? viewerId : null;
  // Changes are attributed to the signed-in (or "Viewing as") member; announcements name only a known viewer.
  const actor = viewer ?? members[0]?.id ?? null;
  const by = (text: string) => viewer ? `${firstName(kitchen.meals.memberName(viewer))}: ${text}` : text;
  const demoOnly = (what: string) => sendJson(response, 403, { error: `In live mode, ${what} in the iMessage group.` });
  const status = (value: unknown): PantryStatus | null => PANTRY_STATUSES.includes(value as PantryStatus) ? value as PantryStatus : null;
  const date = (value: unknown): string | null => typeof value === "string" && isDateString(value) ? value : null;
  const { meals, pantry } = kitchen;
  try {
    switch (path) {
      case "/api/kitchen/pantry/status": {
        const next = status(body.status);
        const item = next ? pantry.setStatusById(str(body.itemId, 64) ?? "", next, actor) : undefined;
        return item ? sendJson(response, 200, { ok: true, item }) : sendJson(response, 400, { error: "Choose an item and a status." });
      }
      case "/api/kitchen/pantry/add": {
        const names = splitItemNames(str(body.name, 120) ?? "", pantry.knownKeys());
        if (!names.length) return sendJson(response, 400, { error: "Name the item." });
        const items: PantryItem[] = names.map((name) => pantry.set(name, status(body.status) ?? "stock", actor).item);
        return sendJson(response, 200, { ok: true, items });
      }
      case "/api/kitchen/pantry/delete":
        return sendJson(response, pantry.remove(str(body.itemId, 64) ?? "") ? 200 : 404, { ok: true });
      case "/api/kitchen/pantry/to-cart": {
        if (!kitchen.demoMode) return demoOnly("text “out of eggs” and reply “yes”");
        const ids = Array.isArray(body.itemIds) ? body.itemIds.filter((id): id is string => typeof id === "string").slice(0, 30) : [];
        const items = ids.map((id) => pantry.get(id)).filter((item): item is PantryItem => Boolean(item));
        if (!items.length || !actor) return sendJson(response, 400, { error: "Choose items." });
        const result = await kitchen.addToCart(actor, items.map((item) => ({ name: item.name, quantity: 1 })), `kitchen-web:${randomUUID()}`, RESTOCK_LIST);
        if (result.status === "added" || result.status === "listed") await notifyGroup(by(result.message));
        return sendJson(response, result.status === "blocked" ? 409 : 200, { ok: result.status !== "blocked", ...result });
      }
      case "/api/kitchen/meals/plan": {
        const result = meals.propose({ weekStart: date(body.weekStart) ?? undefined, proposerId: actor });
        return result.ok ? sendJson(response, 200, { ok: true }) : sendJson(response, 400, { error: result.error });
      }
      case "/api/kitchen/meals/accept": {
        const result = meals.acceptDraft(actor);
        if (!result.ok) return sendJson(response, 400, { error: result.error });
        await notifyGroup(by(kitchen.savedPlanText(result.weekStart, result.days)));
        return sendJson(response, 200, { ok: true, weekStart: result.weekStart });
      }
      case "/api/kitchen/meals/discard":
        meals.discardDraft();
        return sendJson(response, 200, { ok: true });
      case "/api/kitchen/meals/swap": {
        const day = date(body.date);
        if (!day) return sendJson(response, 400, { error: "Choose a night." });
        const result = meals.swap(day, { actorId: actor });
        return result.ok ? sendJson(response, 200, { ok: true, day: kitchen.dayJson(result.day) }) : sendJson(response, 400, { error: result.error });
      }
      case "/api/kitchen/meals/night": {
        const day = date(body.date);
        if (!day) return sendJson(response, 400, { error: "Choose a night." });
        const recipeId = body.recipeId === null ? null : str(body.recipeId, 80) ?? undefined;
        if (recipeId && !meals.recipe(recipeId)) return sendJson(response, 404, { error: "That recipe no longer exists." });
        const cookId = body.cookId === null ? null : str(body.cookId, 64) ?? undefined;
        if (cookId && !members.some((member) => member.id === cookId)) return sendJson(response, 400, { error: "Choose a household member." });
        if (cookId && meals.isAway(cookId, day)) return sendJson(response, 409, { error: `${meals.memberName(cookId)} is away that day.` });
        const result = meals.setNight(day, { recipeId, cookId, off: body.off === true }, actor);
        return sendJson(response, 200, { ok: true, day: kitchen.dayJson(result) });
      }
      case "/api/kitchen/meals/nights": {
        const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number).filter((day) => Number.isInteger(day)) : [];
        return sendJson(response, 200, { ok: true, nights: meals.setNights(weekdays) });
      }
      case "/api/kitchen/meals/shop": {
        if (!kitchen.demoMode) return demoOnly("text “shop for meals”");
        if (!actor) return sendJson(response, 400, { error: "Add household members first." });
        const result = await kitchen.shopForMeals(actor, `kitchen-web:${randomUUID()}`);
        if (result.status === "added" || result.status === "listed") await notifyGroup(by(result.message));
        return sendJson(response, result.status === "blocked" ? 409 : 200, { ok: result.status !== "blocked", ...result });
      }
      case "/api/kitchen/recipes": {
        const ingredients = Array.isArray(body.ingredients)
          ? body.ingredients.filter((value): value is string => typeof value === "string")
          : (str(body.ingredients, 1000) ?? "").split(/\s*(?:,|;|\n)\s*/);
        const result = meals.addRecipe({ name: str(body.name, 60) ?? "", ingredients, emoji: str(body.emoji, 16), createdBy: actor });
        return result.ok ? sendJson(response, 200, { ok: true, recipe: kitchen.recipeJson(result.recipe), updated: result.updated }) : sendJson(response, 400, { error: result.error });
      }
      case "/api/kitchen/recipes/delete":
        return sendJson(response, meals.deleteRecipe(str(body.recipeId, 80) ?? "") ? 200 : 404, { ok: true });
      default:
        return false;
    }
  } catch (error) {
    console.warn("Kitchen request failed:", error instanceof Error ? error.message : error);
    return sendJson(response, 500, { error: "Something went wrong. Please try again." });
  }
}

// ---------------------------------------------------------------------------
// Wiring

/** Registers the kitchen with the platform: chat command, help, routes, tools, checkout watcher, demo seed. */
export function setupKitchen(options: KitchenOptions): Kitchen {
  const kitchen = new Kitchen(options);
  if (options.demoMode && kitchen.seedDemo()) console.log("Kitchen: seeded a demo pantry and this week's dinners.");
  registerCommand("kitchen", (context) => kitchen.handle(context));
  registerRoute((request, response, url) => handleKitchenRoutes(kitchen, request, response, url));
  registerTools(kitchen.tools());
  registerSummaryProvider("kitchen", (caller) => {
    const today = kitchen.meals.today();
    const mine = Array.from({ length: 7 }, (_, offset) => kitchen.meals.night(addDays(today, offset))).filter((day) => day.cookId === caller.memberId);
    const items = kitchen.pantry.items();
    return {
      tonight: kitchen.tonight(),
      youCook: mine.map((day) => ({ date: day.date, recipe: day.recipe?.name ?? null })),
      pantryOut: items.filter((item) => item.status === "out").map((item) => item.name),
      pantryLow: items.filter((item) => item.status === "low").map((item) => item.name),
    };
  });
  registerHelp("Meals: “plan dinners” (reply “ok” or “swap tue”), “what’s for dinner”, “I’ll cook tonight”, “add recipe tacos: tortillas, beef, salsa”, “shop for meals”.");
  registerHelp("Pantry: “pantry”, “out of olive oil” (reply “yes” to add it to the cart), “low on rice”, “restocked eggs”.");
  scheduleEvery("kitchen-checkouts", 3_000, () => { kitchen.watchCheckouts(); });
  return kitchen;
}
