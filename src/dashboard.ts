import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isLocalRequest, remoteAccessGuard, requestViewer } from "./auth.js";
import { avatarFor } from "./profiles.js";
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
import { notifyGroup, recentFeed, runCommands, runRoutes } from "./platform.js";
import { runWithRequestSkin } from "./ui/themes.js";


function safeSnapshot(snapshot: CartSnapshot): Omit<CartSnapshot, "members"> & {
  members: Array<Omit<CartSnapshot["members"][number], "handle">>;
} {
  const { members, ...rest } = snapshot;
  // Profiles: members carry avatarUrl / avatarEmoji when set, so GC.avatar shows photos.
  return { ...rest, members: members.map(({ handle: _handle, ...member }) => ({ ...member, ...avatarFor(member.id) })) };
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

/** Where a member finishes the order GroupCart filled: pick a pickup or delivery time and pay on Kroger. */
const KROGER_CART_URL = "https://www.kroger.com/cart";

function sendHtml(response: import("node:http").ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

function sendJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function krogerCheckoutStatus(store: CartStore): { status: string; revision: number; requesterId: string; selectedMemberId: string | null } | null {
  const pending = store.pendingKrogerCheckout();
  return pending ? { status: pending.status, revision: pending.revision, requesterId: pending.requesterId, selectedMemberId: pending.selectedMemberId } : null;
}

export function startDashboard(store: CartStore, port: number, demoMode: boolean, krogerClient?: KrogerClient, calendar?: CalendarService): Server {
  // runWithRequestSkin: pages render the browser's theme (gc-skin cookie) without a flash.
  const server = createServer((request, response) => runWithRequestSkin(request, async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // --- Remote access guard (profiles & sign-in): LAN/tunnel requests reach only sign-in, /mcp, or a signed-in session's routes ---
    if (remoteAccessGuard(request, response, url)) return;
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
        return sendJson(response, 409, { error: "No matching approved Kroger checkout is waiting for sign-in. Start one with Order with Kroger on Groceries, or text “checkout” in the group." });
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
          message: "Kroger sign-in was cancelled. GroupCart was not changed. Sign in again from Groceries, or cancel the checkout there.",
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
        // The group was told the checkout is underway, so it hears how it ended.
        await notifyGroup(result.message);
        sendHtml(response, result.ok ? 200 : 409, renderNotice({
          title: result.ok ? "Kroger cart ready" : "Checkout needs attention",
          message: result.message,
          tone: result.ok ? "success" : "warning",
          links: [{ href: KROGER_CART_URL, label: "Open Kroger cart", external: true }, { href: "/groceries", label: "Back to groceries" }],
        }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Kroger sign-in failed.";
        sendHtml(response, 400, renderNotice({
          title: "Kroger sign-in did not finish",
          message: `${detail} Sign in again from Groceries. GroupCart has not cleared the approved list.`,
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
      const hostComputer = isLocalRequest(request);
      sendJson(response, 200, {
        ...safeSnapshot(store.snapshot()),
        lists: store.listsSnapshot(),
        demoMode,
        // Who the page acts as (the Groceries buttons approve and order for this member only).
        viewerId: requestViewer(request)?.member.id ?? null,
        krogerConfigured: Boolean(krogerClient),
        krogerLocationConfigured: Boolean(krogerClient?.hasLocation),
        krogerCheckout: krogerCheckoutStatus(store),
        krogerReview: store.krogerReview(),
        krogerLastCart: store.lastKrogerCart(),
        hostComputer,
        // Kroger returns from sign-in to 127.0.0.1, so a browser on another device can't finish it.
        krogerSignInNeedsHost: Boolean(krogerClient?.signInReturnsToHost) && !hostComputer,
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
        // These demo controls act for any member; live mode approves and orders as the signed-in member only.
        return sendJson(response, 403, { error: "In live mode, use Approve and Order with Kroger on Groceries (as yourself), or text the group." });
      }
      if (url.pathname === "/api/demo-message") {
        if (!demoMode) return sendJson(response, 403, { error: "Demo messages are disabled while Spectrum is connected." });
        if (typeof body.memberId !== "string" || typeof body.text !== "string" || !body.text.trim()) {
          return sendJson(response, 400, { error: "Choose a member and enter a message." });
        }
        const member = store.getMembers().find((candidate) => candidate.id === body.memberId);
        if (!member) return sendJson(response, 404, { error: "Member not found." });
        // Normally answered by the web chat route (src/profilesAndChat.ts), which runs the same steps through the
        // shared member-message processor; this is the fallback when that module isn't set up.
        // Feature commands (calendar, chores, bills, ...) run before cart processing, as in the group chat.
        const messageId = `demo:${randomUUID()}`;
        const commandReply = store.ownsMessage(body.text) ? null : await runCommands({ messageId, memberId: member.id, memberName: member.name, text: body.text, attachments: [] });
        const reply = commandReply ?? (krogerClient
          ? await store.processLiveIncomingText(
            messageId,
            member.id,
            body.text,
            (query) => krogerClient.searchProducts(query),
            krogerClient.selectedLocationId,
            false,
            undefined,
            (productId) => krogerClient.getProduct(productId),
          )
          : store.processIncomingText(messageId, member.id, body.text));
        // Demo mode never sends anything on its own; a due recurring-list
        // check-in is shown with the reply and clearly labelled instead.
        const reminder = store.claimDueListReminders();
        const message = reminder ? `${reply ?? "No response."}\n\n[Demo reminder] ${reminder.text}` : reply ?? "No response.";
        return sendJson(response, 200, { message });
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
  }));
  // GROUP_CART_HOST: 127.0.0.1 by default (this computer only). 0.0.0.0 serves the LAN; every remote request
  // then needs a signed-in session (see src/auth.ts) or a connector token.
  const host = process.env.GROUP_CART_HOST?.trim() || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`GroupCart dashboard available at http://127.0.0.1:${port}`);
    if (host !== "127.0.0.1" && host !== "localhost") {
      const lan = Object.values(networkInterfaces()).flat().filter((entry) => entry && entry.family === "IPv4" && !entry.internal).map((entry) => `http://${entry!.address}:${port}`);
      console.log(`Also listening on ${host}${lan.length ? ` (${lan.join(", ")})` : ""}. Other devices must sign in at /signin.`);
    }
  });
  return server;
}
