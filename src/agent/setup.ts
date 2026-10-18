// Wires the household coordinator into the app: Claude Code turns on the host's Claude account over the
// connector, the coordinator's tools and card handler, follow-ups, and the Settings switch (/api/coordinator,
// local only). index.ts routes group messages to it while a roommate has it connected.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isLocalRequest, isSameOriginMutation, readJsonBody } from "../auth.js";
import type { ChatService } from "../chat.js";
import { issueTurnToken } from "../connector.js";
import { sendJson } from "../connectorSecurity.js";
import type { KrogerClient } from "../kroger.js";
import { postCard, postMessage, registerCardHandler, registerRoute, registerTools, scheduleEvery, type CommandContext } from "../platform.js";
import type { CartStore } from "../store.js";
import { coordinatorSettingsCard } from "../ui/coordinatorCard.js";
import type { IntegrationCard } from "../ui/settingsPage.js";
import { runClaudeCode } from "./claudeCode.js";
import { COORDINATOR_NAME, HouseholdCoordinator, type CoordinatorChannel } from "./coordinator.js";
import { findGroceries } from "./groceries.js";
import { CARD_OWNER, coordinatorTools } from "./tools.js";

/** A turn token outlives the Claude Code run that uses it (runs time out at 4 minutes). */
const TURN_TOKEN_TTL_MS = 5 * 60_000;
const FOLLOW_UP_INTERVAL_MS = 60_000;

let settingsCard: (() => IntegrationCard) | null = null;

/** The Settings card, once setupCoordinator has run. */
export function coordinatorCard(): IntegrationCard | null {
  return settingsCard?.() ?? null;
}

export function setupCoordinator(options: {
  store: CartStore;
  chat: ChatService;
  kroger: KrogerClient | null;
  port: number;
  /** GroupCart's built-in command handling for one member's text, returning its reply. */
  runCommand: (message: CommandContext) => Promise<string | null>;
}): HouseholdCoordinator {
  const { store, chat, kroger } = options;
  const groceriesFrom = kroger ? "kroger" as const : "sample" as const;
  const channel: CoordinatorChannel = {
    post: (text, card) => card ? postCard(text, card, { author: COORDINATOR_NAME }) : postMessage(text, { author: COORDINATOR_NAME }),
    updateCard: (messageId, card) => { chat.updateCard(messageId, card); },
    findCard: (cardId) => {
      const message = chat.findByCardId(cardId);
      return message?.card ? { messageId: message.id, card: message.card } : null;
    },
    recent: (limit) => chat.list({ limit }).messages,
  };
  const coordinator = new HouseholdCoordinator({
    runTurn: async ({ prompt, systemPrompt, memberId, disallowedTools }) => {
      const { token, revoke } = issueTurnToken(memberId, TURN_TOKEN_TTL_MS);
      try {
        return await runClaudeCode({ prompt, systemPrompt, token, disallowedTools, mcpUrl: `http://127.0.0.1:${options.port}/mcp` });
      } finally {
        revoke();
      }
    },
    db: store.database,
    members: () => store.getMembers(),
    channel,
    groceriesFrom,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });

  registerTools(coordinatorTools({
    coordinator,
    channel,
    findGroceries: (query, limit) => findGroceries(query, kroger, limit),
    groceriesFrom,
    runCommand: (memberId, text) => {
      const member = store.getMembers().find((candidate) => candidate.id === memberId);
      return member ? options.runCommand({ messageId: `coordinator:${randomUUID()}`, memberId, memberName: member.name, text, attachments: [] }) : Promise.resolve(null);
    },
    photos: async (messageId) => {
      const message = chat.get(messageId);
      const photos: Array<{ mimeType: string; data: Buffer }> = [];
      for (const attachment of message?.attachments ?? []) {
        const file = attachment.image && attachment.url ? chat.filePath(attachment.url.split("/").pop() ?? "") : null;
        if (file) photos.push({ mimeType: attachment.mimeType, data: await readFile(file) });
      }
      return photos;
    },
  }));
  registerCardHandler(CARD_OWNER, (input) => coordinator.handleCardAction(input));
  scheduleEvery("coordinator-follow-ups", FOLLOW_UP_INTERVAL_MS, () => coordinator.runDueFollowUps());

  // Settings switch. Connecting it spends the host's Claude usage, so only the computer running GroupCart may.
  registerRoute(async (request, response, url) => {
    if (url.pathname !== "/api/coordinator") return false;
    if (!isLocalRequest(request)) { sendJson(response, 403, { error: "Connect the coordinator on the computer running GroupCart." }); return true; }
    if (request.method === "GET") { sendJson(response, 200, coordinator.status()); return true; }
    if (request.method !== "POST" || !isSameOriginMutation(request)) { sendJson(response, 405, { error: "POST JSON from the GroupCart page." }); return true; }
    const body = await readJsonBody(request, 1_024);
    try {
      sendJson(response, 200, typeof body.connect === "string" ? coordinator.connect(body.connect) : body.disconnect === true ? coordinator.disconnect() : coordinator.status());
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Couldn't update the coordinator." });
    }
    return true;
  });
  settingsCard = () => coordinatorSettingsCard({ status: coordinator.status(), members: store.getMembers() });
  return coordinator;
}
