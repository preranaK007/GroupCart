// Shared extension points for household features (chores, lists, events, bills, connector).
//
// Each feature module registers what it needs here instead of editing index.ts / dashboard.ts:
//   registerCommand(handler)   group-chat command, tried in order before cart processing
//   registerRoute(handler)     HTTP route on the local dashboard server (pages and /api/*)
//   registerTools(tools)       tools exposed to Claude through the connector (MCP)
//   scheduleEvery(name, ms, fn) background job (nudges, recurring lists, reminders)
//   notifyGroup(text)          proactive message to the household group chat
//
// Live mode sends notifyGroup() messages to the most recent iMessage group space; demo mode
// keeps them in an in-memory feed served at GET /api/feed so the dashboard can show them.
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
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

export type FeedEntry = { id: number; at: string; text: string };

const commands: Array<{ name: string; handler: CommandHandler }> = [];
const routes: RouteHandler[] = [];
const tools = new Map<string, ToolSpec>();
const feed: FeedEntry[] = [];
let feedId = 0;
let groupSender: ((text: string) => Promise<void>) | null = null;
const timers: NodeJS.Timeout[] = [];

export function registerCommand(name: string, handler: CommandHandler): void {
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

/** Live mode: index.ts sets this to send into the household group. */
export function setGroupSender(sender: ((text: string) => Promise<void>) | null): void {
  groupSender = sender;
}

/** Sends a proactive message to the group (live) and always records it in the feed. */
export async function notifyGroup(text: string): Promise<void> {
  feed.push({ id: ++feedId, at: new Date().toISOString(), text });
  if (feed.length > 100) feed.splice(0, feed.length - 100);
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
