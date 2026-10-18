// Shared extension points for household features (chores, lists, events, bills, connector).
//
// Each feature module registers what it needs here instead of editing index.ts / dashboard.ts:
//   registerCommand(handler)   group-chat command, tried in order before cart processing ({ before: name } to go first)
//   registerRoute(handler)     HTTP route on the local dashboard server (pages and /api/*)
//   registerTools(tools)       tools exposed to Claude through the connector (MCP)
//   scheduleEvery(name, ms, fn) background job (nudges, recurring lists, reminders)
//   notifyGroup(text)          proactive message to the household group chat (also shown in the web chat)
//   registerHelp(line)         one line appended to the "help" reply
//   store.database             the shared SQLite handle (create your own tables with CREATE TABLE IF NOT EXISTS)
//
// Live mode sends notifyGroup() messages to the household group that the store persists (upstream's
// store.rememberGroupSpace / store.groupSpace, reopened with imessage(app).space.get after a restart; see
// src/householdGroup.ts), so nudges and reminders work before anyone texts again. Every message is also kept in
// an in-memory feed served at GET /api/feed and mirrored into the web chat; demo mode only does the latter.
import type { IncomingMessage, ServerResponse } from "node:http";

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
};

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

export type FeedEntry = { id: number; at: string; text: string };

const commands: Array<{ name: string; handler: CommandHandler }> = [];
const routes: RouteHandler[] = [];
const tools = new Map<string, ToolSpec>();
const feed: FeedEntry[] = [];
let feedId = 0;
let groupSender: ((text: string) => Promise<void>) | null = null;
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
export function setGroupSender(sender: ((text: string) => Promise<void>) | null): void {
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
