import type { KrogerProduct } from "../kroger.js";

// Kroger price helpers: promo prices apply only while the promo is current.

export function currentPriceCents(product: KrogerProduct): number | null {
  return isCurrentPromo(product) ? product.promoPriceCents : product.regularPriceCents;
}

export function isCurrentPromo(product: KrogerProduct): boolean {
  const now = Date.now();
  const effectiveAt = product.promoEffectiveAt ? Date.parse(product.promoEffectiveAt) : 0;
  const expiresAt = product.promoExpiresAt && !product.promoExpiresAt.startsWith("9999")
    ? Date.parse(product.promoExpiresAt)
    : Number.POSITIVE_INFINITY;
  const promoIsCurrent = (Number.isNaN(effectiveAt) || effectiveAt <= now)
    && (Number.isNaN(expiresAt) || expiresAt > now);
  return promoIsCurrent && product.promoPriceCents !== null && product.promoPriceCents > 0;
}

export function meetsPriceLimit(product: KrogerProduct, cents: number | undefined, inclusive: boolean): boolean {
  if (cents === undefined) return true;
  const price = currentPriceCents(product);
  if (price === null) return false;
  return inclusive ? price <= cents : price < cents;
}
