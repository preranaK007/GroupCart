// The household coordinator: one Claude a roommate connects for the whole apartment, running on that
// roommate's own Claude account (Claude Code on the computer that hosts GroupCart, see claudeCode.ts). When it
// is on, every group-chat message goes to it instead of the deterministic command parsers. Each turn it reads
// the recent chat and acts through GroupCart's connector tools (calendars, events, cart, bills, chores, house,
// plus the cards and follow-ups in tools.ts). It also comes back on its own when everyone has voted on one of
// its polls, someone taps one of its buttons, or a follow-up it scheduled comes due.
//
// Tool calls run as the roommate being answered ("Tanmay via Claude"); proactive turns run as the roommate who
// connected it. It never checks out, places orders, or moves money; the connector tools can't.
import type { DatabaseSync } from "node:sqlite";
import type { ChatCard, ChatMessage } from "../chat.js";
import type { CommandContext } from "../platform.js";
import type { Member } from "../store.js";

export const COORDINATOR_NAME = "Claude";
/** The model's way of saying "nothing worth posting". */
const SILENT = "(no reply)";
const TRANSCRIPT_MESSAGES = 30;

/**
 * Connector tools the coordinator doesn't use: its replies are the group messages, and it runs polls with its
 * own poll cards instead of the number-reply polls.
 */
export const COORDINATOR_EXCLUDED_TOOLS = ["send_group_message", "post_to_group", "read_group_chat", "plan_activity", "vote", "book_event", "create_poll", "vote_poll"];

/** How the coordinator talks to the household chat (web chat + iMessage relay). */
export type CoordinatorChannel = {
  /** Posts a message as Claude, optionally with a card; returns the stored message. */
  post(text: string, card?: ChatCard): Promise<ChatMessage | null>;
  updateCard(messageId: number, card: ChatCard): void;
  findCard(cardId: string): { messageId: number; card: ChatCard } | null;
  /** The newest chat messages, oldest first. */
  recent(limit: number): ChatMessage[];
};

/** One turn: Claude reads `prompt` and acts with GroupCart's tools as `memberId`; returns its final message. */
export type TurnRunner = (input: { prompt: string; systemPrompt: string; memberId: string; disallowedTools: string[] }) => Promise<string | null>;

export type CoordinatorOptions = {
  runTurn: TurnRunner;
  db: DatabaseSync;
  members: () => Member[];
  channel: CoordinatorChannel;
  groceriesFrom: "kroger" | "sample";
  timeZone: string;
  now?: () => Date;
};

export type CoordinatorStatus = { active: boolean; connectedBy: Member | null };

export class HouseholdCoordinator {
  readonly #options: CoordinatorOptions;
  readonly #now: () => Date;
  /** Turns run one at a time, in arrival order, so tool calls and posts never interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: CoordinatorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    options.db.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordinator_follow_ups (id INTEGER PRIMARY KEY AUTOINCREMENT, due_at TEXT NOT NULL, note TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
    `);
  }

  // ---------------------------------------------------------------------------
  // Connection (one roommate connects it for the household)
  // ---------------------------------------------------------------------------

  status(): CoordinatorStatus {
    const row = this.#options.db.prepare("SELECT value FROM coordinator_settings WHERE key = 'connected_by'").get() as { value: string } | undefined;
    const member = row ? this.#options.members().find((candidate) => candidate.id === row.value) ?? null : null;
    return { active: member !== null, connectedBy: member };
  }

  connect(memberId: string): CoordinatorStatus {
    if (!this.#options.members().some((member) => member.id === memberId)) throw new Error("Not a household member.");
    this.#options.db.prepare("INSERT INTO coordinator_settings (key, value) VALUES ('connected_by', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(memberId);
    return this.status();
  }

  disconnect(): CoordinatorStatus {
    this.#options.db.prepare("DELETE FROM coordinator_settings WHERE key = 'connected_by'").run();
    return this.status();
  }

  // ---------------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------------

  /** Handles a roommate's group message (already recorded in the chat). Posts what it has to say itself. */
  handleMessage(message: CommandContext): Promise<void> {
    return this.#enqueue(async () => {
      const photos = message.attachments.filter((attachment) => attachment.mimeType.startsWith("image/")).length;
      const said = message.text.trim() ? `“${message.text.trim()}”` : "(no text)";
      await this.#turn(message.memberId, `Respond to the newest message, from ${message.memberName}: ${said}${photos ? ` with ${photos} photo(s); look at them with view_photo` : ""}.`);
    });
  }

  /** A proactive turn: something happened that the coordinator may want to act on or announce. */
  handleEvent(note: string, actingMemberId?: string): Promise<void> {
    return this.#enqueue(async () => {
      const memberId = actingMemberId ?? this.status().connectedBy?.id;
      if (memberId) await this.#turn(memberId, `Event (not a chat message): ${note}`);
    });
  }

  scheduleFollowUp(at: Date, note: string): void {
    this.#options.db.prepare("INSERT INTO coordinator_follow_ups (due_at, note) VALUES (?, ?)").run(at.toISOString(), note);
  }

  /** Follow-ups that came due become proactive turns. Call this on a timer. */
  async runDueFollowUps(): Promise<void> {
    if (!this.status().active) return;
    const due = this.#options.db.prepare("SELECT id, note FROM coordinator_follow_ups WHERE done = 0 AND due_at <= ? ORDER BY due_at").all(this.#now().toISOString()) as Array<{ id: number; note: string }>;
    for (const followUp of due) {
      this.#options.db.prepare("UPDATE coordinator_follow_ups SET done = 1 WHERE id = ?").run(followUp.id);
      await this.handleEvent(`A follow-up you scheduled came due: ${followUp.note}`);
    }
  }

  /**
   * A roommate voted or tapped a button on a coordinator card. Returns the updated card right away; anything
   * that needs thought (everyone voted, an "Add these" tap) becomes a proactive turn when the coordinator is on.
   */
  handleCardAction(input: { memberId: string; card: ChatCard; actionId?: string; optionIds?: string[] }): { card?: ChatCard } | null {
    const members = this.#options.members();
    const member = members.find((candidate) => candidate.id === input.memberId);
    if (!member) return null;
    const card = input.card;
    const active = this.status().active;
    if (card.kind === "poll") {
      if (card.closed) return null;
      const picked = (input.optionIds ?? (input.actionId ? [input.actionId] : [])).filter((id) => card.options.some((option) => option.id === id));
      const votes: Record<string, string[]> = {};
      for (const option of card.options) votes[option.id] = (card.votes[option.id] ?? []).filter((id) => id !== member.id);
      for (const id of card.multi ? picked : picked.slice(0, 1)) votes[id]!.push(member.id);
      const updated: ChatCard = { ...card, votes };
      const voters = new Set(Object.values(votes).flat());
      if (active && members.every((candidate) => voters.has(candidate.id))) {
        void this.handleEvent(`Everyone has voted on your poll “${card.question}” (card ${card.id}). ${pollTally(updated, members)} Close it with close_poll and act on the result.`, member.id);
      }
      return { card: updated };
    }
    const action = card.actions.find((candidate) => candidate.id === input.actionId);
    if (!action || action.url || card.resolved) return null;
    if (active) {
      const title = card.kind === "choices" ? card.title : card.title ?? "your buttons";
      const items = card.kind === "choices" ? ` Items on the card: ${card.items.map((item) => [item.label, item.detail, item.price].filter(Boolean).join(" · ")).join("; ")}.` : "";
      void this.handleEvent(`${member.name} tapped “${action.label}” on “${title}” (card ${card.id}).${items}`, member.id);
    }
    return action.style === "primary" ? { card: { ...card, resolved: `${member.name}: ${action.label}` } } : null;
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(job, job);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #turn(memberId: string, note: string): Promise<void> {
    const before = this.#options.channel.recent(1).at(-1)?.id ?? 0;
    const reply = (await this.#options.runTurn({ prompt: this.#situation(note), systemPrompt: SYSTEM_PROMPT, memberId, disallowedTools: COORDINATOR_EXCLUDED_TOOLS }))?.trim();
    if (!reply || reply.startsWith(SILENT)) return;
    // A tool already told the group (a saved bill, a booked event, a card): a recap on top would repeat it.
    if (this.#options.channel.recent(20).some((entry) => entry.id > before && entry.kind === "bot")) return;
    await this.#options.channel.post(reply);
  }

  /** The turn's context: who lives here, when it is, the recent chat, and what just happened. */
  #situation(note: string): string {
    const members = this.#options.members();
    const connectedBy = this.status().connectedBy;
    const when = new Intl.DateTimeFormat("en-US", { timeZone: this.#options.timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(this.#now());
    const lines = this.#options.channel.recent(TRANSCRIPT_MESSAGES).map((entry) => {
      const photos = entry.attachments.filter((attachment) => attachment.image).length;
      const extras = [photos ? `[${photos} photo(s), message ${entry.id}]` : "", entry.card ? cardSummary(entry.card, members) : ""].filter(Boolean).join(" ");
      return `[${this.#clock(entry.at)}] ${entry.name}${entry.via ? ` via ${entry.via}` : ""}: ${entry.text.replace(/\s+/g, " ").slice(0, 400)}${extras ? ` ${extras}` : ""}`;
    });
    return [
      `Roommates: ${members.map((member) => member.name).join(", ")}. Connected by: ${connectedBy?.name ?? "nobody"}.`,
      `Now: ${when} (${this.#options.timeZone}).`,
      `Grocery search uses ${this.#options.groceriesFrom === "kroger" ? "Kroger (real store quotes)" : "the sample catalog (estimated prices; Kroger isn't connected)"}.`,
      "",
      "Recent group chat, oldest first:",
      lines.length ? lines.join("\n") : "(empty)",
      "",
      note,
    ].join("\n");
  }

  #clock(iso: string): string {
    return new Intl.DateTimeFormat("en-US", { timeZone: this.#options.timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  }
}

function pollTally(card: Extract<ChatCard, { kind: "poll" }>, members: Member[]): string {
  const name = (id: string) => members.find((member) => member.id === id)?.name ?? "someone";
  return card.options.map((option) => `${option.label}: ${(card.votes[option.id] ?? []).length} (${(card.votes[option.id] ?? []).map(name).join(", ") || "nobody"})`).join("; ") + ".";
}

function cardSummary(card: ChatCard, members: Member[]): string {
  if (card.kind === "poll") return `[poll ${card.id}${card.closed ? `, closed: ${card.result ?? ""}` : ""}: ${pollTally(card, members)}]`;
  if (card.kind === "choices") return `[choices ${card.id}: ${card.items.map((item) => item.label).join(", ")}${card.resolved ? `; ${card.resolved}` : ""}]`;
  return `[buttons: ${card.actions.map((action) => action.label).join(", ")}]`;
}

const SYSTEM_PROMPT = `You are Claude, the coordinator for a shared apartment. You live in the roommates' group chat (iMessage, mirrored in the GroupCart web app) and keep the household running: plans and calendars, groceries, shared expenses and bills, chores, and house stuff. One roommate connected you for everyone; treat all roommates the same. Your only tools are GroupCart's; they act as the roommate you're answering.

How you work:
- Each turn you see the recent chat and one new message or event. Act on it with your tools. Your final message is posted to the group word for word, so it is either one short chat message or exactly "(no reply)". It is never a summary of what you did for whoever is running you.
- Reply "(no reply)" to banter, reactions and people talking among themselves, unless someone asks you something.
- Many tools post their own message to the group (saving a bill, adding an event, chores, cards). When one already said it, your reply is "(no reply)". The same after you post a card: the card carries its own line.
- Do the work instead of asking. If a request is clear enough, act and confirm in one line. Ask one short question only when a wrong guess would cost money or annoy people.
- Write like a thoughtful roommate texting: one or two short lines, plain text, no markdown, no lists, at most one emoji. Never paste links, ids, or tool output; use a card. Call roommates by name and never guess anyone's pronouns.
- Cards: post_poll for group decisions, post_choices for options people confirm (grocery picks), post_buttons for pay-back links.

Plans: for "movie night?", "dinner this week?" and the like, find times when everyone is free (suggest_event_times or free_times), post a poll with the best two or three, and schedule a follow-up to nudge people who haven't voted. When everyone has voted you'll get an event: close the poll, book the winner with add_event, and post one line. Respect privacy: only say free or busy, never what is on someone else's calendar.

Money: "I bought snacks for $13, split evenly" is an expense: save it with add_bill (paid_by the sender, split among everyone unless they say otherwise, a fitting category, save true). A photo of a bill or receipt: look at it with view_photo, read the printed vendor, total and due date, and save it with add_bill; never guess numbers that aren't printed. Use exact amounts. For "what do I owe", use get_balances and get_pay_links and post pay buttons. You never move money yourself.

Groceries: for "we need milk and flour", look up each item with find_groceries, then post_choices with your best pick for each (name, size, price) and the buttons “Add these” (primary) and “Swap something” (secondary). When someone taps “Add these”, add them with add_to_cart in one call written like a text (“2% milk, all-purpose flour”); add_to_cart posts nothing, so confirm in one line. When the search used the sample catalog, don't call it Kroger. Never check out or place an order.

Chores and house: use the chore and house tools as asked. A quick nudge is fine; nagging is not.`;
