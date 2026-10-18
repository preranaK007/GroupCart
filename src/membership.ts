import { findMember, maskHandle, normalizeHandle } from "./config.js";
import type { MemberConfig } from "./store.js";

// Structural subsets of spectrum-ts `Space` and `Message`, so these handlers can be exercised without a live line.
export type GroupSpace = {
  send(text: string): Promise<unknown>;
  getMembers(): Promise<Array<{ id: string }>>;
};
export type GroupEventMessage = {
  id: string;
  content: { type: string; members?: string[] };
  sender?: { id: string };
};
type ProcessedMessages = { markMessageProcessed(messageId: string, reply: string | null): boolean };

const MEMBERSHIP_EVENTS = new Set(["addMember", "removeMember", "leaveSpace"]);

export function isMembershipEvent(content: { type: string }): boolean {
  return MEMBERSHIP_EVENTS.has(content.type);
}

function joinWords(words: string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

export function welcomeText(names: string[]): string {
  return `Welcome to GroupCart, ${joinWords(names)}! Text an item like “2 bananas” or a short list like “bread, eggs, and milk” to add it to the shared cart. “cart” shows the cart and everyone’s share, “approve” signs off on it, and “help” lists every command.`;
}

export function notAllowlistedText(handles: string[]): string {
  const one = handles.length === 1;
  return [
    `Hi! GroupCart only responds to household members an organizer has listed, and ${one ? "the person just added isn’t" : "the people just added aren’t"} on that list yet`,
    ` (Spectrum sees them as ${joinWords(handles.map(maskHandle))}).`,
    ` An organizer needs to add ${one ? "that phone number or Apple ID" : "those phone numbers or Apple IDs"} to GROUP_CART_MEMBERS and restart GroupCart.`,
    " Until then, GroupCart will ignore their messages.",
  ].join("");
}

function describe(members: MemberConfig[], handle: string): string {
  return findMember(members, handle)?.name ?? `${maskHandle(handle)} (not on GROUP_CART_MEMBERS)`;
}

/**
 * Handles an inbound group membership event. `addMember` gets one reply per Spectrum message id: a short welcome
 * for allowlisted handles and an "ask an organizer" note for others. `removeMember`/`leaveSpace` are only logged.
 * Returns the reply that was sent, or null.
 */
export async function handleMembershipEvent(
  space: GroupSpace,
  message: GroupEventMessage,
  members: MemberConfig[],
  store: ProcessedMessages,
  selfHandle?: string,
): Promise<string | null> {
  const { content } = message;
  const actor = message.sender?.id ? describe(members, message.sender.id) : "an unrecorded participant";
  if (content.type === "leaveSpace") {
    console.log(`Group membership: ${actor} left a household group.`);
    return null;
  }
  if (content.type === "removeMember") {
    const removed = (content.members ?? []).map((handle) => describe(members, handle));
    console.log(`Group membership: ${removed.join(", ") || "someone"} removed from a household group by ${actor}.`);
    return null;
  }
  if (content.type !== "addMember") return null;

  const self = selfHandle ? normalizeHandle(selfHandle) : undefined;
  const added = [...new Set((content.members ?? []).map(normalizeHandle))].filter((handle) => handle && handle !== self);
  const names: string[] = [];
  const unlisted: string[] = [];
  for (const handle of added) {
    const member = findMember(members, handle);
    if (!member) unlisted.push(handle);
    else if (!names.includes(member.name)) names.push(member.name);
  }
  const parts = [names.length ? welcomeText(names) : "", unlisted.length ? notAllowlistedText(unlisted) : ""].filter(Boolean);
  const reply = parts.length ? parts.join("\n\n") : null;

  if (!store.markMessageProcessed(message.id, reply)) {
    console.log("Group membership: skipped an add event that was already handled.");
    return null;
  }
  console.log(`Group membership: ${added.map((handle) => describe(members, handle)).join(", ") || "only GroupCart's own line"} added to a household group by ${actor}.`);
  if (reply) await space.send(reply);
  return reply;
}

/** Logs (masked) any current participants of a group that are not on the allowlist, e.g. people added before GroupCart connected. */
export async function auditGroupRoster(space: GroupSpace, members: MemberConfig[], selfHandle?: string): Promise<string[]> {
  try {
    const self = selfHandle ? normalizeHandle(selfHandle) : undefined;
    const participants = (await space.getMembers()).map((user) => normalizeHandle(user.id)).filter((handle) => handle && handle !== self);
    const unlisted = participants.filter((handle) => !findMember(members, handle));
    if (unlisted.length) {
      console.warn(`Group roster check: ${unlisted.length} of ${participants.length} participant(s) are not on GROUP_CART_MEMBERS, so their messages are ignored: ${unlisted.map(maskHandle).join(", ")}.`);
    } else {
      console.log(`Group roster check: all ${participants.length} participant(s) are on GROUP_CART_MEMBERS.`);
    }
    return unlisted;
  } catch (error) {
    console.warn(`Group roster check skipped: ${error instanceof Error ? error.message : "unknown error"}`);
    return [];
  }
}
