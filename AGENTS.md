# GroupCart agent instructions

This repository implements GroupCart using Photon Spectrum (`spectrum-ts`) and the cloud iMessage provider. Group messaging requires the project's dedicated Business line.

## Project structure

- `src/index.ts`: Spectrum startup, group-message filtering, household mapping, and replies.
- `src/store.ts`: SQLite persistence, cart revisions, deterministic splits, approvals, and Kroger cart checkout.
- `src/cart.ts`: sample catalog and deterministic item/quantity extraction.
- `src/dashboard.ts`: HTTP server (127.0.0.1 unless `GROUP_CART_HOST` is set; remote requests pass `remoteAccessGuard` first): page routes, JSON API, and local demo endpoints.
- `src/ui/shell.ts`: shared UI shell (design tokens, icons, components, `renderPage`). Build every browser page on it; see the comment block at the top.
- `src/ui/*Page.ts`, `src/ui/placeholders.ts`: Home (`/`), Groceries (`/groceries`), Settings (`/settings`), and placeholder Chores/Bills/Calendar pages.
- `src/config.ts`: environment configuration, member allowlist parsing, and handle normalization/masking.
- `src/googleCalendar.ts`: per-member Google OAuth (free/busy scope only), freeBusy API, and the calendar service used by `/calendar` and the `calendar` command; `src/calendarPage.ts`: the `/calendar` page and its routes; `src/availability.ts`: pure overlap/free-time math (`src/availability.test.ts`); `src/calendarDemo.ts`: deterministic sample schedules when Google is not configured.
- `src/membership.ts`: group join/leave events and roster checks against the allowlist.
- `src/connector.ts`: Claude connector, a stateless MCP server at `/mcp` (Streamable HTTP, official SDK) exposing every tool in `listTools()`, with per-member connector tokens (SHA-256 hashes in `connector_tokens`) and the `/api/connector/*` Settings API; `src/coreTools.ts`: core connector tools and `registerSummaryProvider` for `whats_on_my_plate`; `src/ui/connectorCard.ts`: the Settings "Claude" card; `src/remoteAccess.ts`: `isRemoteRequest` and the remote-access guard; `src/connector.test.ts`: end-to-end tests.
- `src/chores.ts`: chores (fair rotation, away status, history, group commands, nudges, `/chores` + `/api/chores*`, connector tools), wired by `setupChores()`; `src/choresLogic.ts`: pure schedule/rotation/parser logic; `src/ui/choresPage.ts`: the page and Home "Chores due" card.
- `src/profilesAndChat.ts`: one `setupProfilesAndChat(...)` call wires profiles, web sign-in, and the web chat (routes, connector tools, demo seed). `src/profiles.ts`: member profiles (`registerProfileSection` lets features add cards to `/people/<id>`; `avatarFor`, `referTo`). `src/auth.ts`: local-vs-remote detection, the remote access guard, one-time iMessage codes, and session cookies. `src/chat.ts`: the household conversation mirrored into `chat_messages` for `/chat`. Pages: `src/ui/profilePage.ts` (`/people`, `/people/<id>`), `src/ui/chatPage.ts` (`/chat`, Home chat card), `src/ui/signinPage.ts` (`/signin`), `src/ui/accountMenu.ts` (app-bar account menu).
- `processMemberMessage` in `src/index.ts` is the single path for a member's message (feature commands, then the cart). The iMessage loop and the web chat both call it; keep it that way.

## Environment and credentials

`.env` is gitignored and contains credentials. **Do not read, write, print, or otherwise expose `.env`.** Use `.env.example` only for the variable names and placeholder formats. Never include credentials in source, logs, screenshots, or user-facing output.

Spectrum Cloud uses `PROJECT_ID` and `PROJECT_SECRET`. `GROUP_CART_MEMBERS` is an explicit `handle=name` allowlist (`handle1|handle2=name` maps several handles to one member; compare handles only via `normalizeHandle`). In live mode, only inbound text from these members in iMessage group spaces is handled. Do not remove the allowlist or start processing direct messages unless the product requirements change. GroupCart sends a 1:1 DM only to deliver a sign-in code that member just requested on `/signin`; inbound DMs are still ignored.

## Safety and product boundaries

- Network access is opt-in. The dashboard binds to `127.0.0.1` unless `GROUP_CART_HOST` is set (for example `0.0.0.0` to serve the LAN); only set it when the user explicitly asks for network access. A tunnel (`GROUP_CART_PUBLIC_URL`) is also opt-in.
- Every remote request (LAN address, proxy, or tunnel: `isRemoteRequest` in `src/remoteAccess.ts`, which `isLocalRequest` in `src/auth.ts` reuses) needs a signed-in session (one-time iMessage code) or a connector token. Without one it may reach only `/signin*`, `/api/auth/*`, and the connector's `/mcp` paths. `remoteAccessGuard` stays the first statement of the dashboard request handler. Never weaken it, never trust a Host or forwarded header as proof of a local request, and keep host-only actions (the "Viewing as" switch, connector token management `/api/connector/*`) checking for a local request.
- Store only hashes of connector tokens, sign-in codes, and session tokens. Show a connector token once, at creation; never log, display, or return secrets (logs pass through `redactTokens`; demo mode shows the sign-in code on screen because nothing is sent). A tool call runs as the token's member and nobody else. Connector tools must not check out, place orders, or send real payments.
- Web messages are posted to the group with the sender's name ("Maya: …"), and connector messages as "Maya (via Claude): …"; never post as someone else.
- Browser approval and checkout controls are local-demo-only. In live mode, checkout must come through an allowlisted group member's Spectrum conversation. Approvals come from the group chat, or from that member's own authenticated Claude connector (`approve_cart`, which also announces the approval to the group).
- Local demo checkout is simulated. Live checkout may add approved items to the selected member's Kroger cart after OAuth consent; it must never place an order or collect payment.
- Label sample prices as estimates and Kroger prices as store-specific quotes. Availability checks are point-in-time and do not guarantee pickup stock.
- Ignore outbound messages to prevent echo loops; keep processing idempotent by Spectrum message ID.
- Keep `.env` out of git.

## Commands

- `npm run start` — run with `.env` loaded, or local demo mode if credentials are absent.
- `npm run dev` — watch-mode startup with `.env` loaded.
- `npm run typecheck` — TypeScript validation.

Follow the repository's `.agents/skills/spectrum` instructions for SDK and provider behavior. In particular, cloud iMessage group features require the dedicated line; do not use the local provider for this group workflow.
