// Meal planning: a weekly dinner plan (Mon–Sun, on the nights the household picks). Each planned night has a recipe
// and a cook. Cooks rotate fairly like chores (whoever has gone longest without cooking goes next, then fewest
// turns), and members who are away (the chores feature's away status, read from `chore_away`) are skipped.
//
// Recipes are a small built-in set plus the household's own ("add recipe tacos: tortillas, ground beef, salsa,
// cheese"). Allergens and diet tags (vegan, vegetarian, gluten-free, dairy-free, nut-free) come from the ingredients,
// and profile dietary notes ("Vegetarian", "No shellfish", "Lactose intolerant") flag conflicting recipes; the
// auto-planner leaves them out when it can. "plan dinners" saves a suggestion as a draft that "ok" accepts.
//
// Pure helpers are exported for src/meals.test.ts; MealsService holds the persistence (tables prefixed `meal_` in the
// shared SQLite database). Group chat, routes, and connector tools are wired in src/kitchen.ts.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { addDays, dayOfWeek, localDate, mondayOf } from "./availability.js";
import { fairOrder, type MemberStats } from "./choresLogic.js";
import { cleanIngredient, displayItemName, itemKey, normalizeItemText } from "./pantry.js";
import type { CartStore } from "./store.js";

// ---------------------------------------------------------------------------
// Ingredients, allergens, and diet tags (pure)

export type Allergen = "meat" | "beef" | "pork" | "fish" | "shellfish" | "dairy" | "eggs" | "gluten" | "nuts" | "peanuts" | "soy" | "sesame" | "honey";
export type DietTag = "vegan" | "vegetarian" | "gluten-free" | "dairy-free" | "nut-free";
export const DIET_TAGS: readonly DietTag[] = ["vegan", "vegetarian", "gluten-free", "dairy-free", "nut-free"];
export const TAG_SHORT: Record<DietTag, string> = { vegan: "VG", vegetarian: "V", "gluten-free": "GF", "dairy-free": "DF", "nut-free": "NF" };

const PLANT_ALTERNATIVE = /\b(?:oat|almond|soy|coconut|rice|cashew|vegan|plant[- ]based|dairy[- ]free|non[- ]dairy)\s+(?:milk|cream|yogurt|yoghurt|cheese|butter|creamer)\b/g;
const NUT_BUTTER = /\b(?:peanut|almond|cashew|sunflower|apple|nut)\s+butter\b/g;

/** Allergens in one ingredient, by keyword ("soy sauce" → soy + gluten, "coconut cream" → none). */
export function classifyIngredient(raw: string): Allergen[] {
  let text = ` ${raw.toLowerCase()} `;
  const found = new Set<Allergen>();
  for (const match of text.match(PLANT_ALTERNATIVE) ?? []) {
    if (/almond|cashew/.test(match)) found.add("nuts");
    if (/\bsoy\b/.test(match)) found.add("soy");
  }
  text = text.replace(PLANT_ALTERNATIVE, " ");
  for (const match of text.match(NUT_BUTTER) ?? []) {
    if (/peanut/.test(match)) found.add("peanuts");
    else if (/almond|cashew|nut butter/.test(match)) found.add("nuts");
  }
  text = text.replace(NUT_BUTTER, " ");
  const has = (pattern: RegExp) => pattern.test(text);
  if (has(/\b(?:chicken|beef|steak|pork|bacon|ham|sausages?|turkey|lamb|prosciutto|pepperoni|salami|chorizo|meatballs?|hamburger meat)\b/)) found.add("meat");
  if (has(/\b(?:beef|steak|hamburger meat|meatballs?)\b/)) found.add("beef");
  if (has(/\b(?:pork|bacon|ham|sausages?|prosciutto|pepperoni|salami|chorizo)\b/)) found.add("pork");
  if (has(/\b(?:salmon|tuna|cod|tilapia|fish|anchov(?:y|ies)|sardines?|halibut|trout|mackerel)\b/)) found.add("fish");
  if (has(/\b(?:shrimp|prawns?|crab|lobster|scallops?|clams?|mussels?|oysters?)\b/)) found.add("shellfish");
  if (has(/\b(?:milk|cheese|cheddar|mozzarella|parmesan|feta|ricotta|butter|cream|yogurt|yoghurt|ghee|paneer|queso|brie|pesto)\b/)) found.add("dairy");
  if (has(/\beggs?\b|\bmayo(?:nnaise)?\b/)) found.add("eggs");
  if (!has(/gluten[- ]free|\bcorn tortillas?\b|\brice noodles\b|\btamari\b/)
    && has(/\b(?:bread|pasta|spaghetti|penne|linguine|macaroni|lasagna|noodles|flour|tortillas?|pitas?|buns?|dough|crackers|couscous|barley|wheat|breadcrumbs|panko|soy sauce|beer|bagels?|croutons|naan|ramen|udon|seitan)\b/)) found.add("gluten");
  if (has(/\b(?:tofu|soy|soybeans?|edamame|tempeh|miso|tamari)\b/)) found.add("soy");
  if (has(/\bpeanuts?\b/)) found.add("peanuts");
  if (has(/\b(?:almonds?|cashews?|walnuts?|pecans?|pistachios?|hazelnuts?|pine nuts|macadamias?|nuts|pesto)\b/)) found.add("nuts");
  if (has(/\b(?:sesame|tahini|hummus)\b/)) found.add("sesame");
  if (has(/\bhoney\b/)) found.add("honey");
  return [...found];
}

export function recipeAllergens(ingredients: readonly string[]): Allergen[] {
  return [...new Set(ingredients.flatMap(classifyIngredient))];
}

export function dietTags(contains: readonly Allergen[]): DietTag[] {
  const has = (allergen: Allergen) => contains.includes(allergen);
  const vegetarian = !has("meat") && !has("fish") && !has("shellfish");
  const tags: DietTag[] = [];
  if (vegetarian && !has("dairy") && !has("eggs") && !has("honey")) tags.push("vegan");
  if (vegetarian) tags.push("vegetarian");
  if (!has("gluten")) tags.push("gluten-free");
  if (!has("dairy")) tags.push("dairy-free");
  if (!has("nuts") && !has("peanuts")) tags.push("nut-free");
  return tags;
}

// ---------------------------------------------------------------------------
// Dietary notes (pure): simple keyword matching on profile notes

export type DietRule = { label: string; avoid: Allergen[] };

const DIET_RULES: ReadonlyArray<{ test: RegExp; rule: DietRule; skipIf?: string }> = [
  { test: /\bvegan\b|plant[- ]based/, rule: { label: "vegan", avoid: ["meat", "fish", "shellfish", "dairy", "eggs", "honey"] } },
  { test: /\bvegetarian\b|\bveggie\b|\bno meat\b|\bmeatless\b|(?:don'?t|doesn'?t|do not|does not) eat meat/, rule: { label: "vegetarian", avoid: ["meat", "fish", "shellfish"] }, skipIf: "vegan" },
  { test: /\bpesc[ae]tarian\b/, rule: { label: "pescatarian", avoid: ["meat"] }, skipIf: "vegan" },
  { test: /lactose|dairy|milk allerg|allergic to milk|\bno milk\b|\bno cheese\b|casein|\bwhey\b/, rule: { label: "no dairy", avoid: ["dairy"] } },
  { test: /gluten|celiac|coeliac|\bwheat\b/, rule: { label: "gluten-free", avoid: ["gluten"] } },
  { test: /peanut/, rule: { label: "peanuts", avoid: ["peanuts"] } },
  { test: /tree[- ]nuts?|almond|cashew|walnut|pecan|pistachio|hazelnut/, rule: { label: "tree nuts", avoid: ["nuts"] } },
  { test: /(?<!tree[- ])\bnuts?\b/, rule: { label: "nuts", avoid: ["nuts", "peanuts"] } },
  { test: /shellfish|shrimp|crab|lobster|prawn|seafood/, rule: { label: "shellfish", avoid: ["shellfish"] } },
  { test: /\bfish\b|seafood|salmon|tuna/, rule: { label: "fish", avoid: ["fish"] } },
  { test: /\beggs?\b/, rule: { label: "eggs", avoid: ["eggs"] } },
  { test: /\bsoy\b|\bsoya\b/, rule: { label: "soy", avoid: ["soy"] } },
  { test: /sesame|tahini/, rule: { label: "sesame", avoid: ["sesame"] } },
  { test: /\bpork\b|\bhalal\b|\bbacon\b|\bham\b/, rule: { label: "no pork", avoid: ["pork"] } },
  { test: /\bkosher\b/, rule: { label: "kosher", avoid: ["pork", "shellfish"] } },
  { test: /\bbeef\b|red meat/, rule: { label: "no red meat", avoid: ["beef", "pork"] } },
  { test: /\bhoney\b/, rule: { label: "honey", avoid: ["honey"] } },
];

/** What a person's dietary notes rule out ("Vegetarian; allergic to peanuts" → vegetarian + peanuts). */
export function dietRules(notes: string): DietRule[] {
  const text = ` ${notes.toLowerCase().replace(/[’‘]/g, "'")} `
    .replace(/\b(?:not|no longer)\s+(?:a\s+)?(?:vegan|vegetarian|pesc[ae]tarian)\b/g, " ")
    .replace(/\b[\w-]+\s+(?:is|are)\s+(?:fine|ok|okay|good)\b/g, " ")
    .replace(/\b(?:no (?:dietary )?restrictions|eats everything|anything goes|none)\b/g, " ");
  const matched: DietRule[] = [];
  for (const { test, rule, skipIf } of DIET_RULES) {
    if (skipIf && matched.some((existing) => existing.label === skipIf)) continue;
    if (test.test(text)) matched.push(rule);
  }
  return matched;
}

export type DietPerson = { id: string; name: string; notes: string };
export type Conflict = { memberId: string; name: string; labels: string[] };

/** Who can't eat a recipe, and why (the dietary labels that rule it out). */
export function recipeConflicts(contains: readonly Allergen[], people: readonly DietPerson[]): Conflict[] {
  return people.flatMap((person) => {
    const labels = dietRules(person.notes).filter((rule) => rule.avoid.some((allergen) => contains.includes(allergen))).map((rule) => rule.label);
    return labels.length ? [{ memberId: person.id, name: person.name, labels }] : [];
  });
}

// ---------------------------------------------------------------------------
// Recipes

export type Recipe = { id: string; name: string; emoji: string; ingredients: string[]; builtin: boolean; createdBy: string | null };
export type RecipeInfo = Recipe & { contains: Allergen[]; tags: DietTag[] };
export type RecipeView = RecipeInfo & { conflicts: Conflict[] };

/** Built-in recipes. Ingredient names match the sample catalog (src/cart.ts) so "shop for meals" works in the demo. */
export const BUILTIN_RECIPES: readonly Recipe[] = ([
  ["black-bean-tacos", "Black bean tacos", "🌮", ["tortillas", "black beans", "salsa", "avocados", "lettuce"]],
  ["spaghetti-marinara", "Spaghetti marinara", "🍝", ["pasta", "tomato sauce", "garlic", "olive oil", "parmesan"]],
  ["chickpea-curry", "Chickpea curry", "🍛", ["chickpeas", "coconut cream", "onions", "spinach", "curry paste", "rice"]],
  ["tofu-stir-fry", "Tofu stir-fry", "🥦", ["tofu", "broccoli", "bell peppers", "soy sauce", "garlic", "rice"]],
  ["sheet-pan-chicken", "Sheet-pan chicken", "🍗", ["chicken thighs", "potatoes", "lemons", "garlic", "olive oil"]],
  ["burrito-bowls", "Burrito bowls", "🌯", ["chicken thighs", "rice", "black beans", "salsa", "cheese", "lettuce"]],
  ["burgers", "Burgers", "🍔", ["ground beef", "burger buns", "cheese", "lettuce", "tomatoes"]],
  ["salmon-rice", "Salmon & rice", "🐟", ["salmon", "rice", "broccoli", "lemons", "soy sauce"]],
  ["lentil-soup", "Lentil soup", "🍲", ["lentils", "carrots", "onions", "celery", "vegetable broth", "bread"]],
  ["veggie-fried-rice", "Veggie fried rice", "🍳", ["rice", "eggs", "frozen peas", "carrots", "soy sauce", "green onions"]],
  ["greek-salad", "Greek salad & pita", "🥗", ["lettuce", "cucumbers", "tomatoes", "feta", "olives", "pita"]],
  ["homemade-pizza", "Homemade pizza", "🍕", ["pizza dough", "tomato sauce", "mozzarella", "bell peppers"]],
  ["peanut-noodles", "Peanut noodles", "🥜", ["noodles", "peanut butter", "soy sauce", "cucumbers", "carrots"]],
  ["turkey-chili", "Turkey chili", "🌶️", ["ground turkey", "kidney beans", "canned tomatoes", "onions", "chili powder"]],
  ["shrimp-pasta", "Garlic shrimp pasta", "🍤", ["shrimp", "pasta", "garlic", "butter", "lemons"]],
  ["shakshuka", "Shakshuka", "🍅", ["eggs", "canned tomatoes", "onions", "bell peppers", "bread"]],
] as const).map(([id, name, emoji, ingredients]) => ({ id: `b:${id}`, name, emoji, ingredients: [...ingredients], builtin: true, createdBy: null }));

const EMOJI_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/taco|burrito|quesadilla|enchilada|nacho/, "🌮"], [/pasta|spaghetti|lasagna|mac|penne|linguine/, "🍝"], [/curry|dal|masala/, "🍛"],
  [/soup|stew|chowder|ramen|pho|broth/, "🍲"], [/noodle|lo mein|pad thai|udon/, "🍜"], [/salad|bowl/, "🥗"], [/pizza|flatbread/, "🍕"],
  [/burger|slider/, "🍔"], [/chicken|wings/, "🍗"], [/salmon|fish|tuna|cod/, "🐟"], [/shrimp|prawn/, "🍤"], [/rice|risotto|paella/, "🍚"],
  [/egg|omelet|frittata|shakshuka|breakfast/, "🍳"], [/chili|spicy/, "🌶️"], [/steak|beef|bbq|grill/, "🥩"], [/sandwich|sub|wrap/, "🥪"],
  [/sushi/, "🍣"], [/dumpling|potsticker/, "🥟"], [/pancake|waffle/, "🥞"], [/potato|fries/, "🥔"], [/stir[- ]?fry|veg/, "🥦"],
];

export function guessRecipeEmoji(name: string): string {
  const text = name.toLowerCase();
  return EMOJI_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? "🍽️";
}

export function withInfo(recipe: Recipe): RecipeInfo {
  const contains = recipeAllergens(recipe.ingredients);
  return { ...recipe, contains, tags: dietTags(contains) };
}

/** "tacos: tortillas, ground beef, salsa, cheese" (or "tacos with …", "tacos - …") → name + ingredients. */
export function parseRecipeText(body: string): { name: string; ingredients: string[] } {
  const match = body.match(/^(.+?)\s*(?::|—|–|\s-\s|\bwith\b|\busing\b)\s*(.+)$/i);
  const name = (match ? match[1]! : body).replace(/^(?:called|named)\s+/i, "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const ingredients = match ? match[2]!.split(/\s*(?:,|;|\n|\band\b|\+)\s*/i).map(cleanIngredient).filter(Boolean) : [];
  return { name: name.charAt(0).toUpperCase() + name.slice(1), ingredients: [...new Set(ingredients)] };
}

// ---------------------------------------------------------------------------
// Cooks: fair rotation (pure)

export type CookHistory = ReadonlyArray<{ date: string; cookId: string }>;

/**
 * Picks a cook for each date in order: a fixed cook wins; otherwise whoever (not away that day) has gone longest
 * without cooking, then fewest turns, then member order. Each pick counts for the next date, like chores' rotation.
 */
export function assignCooks(options: {
  dates: readonly string[];
  memberIds: readonly string[];
  history: CookHistory;
  isAway?: (memberId: string, date: string) => boolean;
  fixed?: ReadonlyMap<string, string | null>;
}): Map<string, string | null> {
  const stats = new Map<string, MemberStats>();
  const bump = (id: string, date: string) => {
    const previous = stats.get(id) ?? { last: null, count: 0 };
    const at = Date.parse(`${date}T12:00:00Z`);
    stats.set(id, { last: previous.last === null ? at : Math.max(previous.last, at), count: previous.count + 1 });
  };
  for (const entry of [...options.history].sort((a, b) => a.date.localeCompare(b.date))) bump(entry.cookId, entry.date);
  const result = new Map<string, string | null>();
  for (const date of [...options.dates].sort()) {
    const fixed = options.fixed?.get(date);
    const cook = fixed ?? fairOrder(options.memberIds.filter((id) => !options.isAway?.(id, date)), stats)[0] ?? null;
    if (cook) bump(cook, date);
    result.set(date, cook);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Suggestions (pure)

function jitter(seed: string, id: string): number {
  return createHash("sha256").update(`${seed}:${id}`).digest().readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Recipes in the order the planner prefers: no dietary conflicts first, then ones that use what's in the pantry and
 * weren't cooked recently (`recent`: recipe id → days since it was last cooked, within two weeks; the more recent,
 * the bigger the penalty), with a seeded shuffle for variety.
 */
export function rankRecipes(options: {
  recipes: readonly RecipeInfo[];
  people: readonly DietPerson[];
  seed: string;
  recent?: ReadonlyMap<string, number>;
  inStock?: ReadonlySet<string>;
  exclude?: ReadonlySet<string>;
}): RecipeInfo[] {
  const scored = options.recipes.filter((recipe) => !options.exclude?.has(recipe.id)).map((recipe) => {
    const keys = recipe.ingredients.map(itemKey);
    const coverage = keys.length ? keys.filter((key) => options.inStock?.has(key)).length / keys.length : 0;
    const conflicts = recipeConflicts(recipe.contains, options.people).length;
    const daysAgo = options.recent?.get(recipe.id);
    const penalty = daysAgo === undefined ? 0 : 3 + 3 * Math.max(0, 1 - daysAgo / 14);
    return { recipe, conflicts, score: coverage * 2 - penalty + jitter(options.seed, recipe.id) };
  });
  return scored.sort((a, b) => a.conflicts - b.conflicts || b.score - a.score).map((entry) => entry.recipe);
}

/** One recipe per date (no repeats while there are enough), keeping `fixed` dates as they are. */
export function suggestMeals(options: {
  dates: readonly string[];
  recipes: readonly RecipeInfo[];
  people: readonly DietPerson[];
  seed: string;
  recent?: ReadonlyMap<string, number>;
  inStock?: ReadonlySet<string>;
  fixed?: ReadonlyMap<string, string>;
}): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set(options.fixed?.values() ?? []);
  const compatible = options.recipes.filter((recipe) => !recipeConflicts(recipe.contains, options.people).length);
  const pool = compatible.length ? compatible : options.recipes;
  for (const date of [...options.dates].sort()) {
    const fixed = options.fixed?.get(date);
    if (fixed) { result.set(date, fixed); continue; }
    let ranked = rankRecipes({ ...options, recipes: pool, exclude: used });
    if (!ranked.length) { used.clear(); ranked = rankRecipes({ ...options, recipes: pool }); }
    const pick = ranked[0];
    if (!pick) continue;
    used.add(pick.id);
    result.set(date, pick.id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shopping list (pure)

/** Ingredients one package covers for the whole week, however many dinners use them. */
const STAPLES = new Set(["olive oil", "soy sauce", "garlic", "chili powder", "curry paste", "rice", "butter", "salt", "black pepper", "flour", "sugar", "vinegar", "honey", "salsa", "olives", "lemons", "green onions", "celery"].map(itemKey));

export type ShoppingLine = { key: string; name: string; quantity: number; meals: string[]; status: "add" | "pantry" | "cart" };

/**
 * The week's ingredients, one line per item: quantity is the number of dinners that use it (staples count once),
 * marked "pantry" when In stock and "cart" when it's already in the shared cart.
 */
export function aggregateIngredients(
  dinners: ReadonlyArray<{ recipe: Pick<Recipe, "name" | "emoji" | "ingredients"> }>,
  options: { inStock?: ReadonlySet<string>; inCart?: ReadonlySet<string> } = {},
): ShoppingLine[] {
  const lines = new Map<string, ShoppingLine>();
  for (const { recipe } of dinners) {
    for (const ingredient of new Set(recipe.ingredients.map((value) => value.trim()).filter(Boolean))) {
      const key = itemKey(ingredient);
      const line = lines.get(key) ?? { key, name: displayItemName(ingredient), quantity: 0, meals: [], status: "add" as const };
      line.quantity += 1;
      if (!line.meals.includes(recipe.name)) line.meals.push(recipe.name);
      lines.set(key, line);
    }
  }
  return [...lines.values()].map((line) => ({
    ...line,
    quantity: STAPLES.has(line.key) ? 1 : Math.min(line.quantity, 9),
    status: options.inStock?.has(line.key) ? "pantry" as const : options.inCart?.has(line.key) ? "cart" as const : "add" as const,
  }));
}

// ---------------------------------------------------------------------------
// Chat parsing (pure)

export type DayRef = { kind: "today" } | { kind: "tomorrow" } | { kind: "weekday"; weekday: number };
export type MealCommand =
  | { kind: "show" }
  | { kind: "plan"; weekdays: number[] | null; week: "this" | "next" | null }
  | { kind: "tonight"; day: DayRef }
  | { kind: "addRecipe"; body: string }
  | { kind: "recipes" }
  | { kind: "deleteRecipe"; name: string }
  | { kind: "cook"; day: DayRef; who: string }
  | { kind: "swap"; day: DayRef; recipe: string | null }
  | { kind: "off"; day: DayRef }
  | { kind: "shop" }
  | { kind: "accept" };

const DAY = String.raw`(tonight|today|tomorrow|tmrw|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)`;
const WEEKDAY_PREFIXES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseDay(word: string): DayRef | null {
  const value = word.toLowerCase();
  if (value === "tonight" || value === "today") return { kind: "today" };
  if (value === "tomorrow" || value === "tmrw") return { kind: "tomorrow" };
  const weekday = WEEKDAY_PREFIXES.indexOf(value.slice(0, 3));
  return weekday >= 0 ? { kind: "weekday", weekday } : null;
}

/** "mon-thu", "mon tue wed", "weeknights", "every night" → weekday numbers (0 = Sunday). */
export function parseWeekdays(text: string): number[] | null {
  const value = text.toLowerCase().trim();
  if (!value) return null;
  if (/^(?:weeknights|weekdays)$/.test(value)) return [1, 2, 3, 4, 5];
  if (/^(?:every night|all week|every day|daily|7 nights)$/.test(value)) return [0, 1, 2, 3, 4, 5, 6];
  if (/^(?:weekend|weekends)$/.test(value)) return [0, 6];
  const days = new Set<number>();
  for (const part of value.split(/\s*(?:,|\band\b|&|\s)\s*/).filter(Boolean)) {
    const range = part.match(/^([a-z]+)-([a-z]+)$/);
    if (range) {
      const from = WEEKDAY_PREFIXES.indexOf(range[1]!.slice(0, 3));
      const to = WEEKDAY_PREFIXES.indexOf(range[2]!.slice(0, 3));
      if (from < 0 || to < 0) return null;
      // Ranges run Monday-first, so "fri-sun" means Fri, Sat, Sun.
      const order = [1, 2, 3, 4, 5, 6, 0];
      let index = order.indexOf(from);
      for (let guard = 0; guard < 7; guard += 1) { days.add(order[index]!); if (order[index] === to) break; index = (index + 1) % 7; }
      continue;
    }
    const day = WEEKDAY_PREFIXES.indexOf(part.slice(0, 3));
    if (day < 0 || !/^[a-z]+$/.test(part) || !new RegExp(`^${DAY}$`).test(part)) return null;
    days.add(day);
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

/** Meal-plan commands; null for anything else (other features, groceries). */
export function parseMealCommand(raw: string): MealCommand | null {
  const text = raw.normalize("NFKC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "").trim();
  if (!text || text.length > 300) return null;
  const lower = text.toLowerCase().replace(/\?+$/, "").trim();
  let match: RegExpMatchArray | null;

  if (/^(?:meal plan|meals|meal planner|the meal plan|our meal plan|dinners|dinner plan|dinner plans|menu|the menu|this week'?s (?:dinners|meals|menu)|show (?:the |our )?(?:meal plan|meals|dinners|menu)|what'?s on the menu(?: this week)?|whats on the menu)$/.test(lower)) return { kind: "show" };
  if ((match = lower.match(/^(?:plan|suggest|make|auto[- ]?plan|pick)\s+(?:the\s+|our\s+|my\s+|some\s+)?(?:(this|next)\s+week'?s\s+)?(?:dinners|meals|menu|meal plan|dinner plan)(?:\s+(?:for\s+)?(?:the\s+)?(this|next)\s+week)?(?:\s*(?::|for|on)?\s*(.+))?$/))) {
    const days = match[3] && !/^(?:the |this )?week$/.test(match[3]) ? match[3] : null;
    const weekdays = days ? parseWeekdays(days) : null;
    if (days && !weekdays) return null;
    return { kind: "plan", weekdays, week: (match[1] ?? match[2] ?? null) as "this" | "next" | null };
  }
  if ((match = lower.match(new RegExp(`^(?:what'?s|whats|what is|what are we having)\\s+(?:for\\s+)?dinner(?:\\s+(?:on\\s+)?${DAY})?$`)))
    ?? (match = lower.match(new RegExp(`^(?:who'?s|whos|who is)\\s+cooking(?:\\s+(?:on\\s+)?${DAY})?$`)))
    ?? (match = lower.match(new RegExp(`^who\\s+cooks(?:\\s+(?:on\\s+)?${DAY})?$`)))
    ?? (match = lower.match(new RegExp(`^${DAY}'?s dinner$`)))) {
    return { kind: "tonight", day: (match[1] ? parseDay(match[1]) : null) ?? { kind: "today" } };
  }
  if ((match = text.match(/^(?:add|new|save|create)\s+(?:a\s+)?recipe\s*:?\s+(.+)$/i))) return { kind: "addRecipe", body: match[1]! };
  if (/^(?:recipes|our recipes|recipe list|recipe book|show recipes|list recipes)$/.test(lower)) return { kind: "recipes" };
  if ((match = text.match(/^(?:delete|remove)\s+(?:the\s+)?recipe\s*:?\s+(.+)$/i))) return { kind: "deleteRecipe", name: match[1]! };
  if (/^(?:shop for (?:the |this week'?s |our |next week'?s )?(?:meals|dinners|meal plan|menu|recipes|week)|shop (?:the )?(?:meals|dinners)|add (?:the |this week'?s )?(?:meals|dinners|meal plan|dinner ingredients|meal ingredients|recipe ingredients|ingredients) to (?:the )?cart|(?:buy|get) (?:the )?(?:meal|dinner) ingredients|meal (?:groceries|shopping))$/.test(lower)) return { kind: "shop" };
  if (/^(?:save|keep|accept|confirm|approve|lock in)\s+(?:the\s+)?(?:dinner\s+|meal\s+|suggested\s+)?(?:plan|dinners|meals|menu)$/.test(lower)) return { kind: "accept" };

  if ((match = lower.match(new RegExp(`^(?:the\\s+)?cook\\s+(?:for\\s+|on\\s+)?${DAY}\\s+is\\s+([a-z][a-z'-]*)$`)))) return { kind: "cook", day: parseDay(match[1]!)!, who: match[2]! };
  if ((match = lower.match(new RegExp(`^${DAY}'?s\\s+cook\\s+is\\s+([a-z][a-z'-]*)$`)))) return { kind: "cook", day: parseDay(match[1]!)!, who: match[2]! };
  if ((match = lower.match(new RegExp(`^i(?:'ll|'m| will| can| am|'d| could)?\\s+(?:cook|cooking|make dinner|making dinner|do dinner|doing dinner|take dinner|handle dinner)\\s+(?:on\\s+)?${DAY}$`)))) return { kind: "cook", day: parseDay(match[1]!)!, who: "me" };
  if ((match = lower.match(new RegExp(`^([a-z][a-z'-]*)\\s+(?:is cooking|cooks|will cook|'ll cook|can cook|is making dinner|makes dinner|has dinner|is on dinner)\\s+(?:on\\s+)?${DAY}$`))) && !/^(?:who|whos|who's|i|we|you|nobody|no one|someone)$/.test(match[1]!)) {
    return { kind: "cook", day: parseDay(match[2]!)!, who: match[1]! };
  }
  if ((match = lower.match(new RegExp(`^(?:swap|change|switch|replace|reroll|shuffle)\\s+(?:dinner\\s+(?:on\\s+)?|the\\s+)?${DAY}(?:'?s\\s+dinner)?(?:\\s+(?:for|to)\\s+(.+))?$`)))) {
    return { kind: "swap", day: parseDay(match[1]!)!, recipe: match[2]?.trim() || null };
  }
  if ((match = lower.match(new RegExp(`^(?:no|skip)\\s+(?:dinner|cooking)\\s+(?:on\\s+)?${DAY}$`)))
    ?? (match = lower.match(new RegExp(`^(?:we'?re\\s+|we are\\s+)?(?:eating out|getting takeout|ordering in|takeout)\\s+(?:on\\s+)?${DAY}$`)))) {
    return { kind: "off", day: parseDay(match[1]!)! };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence

export type NightDraft = { date: string; recipeId: string | null; cookId: string | null; tried: string[] };
export type MealDay = {
  date: string;
  dow: string;
  day: number;
  isToday: boolean;
  isPast: boolean;
  /** A dinner is planned this night (with or without a recipe yet). */
  planned: boolean;
  recipe: RecipeView | null;
  cookId: string | null;
};
export type MealDraft = { weekStart: string; proposerId: string | null; createdAt: string; days: MealDay[] };

type NightRow = { date: string; recipe_id: string | null; cook_id: string | null; tried_json: string | null };
type RecipeRow = { id: string; name: string; emoji: string; ingredients_json: string; created_by: string | null };

/** Nights planned by default: Monday through Friday. */
export const DEFAULT_NIGHTS = [1, 2, 3, 4, 5];
const DRAFT_TTL_MS = 2 * 86_400_000;

export class MealsService {
  readonly #store: CartStore;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly timeZone: string;
  /** Pantry keys that are In stock (wired by src/kitchen.ts) so suggestions can use what's at home. */
  inStockKeys: () => ReadonlySet<string> = () => new Set();

  constructor(store: CartStore, options: { timeZone: string; now?: () => number }) {
    this.#store = store;
    this.#db = store.database;
    this.#now = options.now ?? Date.now;
    this.timeZone = options.timeZone;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meal_recipes (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        ingredients_json TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meal_nights (
        household_id TEXT NOT NULL,
        date TEXT NOT NULL,
        recipe_id TEXT,
        cook_id TEXT,
        tried_json TEXT,
        updated_by TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (household_id, date)
      );
      CREATE TABLE IF NOT EXISTS meal_drafts (
        household_id TEXT PRIMARY KEY,
        week_start TEXT NOT NULL,
        nights_json TEXT NOT NULL,
        proposer_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meal_meta (
        household_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (household_id, key)
      );
    `);
  }

  get #household(): string {
    return this.#store.household;
  }

  now(): number {
    return this.#now();
  }

  today(): string {
    return localDate(this.#now(), this.timeZone);
  }

  meta(key: string): string | undefined {
    return (this.#db.prepare("SELECT value FROM meal_meta WHERE household_id = ? AND key = ?").get(this.#household, key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO meal_meta (household_id, key, value) VALUES (?, ?, ?) ON CONFLICT (household_id, key) DO UPDATE SET value = excluded.value").run(this.#household, key, value);
  }

  members(): Array<{ id: string; name: string }> {
    return this.#store.getMembers().map(({ id, name }) => ({ id, name }));
  }

  memberName(id: string | null | undefined): string {
    return this.members().find((member) => member.id === id)?.name ?? "Someone";
  }

  /** Dietary notes from profiles (src/profiles.ts stores them in `profile_profiles`; read only). */
  people(): DietPerson[] {
    let notes = new Map<string, string>();
    try {
      notes = new Map((this.#db.prepare("SELECT member_id, dietary FROM profile_profiles").all() as Array<{ member_id: string; dietary: string | null }>).map((row) => [row.member_id, row.dietary ?? ""]));
    } catch { /* profiles not set up */ }
    return this.members().map((member) => ({ id: member.id, name: member.name, notes: notes.get(member.id) ?? "" }));
  }

  /** Who is away (chores' away status in `chore_away`, read only): member id → the day they're back. */
  awayUntil(): Map<string, string> {
    try {
      return new Map((this.#db.prepare("SELECT member_id, until_date FROM chore_away WHERE until_date > ?").all(this.today()) as Array<{ member_id: string; until_date: string }>).map((row) => [row.member_id, row.until_date]));
    } catch {
      return new Map(); // chores not set up
    }
  }

  isAway(memberId: string, date: string, away = this.awayUntil()): boolean {
    const back = away.get(memberId);
    return Boolean(back && date < back);
  }

  // --- Recipes ---------------------------------------------------------------

  #householdRecipes(): Recipe[] {
    return (this.#db.prepare("SELECT id, name, emoji, ingredients_json, created_by FROM meal_recipes WHERE household_id = ? ORDER BY created_at").all(this.#household) as RecipeRow[])
      .map((row) => ({ id: row.id, name: row.name, emoji: row.emoji, ingredients: JSON.parse(row.ingredients_json) as string[], builtin: false, createdBy: row.created_by }));
  }

  /** Built-ins (unless the household saved its own with the same name) and household recipes, with conflicts. */
  recipes(people: readonly DietPerson[] = this.people()): RecipeView[] {
    const own = this.#householdRecipes();
    const ownNames = new Set(own.map((recipe) => normalizeItemText(recipe.name)));
    return [...BUILTIN_RECIPES.filter((recipe) => !ownNames.has(normalizeItemText(recipe.name))), ...own]
      .map((recipe) => this.#view(recipe, people));
  }

  #view(recipe: Recipe, people: readonly DietPerson[]): RecipeView {
    const info = withInfo(recipe);
    return { ...info, conflicts: recipeConflicts(info.contains, people) };
  }

  recipe(id: string | null | undefined, people: readonly DietPerson[] = this.people()): RecipeView | null {
    if (!id) return null;
    const builtin = BUILTIN_RECIPES.find((recipe) => recipe.id === id);
    if (builtin) return this.#view(builtin, people);
    const own = this.#householdRecipes().find((recipe) => recipe.id === id);
    return own ? this.#view(own, people) : null;
  }

  /** A recipe by id or name: exact, then a unique prefix, then a unique partial match. */
  findRecipe(query: string): RecipeView | null {
    const all = this.recipes();
    const byId = all.find((recipe) => recipe.id === query);
    if (byId) return byId;
    const wanted = normalizeItemText(query).replace(/&/g, "and");
    if (!wanted) return null;
    const name = (recipe: RecipeView) => normalizeItemText(recipe.name).replace(/&/g, "and");
    const exact = all.filter((recipe) => name(recipe) === wanted);
    if (exact.length) return exact[exact.length - 1]!;
    const prefix = all.filter((recipe) => name(recipe).startsWith(wanted));
    if (prefix.length === 1) return prefix[0]!;
    const partial = all.filter((recipe) => name(recipe).includes(wanted) || wanted.includes(name(recipe)));
    return partial.length === 1 ? partial[0]! : null;
  }

  addRecipe(input: { name: string; ingredients: readonly string[]; emoji?: string | null; createdBy: string | null }): { ok: true; recipe: RecipeView; updated: boolean } | { ok: false; error: string } {
    const name = input.name.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return { ok: false, error: "Name the recipe, e.g. “add recipe tacos: tortillas, ground beef, salsa, cheese”." };
    const ingredients = [...new Set(input.ingredients.map(cleanIngredient).filter(Boolean))].slice(0, 20);
    if (!ingredients.length) return { ok: false, error: `What goes in ${name.toLowerCase()}? e.g. “add recipe ${name.toLowerCase()}: tortillas, ground beef, salsa”.` };
    const emoji = input.emoji && input.emoji.trim() && [...input.emoji.trim()].length <= 4 ? input.emoji.trim() : guessRecipeEmoji(name);
    const existing = this.#householdRecipes().find((recipe) => normalizeItemText(recipe.name) === normalizeItemText(name));
    if (existing) {
      this.#db.prepare("UPDATE meal_recipes SET name = ?, emoji = ?, ingredients_json = ? WHERE id = ?").run(name, emoji, JSON.stringify(ingredients), existing.id);
      return { ok: true, recipe: this.recipe(existing.id)!, updated: true };
    }
    const id = `r:${randomUUID()}`;
    this.#db.prepare("INSERT INTO meal_recipes (id, household_id, name, emoji, ingredients_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, this.#household, name.charAt(0).toUpperCase() + name.slice(1), emoji, JSON.stringify(ingredients), input.createdBy, new Date(this.#now()).toISOString());
    return { ok: true, recipe: this.recipe(id)!, updated: false };
  }

  /** Removes a household recipe (built-ins stay). Planned nights keep their date but lose the recipe. */
  deleteRecipe(id: string): boolean {
    const removed = Number(this.#db.prepare("DELETE FROM meal_recipes WHERE id = ? AND household_id = ?").run(id, this.#household).changes) > 0;
    if (removed) this.#db.prepare("UPDATE meal_nights SET recipe_id = NULL WHERE household_id = ? AND recipe_id = ?").run(this.#household, id);
    return removed;
  }

  // --- Nights and weeks -------------------------------------------------------

  /** Weekdays (0 = Sunday) the household plans dinners on. */
  nights(): number[] {
    const value = this.meta("nights");
    const parsed = value ? value.split(",").map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [];
    return parsed.length || value === "" ? parsed : [...DEFAULT_NIGHTS];
  }

  setNights(weekdays: readonly number[]): number[] {
    const clean = [...new Set(weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
    this.setMeta("nights", clean.join(","));
    return clean;
  }

  /** The week "plan dinners" means: this week while at least two planned nights remain, else next week. */
  targetWeek(weekdays = this.nights()): string {
    const today = this.today();
    const monday = mondayOf(today);
    const left = Array.from({ length: 7 }, (_, offset) => addDays(monday, offset)).filter((date) => date >= today && weekdays.includes(dayOfWeek(date)));
    return left.length >= 2 ? monday : addDays(monday, 7);
  }

  #rows(from: string, to: string): NightRow[] {
    return this.#db.prepare("SELECT date, recipe_id, cook_id, tried_json FROM meal_nights WHERE household_id = ? AND date >= ? AND date <= ? ORDER BY date").all(this.#household, from, to) as NightRow[];
  }

  #day(date: string, row: { recipeId: string | null; cookId: string | null } | null, people: readonly DietPerson[]): MealDay {
    const today = this.today();
    return {
      date,
      dow: WEEKDAY_SHORT[dayOfWeek(date)]!,
      day: Number(date.slice(8)),
      isToday: date === today,
      isPast: date < today,
      planned: Boolean(row),
      recipe: row ? this.recipe(row.recipeId, people) : null,
      cookId: row?.cookId ?? null,
    };
  }

  /** Saved dinners for the week starting `weekStart` (a Monday), one entry per day. */
  week(weekStart: string, people: readonly DietPerson[] = this.people()): MealDay[] {
    const rows = new Map(this.#rows(weekStart, addDays(weekStart, 6)).map((row) => [row.date, row]));
    return Array.from({ length: 7 }, (_, offset) => {
      const date = addDays(weekStart, offset);
      const row = rows.get(date);
      return this.#day(date, row ? { recipeId: row.recipe_id, cookId: row.cook_id } : null, people);
    });
  }

  night(date: string, people: readonly DietPerson[] = this.people()): MealDay {
    const row = this.#rows(date, date)[0];
    return this.#day(date, row ? { recipeId: row.recipe_id, cookId: row.cook_id } : null, people);
  }

  /** Saved dinners with a recipe from today through the next `days` days. */
  upcoming(days = 7, people: readonly DietPerson[] = this.people()): MealDay[] {
    const today = this.today();
    return this.#rows(today, addDays(today, days - 1)).map((row) => this.#day(row.date, { recipeId: row.recipe_id, cookId: row.cook_id }, people)).filter((day) => day.recipe);
  }

  #history(before: string): CookHistory {
    return (this.#db.prepare("SELECT date, cook_id FROM meal_nights WHERE household_id = ? AND date < ? AND cook_id IS NOT NULL").all(this.#household, before) as Array<{ date: string; cook_id: string }>)
      .map((row) => ({ date: row.date, cookId: row.cook_id }));
  }

  /** Recipes cooked in the two weeks before `before`: recipe id → days since (the latest time). */
  #recent(before: string): Map<string, number> {
    const rows = this.#db.prepare("SELECT recipe_id, MAX(date) AS last FROM meal_nights WHERE household_id = ? AND date >= ? AND date < ? AND recipe_id IS NOT NULL GROUP BY recipe_id").all(this.#household, addDays(before, -14), before) as Array<{ recipe_id: string; last: string }>;
    const at = (date: string) => Date.parse(`${date}T12:00:00Z`);
    return new Map(rows.map((row) => [row.recipe_id, Math.round((at(before) - at(row.last)) / 86_400_000)]));
  }

  /** Fair cook for one night, given everyone else's turns (saved nights and `extra` draft nights). */
  #cookFor(date: string, extra: CookHistory = []): string | null {
    const others = (this.#db.prepare("SELECT date, cook_id FROM meal_nights WHERE household_id = ? AND date <> ? AND cook_id IS NOT NULL").all(this.#household, date) as Array<{ date: string; cook_id: string }>)
      .map((row) => ({ date: row.date, cookId: row.cook_id }));
    const away = this.awayUntil();
    return assignCooks({ dates: [date], memberIds: this.members().map((member) => member.id), history: [...others.filter((entry) => entry.date < date), ...extra.filter((entry) => entry.date < date)], isAway: (id, day) => this.isAway(id, day, away) }).get(date) ?? null;
  }

  #upsert(date: string, fields: { recipeId?: string | null; cookId?: string | null; tried?: string[] }, actorId: string | null): void {
    const row = this.#rows(date, date)[0];
    const recipeId = fields.recipeId !== undefined ? fields.recipeId : row?.recipe_id ?? null;
    const cookId = fields.cookId !== undefined ? fields.cookId : row?.cook_id ?? null;
    const tried = fields.tried ?? (row?.tried_json ? JSON.parse(row.tried_json) as string[] : []);
    this.#db.prepare("INSERT INTO meal_nights (household_id, date, recipe_id, cook_id, tried_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (household_id, date) DO UPDATE SET recipe_id = excluded.recipe_id, cook_id = excluded.cook_id, tried_json = excluded.tried_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(this.#household, date, recipeId, cookId, JSON.stringify(tried), actorId, new Date(this.#now()).toISOString());
  }

  /** Plans (or changes) one night. A recipe without a cook gets the fair next cook. `off` clears the night. */
  setNight(date: string, input: { recipeId?: string | null; cookId?: string | null; off?: boolean }, actorId: string | null): MealDay {
    // A night in the open suggestion changes the suggestion; "ok" (or Keep) saves it with the rest.
    const draft = this.#draftRow();
    if (draft && draft.nights.some((night) => night.date === date)) {
      if (input.off) draft.nights = draft.nights.filter((night) => night.date !== date);
      else draft.nights = draft.nights.map((night) => night.date === date ? { ...night, ...(input.recipeId !== undefined ? { recipeId: input.recipeId } : {}), ...(input.cookId !== undefined ? { cookId: input.cookId } : {}) } : night);
      this.#saveDraft(draft.weekStart, draft.nights, draft.proposerId, draft.createdAt);
      return this.draft()!.days.find((day) => day.date === date)!;
    }
    if (input.off) {
      this.#db.prepare("DELETE FROM meal_nights WHERE household_id = ? AND date = ?").run(this.#household, date);
      return this.night(date);
    }
    const existing = this.#rows(date, date)[0];
    const cookId = input.cookId !== undefined ? input.cookId : existing?.cook_id ?? this.#cookFor(date);
    this.#upsert(date, { recipeId: input.recipeId, cookId }, actorId);
    return this.night(date);
  }

  // --- Drafts ("plan dinners" → "ok") -----------------------------------------

  #draftRow(): { weekStart: string; nights: NightDraft[]; proposerId: string | null; createdAt: string } | null {
    const row = this.#db.prepare("SELECT week_start, nights_json, proposer_id, created_at FROM meal_drafts WHERE household_id = ?").get(this.#household) as { week_start: string; nights_json: string; proposer_id: string | null; created_at: string } | undefined;
    if (!row) return null;
    if (this.#now() - Date.parse(row.created_at) > DRAFT_TTL_MS || addDays(row.week_start, 6) < this.today()) {
      this.discardDraft();
      return null;
    }
    return { weekStart: row.week_start, nights: JSON.parse(row.nights_json) as NightDraft[], proposerId: row.proposer_id, createdAt: row.created_at };
  }

  #saveDraft(weekStart: string, nights: NightDraft[], proposerId: string | null, createdAt = new Date(this.#now()).toISOString()): void {
    this.#db.prepare("INSERT INTO meal_drafts (household_id, week_start, nights_json, proposer_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (household_id) DO UPDATE SET week_start = excluded.week_start, nights_json = excluded.nights_json, proposer_id = excluded.proposer_id, created_at = excluded.created_at")
      .run(this.#household, weekStart, JSON.stringify(nights.sort((a, b) => a.date.localeCompare(b.date))), proposerId, createdAt);
  }

  draft(people: readonly DietPerson[] = this.people()): MealDraft | null {
    const row = this.#draftRow();
    if (!row) return null;
    const byDate = new Map(row.nights.map((night) => [night.date, night]));
    return {
      weekStart: row.weekStart,
      proposerId: row.proposerId,
      createdAt: row.createdAt,
      days: Array.from({ length: 7 }, (_, offset) => {
        const date = addDays(row.weekStart, offset);
        const night = byDate.get(date);
        return this.#day(date, night ? { recipeId: night.recipeId, cookId: night.cookId } : null, people);
      }),
    };
  }

  /** The draft's date for a weekday, when the open draft covers it. */
  draftDate(weekday: number): string | null {
    const row = this.#draftRow();
    return row?.nights.find((night) => dayOfWeek(night.date) === weekday)?.date ?? null;
  }

  /**
   * Suggests dinners for a week (default: the target week, on the household's nights, from today on) and saves them
   * as the open draft. Nights that already have a saved recipe are kept unless every night is planned already.
   */
  propose(input: { weekStart?: string; weekdays?: readonly number[] | null; proposerId: string | null; seed?: string }): { ok: true; draft: MealDraft } | { ok: false; error: string } {
    const weekdays = input.weekdays?.length ? [...input.weekdays] : this.nights();
    const weekStart = input.weekStart ? mondayOf(input.weekStart) : this.targetWeek(weekdays);
    const today = this.today();
    const dates = Array.from({ length: 7 }, (_, offset) => addDays(weekStart, offset)).filter((date) => date >= today && weekdays.includes(dayOfWeek(date)));
    if (!dates.length) return { ok: false, error: "No nights left to plan that week." };
    const people = this.people();
    const saved = new Map(this.#rows(dates[0]!, dates[dates.length - 1]!).map((row) => [row.date, row]));
    const allPlanned = dates.every((date) => saved.get(date)?.recipe_id);
    const fixedRecipes = new Map<string, string>();
    const fixedCooks = new Map<string, string | null>();
    if (!allPlanned) {
      for (const date of dates) {
        const row = saved.get(date);
        if (row?.recipe_id) fixedRecipes.set(date, row.recipe_id);
        if (row?.cook_id) fixedCooks.set(date, row.cook_id);
      }
    }
    const recipes = this.recipes(people);
    const picks = suggestMeals({ dates, recipes, people, seed: input.seed ?? randomUUID(), recent: this.#recent(dates[0]!), inStock: this.inStockKeys(), fixed: fixedRecipes });
    const away = this.awayUntil();
    const cooks = assignCooks({ dates, memberIds: this.members().map((member) => member.id), history: this.#history(dates[0]!), isAway: (id, date) => this.isAway(id, date, away), fixed: fixedCooks });
    this.#saveDraft(weekStart, dates.map((date) => ({ date, recipeId: picks.get(date) ?? null, cookId: cooks.get(date) ?? null, tried: picks.get(date) ? [picks.get(date)!] : [] })), input.proposerId);
    return { ok: true, draft: this.draft(people)! };
  }

  /** Saves the open draft as the plan. */
  acceptDraft(actorId: string | null): { ok: true; days: MealDay[]; weekStart: string } | { ok: false; error: string } {
    const row = this.#draftRow();
    if (!row) return { ok: false, error: "There’s no suggested plan to save. Text “plan dinners” for one." };
    for (const night of row.nights) this.#upsert(night.date, { recipeId: night.recipeId, cookId: night.cookId, tried: night.tried }, actorId);
    this.discardDraft();
    return { ok: true, days: this.week(row.weekStart), weekStart: row.weekStart };
  }

  discardDraft(): boolean {
    return Number(this.#db.prepare("DELETE FROM meal_drafts WHERE household_id = ?").run(this.#household).changes) > 0;
  }

  /**
   * Swaps one night's recipe: to `recipeQuery` when given, else to the next best suggestion not already in the week
   * (nor tried for that night). Works on the open draft when it covers the date, else on the saved plan.
   */
  swap(date: string, input: { recipeQuery?: string | null; actorId: string | null; seed?: string }): { ok: true; day: MealDay; inDraft: boolean } | { ok: false; error: string } {
    const people = this.people();
    let chosen: RecipeView | null = null;
    if (input.recipeQuery) {
      chosen = this.findRecipe(input.recipeQuery);
      if (!chosen) return { ok: false, error: `I don’t have a recipe called “${input.recipeQuery}”. Add it: “add recipe ${input.recipeQuery}: …”.` };
    }
    const draft = this.#draftRow();
    const inDraft = Boolean(draft?.nights.some((night) => night.date === date));
    const weekStart = mondayOf(date);
    const weekRecipes = new Set<string>();
    let tried: string[] = [];
    let current: string | null = null;
    if (inDraft) {
      for (const night of draft!.nights) if (night.recipeId && night.date !== date) weekRecipes.add(night.recipeId);
      const night = draft!.nights.find((entry) => entry.date === date)!;
      tried = night.tried ?? [];
      current = night.recipeId;
    } else {
      const row = this.#rows(date, date)[0];
      if (!row) return { ok: false, error: `Nothing planned ${WEEKDAY_SHORT[dayOfWeek(date)]}. Text “plan dinners” first.` };
      for (const other of this.#rows(weekStart, addDays(weekStart, 6))) if (other.recipe_id && other.date !== date) weekRecipes.add(other.recipe_id);
      tried = row.tried_json ? JSON.parse(row.tried_json) as string[] : [];
      current = row.recipe_id;
    }
    if (!chosen) {
      const recipes = this.recipes(people);
      const options = { recipes, people, seed: input.seed ?? `${date}:${tried.length}`, recent: this.#recent(weekStart), inStock: this.inStockKeys() };
      const avoid = new Set([...weekRecipes, ...tried, ...(current ? [current] : [])]);
      let ranked = rankRecipes({ ...options, exclude: avoid }).filter((recipe) => !recipeConflicts(recipe.contains, people).length);
      if (!ranked.length) { tried = []; ranked = rankRecipes({ ...options, exclude: new Set([...weekRecipes, ...(current ? [current] : [])]) }); }
      chosen = ranked[0] ? this.recipe(ranked[0].id, people) : null;
      if (!chosen) return { ok: false, error: "I’m out of ideas for that night. Add a recipe: “add recipe …”." };
    }
    const nextTried = [...new Set([...tried, ...(current ? [current] : []), chosen.id])];
    if (inDraft) {
      const extra = draft!.nights.filter((night) => night.cookId && night.date !== date).map((night) => ({ date: night.date, cookId: night.cookId! }));
      draft!.nights = draft!.nights.map((night) => night.date === date ? { ...night, recipeId: chosen!.id, cookId: night.cookId ?? this.#cookFor(date, extra), tried: nextTried } : night);
      this.#saveDraft(draft!.weekStart, draft!.nights, draft!.proposerId, draft!.createdAt);
      return { ok: true, day: this.draft(people)!.days.find((day) => day.date === date)!, inDraft: true };
    }
    const row = this.#rows(date, date)[0]!;
    this.#upsert(date, { recipeId: chosen.id, cookId: row.cook_id ?? this.#cookFor(date), tried: nextTried }, input.actorId);
    return { ok: true, day: this.night(date, people), inDraft: false };
  }

  /** Sets who cooks a night (on the draft when it covers the date). Refuses members who are away that day. */
  setCook(date: string, memberId: string, actorId: string | null): { ok: true; day: MealDay; previous: string | null; inDraft: boolean } | { ok: false; error: string } {
    const away = this.awayUntil();
    if (this.isAway(memberId, date, away)) return { ok: false, error: `${this.memberName(memberId)} is away then (back ${away.get(memberId)}).` };
    const draft = this.#draftRow();
    if (draft?.nights.some((night) => night.date === date)) {
      const previous = draft.nights.find((night) => night.date === date)!.cookId;
      draft.nights = draft.nights.map((night) => night.date === date ? { ...night, cookId: memberId } : night);
      this.#saveDraft(draft.weekStart, draft.nights, draft.proposerId, draft.createdAt);
      return { ok: true, day: this.draft()!.days.find((day) => day.date === date)!, previous, inDraft: true };
    }
    const previous = this.#rows(date, date)[0]?.cook_id ?? null;
    this.#upsert(date, { cookId: memberId }, actorId);
    return { ok: true, day: this.night(date), previous, inDraft: false };
  }

  /** The next week's shopping list from saved dinners (today through six days out). */
  shoppingList(options: { inStock?: ReadonlySet<string>; inCart?: ReadonlySet<string> } = {}): { dinners: MealDay[]; lines: ShoppingLine[] } {
    const dinners = this.upcoming(7);
    return { dinners, lines: aggregateIngredients(dinners.map((day) => ({ recipe: day.recipe! })), options) };
  }
}
