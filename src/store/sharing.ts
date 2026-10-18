import { randomUUID } from "node:crypto";
import type { StoreContext } from "./context.js";
import type { SharingSession } from "./types.js";

/**
 * Sharing sessions: “start sharing with X, Y” splits every item any participant
 * adds among all participants until someone texts “stop sharing”.
 */
export class SharingSessions {
  constructor(private readonly ctx: StoreContext) {}

  activeSessions(): SharingSession[] {
    const rows = this.ctx.db.prepare(
      "SELECT id, participant_ids_json, started_by, started_at FROM sharing_sessions WHERE household_id = ? AND ended_at IS NULL ORDER BY started_at, rowid",
    ).all(this.ctx.householdId) as Array<{ id: string; participant_ids_json: string; started_by: string; started_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      participantIds: JSON.parse(row.participant_ids_json) as string[],
      startedBy: row.started_by,
      startedAt: row.started_at,
    }));
  }

  activeSessionFor(memberId: string): SharingSession | undefined {
    return this.activeSessions().find((session) => session.participantIds.includes(memberId));
  }

  /** Who a newly added item is split among: the sender's active session, or just the sender. */
  participantsFor(memberId: string): string[] {
    return this.activeSessionFor(memberId)?.participantIds ?? [memberId];
  }

  assignmentPhrase(participantIds: string[]): string {
    const names = this.ctx.memberNames(participantIds);
    return participantIds.length > 1 ? `shared by ${this.ctx.joinNames(names)}` : `for ${names[0] ?? "you"}`;
  }

  sharingNote(participantIds: string[]): string {
    return participantIds.length > 1
      ? ` Your sharing session is on, so anything you add now is split among ${this.ctx.joinNames(this.ctx.memberNames(participantIds))}.`
      : "";
  }

  /** Point people still using the removed per-item phrases at sharing sessions. */
  legacyShareHint(text: string, memberId: string): string {
    if (this.activeSessionFor(memberId)) return "";
    if (!/\b(?:shared?|split)\s+(?:with|between|among)\b|\bfor\s+(?:everyone|all\s+of\s+us)\b/i.test(text)) return "";
    return "\nNote: sharing phrases on one item no longer split it. To split new items, first text “start sharing with” plus member names.";
  }

  resolveMemberNames(list: string, memberId: string): { ids: string[]; includesSelf: boolean } | { error: string } {
    const members = this.ctx.getMembers();
    const tokens = list.split(/\s*(?:,|&|\+|\band\b)\s*/i)
      .map((token) => token.trim().replace(/^[.!?;:]+|[.!?;:]+$/g, "").trim())
      .filter(Boolean);
    const ids = new Set<string>();
    const unknown: string[] = [];
    const ambiguous: string[] = [];
    let includesSelf = false;
    for (const token of tokens) {
      const lower = token.toLocaleLowerCase();
      if (/^(?:me|myself|i)$/.test(lower)) { includesSelf = true; continue; }
      const exact = members.filter((member) => member.name.toLocaleLowerCase() === lower);
      const candidates = exact.length
        ? exact
        : members.filter((member) => (member.name.split(/\s+/)[0] ?? member.name).toLocaleLowerCase() === lower);
      if (candidates.length === 1) {
        if (candidates[0]!.id === memberId) includesSelf = true;
        else ids.add(candidates[0]!.id);
      } else if (candidates.length > 1) {
        ambiguous.push(token);
      } else {
        unknown.push(token);
      }
    }
    const roster = this.ctx.joinNames(members.filter((member) => member.id !== memberId).map((member) => member.name));
    if (unknown.length) {
      return { error: `I don’t recognize ${this.ctx.joinNames(unknown.map((name) => `“${name}”`))} as ${unknown.length === 1 ? "a household member" : "household members"}. You can share with ${roster || "no other configured members"}. Nothing changed.` };
    }
    if (ambiguous.length) {
      return { error: `${this.ctx.joinNames(ambiguous.map((name) => `“${name}”`))} matches more than one household member; use the full name. Nothing changed.` };
    }
    return { ids: [...ids], includesSelf };
  }

  startSharing(memberId: string, list: string): string {
    const others = this.ctx.getMembers().filter((member) => member.id !== memberId).map((member) => member.name);
    const example = `“start sharing with ${others.slice(0, 2).join(" and ") || "Maya"}”`;
    if (!list) return `Who should share with you? Text ${example}. Nothing changed.`;
    const resolved = this.resolveMemberNames(list, memberId);
    if ("error" in resolved) return resolved.error;
    if (resolved.includesSelf) {
      return `You’re included automatically, so name only the other members, like ${example}. Nothing changed.`;
    }
    if (!resolved.ids.length) return `Who should share with you? Text ${example}. Nothing changed.`;
    const participantIds = [...new Set([memberId, ...resolved.ids])].sort();
    const current = this.activeSessionFor(memberId);
    if (current) {
      const sameSet = current.participantIds.length === participantIds.length
        && current.participantIds.every((id) => participantIds.includes(id));
      if (sameSet) {
        return `You’re already sharing: new items from ${this.ctx.joinNames(this.ctx.memberNames(participantIds))} are split among all of you. Text “stop sharing” to end it.`;
      }
      const currentOthers = this.ctx.memberNames(current.participantIds.filter((id) => id !== memberId));
      return `You’re already sharing with ${this.ctx.joinNames(currentOthers)}. Text “stop sharing” to end that session before starting a new one. Nothing changed.`;
    }
    const busy = resolved.ids.flatMap((id) => {
      const session = this.activeSessionFor(id);
      return session ? [{ id, session }] : [];
    });
    if (busy.length) {
      const details = busy.map(({ id, session }) => {
        const name = this.ctx.memberNames([id])[0] ?? "A member";
        const partners = this.ctx.memberNames(session.participantIds.filter((other) => other !== id));
        return `${name} is already sharing with ${this.ctx.joinNames(partners)}`;
      });
      return `${details.join("; ")}. Someone in that session needs to text “stop sharing” first. Nothing changed.`;
    }
    this.ctx.db.prepare(
      "INSERT INTO sharing_sessions (id, household_id, participant_ids_json, started_by, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), this.ctx.householdId, JSON.stringify(participantIds), memberId, new Date().toISOString());
    return `Started sharing for ${this.ctx.joinNames(this.ctx.memberNames(participantIds))}. From now on, every item any of you adds is split evenly among you until someone texts “stop sharing”. Items already in the cart keep their current split.`;
  }

  stopSharing(memberId: string, list: string): string {
    const current = this.activeSessionFor(memberId);
    if (!current) {
      return "You aren’t in a sharing session, so nothing changed. Start one with “start sharing with” plus member names.";
    }
    let namedSubset = false;
    if (list) {
      const resolved = this.resolveMemberNames(list, memberId);
      if ("error" in resolved) return resolved.error;
      const outside = resolved.ids.filter((id) => !current.participantIds.includes(id));
      if (outside.length) {
        const currentOthers = this.ctx.memberNames(current.participantIds.filter((id) => id !== memberId));
        return `${this.ctx.joinNames(this.ctx.memberNames(outside))} ${outside.length === 1 ? "isn’t" : "aren’t"} in your sharing session (you’re sharing with ${this.ctx.joinNames(currentOthers)}). Text “stop sharing” to end it. Nothing changed.`;
      }
      namedSubset = resolved.ids.length > 0 && resolved.ids.length < current.participantIds.length - 1;
    }
    this.ctx.db.prepare("UPDATE sharing_sessions SET ended_by = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL")
      .run(memberId, new Date().toISOString(), current.id);
    const names = this.ctx.joinNames(this.ctx.memberNames(current.participantIds));
    const restartHint = namedSubset
      ? " The whole session ended for everyone in it; start a new one with anyone you still want to share with."
      : "";
    return `Stopped sharing for ${names}. New items each of you adds are yours alone again; items added during the session stay split as they were.${restartHint}`;
  }
}
