export type Product = {
  id: string;
  name: string;
  priceCents: number;
  aliases: string[];
};

export type CartRequest = {
  product: Product;
  quantity: number;
};

export const CATALOG: Product[] = [
  { id: "whole-milk", name: "Whole milk", priceCents: 349, aliases: ["whole milk", "dairy milk"] },
  { id: "two-percent-milk", name: "2% milk", priceCents: 349, aliases: ["2% milk", "2 percent milk", "reduced fat milk"] },
  { id: "oat-milk", name: "Oat milk", priceCents: 379, aliases: ["oat milk", "oatmilk"] },
  { id: "almond-milk", name: "Almond milk", priceCents: 379, aliases: ["almond milk"] },
  { id: "eggs", name: "Eggs", priceCents: 329, aliases: ["eggs", "egg"] },
  { id: "bananas", name: "Bananas", priceCents: 150, aliases: ["bananas", "banana"] },
  { id: "pasta", name: "Pasta", priceCents: 199, aliases: ["pasta", "spaghetti", "penne"] },
  { id: "tomato-sauce", name: "Tomato sauce", priceCents: 249, aliases: ["tomato sauce", "pasta sauce", "marinara"] },
  { id: "parmesan", name: "Parmesan", priceCents: 399, aliases: ["parmesan", "parmesan cheese"] },
  { id: "bread", name: "Bread", priceCents: 299, aliases: ["bread", "loaf"] },
  { id: "peanut-butter", name: "Peanut butter", priceCents: 349, aliases: ["peanut butter"] },
  { id: "apples", name: "Apples", priceCents: 299, aliases: ["apples", "apple"] },
  // --- Lists & events: party snacks and household basics for one-off lists (src/namedLists.ts, src/eventsParse.ts) ---
  { id: "coffee", name: "Coffee", priceCents: 899, aliases: ["coffee", "ground coffee", "coffee beans"] },
  { id: "paper-towels", name: "Paper towels", priceCents: 799, aliases: ["paper towels", "paper towel"] },
  { id: "popcorn", name: "Popcorn", priceCents: 399, aliases: ["popcorn"] },
  { id: "candy", name: "Candy", priceCents: 299, aliases: ["candy", "candies"] },
  { id: "tortilla-chips", name: "Tortilla chips", priceCents: 349, aliases: ["tortilla chips", "chips"] },
  { id: "salsa", name: "Salsa", priceCents: 329, aliases: ["salsa"] },
  { id: "soda", name: "Soda 12-pack", priceCents: 699, aliases: ["soda 12-pack", "sodas", "soda"] },
  { id: "party-cups", name: "Party cups", priceCents: 399, aliases: ["party cups", "cups"] },
  { id: "trail-mix", name: "Trail mix", priceCents: 549, aliases: ["trail mix"] },
  { id: "granola-bars", name: "Granola bars", priceCents: 449, aliases: ["granola bars", "granola bar"] },
  { id: "bottled-water", name: "Bottled water", priceCents: 499, aliases: ["bottled water", "water"] },
  // --- end Lists & events ---
  // --- Kitchen: recipe ingredients and pantry staples (src/meals.ts built-in recipes, src/pantry.ts) ---
  { id: "olive-oil", name: "Olive oil", priceCents: 899, aliases: ["olive oil", "extra virgin olive oil"] },
  { id: "rice", name: "Rice", priceCents: 349, aliases: ["rice", "white rice", "brown rice", "jasmine rice"] },
  { id: "tortillas", name: "Tortillas", priceCents: 299, aliases: ["tortillas", "tortilla"] },
  { id: "black-beans", name: "Black beans", priceCents: 129, aliases: ["black beans"] },
  { id: "kidney-beans", name: "Kidney beans", priceCents: 129, aliases: ["kidney beans"] },
  { id: "chickpeas", name: "Chickpeas", priceCents: 139, aliases: ["chickpeas", "garbanzo beans"] },
  { id: "lentils", name: "Lentils", priceCents: 199, aliases: ["lentils"] },
  { id: "avocados", name: "Avocados", priceCents: 349, aliases: ["avocados", "avocado"] },
  { id: "lettuce", name: "Lettuce", priceCents: 229, aliases: ["lettuce", "romaine"] },
  { id: "tomatoes", name: "Tomatoes", priceCents: 299, aliases: ["tomatoes", "tomato"] },
  { id: "canned-tomatoes", name: "Canned tomatoes", priceCents: 179, aliases: ["canned tomatoes", "diced tomatoes", "crushed tomatoes"] },
  { id: "onions", name: "Onions", priceCents: 199, aliases: ["onions", "onion", "yellow onions"] },
  { id: "green-onions", name: "Green onions", priceCents: 99, aliases: ["green onions", "scallions"] },
  { id: "garlic", name: "Garlic", priceCents: 79, aliases: ["garlic"] },
  { id: "spinach", name: "Spinach", priceCents: 349, aliases: ["spinach"] },
  { id: "broccoli", name: "Broccoli", priceCents: 249, aliases: ["broccoli"] },
  { id: "bell-peppers", name: "Bell peppers", priceCents: 299, aliases: ["bell peppers", "bell pepper", "peppers"] },
  { id: "carrots", name: "Carrots", priceCents: 149, aliases: ["carrots", "carrot"] },
  { id: "celery", name: "Celery", priceCents: 199, aliases: ["celery"] },
  { id: "cucumbers", name: "Cucumbers", priceCents: 199, aliases: ["cucumbers", "cucumber"] },
  { id: "potatoes", name: "Potatoes", priceCents: 449, aliases: ["potatoes", "potato"] },
  { id: "lemons", name: "Lemons", priceCents: 199, aliases: ["lemons", "lemon"] },
  { id: "frozen-peas", name: "Frozen peas", priceCents: 199, aliases: ["frozen peas", "peas"] },
  { id: "olives", name: "Olives", priceCents: 349, aliases: ["olives"] },
  { id: "tofu", name: "Tofu", priceCents: 279, aliases: ["tofu"] },
  { id: "chicken-thighs", name: "Chicken thighs", priceCents: 899, aliases: ["chicken thighs", "chicken thigh", "chicken breasts", "chicken breast", "chicken"] },
  { id: "ground-beef", name: "Ground beef", priceCents: 699, aliases: ["ground beef", "hamburger meat"] },
  { id: "ground-turkey", name: "Ground turkey", priceCents: 649, aliases: ["ground turkey"] },
  { id: "salmon", name: "Salmon", priceCents: 1199, aliases: ["salmon", "salmon fillets"] },
  { id: "shrimp", name: "Shrimp", priceCents: 999, aliases: ["shrimp"] },
  { id: "shredded-cheese", name: "Shredded cheese", priceCents: 399, aliases: ["shredded cheese", "cheddar", "cheese"] },
  { id: "feta", name: "Feta", priceCents: 449, aliases: ["feta cheese", "feta"] },
  { id: "mozzarella", name: "Mozzarella", priceCents: 449, aliases: ["mozzarella cheese", "mozzarella"] },
  { id: "butter", name: "Butter", priceCents: 499, aliases: ["butter"] },
  { id: "sour-cream", name: "Sour cream", priceCents: 249, aliases: ["sour cream"] },
  { id: "coconut-cream", name: "Coconut cream", priceCents: 279, aliases: ["coconut cream"] },
  { id: "burger-buns", name: "Burger buns", priceCents: 349, aliases: ["burger buns", "hamburger buns", "buns"] },
  { id: "pita", name: "Pita bread", priceCents: 299, aliases: ["pita bread", "pita"] },
  { id: "pizza-dough", name: "Pizza dough", priceCents: 349, aliases: ["pizza dough"] },
  { id: "noodles", name: "Noodles", priceCents: 249, aliases: ["noodles"] },
  { id: "vegetable-broth", name: "Vegetable broth", priceCents: 279, aliases: ["vegetable broth", "veggie broth", "broth"] },
  { id: "soy-sauce", name: "Soy sauce", priceCents: 329, aliases: ["soy sauce"] },
  { id: "curry-paste", name: "Curry paste", priceCents: 399, aliases: ["curry paste"] },
  { id: "chili-powder", name: "Chili powder", priceCents: 299, aliases: ["chili powder"] },
  // --- end Kitchen ---
];

const aliasEntries = CATALOG.flatMap((product) =>
  product.aliases.map((alias) => ({ product, alias })),
).sort((a, b) => b.alias.length - a.alias.length);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quantityAround(text: string, start: number, end: number): number {
  const before = text.slice(Math.max(0, start - 12), start);
  const after = text.slice(end, end + 12);
  const prefix = before.match(/(\d+)\s*(?:x|×)?\s*$/i);
  const suffix = after.match(/^\s*(?:x|×)?\s*(\d+)/i);
  const quantity = Number(prefix?.[1] ?? suffix?.[1] ?? 1);
  return Number.isSafeInteger(quantity) ? Math.min(Math.max(quantity, 1), 99) : 1;
}

/** Deterministic catalog matcher for the first live demo; AI extraction can sit in front of it later. */
export function extractCartRequests(text: string): CartRequest[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const matches: Array<{ product: Product; start: number; end: number; quantity: number }> = [];

  for (const { product, alias } of aliasEntries) {
    const expression = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(alias)})(?=$|[^\\p{L}\\p{N}])`, "giu");
    let match: RegExpExecArray | null;
    while ((match = expression.exec(normalized)) !== null) {
      const start = match.index + (match[1] ?? "").length;
      const end = start + (match[2] ?? "").length;
      if (matches.some((existing) => start < existing.end && end > existing.start)) continue;
      matches.push({ product, start, end, quantity: quantityAround(normalized, start, end) });
    }
  }

  matches.sort((a, b) => a.start - b.start);
  const totals = new Map<string, CartRequest>();
  for (const match of matches) {
    const existing = totals.get(match.product.id);
    if (existing) existing.quantity = Math.min(existing.quantity + match.quantity, 99);
    else totals.set(match.product.id, { product: match.product, quantity: match.quantity });
  }
  return [...totals.values()];
}

export function isGenericMilkRequest(text: string): boolean {
  return /\bmilk\b/i.test(text) && !/(?:\bwhole\b|\b2\s*%|\btwo percent\b|\breduced fat\b|\boat\b|\balmond\b|\bsoy\b|\bskim\b|\b1\s*%|\bnonfat\b|\blactose[- ]free\b|\bdarigold\b)/i.test(text);
}

export function resolveMilkChoice(text: string): Product | undefined {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  if (/^\s*1\b|\bwhole(?: milk)?\b|\bdairy(?: milk)?\b/.test(normalized)) return CATALOG.find((item) => item.id === "whole-milk");
  if (/^\s*2\b|\b2\s*%|\btwo percent\b/.test(normalized)) return CATALOG.find((item) => item.id === "two-percent-milk");
  if (/^\s*3\b|\boat(?: milk)?\b/.test(normalized)) return CATALOG.find((item) => item.id === "oat-milk");
  if (/^\s*4\b|\balmond(?: milk)?\b/.test(normalized)) return CATALOG.find((item) => item.id === "almond-milk");
  return undefined;
}

export function unsupportedBrandedRequest(text: string): string | undefined {
  if (/\bvital\s+farms?\b/i.test(text) && /\beggs?\b/i.test(text)) return "Vital Farms organic eggs";
  if (/\bdarigold\b/i.test(text) && /\bmilk\b/i.test(text)) return "Darigold milk";
  return undefined;
}

export function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
