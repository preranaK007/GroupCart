// Shared extension points for household features (chores, lists, events, bills, connector).
//
// Each feature module registers what it needs here instead of editing index.ts / dashboard.ts:
//   registerCommand(handler)   group-chat command, tried in order before cart processing ({ before: name } to go first)
//   registerRoute(handler)     HTTP route on the local dashboard server (pages and /api/*)
//   registerTools(tools)       tools exposed to Claude through the connector (MCP)
//   scheduleEvery(name, ms, fn) background job (nudges, recurring lists, reminders)
//   notifyGroup(text)          proactive message to the household group chat (also shown in the web chat)
//   registerHelp(line)         one line appended to the "help" reply
//   registerPendingQuestion(owner, source)  a feature's open questions, so a bare "ok"/number goes to the newest one
//   registerCardHandler(owner, handler)     taps on web chat cards (polls, buttons) whose id starts with "<owner>:"
//   postCard(text, card) / cardReply(text, card)  a bot message with a card (see "Chat cards" below)
//   runBuiltInCommand(context) GroupCart's own command handling for a member's text (index.ts installs it), never the coordinator
//   requestMember(request) / actingMember(request, members, claimedId)  who a web request is; live buttons act as them only
//   store.database            the shared SQLite handle (create your own tables with CREATE TABLE IF NOT EXISTS)
//
// Live mode sends notifyGroup() messages to the household group that the store persists (upstream's
// store.rememberGroupSpace / store.groupSpace, reopened with imessage(app).space.get after a restart; see
// src/householdGroup.ts), so nudges and reminders work before anyone texts again. Every message is also kept in
// an in-memory feed served at GET /api/feed and mirrored into the web chat; demo mode only does the latter.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatCard, ChatMessage } from "./chat.js";

export type CommandAttachment = {
  /** MIME type, e.g. image/png. */
  mimeType: string;
  /** File name when the platform provides one. */
  name?: string;
  /** Loads the attachment bytes. */
  read: () => Promise<Buffer>;
};

export type CommandContext = {
  /** Platform message id; use it to make handlers idempotent. */
  messageId: string;
  memberId: string;
  memberName: string;
  /** Message text (empty string for attachment-only messages). */
  text: string;
  attachments: CommandAttachment[];
  /** The chat message this one replies to (an iMessage threaded reply, or Reply in the web chat). */
  replyTo?: ReplyTarget;
};

/** A replied-to chat message: who wrote it (a roommate, "GroupCart", or "Claude") and its text. */
export type ReplyTarget = { messageId: number; name: string; text: string; fromBot: boolean };

/** Returns a reply to send to the group, or null when the message isn't for this handler. */
export type CommandHandler = (context: CommandContext) => Promise<string | null> | string | null;

export type RouteHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> | boolean;

export type ToolSpec = {
  /** snake_case tool name, unique across the app. */
  name: string;
  /** One or two sentences: what it does and when to use it. */
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** True when the tool changes household data. */
  mutates?: boolean;
  /** Runs as the household member whose Claude connector token made the call. */
  handler: (args: Record<string, unknown>, caller: ToolCaller) => Promise<unknown> | unknown;
};

export type ToolCaller = {
  memberId: string;
  memberName: string;
  /** Which assistant made the call ("Claude", "ChatGPT", "Grok", or "AI assistant"), for attribution like "Maya via Grok". */
  via?: string;
};

/**
 * A tool handler may return raw MCP content instead of a plain value, e.g. to hand bill
 * screenshots to the caller's own Claude for reading (no server-side API key needed):
 *   return { mcpContent: [{ type: "text", text: "..." }, { type: "image", data: base64, mimeType: "image/png" }] };
 */
export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResultWithContent = { mcpContent: McpContent[] };

/**
 * Remote access (LAN or tunnel). By default only loopback requests may use the web app; the connector
 * serves /mcp remotely with its own token auth. A profiles/sign-in module can authorize other remote
 * requests (e.g. a signed-in roommate's session cookie) by installing an authorizer.
 */
export type RemoteAuthorizer = (request: IncomingMessage, url: URL) => boolean;
let remoteAuthorizer: RemoteAuthorizer | null = null;

export function setRemoteAuthorizer(authorizer: RemoteAuthorizer | null): void {
  remoteAuthorizer = authorizer;
}

export function isRemoteAuthorized(request: IncomingMessage, url: URL): boolean {
  return remoteAuthorizer ? remoteAuthorizer(request, url) : false;
}

/**
 * Signed-in member for a web request (e.g. from a profiles module's session cookie), or null.
 * The connector's OAuth consent page uses it to skip the pairing code. Null until a module installs one.
 */
export type RequestMemberResolver = (request: IncomingMessage) => { memberId: string } | null;
let requestMemberResolver: RequestMemberResolver | null = null;

export function setRequestMemberResolver(resolver: RequestMemberResolver | null): void {
  requestMemberResolver = resolver;
}

export function requestMember(request: IncomingMessage): { memberId: string } | null {
  try {
    return requestMemberResolver ? requestMemberResolver(request) : null;
  } catch {
    return null;
  }
}

export type ActingMember = { ok: true; memberId: string } | { ok: false; status: 401 | 403; error: string };

/**
 * The member a live-mode web button acts as: the signed-in (or "Viewing as") household member and nobody else.
 * No such member is a 401; a body naming another member (`claimedId`, e.g. a `memberId` field) is a 403, so a
 * button never adds to the cart, RSVPs, or votes for another roommate.
 */
export function actingMember(request: IncomingMessage, members: ReadonlyArray<{ id: string }>, claimedId?: unknown): ActingMember {
  const viewer = requestMember(request)?.memberId;
  if (!viewer || !members.some((member) => member.id === viewer)) return { ok: false, status: 401, error: "Sign in to GroupCart first." };
  if (claimedId !== undefined && claimedId !== null && claimedId !== viewer) return { ok: false, status: 403, error: "You can only do that for yourself." };
  return { ok: true, memberId: viewer };
}

export type FeedEntry = { id: number; at: string; text: string };

const commands: Array<{ name: string; handler: CommandHandler }> = [];
const routes: RouteHandler[] = [];
const tools = new Map<string, ToolSpec>();
const feed: FeedEntry[] = [];
let feedId = 0;
/** Sends text into the household group and returns iMessage's id for it when known. */
type GroupSender = (text: string) => Promise<string | null | void>;
let groupSender: GroupSender | null = null;
const timers: NodeJS.Timeout[] = [];
const helpLines: string[] = [];

/** Adds a line to the group "help" reply (keep it to one short sentence with the command in quotes). */
export function registerHelp(line: string): void {
  helpLines.push(line);
}

export function registeredHelp(): string[] {
  return [...helpLines];
}

export function registerCommand(name: string, handler: CommandHandler, options: { before?: string } = {}): void {
  // --- House: `before` runs a narrow handler ahead of a broader one (e.g. a "broken: …" photo before bills) ---
  const index = options.before ? commands.findIndex((command) => command.name === options.before) : -1;
  if (index >= 0) { commands.splice(index, 0, { name, handler }); return; }
  // --- end House ---
  commands.push({ name, handler });
}

/** Runs registered command handlers in order; returns the first reply. */
export async function runCommands(context: CommandContext): Promise<string | null> {
  for (const { name, handler } of commands) {
    try {
      const reply = await handler(context);
      if (reply) return reply;
    } catch (error) {
      console.warn(`${name} command failed:`, error instanceof Error ? error.message : error);
      return `Sorry, ${name} hit a problem just now. Please try again in a moment.`;
    }
  }
  return null;
}

// --- Built-in commands: GroupCart's own handling of a member's text (feature commands, then the cart) ---
// index.ts installs it. Web buttons (src/groceryActions.ts) run a click through it as that member's typed command,
// so a click never goes to the household coordinator, even while one is connected.
let builtInCommands: ((context: CommandContext) => Promise<string | null>) | null = null;

export function setBuiltInCommands(handler: ((context: CommandContext) => Promise<string | null>) | null): void {
  builtInCommands = handler;
}

export function runBuiltInCommand(context: CommandContext): Promise<string | null> {
  if (!builtInCommands) throw new Error("GroupCart’s command handling isn’t set up.");
  return builtInCommands(context);
}
// --- end built-in commands ---

// --- Pending questions: who answers a bare "yes"/"ok" or a bare number ---
/** Bare replies that more than one feature might be waiting for: "ok" (yes/ok/no) or "number" (an option pick). */
export type BareReply = "ok" | "number";
/** When (ISO) the feature last asked this member a still-open question that a bare reply of this kind answers. */
export type PendingQuestionSource = (memberId: string, kind: BareReply) => string | null;
const pendingQuestionSources = new Map<string, PendingQuestionSource>();

/**
 * Each feature (cart, kitchen, bills, events, house) registers how to find a member's open question from its own
 * state. Registering an owner again replaces it, so the newest service instance answers (tests build several).
 */
export function registerPendingQuestion(owner: string, source: PendingQuestionSource): void {
  pendingQuestionSources.set(owner, source);
}

/**
 * The newest open question of this kind that any other feature asked the member (ISO), or null. A feature takes a
 * bare reply only when its own question is newer, so the most recent question wins.
 */
export function otherPendingQuestionAt(owner: string, memberId: string, kind: BareReply): string | null {
  let latest: string | null = null;
  for (const [name, source] of pendingQuestionSources) {
    if (name === owner) continue;
    const at = source(memberId, kind);
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}
// --- end pending questions ---

export function registerRoute(handler: RouteHandler): void {
  routes.push(handler);
}

export async function runRoutes(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  for (const handler of routes) {
    if (await handler(request, response, url)) return true;
  }
  return false;
}

export function registerTools(specs: ToolSpec[]): void {
  for (const spec of specs) {
    if (tools.has(spec.name)) throw new Error(`Duplicate tool name: ${spec.name}`);
    tools.set(spec.name, spec);
  }
}

export function listTools(): ToolSpec[] {
  return [...tools.values()];
}

/** Live mode: index.ts sets this once to send into the persisted household group (src/householdGroup.ts). */
export function setGroupSender(sender: GroupSender | null): void {
  groupSender = sender;
}

// --- Profiles & chat: mirror group notifications into the web chat ---
const notifyListeners: Array<(text: string) => void> = [];

/** Called with every notifyGroup() text (the web chat records them as GroupCart messages). */
export function onGroupNotify(listener: (text: string) => void): void {
  notifyListeners.push(listener);
}
// --- end profiles & chat ---

/**
 * Records a GroupCart message that reached the group some other way (e.g. a recurring-list check-in sent by
 * src/reminders.ts, or one shown with a demo reply) in the feed. `mirror` also adds it to the web chat; leave it
 * off when the web chat already recorded the text as part of a reply.
 */
export function recordGroupMessage(text: string, options: { mirror?: boolean } = {}): void {
  feed.push({ id: ++feedId, at: new Date().toISOString(), text });
  if (feed.length > 100) feed.splice(0, feed.length - 100);
  if (!options.mirror) return;
  for (const listener of notifyListeners) { try { listener(text); } catch (error) { console.warn("A group notification listener failed:", error instanceof Error ? error.message : error); } } // profiles & chat
}

/** Sends a proactive message to the group (live) and always records it in the feed and the web chat. */
export async function notifyGroup(text: string): Promise<void> {
  recordGroupMessage(text, { mirror: true });
  if (!groupSender) return;
  try {
    await groupSender(text);
  } catch (error) {
    console.warn("Could not send a group notification:", error instanceof Error ? error.message : error);
  }
}

// --- Chat cards: polls and buttons under a bot message in the web chat (types in src/chat.ts) ---
// A card's id is "<owner>:<rest>"; taps on it (POST /api/chat/cards) go to the handler registered for that owner,
// which returns the updated card and/or a reply for the group (or null when the card is no longer actionable).
// iMessage has no buttons, so everything sent there uses cardText(card).
//
// Two ways to post a card:
//   postCard(text, card)   a proactive bot message (like notifyGroup), returning the web chat message
//   cardReply(text, card)  for a command handler's reply string: returns the iMessage text (text + cardText), and the
//                          web chat, when it records that reply, stores `text` with the card instead. Command
//                          handlers return plain strings, so the card rides along by matching the reply text.
export type CardActionInput = { memberId: string; card: ChatCard; actionId?: string; optionIds?: string[] };
/** `error` is shown only to the member who tapped (e.g. "Only Maya can book this"); nothing is changed. */
export type CardActionResult = { card?: ChatCard; reply?: string; error?: string } | null;
export type CardHandler = (input: CardActionInput) => Promise<CardActionResult> | CardActionResult;
const cardHandlers = new Map<string, CardHandler>();

/** Registering an owner again replaces its handler, so the newest service instance answers (tests build several). */
export function registerCardHandler(owner: string, handler: CardHandler): void {
  cardHandlers.set(owner, handler);
}

export function cardHandler(owner: string): CardHandler | null {
  return cardHandlers.get(owner) ?? null;
}

/** "events:12" → "events". */
export function cardOwner(cardId: string): string {
  return cardId.split(":")[0] ?? "";
}

function numbered(index: number, label: string, extra = ""): string {
  return `${index + 1}. ${label}${extra}`;
}

/** Compact plain text for a card (iMessage and other text-only places): numbered options and how to answer. */
export function cardText(card: ChatCard): string {
  const lines: string[] = [];
  if (card.kind === "poll") {
    if (card.closed) return `${card.question}: ${card.result ?? "voting closed"}`;
    lines.push(card.question, ...card.options.map((option, index) => numbered(index, option.label, option.detail ? ` (${option.detail})` : "")));
    const numbers = card.options.map((_, index) => index + 1);
    if (numbers.length === 1) lines.push("Reply 1.");
    else lines.push(card.multi ? `Reply with every number that works, e.g. “${numbers.slice(0, 2).join(" ")}”.` : `Reply ${numbers.join("/")}.`);
    return lines.join("\n");
  }
  if (card.kind === "choices") {
    lines.push(card.title, ...card.items.map((item, index) => numbered(index, item.label, `${item.price ? ` · ${item.price}` : ""}${item.detail ? ` (${item.detail})` : ""}`)));
  } else if (card.title) {
    lines.push(card.title);
  }
  if (card.resolved) lines.push(`✓ ${card.resolved}`);
  // Buttons that post an action, and app paths like "/bills", only work on the website; web links work anywhere.
  else lines.push(...card.actions.filter((action) => action.url && /^https?:\/\//i.test(action.url)).map((action) => `${action.label}: ${action.url}`));
  return lines.join("\n");
}

/** The web chat's card store, installed by setupProfilesAndChat. */
export type CardSink = {
  record(text: string, card: ChatCard, author?: string): ChatMessage | null;
  /** A plain bot message under another author (the household coordinator posts as "Claude"). */
  recordText(text: string, author: string): ChatMessage | null;
  /** Replaces the newest message carrying card.id with this card (null when none is shown). */
  refresh(card: ChatCard): ChatMessage | null;
  /** Remembers iMessage's id for a bot message sent to the group, so replies and reactions to it find it. */
  linkSent?(messageId: number, sentId: string): void;
};
let cardSink: CardSink | null = null;

export function setCardSink(sink: CardSink | null): void {
  cardSink = sink;
}

/**
 * Posts a bot message with a card: recorded in the web chat (as `author`, default "GroupCart") and the feed, and in
 * live mode sent to the household group as text plus cardText(card), signed "Author: …" when an author is given.
 * Returns the web chat message (id and card).
 */
export async function postCard(text: string, card: ChatCard, options: { author?: string } = {}): Promise<ChatMessage | null> {
  const fallback = [text.trim(), cardText(card)].filter(Boolean).join("\n");
  recordGroupMessage(fallback);
  const message = cardSink?.record(text.trim(), card, options.author) ?? null;
  // An open poll goes to iMessage as a native poll (its votes come back through votePollFromGroup).
  if (groupSender && groupPollSender && card.kind === "poll" && !card.closed) {
    try {
      if (text.trim()) linkSent(message, await groupSender(signed(text.trim(), options.author)));
      const nativePollId = await groupPollSender(card.question, card.options.map((option) => option.label));
      // Remember iMessage's id for the poll so its votes find this card.
      if (nativePollId && message) return cardSink?.refresh({ ...card, nativePollId }) ?? message;
      return message;
    } catch (error) {
      console.warn("Could not send a native poll to the group; sending it as text:", error instanceof Error ? error.message : error);
    }
  }
  if (groupSender) {
    try {
      linkSent(message, await groupSender(signed(fallback, options.author)));
    } catch (error) {
      console.warn("Could not send a card to the group:", error instanceof Error ? error.message : error);
    }
  }
  return message;
}

/**
 * iMessage shows every bot message from the same line, so a message posted under its own author (the household
 * coordinator) carries the name there: "Claude: …". The web chat shows the author on its own.
 */
function signed(text: string, author: string | undefined): string {
  return author ? `${author}: ${text}` : text;
}

function linkSent(message: ChatMessage | null, sentId: string | null | void): void {
  if (message && sentId) cardSink?.linkSent?.(message.id, sentId);
}

/** Posts a plain bot message as `author` (web chat, feed, and the household group in live mode). */
export async function postMessage(text: string, options: { author: string }): Promise<ChatMessage | null> {
  recordGroupMessage(text);
  const message = cardSink?.recordText(text.trim(), options.author) ?? null;
  if (groupSender) {
    try {
      linkSent(message, await groupSender(signed(text, options.author)));
    } catch (error) {
      console.warn("Could not send a message to the group:", error instanceof Error ? error.message : error);
    }
  }
  return message;
}

/** Sends a native iMessage poll and returns iMessage's id for it (null when unknown). */
type GroupPollSender = (title: string, options: string[]) => Promise<string | null>;
let groupPollSender: GroupPollSender | null = null;

/** Live mode: index.ts installs this so poll cards become native iMessage polls. */
export function setGroupPollSender(sender: GroupPollSender | null): void {
  groupPollSender = sender;
}

/** Redraws a card already in the web chat after its state changed elsewhere (e.g. someone voted by text). */
export function refreshCard(card: ChatCard): ChatMessage | null {
  return cardSink?.refresh(card) ?? null;
}

type PendingReplyCard = { key: string; text: string; card: ChatCard; at: number };
const pendingReplyCards: PendingReplyCard[] = [];
const REPLY_CARD_TTL_MS = 10 * 60_000;

/**
 * A command reply with a card. Returns the text to send (text, cardText(card), then `hint`, e.g. “Reply “ok” to
 * save.” for buttons iMessage can't show); when the web chat records a message containing it, it stores `text`
 * and the card instead (claimReplyCard).
 */
export function cardReply(text: string, card: ChatCard, hint?: string): string {
  const full = [text.trim(), cardText(card), hint?.trim()].filter(Boolean).join("\n");
  const now = Date.now();
  // Replies that never reach the chat (e.g. a tool result) expire.
  const fresh = pendingReplyCards.filter((entry) => now - entry.at < REPLY_CARD_TTL_MS).slice(-49);
  pendingReplyCards.splice(0, pendingReplyCards.length, ...fresh, { key: full, text: text.trim(), card, at: now });
  return full;
}

/** For the web chat: the card a recorded bot text was built with (consumed once), and the text to show with it. */
export function claimReplyCard(recorded: string): { text: string; card: ChatCard } | null {
  const index = pendingReplyCards.findIndex((entry) => recorded.includes(entry.key));
  if (index < 0) return null;
  const [entry] = pendingReplyCards.splice(index, 1);
  return { text: recorded.replace(entry!.key, entry!.text).trim(), card: entry!.card };
}
// --- end chat cards ---

export function recentFeed(limit = 20): FeedEntry[] {
  return feed.slice(-limit).reverse();
}

/** Runs fn every intervalMs (and once shortly after startup). Errors are logged, never thrown. */
export function scheduleEvery(name: string, intervalMs: number, fn: () => Promise<void> | void): void {
  const run = async () => {
    try { await fn(); } catch (error) { console.warn(`Scheduled job ${name} failed:`, error instanceof Error ? error.message : error); }
  };
  timers.push(setTimeout(run, 5_000), setInterval(run, intervalMs));
}

export function stopSchedules(): void {
  for (const timer of timers.splice(0)) clearTimeout(timer);
}
