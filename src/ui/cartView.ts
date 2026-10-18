// Groceries page view logic shared by the page script (src/ui/cartPage.ts) and the tests. CART_VIEW_SCRIPT is plain
// browser JavaScript (no build step) defining `CartView`; cartViewHelpers() evaluates the very same source so
// src/groceryActions.test.ts checks what the browser runs. Input is the GET /api/cart payload.
//
//   groupItems(cart)  the Cart list grouped by roommate: a "Shared" section first (items split among several people),
//                     then one section per member with items of their own, each with a subtotal. The subtotals add
//                     up to the cart total.
//   orderState(cart)  live mode's Order card: the one next step for the viewer (approve, order, review unavailable
//                     items, sign in to Kroger, open the Kroger cart), or null in the demo, which keeps its own controls.

export type CartGroup = { key: string; member: { id: string; name: string } | null; items: unknown[]; totalCents: number };
export type OrderState =
  | { step: "unavailable" }
  | { step: "empty" }
  | { step: "approvals"; waiting: Array<{ id: string; name: string; you: boolean }>; viewerApproved: boolean }
  | { step: "ready" }
  | { step: "review"; items: unknown[] }
  | { step: "choosing"; mine: boolean; requesterName: string }
  | { step: "signin"; mine: boolean; accountName: string; signInUrl: string; canSignInHere: boolean; needsHost: boolean; canCancel: boolean }
  | { step: "sending"; accountName: string }
  | { step: "uncertain"; canCancel: boolean }
  | { step: "sent"; mine: boolean; accountName: string; itemCount: number; at: string }
  | { step: "pending"; status: string };

export const CART_VIEW_SCRIPT = String.raw`
var CartView = (function () {
  function total(items) {
    return items.reduce(function (sum, item) { return sum + item.totalCents; }, 0);
  }
  /** Who pays for an item alone: its one participant (the owner for older rows without participants). */
  function soleOwner(item) {
    return item.participantIds.length === 1 ? item.participantIds[0] : item.ownerId;
  }
  function groupItems(cart) {
    var shared = cart.items.filter(function (item) { return item.participantIds.length > 1; });
    var groups = shared.length ? [{ key: "shared", member: null, items: shared, totalCents: total(shared) }] : [];
    var known = {};
    cart.members.forEach(function (member) {
      known[member.id] = true;
      var own = cart.items.filter(function (item) { return item.participantIds.length <= 1 && soleOwner(item) === member.id; });
      if (own.length) groups.push({ key: member.id, member: member, items: own, totalCents: total(own) });
    });
    // Items of someone no longer in the household still count toward the total.
    var others = cart.items.filter(function (item) { return item.participantIds.length <= 1 && !known[soleOwner(item)]; });
    if (others.length) groups.push({ key: "others", member: null, items: others, totalCents: total(others) });
    return groups;
  }
  function orderState(cart) {
    if (cart.demoMode) return null;
    if (!cart.krogerConfigured) return { step: "unavailable" };
    var viewer = cart.viewerId;
    function nameOf(id) {
      var member = cart.members.find(function (candidate) { return candidate.id === id; });
      return member ? member.name : "A former member";
    }
    var pending = cart.krogerCheckout;
    if (pending) {
      if (pending.status === "transfer_uncertain") return { step: "uncertain", canCancel: pending.requesterId === viewer };
      if (pending.status === "adding") return { step: "sending", accountName: nameOf(pending.selectedMemberId) };
      if (pending.status === "replacement_review") return { step: "review", items: cart.krogerReview || [] };
      if (pending.status === "choosing_account") return { step: "choosing", mine: pending.requesterId === viewer, requesterName: nameOf(pending.requesterId) };
      if (pending.status === "awaiting_oauth" && pending.selectedMemberId) {
        var mine = pending.selectedMemberId === viewer;
        return {
          step: "signin",
          mine: mine,
          accountName: nameOf(pending.selectedMemberId),
          signInUrl: "/api/kroger/oauth/start?memberId=" + encodeURIComponent(pending.selectedMemberId),
          // The account's owner signs in; on the computer running GroupCart anyone can do it for them.
          canSignInHere: mine || Boolean(cart.hostComputer),
          needsHost: Boolean(cart.krogerSignInNeedsHost),
          canCancel: pending.requesterId === viewer,
        };
      }
      return { step: "pending", status: pending.status };
    }
    if (!cart.items.length) {
      var sent = cart.krogerLastCart;
      if (sent && cart.checkedOutRevision === sent.revision) {
        return { step: "sent", mine: sent.memberId === viewer, accountName: sent.memberName, itemCount: sent.itemCount, at: sent.at };
      }
      return { step: "empty" };
    }
    var waiting = cart.members.filter(function (member) { return !member.approved; });
    if (waiting.length) {
      return {
        step: "approvals",
        waiting: waiting.map(function (member) { return { id: member.id, name: member.name, you: member.id === viewer }; }),
        viewerApproved: !waiting.some(function (member) { return member.id === viewer; }),
      };
    }
    return { step: "ready" };
  }
  return { groupItems: groupItems, orderState: orderState };
})();
`;

export type CartViewHelpers = {
  groupItems(cart: unknown): CartGroup[];
  orderState(cart: unknown): OrderState | null;
};

/** The browser helpers, evaluated from the same source the page ships (for tests). */
export function cartViewHelpers(): CartViewHelpers {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${CART_VIEW_SCRIPT}\nreturn CartView;`)() as CartViewHelpers;
}
