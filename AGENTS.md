# GroupCart agent instructions

This repository implements GroupCart using Photon Spectrum (`spectrum-ts`) and the cloud iMessage provider. Group messaging requires the project's dedicated Business line.

## Project structure

- `src/index.ts`: Spectrum startup, group-message filtering, household mapping, the recurring-list check-in timer, and replies. `processMemberMessage` is the single path for a member's message (feature commands via `runCommands`, then the cart). The iMessage loop and the web chat both call it; keep it that way.
- `src/store.ts`: `CartStore` facade — the public API used by `index.ts`/`dashboard.ts` and the feature modules (including `database`/`household`, `memberForHandle`/`registerMembers` with handle normalization and aliases, `markMessageProcessed`, `recordedReply`/`recordCommandReply`, Splitwise and Google Calendar persistence), message-ID idempotency, and the order in which commands and pending states are routed to the modules below.
- `src/store/`: the feature modules behind `CartStore`. Each class takes the shared `StoreContext` (database, household settings, reply/member helpers) and the `StoreModules` registry to call the others.
  - `schema.ts` (tables and migrations), `context.ts`, `types.ts`.
  - `parsing.ts` (pure message parsing: commands, price caps, quantities, retailer queries, removal intents, multi-item lists), `pricing.ts` (Kroger promo/price rules), `messages.ts` (help and dashboard text; appends `registeredHelp()` lines from feature modules).
  - `cartLedger.ts`: cart items, deterministic splits, summaries, undo, clearing, removal, approvals, mock checkout, demo catalog adds.
  - `sharing.ts`: “start/stop sharing with …” sessions.
  - `productSearch.ts`: live Kroger single and multi-item search with numbered choices.
  - `krogerCheckout.ts`: availability precheck, replacements, account choice, and adding to a Kroger cart.
  - `recurringLists.ts`, `listCommands.ts`, `listText.ts`: recurring lists (state and cadence, conversation flows, reply text), plus the persisted household group (`rememberGroupSpace`/`groupSpace`).
  - `splitwiseLog.ts`: the `splitwise_expenses` log, checkout hooks called by mock and Kroger checkout, and the `splitwise`/`settle`/`splitwise retry` commands; `googleCalendarAccounts.ts`: per-member Google Calendar tokens.
- `src/cart.ts`: sample catalog and deterministic item/quantity extraction.
- `src/lists.ts`: recurring weekly/biweekly/monthly list command parsing and cadence math (persistence lives in `src/store/recurringLists.ts`).
- `src/reminders.ts`: delivery of due recurring-list check-ins to the remembered household group space.
- `src/householdGroup.ts`: the one live-mode target for everything GroupCart sends on its own (list check-ins, `notifyGroup()`, web chat relays): the group persisted by the store, reopened with `imessage(app).space.get(chatGuid, { phone })` after a restart.
- `src/platform.ts`: shared extension points for feature modules — `registerCommand`/`runCommands`, `registerRoute`, `registerTools`, `registerHelp`, `scheduleEvery`, `notifyGroup` (+ the `/api/feed` feed), the remote authorizer, and the request member resolver.
- `src/splitwise.ts`: Splitwise logging of each completed checkout (simulated in demo mode or without credentials).
- `src/bills.ts` (+ `billParse.ts`, `billSplit.ts`, `billExtract.ts`, `billSample.ts`, `src/ui/billsPage.ts`, `src/ui/billsHome.ts`): household bills (capture, split, balances, reminders), wired by `setupBills()`.
- `src/dashboard.ts`: HTTP server (127.0.0.1 unless `GROUP_CART_HOST` is set; remote requests pass `remoteAccessGuard` first): page routes, JSON API, and local demo endpoints.
- `src/ui/shell.ts`: shared UI shell (design tokens, icons, components, `renderPage`). Build every browser page on it; see the comment block at the top.
- `src/ui/*Page.ts`, `src/ui/placeholders.ts`: Home (`/`), Groceries (`/groceries`), Settings (`/settings`), and fallback Chores/Bills/Calendar pages (the feature modules serve the real ones).
- `src/config.ts`: environment configuration, member allowlist parsing, and handle normalization/masking.
- `src/googleCalendar.ts`: per-member Google OAuth (free/busy scope only), freeBusy API, and the calendar service used by `/calendar` and the `calendar` command; `src/calendarPage.ts`: the `/calendar` page and its routes; `src/availability.ts`: pure overlap/free-time math (`src/availability.test.ts`); `src/calendarDemo.ts`: deterministic sample schedules when Google is not configured.
- `src/membership.ts`: group join/leave events and roster checks against the allowlist.
- `src/connector.ts`: AI assistant connector (Claude, ChatGPT & dots, Grok), a stateless MCP server at `/mcp` (Streamable HTTP, official SDK) exposing every tool in `listTools()`, with per-member connector tokens (SHA-256 hashes in `connector_tokens`) and the `/api/connector/*` Settings API; `src/connectorOAuth.ts`: OAuth 2.1 for hosted assistants (RFC 9728/8414 metadata, RFC 7591 registration, PKCE S256, rotating refresh tokens, RFC 7009 revocation, pairing-code sign-in and consent pages in `src/ui/oauthPages.ts`); `src/connectorSecurity.ts`: hashing, redaction, rate limiting; `src/coreTools.ts`: core connector tools and `registerSummaryProvider` for `whats_on_my_plate`; `src/ui/connectorCard.ts`: the Settings "AI assistants" card; `src/remoteAccess.ts`: `isRemoteRequest` and the remote-access guard; `src/connector.test.ts`, `src/connectorOAuth.test.ts`: end-to-end tests.
- `src/chores.ts`: chores (fair rotation, away status, history, group commands, nudges, `/chores` + `/api/chores*`, connector tools), wired by `setupChores()`; `src/choresLogic.ts`: pure schedule/rotation/parser logic; `src/ui/choresPage.ts`: the page and Home "Chores due" card.
- `src/listsEvents.ts`: one `setupListsAndEvents(...)` call wires one-off named lists (`src/namedLists.ts`) and household events/plans/votes (`src/events.ts`, pure parsing in `src/eventsParse.ts`): group commands, `/api/named-lists*` and `/api/events*`, connector tools, event reminders, and the demo seed. Its handlers return null for the store's phrases (recurring lists, sharing) and leave bare numbers to a newer store question (`CartStore.pendingQuestionAt`). UI: `src/ui/listsPanel.ts` (Groceries Cart | Lists tabs; Lists shows the store's recurring lists read-only plus one-off lists), `src/ui/eventsPanel.ts` (calendar events layer and the Home "Upcoming" card).
- `src/profilesAndChat.ts`: one `setupProfilesAndChat(...)` call wires profiles, web sign-in, and the web chat (routes, connector tools, demo seed). `src/profiles.ts`: member profiles (`registerProfileSection` lets features add cards to `/people/<id>`; `avatarFor`, `referTo`). `src/auth.ts`: local-vs-remote detection, the remote access guard, one-time iMessage codes, and session cookies. `src/chat.ts`: the household conversation mirrored into `chat_messages` for `/chat`. Pages: `src/ui/profilePage.ts` (`/people`, `/people/<id>`), `src/ui/chatPage.ts` (`/chat`, Home chat card), `src/ui/signinPage.ts` (`/signin`), `src/ui/accountMenu.ts` (app-bar account menu).

## Environment and credentials

`.env` is gitignored and contains credentials. **Do not read, write, print, or otherwise expose `.env`.** Use `.env.example` only for the variable names and placeholder formats. Never include credentials in source, logs, screenshots, or user-facing output.

Spectrum Cloud uses `PROJECT_ID` and `PROJECT_SECRET`. `GROUP_CART_MEMBERS` is an explicit `handle=name` allowlist (`handle1|handle2=name` maps several handles to one member; compare handles only via `normalizeHandle`). In live mode, only inbound text from these members in iMessage group spaces is handled. Do not remove the allowlist or start processing direct messages unless the product requirements change. GroupCart sends a 1:1 DM only to deliver a sign-in code that member just requested on `/signin`; inbound DMs are still ignored.

## Safety and product boundaries

- Network access is opt-in. The dashboard binds to `127.0.0.1` unless `GROUP_CART_HOST` is set (for example `0.0.0.0` to serve the LAN); only set it when the user explicitly asks for network access. A tunnel (`GROUP_CART_PUBLIC_URL`) is also opt-in.
- Every remote request (LAN address, proxy, or tunnel: `isRemoteRequest` in `src/remoteAccess.ts`, which `isLocalRequest` in `src/auth.ts` reuses) needs a signed-in session (one-time iMessage code), a connector token, or a connector OAuth access token. Without one it may reach only `/signin*`, `/api/auth/*`, and the connector's self-authenticating `/mcp`, `/oauth/*`, and `/.well-known/*` paths. `remoteAccessGuard` stays the first statement of the dashboard request handler. Never weaken it, never trust a Host or forwarded header as proof of a local request, and keep host-only actions (the "Viewing as" switch, connector token and pairing-code management `/api/connector/*`) checking for a local request. The connector's OAuth pages authenticate the roommate themselves (one-time pairing code from Settings, or a signed-in session through `setRequestMemberResolver`) and always show a consent screen.
- Store only hashes of connector tokens, OAuth codes, access/refresh tokens, client secrets, pairing codes, sign-in codes, and session tokens. Show a connector token or pairing code once, at creation; never log, display, or return secrets (logs pass through `redactTokens`; demo mode shows the sign-in code on screen because nothing is sent). OAuth requires PKCE S256 and exact https (or loopback) redirect URIs. A tool call runs as the connecting member and nobody else. Connector tools must not check out, place orders, or send real payments.
- Web messages are posted to the group with the sender's name ("Maya: …"). Messages from an AI assistant name it from `ToolCaller.via` ("Maya via Grok: …", "Maya (via ChatGPT): …"; connector tokens count as Claude, unknown OAuth apps as "AI assistant"). Never post as someone else.
- Browser approval and checkout controls are local-demo-only. In live mode, checkout must come through an allowlisted group member's Spectrum conversation. Approvals come from the group chat, or from that member's own authenticated AI assistant connector (`approve_cart`, which also announces the approval to the group).
- Local demo checkout is simulated. Live checkout may add approved items to the selected member's Kroger cart after OAuth consent; it must never place an order or collect payment.
- Label sample prices as estimates and Kroger prices as store-specific quotes. Availability checks are point-in-time and do not guarantee pickup stock.
- Ignore outbound messages to prevent echo loops; keep processing idempotent by Spectrum message ID.
- Keep `.env` out of git.

## Commands

- `npm run start` — run with `.env` loaded, or local demo mode if credentials are absent.
- `npm run dev` — watch-mode startup with `.env` loaded.
- `npm run typecheck` — TypeScript validation.

Follow the repository's `.agents/skills/spectrum` instructions for SDK and provider behavior. In particular, cloud iMessage group features require the dedicated line; do not use the local provider for this group workflow.
