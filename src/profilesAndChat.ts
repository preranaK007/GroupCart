// Profiles, web sign-in, and the web group chat: one setup call from index.ts wires the services, the routes
// (via registerRoute), the remote-access authorizer, connector tools, and the demo seed data.
//
// Routes:
//   pages    GET /people, /people/<id>, /chat, /signin
//   auth     POST /api/auth/start | verify | signout | view-as (host only), GET /api/auth/me
//   profile  GET /api/people, /api/people/<id>; POST /api/profile; POST|DELETE /api/profile/avatar (raw image body)
//   chat     GET /api/chat/messages?after=|before=|limit=|updatedSince=; POST /api/chat/messages (JSON {text} or raw
//            image body with x-gc-text / x-gc-filename headers); POST /api/chat/cards {messageId, actionId?, optionIds?}
//            (a tap on a card); demo POST /api/demo-message is also mirrored into the chat
//   files    GET /avatars/<file>, /chat/files/<file>
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import type { Space } from "spectrum-ts";
import type { HouseholdGroup } from "./householdGroup.js";
import {
  AuthService, HttpError, clientKey, isLocalRequest, isSameOriginMutation, readJsonBody, readRawBody, redirect,
  safeNextPath, sendHtml, sendJson, type DirectSender,
} from "./auth.js";
import { activeCoordinatorName } from "./agent/setup.js";
import { ChatError, ChatService, spectrumChannel, type InboundAttachment, type MemberMessageProcessor } from "./chat.js";
import { money } from "./cart.js";
import { cardText, onGroupNotify, registerHelp, registerRoute, registerTools, setCardSink, setRemoteAuthorizer, setRequestMemberResolver, type CommandAttachment } from "./platform.js";
import { IMAGE_MIME_BY_EXT, ProfileService, profileSections, pronounSet, registerProfileSection, type Profile, type ProfilePatch } from "./profiles.js";
import type { CartStore, MemberConfig } from "./store.js";
import { chatPreviewCard, renderChatPage } from "./ui/chatPage.js";
import { renderPeoplePage, renderProfilePage } from "./ui/profilePage.js";
import { escapeHtml, renderNotice, setAvatarDirectory } from "./ui/shell.js";
import { renderSignInPage } from "./ui/signinPage.js";

export { chatPreviewCard };

export type ProfilesAndChatOptions = {
  store: CartStore;
  /** Allowlist entries (with alias handles) so /signin can match any of a member's handles. */
  memberConfigs: MemberConfig[];
  liveMode: boolean;
  databasePath: string;
  publicUrl: string;
  /** The shared member-message processor from index.ts (feature commands, then the cart). */
  processMessage: MemberMessageProcessor;
};

export type ProfilesAndChat = {
  auth: AuthService;
  profiles: ProfileService;
  chat: ChatService;
  /** Live loop: record an inbound member message; returns its attachments for command handlers. */
  recordInbound(input: { messageId: string; memberId: string; memberName: string; text: string; attachments: InboundAttachment[]; at?: Date }): CommandAttachment[];
  /** Live loop: send GroupCart's reply into the group (typing indicator) and record it. */
  replyInGroup(space: Space, text: string): Promise<void>;
  /** Live mode: enable sign-in codes by iMessage DM and relay web chat messages to the persisted household group. */
  useSpectrum(options: { sendDirect: DirectSender; group: HouseholdGroup }): void;
};

function householdName(id: string): string {
  return id.split(/[-_\s]+/).filter(Boolean).map((word) => /\d/.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || "Household";
}

function profileView(profile: Profile) {
  return {
    id: profile.memberId,
    name: profile.displayName,
    ...(profile.avatar.kind === "photo" && profile.avatar.url ? { avatarUrl: profile.avatar.url } : {}),
    ...(profile.avatar.kind === "emoji" && profile.avatar.emoji ? { avatarEmoji: profile.avatar.emoji } : {}),
  };
}

function profileJson(profile: Profile) {
  return {
    id: profile.memberId,
    name: profile.name,
    displayName: profile.displayName,
    pronouns: profile.pronouns,
    bio: profile.bio,
    dietary: profile.dietary,
    snacks: profile.snacks,
    genres: profile.genres,
    birthday: profile.birthday,
    paymentHandle: profile.paymentHandle,
    avatar: profile.avatar,
  };
}

function patchFrom(body: Record<string, unknown>): ProfilePatch {
  const patch: ProfilePatch = {};
  for (const key of ["displayName", "pronouns", "bio", "dietary", "snacks", "genres", "birthday", "paymentHandle", "avatarEmoji"] as const) {
    if (typeof body[key] === "string") patch[key] = body[key] as string;
  }
  if (body.avatarKind === "initial" || body.avatarKind === "emoji" || body.avatarKind === "photo") patch.avatarKind = body.avatarKind;
  return patch;
}

function decodePart(value: string): string {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function sendFile(response: ServerResponse, path: string): void {
  const mime = IMAGE_MIME_BY_EXT[extname(path).slice(1)] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": mime,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  });
  createReadStream(path).on("error", () => response.destroy()).pipe(response);
}

export function setupProfilesAndChat(options: ProfilesAndChatOptions): ProfilesAndChat {
  const { store, liveMode } = options;
  const db = store.database;
  const dataDir = dirname(resolve(options.databasePath));
  const members = () => store.getMembers();
  const household = householdName(store.household);

  const auth = new AuthService({ db, members, memberConfigs: options.memberConfigs, demoMode: !liveMode, secureCookies: options.publicUrl.startsWith("https://") });
  const profiles = new ProfileService({ db, members, avatarDir: join(dataDir, "avatars") });
  const chat = new ChatService({
    db,
    filesDir: join(dataDir, "chat-files"),
    liveMode,
    members,
    displayName: (id) => profiles.get(id)?.displayName,
    process: options.processMessage,
  });

  setAvatarDirectory(() => profiles.directory());
  // Signed-in roommates may use every page and API from their own devices (the guard covers everything else).
  setRemoteAuthorizer((request) => auth.sessionMember(request) !== null);
  // The connector's OAuth consent page acts as the signed-in (or "Viewing as") member instead of asking for a pairing code.
  setRequestMemberResolver((request) => { const viewer = auth.viewer(request); return viewer ? { memberId: viewer.member.id } : null; });
  // notifyGroup() (chore nudges, reminders, ...) also lands in the web chat.
  onGroupNotify((text) => { chat.recordBot(text, "notify"); });
  // postCard() / refreshCard(): bot messages with polls and buttons.
  setCardSink({
    record: (text, card, author) => chat.recordBot(text, "notify", undefined, card, { author }),
    recordText: (text, author) => chat.recordBot(text, "notify", undefined, undefined, { author }),
    refresh: (card) => { const message = chat.findByCardId(card.id); return message ? chat.updateCard(message.id, card) : null; },
  });
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(options.publicUrl)) {
    registerHelp(`Web: ${options.publicUrl}/chat shows this chat, profiles, and the calendar. On your own phone or laptop, sign in with your number.`);
  }

  // Built-in profile section: this member's groceries.
  registerProfileSection(({ memberId }) => {
    const snapshot = store.snapshot();
    const items = snapshot.items.filter((item) => item.participantIds.includes(memberId));
    const share = snapshot.members.find((member) => member.id === memberId)?.shareCents ?? 0;
    const rows = items.slice(0, 4).map((item) => `<li class="gc-list-item"><div class="gc-list-main"><div class="gc-list-title">${escapeHtml(item.name)}</div>${item.participantIds.length > 1 ? `<div class="gc-list-sub">Shared · ${escapeHtml(item.participantNames.join(", "))}</div>` : ""}</div><span class="gc-amount">${escapeHtml(money(item.totalCents))}</span></li>`).join("");
    return {
      title: "Groceries",
      icon: "cart",
      href: "/groceries",
      order: 10,
      html: items.length
        ? `<div class="gc-row" style="justify-content:space-between"><span class="gc-meta">${items.length} ${items.length === 1 ? "item" : "items"} in the cart</span><span class="gc-amount">${escapeHtml(money(share))} share</span></div><ul class="gc-list">${rows}</ul>${items.length > 4 ? `<p class="gc-meta">+${items.length - 4} more</p>` : ""}`
        : `<p class="gc-meta">Nothing in the cart right now.</p>`,
    };
  });

  function viewerOr401(request: IncomingMessage, response: ServerResponse) {
    const viewer = auth.viewer(request);
    if (!viewer) sendJson(response, 401, { error: "Sign in to GroupCart first.", signIn: "/signin" });
    return viewer;
  }

  function requireMutation(request: IncomingMessage): void {
    if (!isSameOriginMutation(request)) throw new HttpError(403, "This request must come from the GroupCart page.");
  }

  function chatState(viewerId: string) {
    const all = profiles.list();
    const me = all.find((profile) => profile.memberId === viewerId);
    return {
      me: me ? profileView(me) : null,
      household: all.map(profileView),
      householdName: household,
      live: liveMode,
      groupConnected: !liveMode || chat.groupConnected,
      typing: chat.typing,
      /** The household coordinator answering the group, if one is connected (the composer's suggestions ask it). */
      assistant: activeCoordinatorName(),
    };
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const method = request.method ?? "GET";

    // --- Sign-in ---
    if (path === "/signin" && method === "GET") {
      const next = safeNextPath(url.searchParams.get("next"));
      if (auth.viewer(request)) { redirect(response, next); return true; }
      // Demo codes appear on screen, so only the host computer may use them; everyone else needs an invite link.
      const codesHere = auth.canSendCodes && (!auth.demoMode || isLocalRequest(request));
      sendHtml(response, 200, renderSignInPage({ demoMode: auth.demoMode && codesHere, canSendCodes: codesHere, next }), { "x-frame-options": "DENY" });
      return true;
    }
    if (path === "/api/auth/me" && method === "GET") {
      const viewer = auth.viewer(request);
      const local = isLocalRequest(request);
      const all = viewer ? profiles.list() : [];
      const me = viewer ? all.find((profile) => profile.memberId === viewer.member.id) : undefined;
      sendJson(response, 200, {
        signedIn: Boolean(viewer),
        via: viewer?.via ?? null,
        local,
        demoMode: !liveMode,
        canSendCodes: auth.canSendCodes,
        member: me ? profileView(me) : null,
        householdIds: viewer ? all.map((profile) => profile.memberId) : [],
        members: viewer && local ? all.map(profileView) : undefined,
      });
      return true;
    }
    if (path.startsWith("/signin/invite/") && method === "GET") {
      const result = auth.redeemInvite(path.slice("/signin/invite/".length), clientKey(request), request.headers["user-agent"]);
      if (!result.ok) {
        sendHtml(response, result.status, renderNotice({ title: "Invite link didn’t work", message: result.error, tone: "warning" }), { "x-frame-options": "DENY" });
        return true;
      }
      response.writeHead(303, { location: "/", "set-cookie": auth.sessionCookie(result.token, request), "cache-control": "no-store" });
      response.end();
      return true;
    }
    if (path === "/api/auth/invite" && method === "POST") {
      requireMutation(request);
      if (!isLocalRequest(request)) { sendJson(response, 403, { error: "Make invite links on the computer running GroupCart." }); return true; }
      const body = await readJsonBody(request, 1_024);
      const invite = auth.createInvite(String(body.memberId ?? ""));
      sendJson(response, 200, { url: `${options.publicUrl}/signin/invite/${invite.token}`, expiresAt: invite.expiresAt });
      return true;
    }
    if (path === "/api/auth/start" && method === "POST") {
      requireMutation(request);
      if (auth.demoMode && !isLocalRequest(request)) { sendJson(response, 403, { error: "Use the invite link from your household’s host to sign in." }); return true; }
      const body = await readJsonBody(request, 2_048);
      const result = await auth.startSignIn(typeof body.handle === "string" ? body.handle : "", clientKey(request));
      if (!result.ok) {
        sendJson(response, result.status, { error: result.error, hostOnly: result.hostOnly ?? false }, result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {});
        return true;
      }
      sendJson(response, 200, result);
      return true;
    }
    if (path === "/api/auth/verify" && method === "POST") {
      requireMutation(request);
      const body = await readJsonBody(request, 2_048);
      const result = auth.verifyCode(String(body.challengeId ?? ""), String(body.code ?? ""), clientKey(request), request.headers["user-agent"]);
      if (!result.ok) {
        sendJson(response, result.status, { error: result.error }, result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {});
        return true;
      }
      const profile = profiles.get(result.member.id);
      sendJson(response, 200, { ok: true, member: profile ? profileView(profile) : { id: result.member.id, name: result.member.name } }, { "set-cookie": auth.sessionCookie(result.token, request) });
      return true;
    }
    if (path === "/api/auth/signout" && method === "POST") {
      requireMutation(request);
      auth.signOut(request);
      sendJson(response, 200, { ok: true }, { "set-cookie": auth.clearSessionCookie(request) });
      return true;
    }
    if (path === "/api/auth/view-as" && method === "POST") {
      requireMutation(request);
      if (!isLocalRequest(request)) { sendJson(response, 403, { error: "Switching members works only on the computer running GroupCart." }); return true; }
      const body = await readJsonBody(request, 1_024);
      const member = members().find((candidate) => candidate.id === body.memberId);
      if (!member) { sendJson(response, 404, { error: "Member not found." }); return true; }
      sendJson(response, 200, { ok: true }, { "set-cookie": auth.viewAsCookie(member.id) });
      return true;
    }

    // --- Pages ---
    if (method === "GET" && path === "/people") {
      const viewer = auth.viewer(request);
      sendHtml(response, 200, renderPeoplePage({ profiles: profiles.list(), viewerId: viewer?.member.id ?? null, householdName: household, canInvite: isLocalRequest(request) }));
      return true;
    }
    const personPage = method === "GET" ? /^\/people\/([^/]+)$/.exec(path) : null;
    if (personPage) {
      const viewer = auth.viewer(request);
      const profile = profiles.get(decodePart(personPage[1]!));
      if (!profile) {
        sendHtml(response, 404, renderNotice({ title: "Not found", message: "There’s no one with that profile in this household.", active: "people", links: [{ href: "/people", label: "Household" }] }));
        return true;
      }
      const isSelf = viewer?.member.id === profile.memberId;
      const sections = await profileSections({ memberId: profile.memberId, memberName: profile.name, viewerId: viewer?.member.id ?? null, isSelf });
      sendHtml(response, 200, renderProfilePage({ profile, householdIds: members().map((member) => member.id), isSelf, sections }));
      return true;
    }
    if (method === "GET" && path === "/chat") {
      sendHtml(response, 200, renderChatPage());
      return true;
    }

    // --- Files ---
    if (method === "GET" && path.startsWith("/avatars/")) {
      const file = profiles.avatarPath(decodePart(path.slice("/avatars/".length)));
      if (!file) { sendJson(response, 404, { error: "Not found." }); return true; }
      sendFile(response, file);
      return true;
    }
    if (method === "GET" && path.startsWith("/chat/files/")) {
      const file = chat.filePath(decodePart(path.slice("/chat/files/".length)));
      if (!file) { sendJson(response, 404, { error: "Not found." }); return true; }
      sendFile(response, file);
      return true;
    }

    // --- Profiles API ---
    if (method === "GET" && path === "/api/people") {
      if (!viewerOr401(request, response)) return true;
      sendJson(response, 200, { people: profiles.list().map(profileJson) });
      return true;
    }
    const personApi = method === "GET" ? /^\/api\/people\/([^/]+)$/.exec(path) : null;
    if (personApi) {
      if (!viewerOr401(request, response)) return true;
      const profile = profiles.get(decodePart(personApi[1]!));
      if (!profile) { sendJson(response, 404, { error: "Member not found." }); return true; }
      sendJson(response, 200, { profile: profileJson(profile) });
      return true;
    }
    if (path === "/api/profile" && method === "POST") {
      requireMutation(request);
      const viewer = viewerOr401(request, response);
      if (!viewer) return true;
      const result = profiles.update(viewer.member.id, patchFrom(await readJsonBody(request)));
      sendJson(response, result.ok ? 200 : 400, result.ok ? { profile: profileJson(result.profile) } : { error: result.error });
      return true;
    }
    if (path === "/api/profile/avatar" && (method === "POST" || method === "DELETE")) {
      requireMutation(request);
      const viewer = viewerOr401(request, response);
      if (!viewer) return true;
      if (method === "DELETE") {
        const profile = profiles.removeAvatarPhoto(viewer.member.id);
        sendJson(response, 200, { profile: profile ? profileJson(profile) : null });
        return true;
      }
      const result = profiles.saveAvatarPhoto(viewer.member.id, await readRawBody(request, 5 * 1024 * 1024));
      sendJson(response, result.ok ? 200 : 415, result.ok ? { profile: profileJson(result.profile) } : { error: result.error });
      return true;
    }

    // --- Chat API ---
    if (path === "/api/chat/messages" && method === "GET") {
      const viewer = viewerOr401(request, response);
      if (!viewer) return true;
      const number = (name: string) => {
        const value = url.searchParams.get(name);
        return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
      };
      // Taken before reading, so a card changed during this request shows up again next time rather than never.
      const serverTime = new Date().toISOString();
      const page = chat.list({ after: number("after"), before: number("before"), limit: number("limit") });
      const since = url.searchParams.get("updatedSince");
      const changed = since && !Number.isNaN(Date.parse(since)) ? chat.changedSince(new Date(since).toISOString()) : [];
      sendJson(response, 200, { ...page, changed, serverTime, ...chatState(viewer.member.id) });
      return true;
    }
    if (path === "/api/chat/messages" && method === "POST") {
      requireMutation(request);
      const viewer = viewerOr401(request, response);
      if (!viewer) return true;
      const type = String(request.headers["content-type"] ?? "").toLowerCase();
      let input: { text: string; image?: Buffer; imageName?: string };
      if (type.startsWith("application/json")) {
        const body = await readJsonBody(request, 16_384);
        input = { text: typeof body.text === "string" ? body.text : "" };
      } else {
        const decode = (value: string | string[] | undefined) => { try { return decodeURIComponent(String(value ?? "")); } catch { return ""; } };
        input = { text: decode(request.headers["x-gc-text"]), image: await readRawBody(request, 15 * 1024 * 1024), imageName: decode(request.headers["x-gc-filename"]) };
      }
      try {
        const result = await chat.send(viewer.member, input, { source: "web", awaitReply: url.searchParams.get("wait") === "1" });
        sendJson(response, 201, result);
      } catch (error) {
        if (error instanceof ChatError) { sendJson(response, error.status, { error: error.message }); return true; }
        throw error;
      }
      return true;
    }
    if (path === "/api/chat/cards" && method === "POST") {
      requireMutation(request);
      const viewer = viewerOr401(request, response);
      if (!viewer) return true;
      const body = await readJsonBody(request, 4_096);
      const messageId = typeof body.messageId === "number" ? body.messageId : Number(body.messageId);
      if (!Number.isSafeInteger(messageId)) { sendJson(response, 400, { error: "Pick a message." }); return true; }
      try {
        const result = await chat.actOnCard(viewer.member, messageId, {
          actionId: typeof body.actionId === "string" ? body.actionId.slice(0, 120) : undefined,
          optionIds: Array.isArray(body.optionIds) ? body.optionIds.filter((id): id is string => typeof id === "string").map((id) => id.slice(0, 120)) : undefined,
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof ChatError) { sendJson(response, error.status, { error: error.message }); return true; }
        throw error;
      }
      return true;
    }
    // Demo: the Groceries page's "Try a request" form goes through the chat too, so it shows up there.
    if (path === "/api/demo-message" && method === "POST" && !liveMode) {
      const body = await readJsonBody(request, 8_192);
      if (typeof body.memberId !== "string" || typeof body.text !== "string" || !body.text.trim()) {
        sendJson(response, 400, { error: "Choose a member and enter a message." });
        return true;
      }
      const member = members().find((candidate) => candidate.id === body.memberId);
      if (!member) { sendJson(response, 404, { error: "Member not found." }); return true; }
      const result = await chat.send(member, { text: body.text }, { source: "web", awaitReply: true });
      sendJson(response, 200, { message: result.reply ?? "No response." });
      return true;
    }
    return false;
  }

  registerRoute(async (request, response, url) => {
    try {
      return await handle(request, response, url);
    } catch (error) {
      if (error instanceof HttpError) { sendJson(response, error.status, { error: error.message }); return true; }
      console.warn("Profiles/chat request failed:", error instanceof Error ? error.message : error);
      sendJson(response, 500, { error: "Something went wrong." });
      return true;
    }
  });

  // --- Connector tools (Claude) ---
  registerTools([
    {
      name: "get_profile",
      description: "Look up a household member's profile: name, pronouns, short bio, dietary notes and allergies, favorite snacks, movie/game genres, birthday, and payment handle. Omit `member` for your own profile.",
      inputSchema: { type: "object", properties: { member: { type: "string", description: "Member name or id. Omit for yourself." } } },
      handler: (args, caller) => {
        const query = typeof args.member === "string" && args.member.trim() ? args.member : caller.memberId;
        const profile = profiles.find(query) ?? profiles.get(query);
        if (!profile) return { error: `No household member matches “${query}”.`, members: profiles.list().map((item) => item.displayName) };
        const pronouns = pronounSet(profile.pronouns);
        return {
          ...profileJson(profile),
          referTo: pronouns.known ? `${profile.displayName} (${profile.pronouns})` : `${profile.displayName} (pronouns not shared: use their name or they/them)`,
        };
      },
    },
    {
      name: "update_my_profile",
      description: "Update your own GroupCart profile. Only the fields you pass change; pass an empty string to clear one. birthday is YYYY-MM-DD or --MM-DD; avatarEmoji sets a single-emoji avatar.",
      mutates: true,
      inputSchema: {
        type: "object",
        properties: {
          displayName: { type: "string" }, pronouns: { type: "string" }, bio: { type: "string" }, dietary: { type: "string", description: "Dietary notes and allergies" },
          snacks: { type: "string" }, genres: { type: "string", description: "Movie and game genres" }, birthday: { type: "string" },
          paymentHandle: { type: "string", description: "Pay-back handles, e.g. \"Venmo @name · Cash App $tag · PayPal.me/name\"" }, avatarEmoji: { type: "string" },
        },
      },
      handler: (args, caller) => {
        const patch = patchFrom(args);
        if (typeof args.avatarEmoji === "string") patch.avatarKind = args.avatarEmoji.trim() ? "emoji" : "initial";
        const result = profiles.update(caller.memberId, patch);
        return result.ok ? { updated: true, profile: profileJson(result.profile) } : { updated: false, error: result.error };
      },
    },
    {
      name: "read_group_chat",
      description: "Read recent messages from the household group chat (the iMessage group, mirrored on the GroupCart website), oldest first, including GroupCart's own replies.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "How many recent messages (default 30)." } } },
      handler: (args) => {
        const limit = typeof args.limit === "number" ? args.limit : 30;
        return {
          messages: chat.list({ limit }).messages.map((message) => ({
            at: message.at,
            from: message.name,
            ...(message.kind === "bot" ? { bot: true } : {}),
            text: message.text,
            ...(message.card ? { card: cardText(message.card) } : {}),
            ...(message.attachments.length ? { attachments: message.attachments.map((item) => item.name) } : {}),
          })),
        };
      },
    },
    {
      name: "send_group_message",
      description: "Send a message to the household group chat as you. It posts to the iMessage group as “Your name (via <assistant>): …” (e.g. “Maya (via Claude)”) and GroupCart handles it like any group message (for example “2 bananas” or “cart”). Returns GroupCart's reply, if any.",
      mutates: true,
      inputSchema: { type: "object", properties: { text: { type: "string", description: "The message." } }, required: ["text"] },
      handler: async (args, caller) => {
        const member = members().find((candidate) => candidate.id === caller.memberId);
        if (!member) return { sent: false, error: "You are not a household member." };
        try {
          const result = await chat.send(member, { text: typeof args.text === "string" ? args.text : "" }, { source: "connector", awaitReply: true, via: caller.via ?? "AI assistant" });
          return { sent: true, reply: result.reply ?? null };
        } catch (error) {
          return { sent: false, error: error instanceof Error ? error.message : "Could not send." };
        }
      },
    },
  ]);

  if (!liveMode) {
    profiles.seedDemo();
    void chat.seedDemo().catch((error) => console.warn("Demo chat seed failed:", error instanceof Error ? error.message : error));
  }

  return {
    auth,
    profiles,
    chat,
    recordInbound(input) {
      return chat.recordInbound(input);
    },
    async replyInGroup(space, text) {
      await chat.replyInGroup(spectrumChannel(space), text);
    },
    useSpectrum({ sendDirect, group }) {
      auth.setDirectSender(sendDirect);
      // One group mechanism: the store remembers the household group (upstream's rememberGroupSpace), and the
      // web chat relays through it, so it works across restarts as soon as the group is known.
      chat.useGroup(group.channel(), () => group.known);
    },
  };
}
