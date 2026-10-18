// The household group conversation, mirrored for the web chat at /chat.
//
// Live mode: index.ts records every inbound allowlisted group message (text + attachment metadata; images are
// saved so they show inline) and every GroupCart reply; notifyGroup() messages arrive through onGroupNotify.
// Web messages are relayed to the household group persisted by the store (src/householdGroup.ts), so the web chat
// works after a restart without waiting for someone to text.
// A message sent from the website is posted into the iMessage group as "Maya: <text>" and then processed
// exactly like a group message from that member (the shared processMemberMessage in index.ts).
// Demo mode: the web chat is the group; nothing is sent anywhere.
//
// Rich cards: a bot message may carry a ChatCard (poll, choices, or action buttons) in card_json. The web chat draws
// it and posts taps to POST /api/chat/cards, which runs the card handler registered for the card id's owner
// (registerCardHandler in src/platform.ts) and stores the updated card (updated_at tells pollers what changed).
// iMessage gets cardText(card) instead.
//
// Tables use the chat_ prefix; image files live in <data dir>/chat-files and are served at /chat/files/<file>.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { attachment, type Space } from "spectrum-ts";
import { cardHandler, cardOwner, claimReplyCard, type CardActionResult, type CommandAttachment, type CommandContext, type ReplyTarget } from "./platform.js";
import { joinNames } from "./choresLogic.js";
import { isStoredImageName, sniffImage } from "./profiles.js";
import type { Member } from "./store.js";

export const CHAT_TEXT_LIMIT = 2_000;
export const CHAT_IMAGE_LIMIT = 15 * 1024 * 1024;

export type ChatSource = "imessage" | "web" | "connector" | "reply" | "notify" | "seed" | "card";

// --- Rich message cards (web chat). Card ids are namespaced "<owner>:<rest>", e.g. "events:12", "agent:abc". ---
export type ChatCardOption = { id: string; label: string; detail?: string };
export type ChatCardItem = { id: string; label: string; detail?: string; price?: string; imageUrl?: string };
/** A button. With `url` it opens that link in a new tab (e.g. a Venmo pay link) instead of posting an action. */
export type ChatCardAction = { id: string; label: string; style?: "primary" | "secondary"; url?: string };
export type ChatCard =
  /** votes maps optionId → memberIds. */
  | { kind: "poll"; id: string; question: string; options: ChatCardOption[]; multi: boolean; votes: Record<string, string[]>; closed?: boolean; result?: string; /** iMessage's id for the native poll GroupCart sent (live mode). */ nativePollId?: string }
  | { kind: "choices"; id: string; title: string; items: ChatCardItem[]; actions: ChatCardAction[]; resolved?: string }
  | { kind: "actions"; id: string; title?: string; actions: ChatCardAction[]; resolved?: string };
export type PollCard = Extract<ChatCard, { kind: "poll" }>;

/** Option text as iMessage may echo it back: same characters, spacing and dashes aside. */
function sameText(value: string): string {
  return value.normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The default poll behavior: toggles the member's vote on each tapped option. A single-choice poll keeps at most one
 * vote per member (tapping another option moves it there; tapping the same one again removes it).
 */
export function togglePollVote(card: PollCard, memberId: string, optionIds: readonly string[]): PollCard {
  const known = card.options.map((option) => option.id);
  const votes: Record<string, string[]> = Object.fromEntries(known.map((id) => [id, [...(card.votes[id] ?? [])]]));
  for (const optionId of optionIds) {
    if (!votes[optionId]) continue;
    const had = votes[optionId].includes(memberId);
    if (!card.multi) for (const id of known) votes[id] = votes[id]!.filter((voter) => voter !== memberId);
    votes[optionId] = had ? votes[optionId]!.filter((voter) => voter !== memberId) : [...votes[optionId]!, memberId];
  }
  return { ...card, votes };
}
// --- end cards ---
/** How long after a voter's last tap in the app their vote is told to the iMessage group. */
const VOTE_ECHO_SETTLE_MS = 8_000;

export type ChatKind = "member" | "bot";

type StoredAttachment = { name: string; mimeType: string; size: number | null; file: string | null };

export type ChatAttachmentView = { name: string; mimeType: string; size: number | null; url: string | null; image: boolean };
export type ChatMessage = {
  id: number;
  kind: ChatKind;
  memberId: string | null;
  name: string;
  text: string;
  attachments: ChatAttachmentView[];
  source: ChatSource;
  /** The AI assistant that sent a connector message for the member ("Claude", "Grok", …), else null. */
  via: string | null;
  at: string;
  /** Rich card under a bot message, or null. */
  card: ChatCard | null;
  /** Emoji reactions on the message (the household coordinator's, today), oldest first. */
  reactions: Array<{ emoji: string; by: string }>;
  /** The message this one replies to, or null. */
  replyTo: ReplyTarget | null;
  /** Last change (a card update bumps it), so pollers can ask for messages updated since their last poll. */
  updatedAt: string;
};

/** Processes one member message (feature commands, then the cart) and returns GroupCart's reply. */
export type MemberMessageProcessor = (context: CommandContext) => Promise<string | null>;

/** What the chat needs from the household's iMessage group. */
export type GroupChannel = {
  /** Sends text; returns iMessage's id for it when known. */
  sendText(text: string): Promise<string | null | void>;
  sendImage(path: string, mimeType: string, name: string): Promise<void>;
  /** Sends a GroupCart reply with the typing indicator; returns iMessage's id for it when known. */
  respond(text: string): Promise<string | null | void>;
  /** Sends text as a threaded reply to a group message (by its Spectrum id); returns the new message's id. */
  reply?(messageId: string, text: string): Promise<string | null | void>;
  /** Reacts to a message in the group (an iMessage tapback) by its Spectrum message id. */
  react?(messageId: string, emoji: string): Promise<void>;
};

export function spectrumChannel(space: Space): GroupChannel {
  return {
    sendText: async (text) => (await space.send(text))?.id ?? null,
    sendImage: async (path, mimeType, name) => { await space.send(attachment(path, { name, mimeType })); },
    respond: async (text) => {
      let sentId: string | null = null;
      await space.responding(async () => { sentId = (await space.send(text))?.id ?? null; });
      return sentId;
    },
    reply: async (messageId, text) => replyInSpace(space, messageId, text),
    react: async (messageId, emoji) => { await reactInSpace(space, messageId, emoji); },
  };
}

/** Tapback on one of the group's messages; only messages roommates sent can take one. */
export async function reactInSpace(space: Space, messageId: string, emoji: string): Promise<void> {
  const message = await space.getMessage(messageId);
  if (message?.direction === "inbound") await message.react(emoji);
}

/** A threaded reply to one of the group's messages; a plain message when that one can't be found. */
export async function replyInSpace(space: Space, messageId: string, text: string): Promise<string | null> {
  const target = await space.getMessage(messageId);
  const sent = target ? await target.reply(text) : await space.send(text);
  return sent?.id ?? null;
}

/** One emoji (with its modifiers), nothing else. */
export function isSingleEmoji(value: string): boolean {
  return value.length <= 16 && /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u.test(value);
}

export type InboundAttachment = { mimeType: string; name?: string; size?: number; read: () => Promise<Buffer> };

export class ChatError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Row = { id: number; external_id: string | null; kind: string; member_id: string | null; author_name: string; text: string; attachments_json: string; source: string; via: string | null; created_at: string; card_json: string | null; updated_at: string | null; reactions_json: string | null; reply_to_id: number | null };

/** Author of a bot message that names none. */
export const BOT_AUTHOR = "GroupCart";

function memoize(read: () => Promise<Buffer>): () => Promise<Buffer> {
  let pending: Promise<Buffer> | null = null;
  return () => (pending ??= read());
}

export type ChatOptions = {
  db: DatabaseSync;
  filesDir: string;
  liveMode: boolean;
  members: () => Member[];
  /** Current display name for a member (profiles), used when reading messages back. */
  displayName?: (memberId: string) => string | undefined;
  process: MemberMessageProcessor;
};

export class ChatService {
  readonly #db: DatabaseSync;
  readonly #filesDir: string;
  readonly #live: boolean;
  readonly #members: () => Member[];
  readonly #displayName: (memberId: string) => string | undefined;
  readonly #process: MemberMessageProcessor;
  #group: GroupChannel | null = null;
  #groupKnown: () => boolean = () => true;
  #queue: Promise<unknown> = Promise.resolve();
  #busy = 0;
  #voteEchoes = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: ChatOptions) {
    this.#db = options.db;
    this.#filesDir = options.filesDir;
    this.#live = options.liveMode;
    this.#members = options.members;
    this.#displayName = options.displayName ?? (() => undefined);
    this.#process = options.process;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE,
        kind TEXT NOT NULL,
        member_id TEXT,
        author_name TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const columns = this.#db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "via")) this.#db.exec("ALTER TABLE chat_messages ADD COLUMN via TEXT");
    if (!columns.some((column) => column.name === "card_json")) this.#db.exec("ALTER TABLE chat_messages ADD COLUMN card_json TEXT");
    if (!columns.some((column) => column.name === "updated_at")) this.#db.exec("ALTER TABLE chat_messages ADD COLUMN updated_at TEXT");
    if (!columns.some((column) => column.name === "reactions_json")) this.#db.exec("ALTER TABLE chat_messages ADD COLUMN reactions_json TEXT");
    if (!columns.some((column) => column.name === "reply_to_id")) this.#db.exec("ALTER TABLE chat_messages ADD COLUMN reply_to_id INTEGER");
    this.#db.exec("CREATE INDEX IF NOT EXISTS chat_messages_updated ON chat_messages (updated_at)");
  }

  get liveMode(): boolean {
    return this.#live;
  }

  /** True while GroupCart is working on a web-sent message (shown as a typing indicator). */
  get typing(): boolean {
    return this.#busy > 0;
  }

  /** Live mode: whether web messages can reach the iMessage group (GroupCart has seen the household group). */
  get groupConnected(): boolean {
    return this.#group !== null && this.#groupKnown();
  }

  /**
   * Live mode: where web messages are relayed. index.ts passes the household group channel once at startup; it
   * resolves the group the store persisted (one mechanism with list check-ins and notifyGroup()).
   */
  useGroup(channel: GroupChannel, known: () => boolean = () => true): void {
    this.#group = channel;
    this.#groupKnown = known;
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  #insert(input: { externalId?: string; kind: ChatKind; memberId: string | null; authorName: string; text: string; attachments: StoredAttachment[]; source: ChatSource; via?: string; at?: Date; card?: ChatCard | null; replyToId?: number | null }): ChatMessage | null {
    const at = input.at && !Number.isNaN(input.at.getTime()) ? input.at : new Date();
    // updated_at is the real insert time even for back-dated (seed) messages.
    const result = this.#db.prepare(
      "INSERT OR IGNORE INTO chat_messages (external_id, kind, member_id, author_name, text, attachments_json, source, via, created_at, card_json, updated_at, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.externalId ?? null, input.kind, input.memberId, input.authorName, input.text, JSON.stringify(input.attachments), input.source, input.via ?? null, at.toISOString(), input.card ? JSON.stringify(input.card) : null, new Date().toISOString(), input.replyToId ?? null);
    if (!Number(result.changes)) return null;
    return this.get(Number(result.lastInsertRowid));
  }

  /**
   * Records an inbound group message from an allowlisted member (idempotent by platform message id) and returns
   * its attachments for command handlers. Attachment bytes are read once and shared: image files are saved for
   * inline display while handlers (e.g. Bills) read the same bytes.
   */
  recordInbound(input: { messageId: string; memberId: string; memberName: string; text: string; attachments: InboundAttachment[]; at?: Date; replyToId?: number | null }): CommandAttachment[] {
    const shared = input.attachments.map((item) => ({ ...item, read: memoize(item.read) }));
    const message = this.#insert({
      externalId: `imessage:${input.messageId}`,
      replyToId: input.replyToId ?? null,
      kind: "member",
      memberId: input.memberId,
      authorName: input.memberName,
      text: input.text.slice(0, 20_000),
      attachments: shared.map((item) => ({ name: item.name || "Attachment", mimeType: item.mimeType, size: item.size ?? null, file: null })),
      source: "imessage",
      at: input.at,
    });
    if (message) {
      shared.forEach((item, index) => {
        if (!item.mimeType.startsWith("image/") || item.mimeType.includes("svg") || (item.size ?? 0) > CHAT_IMAGE_LIMIT) return;
        void this.#persistInboundImage(message.id, index, item.read);
      });
    }
    return shared.map(({ mimeType, name, read }) => ({ mimeType, name, read }));
  }

  async #persistInboundImage(messageId: number, index: number, read: () => Promise<Buffer>): Promise<void> {
    try {
      const bytes = await read();
      if (bytes.length > CHAT_IMAGE_LIMIT) return;
      const stored = this.#storeImage(bytes);
      if (!stored) return;
      const row = this.#db.prepare("SELECT attachments_json FROM chat_messages WHERE id = ?").get(messageId) as { attachments_json: string } | undefined;
      if (!row) return;
      const attachments = JSON.parse(row.attachments_json) as StoredAttachment[];
      const target = attachments[index];
      if (!target) return;
      attachments[index] = { ...target, mimeType: stored.mimeType, size: bytes.length, file: stored.file };
      this.#db.prepare("UPDATE chat_messages SET attachments_json = ? WHERE id = ?").run(JSON.stringify(attachments), messageId);
    } catch (error) {
      console.warn("Could not save a group chat image:", error instanceof Error ? error.message : error);
    }
  }

  #storeImage(bytes: Buffer): { file: string; mimeType: string } | null {
    const type = sniffImage(bytes);
    if (!type) return null;
    mkdirSync(this.#filesDir, { recursive: true });
    const file = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.${type.ext}`;
    writeFileSync(join(this.#filesDir, file), bytes);
    return { file, mimeType: type.mimeType };
  }

  /**
   * A bot author (the household coordinator) posts an image, e.g. a GIF or meme it found: stored like a member's
   * photo, shown in the web chat, and in live mode sent to the group signed "Author: caption".
   */
  async postBotImage(input: { text: string; image: Buffer; author: string }): Promise<ChatMessage> {
    const stored = this.#storeImage(input.image);
    if (!stored) throw new ChatError(400, "That isn't a supported image.");
    const name = `image.${stored.file.split(".").pop()}`;
    const message = this.#insert({
      kind: "bot", memberId: null, authorName: input.author, text: input.text.trim().slice(0, 2_000),
      attachments: [{ name, mimeType: stored.mimeType, size: input.image.length, file: stored.file }], source: "notify",
    })!;
    const group = this.#live && this.groupConnected ? this.#group : null;
    if (group) {
      try {
        if (input.text.trim()) await group.sendText(`${input.author}: ${input.text.trim()}`);
        await group.sendImage(join(this.#filesDir, stored.file), stored.mimeType, name);
      } catch (error) {
        console.warn("Could not send an image to the iMessage group:", error instanceof Error ? error.message : error);
      }
    }
    return message;
  }

  /**
   * Records a bot message: GroupCart's replies and notifications, or another bot author such as "Claude". Without a
   * card, a reply built with cardReply() (src/platform.ts) gets its card back here, and the web chat stores the short
   * text plus the card instead of the iMessage fallback text.
   */
  recordBot(text: string, source: ChatSource = "reply", at?: Date, card?: ChatCard | null, options: { author?: string } = {}): ChatMessage | null {
    let body = text;
    let attached = card ?? null;
    if (!attached) {
      const claimed = claimReplyCard(text);
      if (claimed) { body = claimed.text; attached = claimed.card; }
    }
    if (!body.trim() && !attached) return null;
    const author = options.author?.trim().slice(0, 40) || BOT_AUTHOR;
    return this.#insert({ kind: "bot", memberId: null, authorName: author, text: body.slice(0, 20_000), attachments: [], source, at, card: attached });
  }

  /**
   * `by` (a bot author such as "Claude") reacts to a message with one emoji: shown on the message in the web chat,
   * and in live mode as a tapback on the iMessage it came from. Reacting again with the same emoji does nothing.
   */
  async react(messageId: number, emoji: string, by: string): Promise<ChatMessage> {
    const glyph = emoji.trim();
    if (!isSingleEmoji(glyph)) throw new ChatError(400, "React with a single emoji.");
    const row = this.#db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageId) as Row | undefined;
    if (!row) throw new ChatError(404, "That message isn’t in the chat.");
    const reactions = this.#view(row).reactions;
    if (reactions.some((reaction) => reaction.emoji === glyph && reaction.by === by)) return this.#view(row);
    this.#db.prepare("UPDATE chat_messages SET reactions_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify([...reactions, { emoji: glyph, by }].slice(-12)), new Date().toISOString(), messageId);
    const group = this.#live && this.groupConnected ? this.#group : null;
    if (group?.react && row.external_id?.startsWith("imessage:")) {
      try { await group.react(row.external_id.slice("imessage:".length), glyph); } catch (error) {
        console.warn("Could not react in the iMessage group:", error instanceof Error ? error.message : error);
      }
    }
    return this.get(messageId)!;
  }

  /** Replaces a message's card and bumps updated_at so open chats redraw it. Null when the message has no card. */
  updateCard(messageId: number, card: ChatCard): ChatMessage | null {
    const changed = this.#db.prepare("UPDATE chat_messages SET card_json = ?, updated_at = ? WHERE id = ? AND card_json IS NOT NULL")
      .run(JSON.stringify(card), new Date().toISOString(), messageId).changes;
    return Number(changed) ? this.get(messageId) : null;
  }

  /** The newest message carrying the card with this id. */
  findByCardId(cardId: string): ChatMessage | null {
    const row = this.#db.prepare("SELECT * FROM chat_messages WHERE card_json IS NOT NULL AND json_extract(card_json, '$.id') = ? ORDER BY id DESC LIMIT 1").get(cardId) as Row | undefined;
    return row ? this.#view(row) : null;
  }

  /**
   * A member tapped a card button or poll option on the website. Runs the handler registered for the card's owner
   * (a poll without a handler just toggles the member's vote), stores the card it returns, and records its reply
   * as a bot message (also sent to the iMessage group in live mode).
   */
  async actOnCard(member: Member, messageId: number, input: { actionId?: string; optionIds?: string[] }, options: { fromWeb?: boolean } = {}): Promise<{ message: ChatMessage; reply: ChatMessage | null }> {
    const message = this.get(messageId);
    const card = message?.card;
    if (!message || !card) throw new ChatError(404, "That message has no buttons.");
    if (card.kind === "poll" ? card.closed : card.resolved) throw new ChatError(409, "That’s already settled.");
    const optionIds = card.kind === "poll" ? (input.optionIds ?? []).filter((id) => typeof id === "string").slice(0, 20) : undefined;
    const actionId = card.kind === "poll" ? undefined : typeof input.actionId === "string" ? input.actionId : undefined;
    if (optionIds ? !optionIds.length : !actionId) throw new ChatError(400, optionIds ? "Pick an option." : "Pick a button.");
    if (actionId && card.kind !== "poll" && !card.actions.some((action) => action.id === actionId && !action.url)) throw new ChatError(400, "That button isn’t on this card.");
    const handler = cardHandler(cardOwner(card.id));
    const result: CardActionResult = handler
      ? await handler({ memberId: member.id, card, actionId, optionIds })
      : card.kind === "poll" ? { card: togglePollVote(card, member.id, optionIds!) } : null;
    if (!result) throw new ChatError(409, "That button isn’t available anymore.");
    if (result.error) throw new ChatError(409, result.error);
    const updated = (result.card && this.updateCard(message.id, result.card)) || this.get(message.id)!;
    if (options.fromWeb && updated.card?.kind === "poll" && updated.card.nativePollId) this.#echoWebVote(member, message.id);
    let reply: ChatMessage | null = null;
    if (result.reply) {
      reply = this.recordBot(result.reply, "card");
      const group = this.#live && this.groupConnected ? this.#group : null;
      if (group) {
        try { await group.sendText(result.reply); } catch (error) {
          console.warn("Could not send a card reply to the iMessage group:", error instanceof Error ? error.message : error);
        }
      }
    }
    return { message: updated, reply };
  }

  /**
   * iMessage can't take a vote for someone else, so a vote cast in the app on a poll that is also a native iMessage
   * poll is told to the group once the voter settles (taps within a few seconds count as one change).
   */
  #echoWebVote(member: Member, messageId: number): void {
    const key = `${messageId}:${member.id}`;
    clearTimeout(this.#voteEchoes.get(key));
    const timer = setTimeout(() => {
      this.#voteEchoes.delete(key);
      const card = this.get(messageId)?.card;
      const group = this.#live && this.groupConnected ? this.#group : null;
      if (card?.kind !== "poll" || !group) return;
      const picks = card.options.filter((option) => (card.votes[option.id] ?? []).includes(member.id)).map((option) => `“${option.label}”`);
      const name = (this.#displayName(member.id) ?? member.name).split(/\s+/)[0];
      const text = picks.length ? `🗳️ ${name} voted ${picks.join(" and ")} in the app.` : `🗳️ ${name} took back their vote in the app.`;
      group.sendText(text).catch((error) => console.warn("Could not tell the iMessage group about an app vote:", error instanceof Error ? error.message : error));
    }, VOTE_ECHO_SETTLE_MS);
    timer.unref?.();
    this.#voteEchoes.set(key, timer);
  }

  /**
   * Live loop: a vote on one of GroupCart's native iMessage polls (selected or unselected). It applies to the newest
   * open poll card with that question and option, the same way a tap in the web chat does. False when none matches.
   */
  async voteFromGroup(member: Member, vote: { nativePollId?: string; optionLabel: string; selected: boolean }): Promise<boolean> {
    const label = sameText(vote.optionLabel);
    const open = this.list({ limit: 100 }).messages.reverse().filter((entry) => entry.card?.kind === "poll" && !entry.card.closed);
    // By iMessage's poll id when GroupCart recorded it; otherwise the newest open poll with that option.
    const message = (vote.nativePollId ? open.find((entry) => entry.card?.kind === "poll" && entry.card.nativePollId === vote.nativePollId) : undefined)
      ?? open.find((entry) => entry.card?.kind === "poll" && entry.card.options.some((option) => sameText(option.label) === label));
    const card = message?.card;
    if (!message || card?.kind !== "poll") return false;
    const option = card.options.find((candidate) => sameText(candidate.label) === label);
    if (!option) return false;
    const selected = vote.selected;
    if ((card.votes[option.id] ?? []).includes(member.id) === selected) return true;
    await this.actOnCard(member, message.id, { optionIds: [option.id] });
    return true;
  }

  /** Live loop: sends a GroupCart reply into the group (with typing) and records it. */
  async replyInGroup(channel: GroupChannel, text: string): Promise<void> {
    let sentId: string | null | void = null;
    try {
      sentId = await channel.respond(text);
    } finally {
      const recorded = this.recordBot(text, "reply");
      if (recorded && sentId) this.linkSent(recorded.id, sentId);
    }
  }

  /** Remembers iMessage's id for a message GroupCart sent to the group (bot posts, web relays). */
  linkSent(messageId: number, sentId: string): void {
    try {
      this.#db.prepare("UPDATE chat_messages SET external_id = ? WHERE id = ? AND external_id IS NULL").run(`imessage:${sentId}`, messageId);
    } catch { /* already linked to another message */ }
  }

  /**
   * The chat message an iMessage reply points at: by iMessage id (roommates' messages, and GroupCart's own once
   * linked), else the newest message whose iMessage text matches (“Claude: …”, “Maya: …”, or GroupCart's text).
   */
  findReplyTarget(target: { messageId: string; text: string | null }): number | null {
    const linked = this.#db.prepare("SELECT id FROM chat_messages WHERE external_id = ?").get(`imessage:${target.messageId}`) as { id: number } | undefined;
    if (linked) return linked.id;
    const wanted = target.text?.trim();
    if (!wanted) return null;
    const rows = this.#db.prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT 300").all() as Row[];
    const match = rows.find((row) => {
      const text = row.text.trim();
      return text === wanted || `${row.author_name}: ${text}` === wanted || wanted.startsWith(`${row.author_name}: ${text}\n`);
    });
    return match?.id ?? null;
  }

  /** Who wrote a message and its first line or so, for showing (and telling the coordinator) what a reply answers. */
  quote(messageId: number): ReplyTarget | null {
    const row = this.#db.prepare("SELECT id, kind, member_id, author_name, text, attachments_json FROM chat_messages WHERE id = ?").get(messageId) as Pick<Row, "id" | "kind" | "member_id" | "author_name" | "text" | "attachments_json"> | undefined;
    if (!row) return null;
    const bot = row.kind === "bot";
    const photo = (JSON.parse(row.attachments_json) as StoredAttachment[]).length ? "Photo" : "";
    return {
      messageId: row.id,
      name: bot ? row.author_name || BOT_AUTHOR : (row.member_id && this.#displayName(row.member_id)) || row.author_name,
      text: (row.text.replace(/\s+/g, " ").trim() || photo).slice(0, 160),
      fromBot: bot,
    };
  }

  // ---------------------------------------------------------------------------
  // Sending from the website (or the Claude connector)
  // ---------------------------------------------------------------------------

  /**
   * Posts a member's message. Live mode relays it into the iMessage group as "Name: text" first. Then it is
   * processed exactly like a group message from that member, and GroupCart's reply is sent and recorded.
   * Returns right after recording unless awaitReply is set. `process` replaces the chat's processor for this one
   * message (the Groceries page's buttons run GroupCart's built-in commands, never the coordinator).
   */
  async send(
    member: Member,
    input: { text: string; image?: Buffer; imageName?: string; replyToId?: number | null },
    options: { source: "web" | "connector"; awaitReply?: boolean; /** Connector: which assistant ("Claude", "ChatGPT", "Grok"). */ via?: string; process?: MemberMessageProcessor } = { source: "web" },
  ): Promise<{ message: ChatMessage; reply?: string | null }> {
    const text = input.text.replace(/\r\n/g, "\n").trim().slice(0, CHAT_TEXT_LIMIT);
    if (!text && !input.image) throw new ChatError(400, "Type a message first.");
    if (this.#live && !this.groupConnected) throw new ChatError(409, "GroupCart hasn’t connected to the iMessage group yet. Send any message in the group, then try again.");
    let stored: { file: string; mimeType: string } | null = null;
    if (input.image) {
      if (input.image.length > CHAT_IMAGE_LIMIT) throw new ChatError(413, "That image is too large (15 MB max).");
      stored = this.#storeImage(input.image);
      if (!stored) throw new ChatError(415, "Send a PNG, JPEG, GIF, WebP, or HEIC image.");
    }
    const imageName = (input.imageName ?? "").replace(/[^\w .()-]+/g, "").trim().slice(0, 80) || `photo.${stored?.file.split(".").pop() ?? "jpg"}`;
    const replyTo = input.replyToId ? this.quote(input.replyToId) : null;
    if (input.replyToId && !replyTo) throw new ChatError(404, "The message you’re replying to isn’t in the chat anymore.");
    const message = this.#insert({
      kind: "member",
      memberId: member.id,
      authorName: member.name,
      text,
      attachments: stored ? [{ name: imageName, mimeType: stored.mimeType, size: input.image!.length, file: stored.file }] : [],
      source: options.source,
      via: options.source === "connector" ? options.via ?? "AI assistant" : undefined,
      replyToId: replyTo?.messageId ?? null,
    })!;
    // A reply to a message that is in iMessage goes there as a threaded reply.
    const threadTo = replyTo ? (this.#db.prepare("SELECT external_id FROM chat_messages WHERE id = ?").get(replyTo.messageId) as { external_id: string | null } | undefined)?.external_id : null;
    const replyId = threadTo?.startsWith("imessage:") ? threadTo.slice("imessage:".length) : null;

    const job = async (): Promise<string | null> => {
      this.#busy += 1;
      try {
        const group = this.#live ? this.#group : null;
        if (group) {
          const label = options.source === "connector" ? `${member.name} (via ${options.via ?? "AI assistant"})` : member.name;
          try {
            if (text) {
              const sentId = replyId && group.reply ? await group.reply(replyId, `${label}: ${text}`) : await group.sendText(`${label}: ${text}`);
              if (sentId) this.linkSent(message.id, sentId);
            }
            if (stored) {
              if (!text) await group.sendText(`${label} sent a photo:`);
              await group.sendImage(join(this.#filesDir, stored.file), stored.mimeType, imageName);
            }
          } catch (error) {
            // The group never saw it, so don't act on it either.
            console.warn("Could not relay a web chat message to the iMessage group:", error instanceof Error ? error.message : error);
            this.recordBot(`Sorry, I couldn’t post ${member.name}’s message to the iMessage group, so I didn’t act on it. Please try again.`, "reply");
            return null;
          }
        }
        const attachments: CommandAttachment[] = stored
          ? [{ mimeType: stored.mimeType, name: imageName, read: memoize(() => readFile(join(this.#filesDir, stored!.file))) }]
          : [];
        const reply = await (options.process ?? this.#process)({ messageId: `web:${message.id}`, memberId: member.id, memberName: member.name, text, attachments, ...(replyTo ? { replyTo } : {}) });
        if (reply) {
          if (group) {
            try { await group.respond(reply); } catch (error) {
              console.warn("Could not send a reply to the iMessage group:", error instanceof Error ? error.message : error);
            }
          }
          this.recordBot(reply, "reply");
        }
        return reply;
      } catch (error) {
        console.warn("Could not finish a web chat message:", error instanceof Error ? error.message : error);
        this.recordBot("Sorry, I couldn’t finish that one. Please try again in a moment.", "reply");
        return null;
      } finally {
        this.#busy -= 1;
      }
    };
    // One at a time, in the order people sent them.
    const run = this.#queue.then(job, job);
    this.#queue = run.catch(() => undefined);
    if (!options.awaitReply) return { message };
    return { message, reply: await run };
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  #view(row: Row): ChatMessage {
    const attachments = (JSON.parse(row.attachments_json) as StoredAttachment[]).map((item) => ({
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      url: item.file && isStoredImageName(item.file) ? `/chat/files/${item.file}` : null,
      image: Boolean(item.file) && item.mimeType.startsWith("image/"),
    }));
    return {
      id: row.id,
      kind: row.kind === "bot" ? "bot" : "member",
      memberId: row.member_id,
      name: row.kind === "bot" ? row.author_name || BOT_AUTHOR : (row.member_id && this.#displayName(row.member_id)) || row.author_name,
      text: row.text,
      attachments,
      source: row.source as ChatSource,
      via: row.via ?? null,
      at: row.created_at,
      card: row.card_json ? JSON.parse(row.card_json) as ChatCard : null,
      reactions: row.reactions_json ? JSON.parse(row.reactions_json) as Array<{ emoji: string; by: string }> : [],
      replyTo: row.reply_to_id ? this.quote(row.reply_to_id) : null,
      updatedAt: row.updated_at ?? row.created_at,
    };
  }

  get(id: number): ChatMessage | null {
    const row = this.#db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#view(row) : null;
  }

  /** Messages in order. `after` returns newer ones; otherwise the latest `limit` (or those before `before`). */
  list(options: { after?: number; before?: number; limit?: number } = {}): { messages: ChatMessage[]; hasEarlier: boolean } {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 60), 1), 200);
    let rows: Row[];
    if (options.after !== undefined) {
      rows = this.#db.prepare("SELECT * FROM chat_messages WHERE id > ? ORDER BY id LIMIT ?").all(options.after, limit) as Row[];
    } else if (options.before !== undefined) {
      rows = (this.#db.prepare("SELECT * FROM chat_messages WHERE id < ? ORDER BY id DESC LIMIT ?").all(options.before, limit) as Row[]).reverse();
    } else {
      rows = (this.#db.prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?").all(limit) as Row[]).reverse();
    }
    const first = rows[0];
    const hasEarlier = first ? Boolean(this.#db.prepare("SELECT 1 FROM chat_messages WHERE id < ? LIMIT 1").get(first.id)) : false;
    return { messages: rows.map((row) => this.#view(row)), hasEarlier };
  }

  /** Messages changed at or after `since` (ISO), e.g. a card someone voted on, so open chats can redraw them. */
  changedSince(since: string, limit = 100): ChatMessage[] {
    const rows = this.#db.prepare("SELECT * FROM chat_messages WHERE updated_at >= ? ORDER BY id LIMIT ?").all(since, Math.min(Math.max(Math.floor(limit), 1), 200)) as Row[];
    return rows.map((row) => this.#view(row));
  }

  /** Absolute path of a stored chat image, or null when the name is not one of ours. */
  filePath(file: string): string | null {
    if (!isStoredImageName(file)) return null;
    const path = join(this.#filesDir, file);
    return existsSync(path) ? path : null;
  }

  get isEmpty(): boolean {
    return !this.#db.prepare("SELECT 1 FROM chat_messages LIMIT 1").get();
  }

  // ---------------------------------------------------------------------------
  // Demo history
  // ---------------------------------------------------------------------------

  /**
   * Demo mode: a short, realistic history (game night, a chore nudge, a bill, groceries) cast from the first three
   * members, whatever their names. Grocery requests run through the real processor so the cart matches the conversation.
   */
  async seedDemo(): Promise<void> {
    if (this.#live || !this.isEmpty) return;
    const members = this.#members();
    if (members.length < 2) return;
    const cast = (index: number) => members[index % members.length]!;
    const [host, snacker, trashDuty] = [cast(0), cast(1), cast(2)];
    const first = (member: Member) => member.name.split(/\s+/)[0] ?? member.name;
    const others = (member: Member) => members.filter((candidate) => candidate.id !== member.id).map(first);
    const internetShare = (6_000 / members.length / 100).toFixed(2);
    const month = new Date().toLocaleString("en-US", { month: "long" });
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    type Step = { at: number; from?: Member; bot?: string; text?: string; process?: boolean };
    const steps: Step[] = [
      { at: 1_560, from: host, text: "Game night Friday? I can host 🎲" },
      { at: 1_557, from: trashDuty, text: "I’m in. Codenames or Catan?" },
      { at: 1_555, from: snacker, text: "Catan!! I’ll bring chips 🍟" },
      { at: 1_554, bot: `🎲 Game night: Friday 8 PM at ${first(host)}’s. ${joinNames([...new Set([snacker, trashDuty, host].map(first))])} are in.` },
      { at: 600, bot: `🧹 Friendly nudge: ${first(trashDuty)}, it’s your week for trash and recycling. Pickup is tomorrow morning.` },
      { at: 596, from: trashDuty, text: "On it 👍" },
      { at: 240, from: snacker, text: `Internet bill came in: $60 for ${month}` },
      { at: 239, bot: `🧾 Logged Internet: $60.00 split ${members.length} ways, $${internetShare} each. ${first(snacker)} paid it.` },
      { at: 45, from: host, text: "We’re out of eggs and pasta 😩" },
      // Splits come from upstream's sharing sessions (per-item “for everyone” no longer shares anything).
      { at: 44, from: host, text: `start sharing with ${joinNames(others(host))}`, process: true },
      { at: 43, from: host, text: "eggs and pasta", process: true },
      { at: 42, from: host, text: "stop sharing", process: true },
      { at: 12, from: trashDuty, text: "oat milk please", process: true },
    ];
    let index = 0;
    for (const step of steps) {
      index += 1;
      if (step.bot) {
        this.recordBot(step.bot, "seed", minutesAgo(step.at));
        continue;
      }
      if (!step.from || !step.text) continue;
      const message = this.#insert({ externalId: `seed:${index}`, kind: "member", memberId: step.from.id, authorName: step.from.name, text: step.text, attachments: [], source: "seed", at: minutesAgo(step.at) });
      if (!message || !step.process) continue;
      try {
        const reply = await this.#process({ messageId: `seed:${index}`, memberId: step.from.id, memberName: step.from.name, text: step.text, attachments: [] });
        if (reply) this.recordBot(reply, "seed", new Date(minutesAgo(step.at).getTime() + 20_000));
      } catch (error) {
        console.warn("Demo chat seed step failed:", error instanceof Error ? error.message : error);
      }
    }
  }
}
