// Grocery lookups for the household coordinator: a few candidate products for a plain request ("milk",
// "flour"), from Kroger when it is configured (store-specific quotes) or from the sample catalog otherwise
// (estimates). The coordinator shows them as a choices card and adds the confirmed ones with add_to_cart.
import { CATALOG, money } from "../cart.js";
import type { KrogerClient } from "../kroger.js";

export type GroceryOption = {
  /** Kroger productId, or the sample catalog id. */
  id: string;
  name: string;
  /** Size or brand line, when known. */
  detail: string;
  /** "$3.49", or "" when Kroger returned no price. */
  price: string;
  source: "kroger" | "sample";
};

const MAX_OPTIONS = 5;

function sampleMatches(query: string): GroceryOption[] {
  const wanted = query.toLowerCase().replace(/[^a-z0-9% ]+/g, " ").trim();
  if (!wanted) return [];
  const words = wanted.split(/\s+/).filter((word) => word.length > 2);
  return CATALOG
    .filter((product) => [product.name.toLowerCase(), ...product.aliases].some((alias) => wanted.includes(alias) || alias.includes(wanted) || words.some((word) => alias.split(" ").includes(word))))
    .map((product) => ({ id: product.id, name: product.name, detail: "Sample catalog", price: money(product.priceCents), source: "sample" as const }));
}

/** Up to `limit` options for one grocery request. Kroger errors propagate so the caller can say the search failed. */
export async function findGroceries(query: string, kroger: KrogerClient | null, limit = 3): Promise<GroceryOption[]> {
  const count = Math.max(1, Math.min(MAX_OPTIONS, Math.floor(limit)));
  if (!kroger) return sampleMatches(query).slice(0, count);
  const { products } = await kroger.searchProducts(query);
  return products.slice(0, count).map((product) => {
    const cents = product.promoPriceCents ?? product.regularPriceCents;
    return {
      id: product.productId,
      name: [product.brand, product.description].filter(Boolean).join(" ").replace(/^(.+?) \1 /, "$1 "),
      detail: product.size ?? "",
      price: cents === null ? "" : money(cents),
      source: "kroger" as const,
    };
  });
}
