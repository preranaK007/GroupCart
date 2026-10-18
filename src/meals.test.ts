// Run with: node --import=tsx --test src/meals.test.ts
// Meal planning: dietary tags and conflicts, the fair cook rotation (with away status), suggestions, ingredient
// aggregation, chat parsing, and the chat flow through the Kitchen (plan → ok, swap, cook, shop for meals through
// the member request path, and leaving a bare "ok" to a newer grocery question). Temporary database, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { addDays, mondayOf } from "./availability.js";
import { Kitchen } from "./kitchen.js";
import {
  BUILTIN_RECIPES, aggregateIngredients, assignCooks, classifyIngredient, dietRules, dietTags, parseMealCommand, parseRecipeText,
  parseWeekdays, recipeConflicts, suggestMeals, withInfo, type DietPerson,
} from "./meals.js";
import { CartStore, type Member } from "./store.js";

let directory: string;
let counter = 0;
const id = () => `meals-test:${++counter}`;

before(() => { directory = mkdtempSync(join(tmpdir(), "groupcart-meals-")); });
after(() => { rmSync(directory, { recursive: true, force: true }); });

const PEOPLE: DietPerson[] = [
  { id: "alex", name: "Alex", notes: "No shellfish" },
  { id: "maya", name: "Maya", notes: "Vegetarian" },
  { id: "jordan", name: "Jordan", notes: "Lactose intolerant (oat milk, please)" },
];

function setup(name: string, now: () => number = Date.now): { store: CartStore; kitchen: Kitchen; alex: Member; maya: Member; jordan: Member } {
  const store = new CartStore(join(directory, `${name}.sqlite`), "household-test", 50_000, "http://127.0.0.1:3999");
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }, { handle: "demo:maya", name: "Maya" }, { handle: "demo:jordan", name: "Jordan" }]);
  const kitchen = new Kitchen({ store, demoMode: true, timeZone: "UTC", now });
  const byName = (memberName: string) => store.getMembers().find((member) => member.name === memberName)!;
  return { store, kitchen, alex: byName("Alex"), maya: byName("Maya"), jordan: byName("Jordan") };
}

function say(kitchen: Kitchen, member: Member, text: string, messageId = id()): Promise<string | null> {
  return kitchen.handle({ messageId, memberId: member.id, memberName: member.name, text, attachments: [] });
}

test("allergens and diet tags come from the ingredients", () => {
  assert.deepEqual(classifyIngredient("soy sauce").sort(), ["gluten", "soy"]);
  assert.deepEqual(classifyIngredient("coconut cream"), []);
  assert.deepEqual(classifyIngredient("peanut butter"), ["peanuts"]);
  assert.deepEqual(classifyIngredient("corn tortillas"), []);
  assert.deepEqual(classifyIngredient("ground beef").sort(), ["beef", "meat"]);
  assert.deepEqual(dietTags(["gluten"]), ["vegan", "vegetarian", "dairy-free", "nut-free"]);
  const recipe = (key: string) => withInfo(BUILTIN_RECIPES.find((entry) => entry.id === key)!);
  assert.deepEqual(recipe("b:chickpea-curry").tags, ["vegan", "vegetarian", "gluten-free", "dairy-free", "nut-free"]);
  assert.ok(!recipe("b:shrimp-pasta").tags.includes("vegetarian"));
  assert.ok(BUILTIN_RECIPES.length >= 14 && BUILTIN_RECIPES.length <= 17);
});

test("dietary notes flag conflicting recipes (simple keyword matching)", () => {
  assert.deepEqual(dietRules("Vegan, nut allergy").map((rule) => rule.label), ["vegan", "nuts"]);
  assert.deepEqual(dietRules("Not vegetarian; dairy is fine"), []);
  assert.deepEqual(dietRules("tree nut allergy").map((rule) => rule.label), ["tree nuts"]);
  const shrimp = withInfo(BUILTIN_RECIPES.find((entry) => entry.id === "b:shrimp-pasta")!);
  assert.deepEqual(recipeConflicts(shrimp.contains, PEOPLE).map((conflict) => `${conflict.name}:${conflict.labels.join("+")}`), ["Alex:shellfish", "Maya:vegetarian", "Jordan:no dairy"]);
  const tacos = withInfo(BUILTIN_RECIPES.find((entry) => entry.id === "b:black-bean-tacos")!);
  assert.deepEqual(recipeConflicts(tacos.contains, PEOPLE), []);
  // The planner leaves conflicting recipes out while enough recipes suit everyone, and doesn't repeat them.
  const dates = Array.from({ length: 7 }, (_, offset) => addDays("2026-10-19", offset));
  const picks = suggestMeals({ dates, recipes: BUILTIN_RECIPES.map(withInfo), people: PEOPLE, seed: "test" });
  const chosen = [...picks.values()].map((recipeId) => withInfo(BUILTIN_RECIPES.find((entry) => entry.id === recipeId)!));
  assert.equal(chosen.length, 7);
  assert.equal(new Set(chosen.map((recipe) => recipe.id)).size, 7);
  for (const recipe of chosen) assert.deepEqual(recipeConflicts(recipe.contains, PEOPLE), [], recipe.name);
});

test("cooks rotate fairly, skip people who are away, and respect fixed cooks", () => {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
  const ids = ["alex", "jordan", "maya"];
  assert.deepEqual([...assignCooks({ dates, memberIds: ids, history: [] }).values()], ["alex", "jordan", "maya", "alex", "jordan"]);
  // Whoever cooked most recently goes last; whoever has never cooked goes first.
  const history = [{ date: "2026-10-16", cookId: "alex" }, { date: "2026-10-15", cookId: "maya" }];
  assert.deepEqual([...assignCooks({ dates: dates.slice(0, 3), memberIds: ids, history }).values()], ["jordan", "maya", "alex"]);
  // Maya is away until the 22nd (back that day): skipped on the 20th and 21st.
  const away = (memberId: string, date: string) => memberId === "maya" && date < "2026-10-22";
  assert.deepEqual([...assignCooks({ dates: dates.slice(0, 4), memberIds: ids, history: [], isAway: away }).values()], ["alex", "jordan", "alex", "maya"]);
  // A fixed cook counts for the rotation that follows.
  assert.deepEqual([...assignCooks({ dates: dates.slice(0, 3), memberIds: ids, history: [], fixed: new Map([["2026-10-19", "maya"]]) }).values()], ["maya", "alex", "jordan"]);
});

test("ingredients aggregate across dinners: one line each, staples once, pantry and cart marked", () => {
  const recipe = (key: string) => BUILTIN_RECIPES.find((entry) => entry.id === key)!;
  const lines = aggregateIngredients(
    [{ recipe: recipe("b:tofu-stir-fry") }, { recipe: recipe("b:chickpea-curry") }, { recipe: recipe("b:salmon-rice") }],
    { inStock: new Set(["p:garlic"]), inCart: new Set(["p:tofu"]) },
  );
  const line = (name: string) => lines.find((entry) => entry.name === name)!;
  assert.equal(lines.filter((entry) => entry.name === "Rice").length, 1);
  assert.equal(line("Rice").quantity, 1); // staple: one bag covers the week
  assert.deepEqual(line("Rice").meals, ["Tofu stir-fry", "Chickpea curry", "Salmon & rice"]);
  assert.equal(line("Broccoli").quantity, 2); // two dinners use it
  assert.equal(line("Garlic").status, "pantry");
  assert.equal(line("Tofu").status, "cart");
  assert.equal(line("Salmon").status, "add");
});

test("meal commands parse without claiming other features' phrases", () => {
  assert.deepEqual(parseMealCommand("plan dinners"), { kind: "plan", weekdays: null, week: null });
  assert.deepEqual(parseMealCommand("plan dinners for next week"), { kind: "plan", weekdays: null, week: "next" });
  assert.deepEqual(parseMealCommand("plan dinners mon-thu"), { kind: "plan", weekdays: [1, 2, 3, 4], week: null });
  assert.deepEqual(parseWeekdays("fri-sun"), [0, 5, 6]);
  assert.deepEqual(parseMealCommand("what's for dinner?"), { kind: "tonight", day: { kind: "today" } });
  assert.deepEqual(parseMealCommand("cook tonight is Maya"), { kind: "cook", day: { kind: "today" }, who: "maya" });
  assert.deepEqual(parseMealCommand("I'll cook tonight"), { kind: "cook", day: { kind: "today" }, who: "me" });
  assert.deepEqual(parseMealCommand("swap tue"), { kind: "swap", day: { kind: "weekday", weekday: 2 }, recipe: null });
  assert.deepEqual(parseMealCommand("shop for meals"), { kind: "shop" });
  assert.deepEqual(parseRecipeText("tacos: tortillas, 1 lb ground beef, salsa, cheese"), { name: "Tacos", ingredients: ["tortillas", "ground beef", "salsa", "cheese"] });
  for (const other of ["plan dinner friday", "plan game night", "lists", "weekly: milk", "dinners this week to cart", "ok", "swap dishes with Maya", "done dishes", "start sharing with Maya"]) {
    assert.equal(parseMealCommand(other), null, other);
  }
});

test("plan dinners → ok saves the week; swap, cook, and what's for dinner", async () => {
  const { store, kitchen, alex, maya } = setup("plan-flow");
  const draft = await say(kitchen, alex, "plan dinners for next week") ?? "";
  assert.match(draft, /^🍽️ Suggested dinners/);
  assert.match(draft, /Reply “ok” to save/);
  const nextMonday = addDays(mondayOf(kitchen.meals.today()), 7);
  assert.equal(kitchen.meals.draft()?.weekStart, nextMonday);
  assert.equal(kitchen.meals.week(nextMonday).filter((day) => day.planned).length, 0);
  // Swapping a night in the suggestion changes the suggestion, not the saved plan.
  const before = kitchen.meals.draft()!.days.find((day) => day.date === addDays(nextMonday, 1))!.recipe!.id;
  assert.match(await say(kitchen, alex, "swap tue") ?? "", /^Tue /);
  assert.notEqual(kitchen.meals.draft()!.days.find((day) => day.date === addDays(nextMonday, 1))!.recipe!.id, before);
  assert.match(await say(kitchen, alex, "ok") ?? "", /^✓ Saved dinners/);
  assert.equal(kitchen.meals.draft(), null);
  const saved = kitchen.meals.week(nextMonday).filter((day) => day.planned);
  assert.equal(saved.length, 5); // Mon–Fri by default
  assert.ok(saved.every((day) => day.recipe && day.cookId));
  assert.ok(new Set(saved.map((day) => day.cookId)).size >= 2);
  // Tonight: nobody planned it yet, then Maya volunteers.
  assert.match(await say(kitchen, maya, "what's for dinner") ?? "", /^Nothing planned tonight/);
  assert.match(await say(kitchen, maya, "I'll cook tonight") ?? "", /^👩‍🍳 Maya cooks tonight/);
  assert.match(await say(kitchen, alex, "swap tonight for black bean tacos") ?? "", /Black bean tacos · Maya/);
  assert.match(await say(kitchen, alex, "what's for dinner") ?? "", /Tonight: 🌮 Black bean tacos · Maya cooks/);
  // Redelivered messages get the same reply (idempotent by message id).
  const again = await say(kitchen, alex, "what's for dinner", "same-message");
  assert.equal(await say(kitchen, alex, "what's for dinner", "same-message"), again);
  store.close();
});

test("a bare “ok” goes to a newer grocery question, and others can't accept an old suggestion", async () => {
  let offset = 0;
  const { store, kitchen, alex, jordan } = setup("ok-disambiguation", () => Date.now() + offset);
  await say(kitchen, alex, "plan dinners for next week");
  // Alex is asked a grocery question after the suggestion, so “ok” is theirs (null = not claimed here).
  assert.match(store.processIncomingText(id(), alex.id, "milk") ?? "", /What kind of milk/);
  assert.equal(await say(kitchen, alex, "ok"), null);
  assert.ok(kitchen.meals.draft());
  store.processIncomingText(id(), alex.id, "cancel");
  // An hour later, someone else's casual “ok” doesn't save the plan; the proposer's still does.
  offset = 3_600_000;
  assert.equal(await say(kitchen, jordan, "ok"), null);
  assert.match(await say(kitchen, alex, "ok") ?? "", /^✓ Saved dinners/);
  store.close();
});

test("shop for meals adds the week's ingredients through the member path (sharing decides the split)", async () => {
  const { store, kitchen, alex, maya } = setup("shop");
  const today = kitchen.meals.today();
  kitchen.meals.setNight(today, { recipeId: "b:tofu-stir-fry", cookId: alex.id }, alex.id);
  kitchen.meals.setNight(addDays(today, 1), { recipeId: "b:chickpea-curry", cookId: maya.id }, alex.id);
  kitchen.pantry.set("garlic", "stock", alex.id);
  kitchen.pantry.set("rice", "low", alex.id); // low still gets bought
  assert.match(store.processIncomingText(id(), alex.id, "start sharing with Maya") ?? "", /Started sharing/);
  const reply = await say(kitchen, alex, "shop for meals") ?? "";
  assert.match(reply, /^🛒 Added/);
  assert.match(reply, /shared: Alex, Maya/);
  assert.match(reply, /Skipped \(in the pantry\): garlic/);
  const names = store.snapshot().items.map((item) => item.name);
  assert.ok(names.includes("Tofu") && names.includes("Chickpeas") && names.includes("Rice"));
  assert.ok(!names.includes("Garlic"));
  assert.ok(store.snapshot().items.every((item) => item.participantIds.length === 2));
  assert.equal(store.snapshot().revision, 1); // one request: one cart revision and one undo step
  // Running it again skips what's now in the cart.
  assert.match(await say(kitchen, alex, "shop for meals") ?? "", /in the pantry or the cart/);
  store.close();
});

test("recipes: add your own; conflicts are flagged and the planner leaves them out", async () => {
  const { store, kitchen, alex } = setup("recipes");
  store.database.exec("CREATE TABLE IF NOT EXISTS profile_profiles (member_id TEXT PRIMARY KEY, dietary TEXT)");
  for (const member of store.getMembers()) store.database.prepare("INSERT INTO profile_profiles (member_id, dietary) VALUES (?, ?)").run(member.id, PEOPLE.find((person) => person.name === member.name)!.notes);
  const reply = await say(kitchen, alex, "add recipe tacos: tortillas, ground beef, salsa, cheese") ?? "";
  assert.match(reply, /^📖 Saved 🌮 Tacos: tortillas, ground beef, salsa, cheese\./);
  assert.match(reply, /Not for Jordan \(no dairy\), Maya \(vegetarian\)/);
  const result = kitchen.meals.propose({ weekStart: addDays(mondayOf(kitchen.meals.today()), 7), weekdays: [0, 1, 2, 3, 4, 5, 6], proposerId: alex.id, seed: "s" });
  assert.ok(result.ok);
  if (result.ok) for (const day of result.draft.days) assert.equal(day.recipe?.conflicts.length ?? 0, 0, day.recipe?.name);
  store.close();
});
