import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { CartStore, type CartSnapshot } from "./store.js";
import { KrogerClient } from "./kroger.js";
import { splitwiseDashboardView } from "./splitwise.js";
import { handleCalendarRequest } from "./calendarPage.js";
import type { CalendarService } from "./googleCalendar.js";
import { renderCartPage } from "./ui/cartPage.js";
import { renderHomePage } from "./ui/homePage.js";
import { renderBillsPlaceholder, renderCalendarPlaceholder, renderChoresPlaceholder } from "./ui/placeholders.js";
import { renderSettingsPage } from "./ui/settingsPage.js";
import { renderNotice } from "./ui/shell.js";
import { recentFeed, runCommands, runRoutes } from "./platform.js";
import { blockRemoteRequest } from "./remoteAccess.js"; // Remote access guard (Claude connector)


function safeSnapshot(snapshot: CartSnapshot): Omit<CartSnapshot, "members"> & {
  members: Array<Omit<CartSnapshot["members"][number], "handle">>;
} {
  const { members, ...rest } = snapshot;
  return { ...rest, members: members.map(({ handle: _handle, ...member }) => member) };
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 8_192) reject(new Error("Request body is too large."));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) as Record<string, unknown> : {}); }
      catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}

function sendHtml(response: import("node:http").ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

function sendJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function krogerCheckoutStatus(store: CartStore): { status: string; revision: number; selectedMemberId: string | null } | null {
  const pending = store.pendingKrogerCheckout();
  return pending ? { status: pending.status, revision: pending.revision, selectedMemberId: pending.selectedMemberId } : null;
}

export function startDashboard(store: CartStore, port: number, demoMode: boolean, krogerClient?: KrogerClient, calendar?: CalendarService): Server {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // --- Remote access guard (Claude connector): tunnel/LAN requests reach only /mcp, sign-in, or authorized routes ---
    if (blockRemoteRequest(request, response, url)) return;
    // --- end remote access guard ---
    // Google Calendar: /calendar page, /api/calendar, and /api/google/* OAuth routes.
    if (calendar && await handleCalendarRequest(calendar, request, response, url)) return;
    // Feature routes registered through src/platform.ts (chores, lists, events, bills, connector).
    if (await runRoutes(request, response, url)) return;
    if (request.method === "GET" && url.pathname === "/api/feed") return sendJson(response, 200, { entries: recentFeed() });
    if (request.method === "GET" && url.pathname === "/api/kroger/oauth/start") {
      if (!krogerClient) return sendJson(response, 503, { error: "Kroger credentials are not configured." });
      const memberId = url.searchParams.get("memberId");
      const pending = store.pendingKrogerCheckout();
      if (!memberId || !pending || pending.status !== "awaiting_oauth" || pending.selectedMemberId !== memberId) {
        return sendJson(response, 409, { error: "No matching approved Kroger checkout is waiting for sign-in. Start checkout in the iMessage group first." });
      }
      const authorization = krogerClient.createUserAuthorization(memberId);
      response.writeHead(302, { location: authorization.url, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/kroger/oauth/callback") {
      if (!krogerClient) return sendJson(response, 503, { error: "Kroger credentials are not configured." });
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (url.searchParams.has("error")) {
        sendHtml(response, 200, renderNotice({
          title: "Kroger sign-in cancelled",
          message: "Kroger sign-in was cancelled. GroupCart was not changed. Return to the iMessage group to retry or text “cancel checkout”.",
          tone: "warning",
          links: [{ href: "/groceries", label: "Back to groceries" }],
        }));
        return;
      }
      if (!code || !state) return sendJson(response, 400, { error: "Kroger did not return a sign-in code. Return to the group and start checkout again." });
      try {
        const authorization = await krogerClient.completeUserAuthorization(code, state);
        const result = await store.completeKrogerCartCheckout(
          authorization.memberId,
          (items) => krogerClient.addItemsToCart(authorization.accessToken, items),
        );
        sendHtml(response, result.ok ? 200 : 409, renderNotice({
          title: result.ok ? "Kroger cart ready" : "Checkout needs attention",
          message: result.message,
          tone: result.ok ? "success" : "warning",
          links: [{ href: "https://www.kroger.com", label: "Open Kroger", external: true }, { href: "/groceries", label: "Back to groceries" }],
        }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Kroger sign-in failed.";
        sendHtml(response, 400, renderNotice({
          title: "Kroger sign-in did not finish",
          message: `${detail} Return to the iMessage group to try again. GroupCart has not cleared the approved list.`,
          tone: "danger",
          links: [{ href: "/groceries", label: "Back to groceries" }],
        }));
      }
      return;
    }
    // Browser pages (all rendered through src/ui/shell.ts).
    if (request.method === "GET" && url.pathname === "/") return sendHtml(response, 200, renderHomePage());
    if (request.method === "GET" && url.pathname === "/groceries") return sendHtml(response, 200, renderCartPage());
    if (request.method === "GET" && url.pathname === "/chores") return sendHtml(response, 200, renderChoresPlaceholder());
    if (request.method === "GET" && url.pathname === "/bills") return sendHtml(response, 200, renderBillsPlaceholder());
    if (request.method === "GET" && url.pathname === "/calendar") return sendHtml(response, 200, renderCalendarPlaceholder());
    if (request.method === "GET" && url.pathname === "/expenses") {
      response.writeHead(302, { location: "/bills", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/settings") {
      const snapshot = safeSnapshot(store.snapshot());
      const pending = store.pendingKrogerCheckout();
      return sendHtml(response, 200, renderSettingsPage({
        demoMode,
        householdId: snapshot.householdId,
        members: snapshot.members.map(({ id, name }) => ({ id, name })),
        kroger: {
          configured: Boolean(krogerClient),
          locationConfigured: Boolean(krogerClient?.hasLocation),
          checkout: pending ? { status: pending.status, selectedMemberId: pending.selectedMemberId } : null,
        },
      }));
    }
    if (request.method === "GET" && url.pathname === "/api/cart") {
      sendJson(response, 200, {
        ...safeSnapshot(store.snapshot()),
        demoMode,
        krogerConfigured: Boolean(krogerClient),
        krogerLocationConfigured: Boolean(krogerClient?.hasLocation),
        krogerCheckout: krogerCheckoutStatus(store),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/splitwise") {
      // Splitwise status of the latest checkout (names and amounts only).
      return sendJson(response, 200, splitwiseDashboardView(store.latestSplitwiseExpense()));
    }
    if (request.method === "GET" && url.pathname === "/api/kroger/products") {
      if (!krogerClient) return sendJson(response, 503, { error: "Kroger API credentials are not configured in .env." });
      try {
        const result = await krogerClient.searchProducts(url.searchParams.get("q") ?? "");
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 502, { error: error instanceof Error ? error.message : "Kroger search failed." });
      }
    }
    if (request.method !== "POST") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }

    try {
      const body = await readJson(request);
      if (!demoMode && (url.pathname === "/api/approve" || url.pathname === "/api/checkout")) {
        return sendJson(response, 403, { error: "In live mode, approve and checkout by messaging GroupCart from your configured Spectrum group." });
      }
      if (url.pathname === "/api/demo-message") {
        if (!demoMode) return sendJson(response, 403, { error: "Demo messages are disabled while Spectrum is connected." });
        if (typeof body.memberId !== "string" || typeof body.text !== "string" || !body.text.trim()) {
          return sendJson(response, 400, { error: "Choose a member and enter a message." });
        }
        const member = store.getMembers().find((candidate) => candidate.id === body.memberId);
        if (!member) return sendJson(response, 404, { error: "Member not found." });
        // Feature commands (calendar, chores, bills, ...) run before cart processing, as in the group chat.
        const commandReply = await runCommands({ messageId: `demo:${randomUUID()}`, memberId: member.id, memberName: member.name, text: body.text, attachments: [] });
        if (commandReply) return sendJson(response, 200, { message: commandReply });
      const reply = krogerClient
        ? await store.processLiveIncomingText(
          `demo:${randomUUID()}`,
          member.id,
          body.text,
          (query) => krogerClient.searchProducts(query),
          krogerClient.selectedLocationId,
        )
        : store.processIncomingText(`demo:${randomUUID()}`, member.id, body.text);
        return sendJson(response, 200, { message: reply ?? "No response." });
      }
      if (url.pathname === "/api/approve") {
        if (typeof body.memberId !== "string") return sendJson(response, 400, { error: "Choose a member." });
        const result = store.approveForMember(body.memberId);
        return sendJson(response, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/checkout") {
        const result = store.completeMockCheckout(typeof body.memberId === "string" ? body.memberId : undefined);
        return sendJson(response, result.ok ? 200 : 400, result);
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Request failed." });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`GroupCart dashboard available at http://127.0.0.1:${port}`);
  });
  return server;
}
