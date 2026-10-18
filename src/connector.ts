// AI assistant connector: GroupCart as a remote MCP server (Streamable HTTP, stateless, JSON responses) that
// each roommate adds to their own assistant: Claude (Code, Desktop, claude.ai), ChatGPT and dots, or Grok.
// Every call runs as the roommate who connected it.
//
// Routes (registered through src/platform.ts registerRoute):
//   POST /mcp                          MCP JSON-RPC with `Authorization: Bearer <token>`, where the token is a
//                                      personal connector token (gct_…) or an OAuth access token (gca_…)
//   POST /mcp/t/<token>                same, connector token in a secret path (for clients without headers)
//   /.well-known/oauth-*, /oauth/*     OAuth 2.1 for hosted assistants (src/connectorOAuth.ts)
//   GET  /api/connector                Settings status: URLs, members, connections, tools (local only)
//   POST /api/connector/tokens         {memberId} → new connector token, shown once (local only)
//   POST /api/connector/tokens/revoke  {memberId} (local only)
//   POST /api/connector/pairing        {memberId} → one-time pairing code for OAuth sign-in (local only)
//   POST /api/connector/grants/revoke  {grantId} → disconnect one OAuth app (local only)
//
// Connector tokens are 32 random bytes; only their SHA-256 hash is stored (table connector_tokens). Failed
// auth is rate-limited per client and globally. Secrets are never logged. Tools are whatever
// registerTools() holds at request time (listTools()), so feature modules' tools appear automatically.
// Remote (tunnel/LAN) requests are limited to /mcp, /oauth/* and /.well-known/* by src/remoteAccess.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  type CallToolResult, type ImageContent, type TextContent, type Tool, type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { listTools, registerRoute, type McpContent, type ToolCaller, type ToolResultWithContent, type ToolSpec } from "./platform.js";
import { hostNameOf, isConnectorPath, isRemoteRequest } from "./remoteAccess.js";
import { registerCoreTools, type CoreToolDeps } from "./coreTools.js";
import { ConnectorOAuth, publicOriginOf, resourceMetadataUrl, type OAuthConnection } from "./connectorOAuth.js";
import {
  FailedAuthLimiter, clientKey, crossOrigin, headerValue, randomSecret, readParams, redactTokens, sendJson, sha256Hex,
} from "./connectorSecurity.js";
import type { CartStore } from "./store.js";

export { FailedAuthLimiter, redactTokens } from "./connectorSecurity.js";

// ---------------------------------------------------------------------------
// Tokens

const TOKEN_PREFIX = "gct_";
const TOKEN_PATTERN = /^gct_[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60_000;

export type ConnectorTokenInfo = { memberId: string; hint: string; createdAt: string; lastUsedAt: string | null };

export class ConnectorTokens {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connector_tokens (
        member_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        token_hint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `);
  }

  /** Creates (or rotates) the member's token. The plaintext is returned once and never stored. */
  issue(memberId: string): string {
    const token = randomSecret(TOKEN_PREFIX);
    this.db.prepare(
      "INSERT INTO connector_tokens (member_id, token_hash, token_hint, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(member_id) DO UPDATE SET token_hash = excluded.token_hash, token_hint = excluded.token_hint, created_at = excluded.created_at, last_used_at = NULL",
    ).run(memberId, sha256Hex(token), token.slice(-4), new Date().toISOString());
    return token;
  }

  revoke(memberId: string): boolean {
    return Number(this.db.prepare("DELETE FROM connector_tokens WHERE member_id = ?").run(memberId).changes) > 0;
  }

  /** Member id owning the token, or undefined. Malformed tokens are rejected without a lookup. */
  verify(token: string): string | undefined {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const row = this.db.prepare("SELECT member_id FROM connector_tokens WHERE token_hash = ?").get(sha256Hex(token)) as { member_id: string } | undefined;
    return row?.member_id;
  }

  /** Records use, at most once a minute per member. */
  touch(memberId: string, now = Date.now()): void {
    this.db.prepare(
      "UPDATE connector_tokens SET last_used_at = ? WHERE member_id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
    ).run(new Date(now).toISOString(), memberId, new Date(now - TOUCH_INTERVAL_MS).toISOString());
  }

  list(): ConnectorTokenInfo[] {
    return (this.db.prepare("SELECT member_id, token_hint, created_at, last_used_at FROM connector_tokens").all() as Array<{
      member_id: string; token_hint: string; created_at: string; last_used_at: string | null;
    }>).map((row) => ({ memberId: row.member_id, hint: row.token_hint, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
  }
}

// ---------------------------------------------------------------------------
// Tools → MCP

const DESTRUCTIVE_TOOL = /^(delete|remove|clear|cancel|revoke|reset)_/;
/** Tools that reach people or services outside GroupCart's own data. */
const OPEN_WORLD_TOOLS = new Set(["post_to_group"]);

function titleFromName(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toMcpTool(spec: ToolSpec): Tool {
  const mutates = Boolean(spec.mutates);
  const annotations: ToolAnnotations = {
    title: titleFromName(spec.name),
    readOnlyHint: !mutates,
    openWorldHint: OPEN_WORLD_TOOLS.has(spec.name),
  };
  if (mutates) {
    annotations.destructiveHint = DESTRUCTIVE_TOOL.test(spec.name);
    annotations.idempotentHint = false;
  }
  return {
    name: spec.name,
    title: annotations.title,
    description: spec.description,
    inputSchema: spec.inputSchema as Tool["inputSchema"],
    annotations,
  };
}

type SchemaProperty = { type?: string | string[]; enum?: unknown[] };

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

/** Light top-level check against the tool's JSON Schema: required keys, primitive types, enums. */
export function validateArguments(schema: ToolSpec["inputSchema"], args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "Arguments must be a JSON object.";
  const record = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (record[key] === undefined || record[key] === null) return `Missing required argument "${key}".`;
  }
  const additional = (schema as { additionalProperties?: unknown }).additionalProperties;
  for (const [key, value] of Object.entries(record)) {
    const property = schema.properties[key] as SchemaProperty | undefined;
    if (!property) {
      if (additional === false) return `Unknown argument "${key}".`;
      continue;
    }
    if (value === undefined) continue;
    const types = property.type === undefined ? [] : Array.isArray(property.type) ? property.type : [property.type];
    if (types.length && !types.some((type) => matchesType(value, type))) return `Argument "${key}" must be of type ${types.join(" or ")}.`;
    if (property.enum && !property.enum.some((option) => option === value)) {
      return `Argument "${key}" must be one of: ${property.enum.map((option) => JSON.stringify(option)).join(", ")}.`;
    }
  }
  return null;
}

function isContentResult(value: unknown): value is ToolResultWithContent {
  return typeof value === "object" && value !== null && Array.isArray((value as { mcpContent?: unknown }).mcpContent);
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function toContentBlock(block: McpContent): TextContent | ImageContent {
  if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
  if (block?.type === "image" && typeof block.data === "string" && block.data.length % 4 === 0 && BASE64.test(block.data)
    && typeof block.mimeType === "string" && /^image\/[a-z0-9.+-]+$/i.test(block.mimeType)) {
    return { type: "image", data: block.data, mimeType: block.mimeType };
  }
  throw new Error("The tool returned a content block GroupCart can't send (expected text, or base64 image data with an image/* type).");
}

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/** Maps a handler's return value to MCP content: raw blocks, text, or pretty-printed JSON. */
export function toCallToolResult(value: unknown): CallToolResult {
  if (isContentResult(value)) {
    const content = value.mcpContent.map(toContentBlock);
    return { content: content.length ? content : [{ type: "text", text: "Done." }] };
  }
  if (typeof value === "string") return textResult(value || "Done.");
  if (value === undefined || value === null) return textResult("Done.");
  return textResult(JSON.stringify(value, null, 2));
}

/** Runs a registered tool as `caller`. Problems come back as isError results, never thrown. */
export async function runTool(name: string, args: unknown, caller: ToolCaller): Promise<CallToolResult> {
  const spec = listTools().find((tool) => tool.name === name);
  if (!spec) return textResult(`Unknown tool "${name}". Call tools/list to see what GroupCart offers.`, true);
  const problem = validateArguments(spec.inputSchema, args ?? {});
  if (problem) return textResult(problem, true);
  try {
    return toCallToolResult(await spec.handler((args ?? {}) as Record<string, unknown>, caller));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tool failed.";
    console.warn(`Claude connector: ${name} failed for ${caller.memberName}: ${redactTokens(message)}`);
    return textResult(message, true);
  }
}

// ---------------------------------------------------------------------------
// HTTP

type ConnectorState = {
  tokens: ConnectorTokens;
  oauth: ConnectorOAuth;
  store: CartStore;
  port: number;
  publicUrl: string;
  demoMode: boolean;
};

let state: ConnectorState | null = null;
const limiter = new FailedAuthLimiter();
const MAX_MCP_BODY_BYTES = 512 * 1024;

function sendRpcError(response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(response, status, { jsonrpc: "2.0", error: { code: status === 401 ? -32001 : -32000, message }, id: null }, headers);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const match = headerValue(request, "authorization")?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

function serverInstructions(caller: ToolCaller, household: string): string {
  return [
    `GroupCart is the shared household app for ${household}: groceries, chores, bills, events, and the household calendar.`,
    `You are connected as ${caller.memberName} (through ${caller.via ?? "an AI assistant"}). Every tool runs as ${caller.memberName}; changes are attributed to them and visible to the whole household.`,
    "Start with whats_on_my_plate or view_cart before changing anything.",
    "Sample-catalog prices are estimates; Kroger prices are store-specific quotes. GroupCart never places orders or sends payments.",
    `Use post_to_group only when ${caller.memberName} asks you to message the household.`,
  ].join(" ");
}

function buildServer(caller: ToolCaller, household: string): McpServer {
  const mcp = new McpServer(
    { name: "groupcart", title: "GroupCart", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: serverInstructions(caller, household) },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools().map(toMcpTool) }));
  mcp.server.setRequestHandler(CallToolRequestSchema, (request) => runTool(request.params.name, request.params.arguments ?? {}, caller));
  return mcp;
}

type Authenticated = { memberId: string; via: string } | { expired: true } | null;

/** Connector token (header or secret path; acts "via Claude") or OAuth access token (header only). */
function authenticate(request: IncomingMessage, pathToken: string | undefined, current: ConnectorState): Authenticated {
  if (pathToken) {
    const memberId = current.tokens.verify(pathToken);
    return memberId ? { memberId, via: "Claude" } : null;
  }
  const token = bearerToken(request);
  if (!token) return null;
  if (token.startsWith("gca_")) {
    const check = current.oauth.verifyAccessToken(token);
    if (check.status === "expired") return { expired: true };
    return check.status === "valid" ? { memberId: check.memberId, via: check.via } : null;
  }
  const memberId = current.tokens.verify(token);
  if (memberId) current.tokens.touch(memberId);
  return memberId ? { memberId, via: "Claude" } : null;
}

async function handleMcp(request: IncomingMessage, response: ServerResponse, pathToken: string | undefined, current: ConnectorState): Promise<void> {
  if (crossOrigin(request)) return sendRpcError(response, 403, "Cross-origin browser requests are not allowed.");
  const key = clientKey(request);
  const waitMs = limiter.retryAfterMs(key);
  if (waitMs > 0) {
    return sendRpcError(response, 429, "Too many failed attempts. Try again later.", { "retry-after": String(Math.ceil(waitMs / 1000)) });
  }
  const auth = authenticate(request, pathToken, current);
  const member = auth && "memberId" in auth ? current.store.getMembers().find((candidate) => candidate.id === auth.memberId) : undefined;
  if (!auth || !member || !("memberId" in auth)) {
    // An expired OAuth access token is a normal refresh signal, not a guess, so it isn't counted.
    const expired = Boolean(auth && "expired" in auth);
    if (!expired) limiter.recordFailure(key);
    const presented = Boolean(pathToken ?? bearerToken(request));
    const challenge = `Bearer realm="GroupCart", resource_metadata="${resourceMetadataUrl(request, publicOriginOf(current.publicUrl))}"${presented ? `, error="invalid_token", error_description="${expired ? "The access token expired" : "Unknown or revoked token"}"` : ""}`;
    return sendRpcError(response, 401, expired
      ? "The access token expired. Refresh it and try again."
      : "Missing or invalid GroupCart token. Connect through OAuth, or create a connector token in GroupCart Settings > AI assistants.", { "www-authenticate": challenge });
  }
  limiter.reset(key);
  if (request.method !== "POST") {
    return sendRpcError(response, 405, "Method not allowed. This connector is stateless: send JSON-RPC with POST.", { allow: "POST" });
  }
  if (pathToken) current.tokens.touch(member.id);

  const caller: ToolCaller = { memberId: member.id, memberName: member.name, via: auth.via };
  const server = buildServer(caller, current.store.household);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
  });
  transport.onerror = (error) => console.warn(`Connector request problem: ${redactTokens(error.message)}`);
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error) {
    console.warn(`Connector request failed: ${redactTokens(error instanceof Error ? error.message : "unknown error")}`);
    if (!response.headersSent) sendRpcError(response, 500, "Internal server error.");
  }
}

// ---------------------------------------------------------------------------
// Settings view and connection snippets

export type ConnectorMemberStatus = {
  id: string;
  name: string;
  /** True when the member has a connector token or at least one connected OAuth app. */
  connected: boolean;
  /** Personal connector token (Claude Code / secret URL), if any. */
  token: { hint: string; createdAt: string; lastUsedAt: string | null } | null;
  /** OAuth apps the member connected (ChatGPT, Grok, claude.ai, ...). */
  connections: OAuthConnection[];
  /** Expiry of an unused pairing code, if one is active. */
  pairingExpiresAt: string | null;
};

export type ConnectorToolGroup = { group: string; tools: Array<{ name: string; description: string; mutates: boolean }> };

export type ConnectorView = {
  demoMode: boolean;
  port: number;
  localUrl: string;
  /** Non-loopback GROUP_CART_PUBLIC_URL (e.g. a tunnel) with /mcp appended, or null. */
  publicUrl: string | null;
  publicHttps: boolean;
  members: ConnectorMemberStatus[];
  toolGroups: ConnectorToolGroup[];
};

export type ConnectionSnippet = { id: string; title: string; note: string; code: string | null };

const TOOL_GROUPS: Array<[string, RegExp]> = [
  ["Groceries", /cart|product|grocer|kroger/],
  ["Chores", /chore/],
  ["Bills", /bill|balance|payment|expense|splitwise|owe|settle/],
  ["Calendar", /free_time|calendar|availability/],
  ["Lists & events", /staple|list|event/],
];
const GROUP_ORDER = ["Household", ...TOOL_GROUPS.map(([group]) => group)];

export function toolGroupOf(name: string): string {
  return TOOL_GROUPS.find(([, pattern]) => pattern.test(name))?.[0] ?? "Household";
}

function publicBase(publicUrl: string): string | null {
  try {
    const parsed = new URL(publicUrl);
    const host = hostNameOf(parsed.host);
    if (!host || host === "127.0.0.1" || host === "localhost" || host === "[::1]") return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** Status for the Settings card, or null before setupConnector() runs. Never includes secrets. */
export function connectorView(): ConnectorView | null {
  if (!state) return null;
  const tokens = new Map(state.tokens.list().map((info) => [info.memberId, info]));
  const connections = state.oauth.connections();
  const pairing = state.oauth.pairingExpiries();
  const base = publicBase(state.publicUrl);
  const groups = new Map<string, ConnectorToolGroup>();
  for (const spec of listTools()) {
    const group = toolGroupOf(spec.name);
    if (!groups.has(group)) groups.set(group, { group, tools: [] });
    groups.get(group)!.tools.push({ name: spec.name, description: spec.description, mutates: Boolean(spec.mutates) });
  }
  return {
    demoMode: state.demoMode,
    port: state.port,
    localUrl: `http://127.0.0.1:${state.port}/mcp`,
    publicUrl: base ? `${base}/mcp` : null,
    publicHttps: Boolean(base?.startsWith("https://")),
    members: state.store.getMembers().map((member) => {
      const info = tokens.get(member.id);
      const apps = connections.filter((connection) => connection.memberId === member.id);
      return {
        id: member.id,
        name: member.name,
        connected: Boolean(info) || apps.length > 0,
        token: info ? { hint: info.hint, createdAt: info.createdAt, lastUsedAt: info.lastUsedAt } : null,
        connections: apps,
        pairingExpiresAt: pairing.get(member.id) ?? null,
      };
    }),
    toolGroups: [...groups.values()].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)),
  };
}

/** Copy-ready setup snippets for one member's freshly issued connector token. */
export function connectionSnippets(token: string, view: ConnectorView): ConnectionSnippet[] {
  const local = view.localUrl;
  const remote = view.publicUrl;
  const snippets: ConnectionSnippet[] = [
    {
      id: "claude-code",
      title: "Claude Code (this computer)",
      note: "Run in a terminal, then start Claude Code and check /mcp.",
      code: `claude mcp add --transport http groupcart ${local} --header "Authorization: Bearer ${token}"`,
    },
  ];
  if (remote) {
    snippets.push({
      id: "claude-code-remote",
      title: "Claude Code (another computer)",
      note: "Same command with the public URL.",
      code: `claude mcp add --transport http groupcart ${remote} --header "Authorization: Bearer ${token}"`,
    });
  }
  snippets.push(view.publicHttps && remote
    ? {
      id: "custom-connector",
      title: "Personal URL (no sign-in step)",
      note: "For claude.ai, Claude Desktop, ChatGPT, or Grok custom connectors set to no authentication: paste this URL. It acts as you via Claude; treat it like a password. Or paste the plain /mcp URL and sign in with a pairing code instead.",
      code: `${remote}/t/${token}`,
    }
    : {
      id: "custom-connector",
      title: "claude.ai, Claude Desktop, ChatGPT, or Grok",
      note: `Hosted assistants need a public HTTPS URL. On this computer run \`cloudflared tunnel --url http://127.0.0.1:${view.port}\`, set GROUP_CART_PUBLIC_URL to the https://….trycloudflare.com address it prints, and restart GroupCart. Then add the /mcp URL as a custom connector and sign in with a pairing code. Only /mcp and sign-in pages are reachable through the tunnel.`,
      code: null,
    });
  snippets.push({
    id: "desktop-local",
    title: "Claude Desktop, local config (this computer)",
    note: "Settings > Developer > Edit Config, merge this into claude_desktop_config.json, and restart Claude Desktop. Needs Node.js (uses the mcp-remote bridge).",
    code: JSON.stringify({
      mcpServers: {
        groupcart: {
          command: "npx",
          args: ["-y", "mcp-remote", local, "--header", "Authorization:${GROUPCART_AUTH}"],
          env: { GROUPCART_AUTH: `Bearer ${token}` },
        },
      },
    }, null, 2),
  });
  return snippets;
}

async function handleSettingsApi(request: IncomingMessage, response: ServerResponse, url: URL, current: ConnectorState): Promise<void> {
  // Token and pairing management stays on this computer even if a profiles module authorizes other remote routes.
  if (isRemoteRequest(request)) return sendJson(response, 404, { error: "Not found." });
  if (request.method === "GET" && url.pathname === "/api/connector") return sendJson(response, 200, connectorView());
  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed." }, { allow: "GET, POST" });
  if (crossOrigin(request)) return sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
  if (!/^application\/json\b/i.test(headerValue(request, "content-type") ?? "")) {
    return sendJson(response, 415, { error: "Send JSON (Content-Type: application/json)." });
  }
  let body: Record<string, unknown>;
  try {
    body = await readParams(request, 4_096);
  } catch {
    return sendJson(response, 400, { error: "Request body must be valid JSON." });
  }
  if (url.pathname === "/api/connector/grants/revoke") {
    const grantId = typeof body.grantId === "string" ? body.grantId : "";
    const connection = current.oauth.connections().find((entry) => entry.grantId === grantId);
    if (!connection) return sendJson(response, 404, { error: "That connection was not found." });
    current.oauth.revokeGrant(grantId);
    console.log(`Connector: disconnected "${connection.clientName}".`);
    return sendJson(response, 200, { grantId, revoked: true });
  }
  const member = typeof body.memberId === "string" ? current.store.getMembers().find((candidate) => candidate.id === body.memberId) : undefined;
  if (!member) return sendJson(response, 404, { error: "Choose a household member." });
  if (url.pathname === "/api/connector/tokens") {
    const token = current.tokens.issue(member.id);
    const view = connectorView()!;
    console.log(`Connector: issued a new connector token for ${member.name}.`);
    return sendJson(response, 200, {
      memberId: member.id,
      memberName: member.name,
      token,
      snippets: connectionSnippets(token, view),
    });
  }
  if (url.pathname === "/api/connector/tokens/revoke") {
    const revoked = current.tokens.revoke(member.id);
    if (revoked) console.log(`Connector: revoked ${member.name}'s connector token.`);
    return sendJson(response, 200, { memberId: member.id, revoked });
  }
  if (url.pathname === "/api/connector/pairing") {
    const pairing = current.oauth.issuePairingCode(member.id);
    const view = connectorView()!;
    return sendJson(response, 200, { memberId: member.id, memberName: member.name, code: pairing.code, expiresAt: pairing.expiresAt, publicUrl: view.publicUrl, publicHttps: view.publicHttps });
  }
  return sendJson(response, 404, { error: "Not found." });
}

export type ConnectorOptions = CoreToolDeps & {
  port: number;
  /** GROUP_CART_PUBLIC_URL; a non-loopback value (e.g. a tunnel) becomes the public connector URL. */
  publicUrl: string;
};

/** Registers the connector routes (MCP, OAuth, Settings API) and GroupCart's core tools. Call once at startup. */
export function setupConnector(options: ConnectorOptions): void {
  if (state) throw new Error("setupConnector() was already called.");
  const current: ConnectorState = {
    tokens: new ConnectorTokens(options.store.database),
    oauth: new ConnectorOAuth(options.store.database, options.store, options.publicUrl),
    store: options.store,
    port: options.port,
    publicUrl: options.publicUrl,
    demoMode: options.demoMode,
  };
  state = current;
  registerCoreTools(options);
  registerRoute(async (request, response, url) => {
    if (isConnectorPath(url.pathname)) {
      const pathToken = url.pathname.match(/^\/mcp\/t\/([^/]+)\/?$/)?.[1];
      await handleMcp(request, response, pathToken, current);
      return true;
    }
    if (url.pathname.startsWith("/.well-known/oauth-") || url.pathname.startsWith("/oauth/")) {
      return current.oauth.handle(request, response, url);
    }
    if (url.pathname === "/api/connector" || url.pathname.startsWith("/api/connector/")) {
      await handleSettingsApi(request, response, url, current);
      return true;
    }
    return false;
  });
  const base = publicBase(options.publicUrl);
  console.log(`AI assistant connector: http://127.0.0.1:${options.port}/mcp${base ? ` (public: ${base}/mcp)` : ""}. Connect assistants in Settings > AI assistants.`);
}
