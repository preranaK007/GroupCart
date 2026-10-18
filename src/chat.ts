// The household group conversation, mirrored for the web chat at /chat.
//
// Live mode: index.ts records every inbound allowlisted group message (text + attachment metadata; images are
// saved so they show inline) and every GroupCart reply; notifyGroup() messages arrive through onGroupNotify.
// A message sent from the website is posted into the iMessage group as "Maya: <text>" and then processed
// exactly like a group message from that member (the shared processMemberMessage in index.ts).
// Demo mode: the web chat is the group; nothing is sent anywhere.
//
// Tables use the chat_ prefix; image files live in <data dir>/chat-files and are served at /chat/files/<file>.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { attachment, type Space } from "spectrum-ts";
import type { CommandAttachment, CommandContext } from "./platform.js";
import { isStoredImageName, sniffImage } from "./profiles.js";
import type { Member } from "./store.js";

export const CHAT_TEXT_LIMIT = 2_000;
export const CHAT_IMAGE_LIMIT = 15 * 1024 * 1024;

export type ChatSource = "imessage" | "web" | "connector" | "reply" | "notify" | "seed";
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
  at: string;
};

/** Processes one member message (feature commands, then the cart) and returns GroupCart's reply. */
export type MemberMessageProcessor = (context: CommandContext) => Promise<string | null>;

/** What the chat needs from the household's iMessage group. */
export type GroupChannel = {
  sendText(text: string): Promise<void>;
  sendImage(path: string, mimeType: string, name: string): Promise<void>;
  /** Sends a GroupCart reply with the typing indicator. */
  respond(text: string): Promise<void>;
};

export function spectrumChannel(space: Space): GroupChannel {
  return {
    sendText: async (text) => { await space.send(text); },
    sendImage: async (path, mimeType, name) => { await space.send(attachment(path, { name, mimeType })); },
    respond: async (text) => { await space.responding(async () => { await space.send(text); }); },
  };
}

export type InboundAttachment = { mimeType: string; name?: string; size?: number; read: () => Promise<Buffer> };

export class ChatError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Row = { id: number; kind: string; member_id: string | null; author_name: string; text: string; attachments_json: string; source: string; created_at: string };

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
  #queue: Promise<unknown> = Promise.resolve();
  #busy = 0;

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
      CREATE TABLE IF NOT EXISTS chat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  get liveMode(): boolean {
    return this.#live;
  }

  /** True while GroupCart is working on a web-sent message (shown as a typing indicator). */
  get typing(): boolean {
    return this.#busy > 0;
  }

  /** Live mode: whether web messages can reach the iMessage group right now. */
  get groupConnected(): boolean {
    return this.#group !== null;
  }

  /** Remembers the household group (called from the message loop for every group message). */
  useGroup(channel: GroupChannel, spaceId?: string): void {
    this.#group = channel;
    if (spaceId && spaceId !== this.savedGroupId) {
      this.#db.prepare("INSERT INTO chat_state (key, value) VALUES ('group_space_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(spaceId);
    }
  }

  /** The last group space id seen, so a restart can reconnect the web chat before anyone texts. */
  get savedGroupId(): string | null {
    return (this.#db.prepare("SELECT value FROM chat_state WHERE key = 'group_space_id'").get() as { value: string } | undefined)?.value ?? null;
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  #insert(input: { externalId?: string; kind: ChatKind; memberId: string | null; authorName: string; text: string; attachments: StoredAttachment[]; source: ChatSource; at?: Date }): ChatMessage | null {
    const at = input.at && !Number.isNaN(input.at.getTime()) ? input.at : new Date();
    const result = this.#db.prepare(
      "INSERT OR IGNORE INTO chat_messages (external_id, kind, member_id, author_name, text, attachments_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.externalId ?? null, input.kind, input.memberId, input.authorName, input.text, JSON.stringify(input.attachments), input.source, at.toISOString());
    if (!Number(result.changes)) return null;
    return this.get(Number(result.lastInsertRowid));
  }

  /**
   * Records an inbound group message from an allowlisted member (idempotent by platform message id) and returns
   * its attachments for command handlers. Attachment bytes are read once and shared: image files are saved for
   * inline display while handlers (e.g. Bills) read the same bytes.
   */
  recordInbound(input: { messageId: string; memberId: string; memberName: string; text: string; attachments: InboundAttachment[]; at?: Date }): CommandAttachment[] {
    const shared = input.attachments.map((item) => ({ ...item, read: memoize(item.read) }));
    const message = this.#insert({
      externalId: `imessage:${input.messageId}`,
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

  /** Records a message from GroupCart itself (replies and notifications). */
  recordBot(text: string, source: ChatSource = "reply", at?: Date): ChatMessage | null {
    if (!text.trim()) return null;
    return this.#insert({ kind: "bot", memberId: null, authorName: "GroupCart", text: text.slice(0, 20_000), attachments: [], source, at });
  }

  /** Live loop: sends a GroupCart reply into the group (with typing) and records it. */
  async replyInGroup(channel: GroupChannel, text: string): Promise<void> {
    try {
      await channel.respond(text);
    } finally {
      this.recordBot(text, "reply");
    }
  }

  // ---------------------------------------------------------------------------
  // Sending from the website (or the Claude connector)
  // ---------------------------------------------------------------------------

  /**
   * Posts a member's message. Live mode relays it into the iMessage group as "Name: text" first. Then it is
   * processed exactly like a group message from that member, and GroupCart's reply is sent and recorded.
   * Returns right after recording unless awaitReply is set.
   */
  async send(
    member: Member,
    input: { text: string; image?: Buffer; imageName?: string },
    options: { source: "web" | "connector"; awaitReply?: boolean; /** Connector: which assistant ("Claude", "ChatGPT", "Grok"). */ via?: string } = { source: "web" },
  ): Promise<{ message: ChatMessage; reply?: string | null }> {
    const text = input.text.replace(/\r\n/g, "\n").trim().slice(0, CHAT_TEXT_LIMIT);
    if (!text && !input.image) throw new ChatError(400, "Type a message first.");
    if (this.#live && !this.#group) throw new ChatError(409, "GroupCart hasn’t connected to the iMessage group yet. Send any message in the group, then try again.");
    let stored: { file: string; mimeType: string } | null = null;
    if (input.image) {
      if (input.image.length > CHAT_IMAGE_LIMIT) throw new ChatError(413, "That image is too large (15 MB max).");
      stored = this.#storeImage(input.image);
      if (!stored) throw new ChatError(415, "Send a PNG, JPEG, GIF, WebP, or HEIC image.");
    }
    const imageName = (input.imageName ?? "").replace(/[^\w .()-]+/g, "").trim().slice(0, 80) || `photo.${stored?.file.split(".").pop() ?? "jpg"}`;
    const message = this.#insert({
      kind: "member",
      memberId: member.id,
      authorName: member.name,
      text,
      attachments: stored ? [{ name: imageName, mimeType: stored.mimeType, size: input.image!.length, file: stored.file }] : [],
      source: options.source,
    })!;

    const job = async (): Promise<string | null> => {
      this.#busy += 1;
      try {
        const group = this.#live ? this.#group : null;
        if (group) {
          const label = options.source === "connector" ? `${member.name} (via ${options.via ?? "AI assistant"})` : member.name;
          try {
            if (text) await group.sendText(`${label}: ${text}`);
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
        const reply = await this.#process({ messageId: `web:${message.id}`, memberId: member.id, memberName: member.name, text, attachments });
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
      name: row.kind === "bot" ? "GroupCart" : (row.member_id && this.#displayName(row.member_id)) || row.author_name,
      text: row.text,
      attachments,
      source: row.source as ChatSource,
      at: row.created_at,
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
   * Demo mode: a short, realistic history (game night, a chore nudge, a bill, groceries) for the default demo
   * members. Grocery requests run through the real processor so the cart matches the conversation.
   */
  async seedDemo(): Promise<void> {
    if (this.#live || !this.isEmpty) return;
    const byName = new Map(this.#members().map((member) => [member.name.toLowerCase(), member]));
    const alex = byName.get("alex");
    const maya = byName.get("maya");
    const jordan = byName.get("jordan");
    if (!alex || !maya || !jordan) return;
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    type Step = { at: number; from?: Member; bot?: string; text?: string; process?: boolean };
    const steps: Step[] = [
      { at: 1_560, from: maya, text: "Game night Friday? I can host 🎲" },
      { at: 1_557, from: jordan, text: "I’m in. Codenames or Catan?" },
      { at: 1_555, from: alex, text: "Catan!! I’ll bring chips 🍟" },
      { at: 1_554, bot: "🎲 Game night: Friday 8 PM at Maya’s. Alex, Jordan, and Maya are in." },
      { at: 600, bot: "🧹 Friendly nudge: Jordan, it’s your week for trash and recycling. Pickup is tomorrow morning." },
      { at: 596, from: jordan, text: "On it 👍" },
      { at: 240, from: alex, text: "Internet bill came in: $60 for October" },
      { at: 239, bot: "🧾 Logged Internet: $60.00 split 3 ways, $20.00 each. Pay Alex (Venmo @alex-k)." },
      { at: 45, from: maya, text: "We’re out of eggs and pasta 😩" },
      { at: 44, from: maya, text: "eggs and pasta for everyone", process: true },
      { at: 12, from: jordan, text: "oat milk please", process: true },
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
