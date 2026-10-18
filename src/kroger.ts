import { createHash, randomBytes } from "node:crypto";

export type KrogerProduct = {
  productId: string;
  description: string;
  brand: string | null;
  upc: string | null;
  size: string | null;
  regularPriceCents: number | null;
  promoPriceCents: number | null;
  promoEffectiveAt: string | null;
  promoExpiresAt: string | null;
  curbsideAvailable?: boolean;
  deliveryAvailable?: boolean;
};

export type KrogerCartItem = { upc: string; quantity: number; modality: "PICKUP" | "DELIVERY" };
export type KrogerUserAuthorization = { memberId: string; accessToken: string };
export type KrogerCartAvailabilityIssue = {
  itemId: string;
  name: string;
  upc: string;
  quantity: number;
  alternatives: KrogerProduct[];
};

type KrogerProductResponse = {
  data?: Array<{
    productId?: string;
    description?: string;
    brand?: string;
    upc?: string;
    items?: Array<{
      size?: string;
      fulfillment?: { curbside?: boolean; delivery?: boolean };
      inventory?: { stockLevel?: string };
      price?: {
        regular?: number;
        promo?: number;
        effectiveDate?: { value?: string };
        expirationDate?: { value?: string };
      };
    }>;
  }>;
  meta?: { pagination?: { total?: number } };
};

export class KrogerClient {
  #accessToken: string | undefined;
  #tokenExpiresAt = 0;
  readonly #pendingUserAuthorizations = new Map<string, { memberId: string; codeVerifier: string; createdAt: number }>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly locationId?: string,
    private readonly redirectUri = "http://127.0.0.1:3000/api/kroger/oauth/callback",
    private readonly cartModality: "PICKUP" | "DELIVERY" = "PICKUP",
  ) {}

  createUserAuthorization(memberId: string): { url: string; state: string } {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.#pendingUserAuthorizations.set(state, { memberId, codeVerifier, createdAt: Date.now() });
    const authorizationUrl = new URL("https://api.kroger.com/v1/connect/oauth2/authorize");
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: "cart.basic:write",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: authorizationUrl.toString(), state };
  }

  async completeUserAuthorization(code: string, state: string): Promise<KrogerUserAuthorization> {
    const authorization = this.#pendingUserAuthorizations.get(state);
    this.#pendingUserAuthorizations.delete(state);
    if (!authorization || Date.now() - authorization.createdAt > 10 * 60_000) {
      throw new Error("Kroger sign-in expired or was already used. Start checkout again to get a fresh sign-in link.");
    }
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        code_verifier: authorization.codeVerifier,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Kroger sign-in failed (${response.status}): ${detail.slice(0, 240)}`);
    }
    const body = await response.json() as { access_token?: string };
    if (!body.access_token) throw new Error("Kroger sign-in did not return an access token.");
    return { memberId: authorization.memberId, accessToken: body.access_token };
  }

  async addItemsToCart(accessToken: string, items: Array<Omit<KrogerCartItem, "modality">>): Promise<void> {
    const response = await fetch("https://api.kroger.com/v1/cart/add", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ items: items.map((item) => ({ ...item, modality: this.cartModality })) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Kroger did not accept the cart items (${response.status}): ${detail.slice(0, 240)}`);
    }
  }

  async checkCartAvailability(
    items: Array<{ id: string; name: string; upc: string; quantity: number }>,
  ): Promise<KrogerCartAvailabilityIssue[]> {
    if (!this.locationId) {
      throw new Error("Set KROGER_LOCATION_ID to the same store selected in Kroger before checking availability.");
    }
    const unavailable: KrogerCartAvailabilityIssue[] = [];
    for (const item of items) {
      const params = new URLSearchParams({ "filter.locationId": this.locationId });
      const response = await fetch(`https://api.kroger.com/v1/products/${encodeURIComponent(item.upc)}?${params}`, {
        headers: { Authorization: `Bearer ${await this.#getAccessToken()}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 404) {
        unavailable.push({ itemId: item.id, name: item.name, upc: item.upc, quantity: item.quantity, alternatives: await this.#availableAlternatives(item.name, item.upc) });
        continue;
      }
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Kroger availability check failed (${response.status}): ${detail.slice(0, 240)}`);
      }

      const body = await response.json() as {
        data?: {
          upc?: string;
          items?: Array<{ fulfillment?: { curbside?: boolean; delivery?: boolean }; inventory?: { stockLevel?: string } }>;
        };
      };
      const matchingItem = body.data?.upc && body.data.upc !== item.upc
        ? []
        : (body.data?.items ?? []).flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
      const fulfillmentKey = this.cartModality === "PICKUP" ? "curbside" : "delivery";
      const availabilityValues = matchingItem.map((entry) => entry.fulfillment?.[fulfillmentKey]);
      if (!availabilityValues.length || availabilityValues.every((available) => available === undefined)) {
        throw new Error(`Kroger did not return ${this.cartModality.toLocaleLowerCase()} availability for ${item.name}; nothing has been sent to the cart. Please retry.`);
      }
      const isAvailable = availabilityValues.some((available) => available === true);
      if (!isAvailable) {
        unavailable.push({ itemId: item.id, name: item.name, upc: item.upc, quantity: item.quantity, alternatives: await this.#availableAlternatives(item.name, item.upc) });
      }
    }
    return unavailable;
  }

  get hasLocation(): boolean {
    return Boolean(this.locationId);
  }

  /** True when Kroger returns from sign-in to this computer (a loopback redirect), so sign-in finishes only here. */
  get signInReturnsToHost(): boolean {
    try {
      return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(this.redirectUri).hostname);
    } catch {
      return false;
    }
  }

  get selectedLocationId(): string | undefined {
    return this.locationId;
  }

  async searchProducts(term: string, fulfillment?: "csp" | "dth"): Promise<{ total: number; products: KrogerProduct[] }> {
    const query = term.trim();
    if (query.length < 2) throw new Error("Enter at least 2 characters to search Kroger.");

    const params = new URLSearchParams({ "filter.term": query, "filter.limit": "10" });
    if (this.locationId) params.set("filter.locationId", this.locationId);
    if (fulfillment) params.set("filter.fulfillment", fulfillment);
    const response = await fetch(`https://api.kroger.com/v1/products?${params}`, {
      headers: { Authorization: `Bearer ${await this.#getAccessToken()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Kroger product search failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const body = await response.json() as KrogerProductResponse;
    const products = (body.data ?? []).map((product) => this.#toProduct(product));

    return { total: body.meta?.pagination?.total ?? products.length, products };
  }

  /** Fetch one product by Kroger product ID at the configured store; null when Kroger has no such product there. */
  async getProduct(productId: string): Promise<KrogerProduct | null> {
    const params = new URLSearchParams();
    if (this.locationId) params.set("filter.locationId", this.locationId);
    const query = params.toString();
    const response = await fetch(`https://api.kroger.com/v1/products/${encodeURIComponent(productId)}${query ? `?${query}` : ""}`, {
      headers: { Authorization: `Bearer ${await this.#getAccessToken()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Kroger product lookup failed (${response.status}): ${detail.slice(0, 240)}`);
    }
    const body = await response.json() as { data?: NonNullable<KrogerProductResponse["data"]>[number] };
    if (!body.data) return null;
    // Like the availability check, tolerate `items` arriving as nested arrays.
    const items = (body.data.items ?? []) as unknown[];
    const flatItems = items.flatMap((entry) => Array.isArray(entry) ? entry : [entry]) as NonNullable<typeof body.data.items>;
    return this.#toProduct({ ...body.data, items: flatItems });
  }

  #toProduct(product: NonNullable<KrogerProductResponse["data"]>[number]): KrogerProduct {
    const item = product.items?.[0];
    return {
      productId: product.productId ?? product.upc ?? "unknown",
      description: product.description ?? "Unnamed product",
      brand: product.brand ?? null,
      upc: product.upc ?? null,
      size: item?.size ?? null,
      regularPriceCents: this.#cents(item?.price?.regular),
      promoPriceCents: this.#cents(item?.price?.promo),
      promoEffectiveAt: item?.price?.effectiveDate?.value ?? null,
      promoExpiresAt: item?.price?.expirationDate?.value ?? null,
      curbsideAvailable: item?.fulfillment?.curbside,
      deliveryAvailable: item?.fulfillment?.delivery,
    };
  }

  async #availableAlternatives(name: string, unavailableUpc: string): Promise<KrogerProduct[]> {
    const query = name.trim().split(/\s+/).slice(0, 8).join(" ");
    if (query.length < 2) return [];
    try {
      const fulfillment = this.cartModality === "PICKUP" ? "csp" : "dth";
      const result = await this.searchProducts(query, fulfillment);
      return result.products
        .filter((product) => product.upc && product.upc !== unavailableUpc
          && (product.promoPriceCents !== null || product.regularPriceCents !== null))
        .slice(0, 3);
    } catch {
      // An unavailable item should still be reported if only the suggestion search failed.
      return [];
    }
  }

  async #getAccessToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#tokenExpiresAt) return this.#accessToken;

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "product.compact" }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      throw new Error(`Kroger authentication failed (${response.status}). Check the Production app credentials and Products API access.`);
    }

    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Kroger authentication response did not include an access token.");
    this.#accessToken = body.access_token;
    this.#tokenExpiresAt = Date.now() + Math.max(30, (body.expires_in ?? 1800) - 60) * 1000;
    return this.#accessToken;
  }

  #cents(value: number | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
  }
}
