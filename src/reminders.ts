import type { CartStore } from "./store.js";

export type GroupTarget = { type?: string; send: (text: string) => Promise<unknown> };
export type ReminderDelivery = "no-group" | "none" | "sent" | "failed";

/**
 * Send any due recurring-list check-in to the household group the bot has
 * already seen allowlisted messages from. Each list is claimed at most once per
 * cycle before sending; a failed send releases the claim for a later attempt.
 */
export async function deliverDueListReminders(
  store: CartStore,
  openGroup: (ref: { id: string; phone?: string }) => Promise<GroupTarget>,
): Promise<{ status: ReminderDelivery; lists?: string[]; error?: string }> {
  const groupRef = store.groupSpace();
  if (!groupRef) return { status: "no-group" };
  const claim = store.claimDueListReminders();
  if (!claim) return { status: "none" };
  const lists = claim.claims.map((entry) => entry.listKey);
  try {
    const group = await openGroup(groupRef);
    if (group.type !== "group") throw new Error("The saved household conversation is not a group chat.");
    await group.send(claim.text);
    return { status: "sent", lists };
  } catch (error) {
    store.releaseListReminders(claim);
    return { status: "failed", lists, error: error instanceof Error ? error.message : String(error) };
  }
}
