// The Groceries page's buttons in live mode, for the signed-in member only (requestViewer in src/auth.ts):
//   POST /api/groceries/add {productId}         add that exact Kroger product (looked up again at the store) for you
//   POST /api/groceries/remove {itemId}         take yourself off one item, as the chat's “remove …” does: deleted
//                                               when only you have it, your share dropped when shared, never
//                                               someone else's item
//   POST /api/groceries/approve                 approve your own share of the current cart
//   POST /api/groceries/order                   “Order with Kroger”: the same checkout as texting “checkout”; when
//                                               GroupCart asks whose Kroger account to use, it answers with yours
//   POST /api/groceries/review {item, option?}  answer the availability review (“replace 1 with 2” / “remove 1”)
//   POST /api/groceries/cancel                  “cancel checkout”
// A click is a message from you in the household chat: the web chat posts “Maya: approve” to the iMessage group
// first (nothing happens when that fails), GroupCart's built-in command handling runs it (runBuiltInCommand, never
// the household coordinator), and its reply goes to the group as well. GroupCart only fills a Kroger cart: the
// member picks a time and pays on Kroger. The local demo keeps its own controls (/api/approve, /api/checkout).
import { HttpError, isSameOriginMutation, readJsonBody, requestViewer, sendJson } from "./auth.js";
import { ChatError, type ChatService, type MemberMessageProcessor } from "./chat.js";
import type { KrogerClient, KrogerProduct } from "./kroger.js";
import { registerRoute, runBuiltInCommand } from "./platform.js";
import { currentPriceCents } from "./store/pricing.js";
import type { CartStore, Member } from "./store.js";

export type GroceryActionsOptions = {
  store: CartStore;
  /** The web chat, which relays each click to the iMessage group as the member's line. */
  chat: ChatService;
  kroger: KrogerClient | null;
};

/** Kroger product ids are short digit strings; anything else did not come from a search result. */
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const CART_LOCKED = "Finish or cancel the Kroger checkout first; the cart is locked until then.";

export function setupGroceryActions({ store, chat, kroger }: GroceryActionsOptions): void {
  /** Posts `text` to the household chat as the member and returns GroupCart's reply. */
  async function say(member: Member, text: string, process: MemberMessageProcessor = runBuiltInCommand): Promise<string> {
    const { reply } = await chat.send(member, { text }, { source: "web", awaitReply: true, process });
    if (!reply) throw new HttpError(502, "That didn’t go through. Check the chat, then try again.");
    return reply;
  }

  async function order(member: Member): Promise<string> {
    const reply = await say(member, "checkout");
    const pending = store.pendingKrogerCheckout();
    if (pending?.status !== "choosing_account" || pending.requesterId !== member.id) return reply;
    // GroupCart asked whose Kroger account gets the items; the member who pressed Order uses their own, answered
    // by number exactly as in the chat.
    const number = store.getMembers().findIndex((candidate) => candidate.id === member.id) + 1;
    return say(member, String(number));
  }

  async function add(member: Member, body: Record<string, unknown>): Promise<string> {
    if (!kroger) throw new HttpError(503, "Kroger isn’t connected, so products can’t be added here.");
    const productId = typeof body.productId === "string" ? body.productId.trim() : "";
    if (!PRODUCT_ID.test(productId)) throw new HttpError(400, "Pick a product from the search results.");
    // Checked before posting anything, so a refused add doesn't show up in the group.
    if (store.pendingKrogerCheckout()) throw new HttpError(409, CART_LOCKED);
    let product: KrogerProduct | null;
    try {
      product = await kroger.getProduct(productId);
    } catch (error) {
      throw new HttpError(502, `Couldn’t reach Kroger (${error instanceof Error ? error.message : "request failed"}). Nothing was added.`);
    }
    if (!product) throw new HttpError(404, "Kroger doesn’t list that product at this store anymore. Search again.");
    if (currentPriceCents(product) === null || !product.upc) {
      throw new HttpError(409, `Kroger didn’t return a store price and UPC for ${product.description}, so it can’t be ordered.`);
    }
    const chosen = product;
    return say(member, `add ${chosen.description}${chosen.size ? ` (${chosen.size})` : ""}`, async ({ messageId }) => store.addKrogerProduct(messageId, member.id, chosen));
  }

  async function remove(member: Member, body: Record<string, unknown>): Promise<string> {
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const item = store.snapshot().items.find((candidate) => candidate.id === itemId);
    // Checked before posting anything; the store enforces the same rules when it runs.
    if (!item) throw new HttpError(404, "That item isn’t in the cart anymore.");
    if (!item.participantIds.includes(member.id)) throw new HttpError(403, "That item isn’t yours, so it was left alone. Ask whoever added it to remove it.");
    if (store.pendingKrogerCheckout()) throw new HttpError(409, CART_LOCKED);
    const label = item.participantIds.length > 1 ? `remove my share of ${item.name}` : `remove ${item.name}`;
    return say(member, label, async ({ messageId }) => store.removeItemForMember(messageId, member.id, item.id));
  }

  async function review(member: Member, body: Record<string, unknown>): Promise<string> {
    const item = Number(body.item);
    const option = body.option === undefined || body.option === null ? null : Number(body.option);
    const valid = (value: number) => Number.isInteger(value) && value >= 1 && value <= 99;
    if (!valid(item) || (option !== null && !valid(option))) throw new HttpError(400, "Pick an unavailable item (and a suggestion to swap in).");
    if (store.pendingKrogerCheckout()?.status !== "replacement_review") throw new HttpError(409, "There isn’t an availability review open.");
    return say(member, option === null ? `remove ${item}` : `replace ${item} with ${option}`);
  }

  async function act(path: string, member: Member, body: Record<string, unknown>): Promise<string> {
    switch (path) {
      case "/api/groceries/add": return add(member, body);
      case "/api/groceries/remove": return remove(member, body);
      case "/api/groceries/approve":
        if (body.memberId !== undefined && body.memberId !== member.id) throw new HttpError(403, "You can only approve your own share.");
        return say(member, "approve");
      case "/api/groceries/order": return order(member);
      case "/api/groceries/review": return review(member, body);
      case "/api/groceries/cancel":
        if (!store.pendingKrogerCheckout()) throw new HttpError(409, "There isn’t a Kroger checkout to cancel.");
        return say(member, "cancel checkout");
      default: throw new HttpError(404, "Not found.");
    }
  }

  registerRoute(async (request, response, url) => {
    if (!url.pathname.startsWith("/api/groceries/")) return false;
    try {
      if (request.method !== "POST") throw new HttpError(405, "Use POST.");
      if (!isSameOriginMutation(request)) throw new HttpError(403, "This request must come from the GroupCart page.");
      const viewer = requestViewer(request);
      if (!viewer) throw new HttpError(401, "Sign in to GroupCart first.");
      const body = await readJsonBody(request, 2_048);
      sendJson(response, 200, { message: await act(url.pathname, viewer.member, body) });
    } catch (error) {
      if (error instanceof HttpError || error instanceof ChatError) {
        sendJson(response, error.status, { error: error.message });
      } else {
        console.warn("Grocery action failed:", error instanceof Error ? error.message : error);
        sendJson(response, 500, { error: "Something went wrong." });
      }
    }
    return true;
  });
}
