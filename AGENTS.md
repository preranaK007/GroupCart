# GroupCart agent instructions

This repository implements GroupCart using Photon Spectrum (`spectrum-ts`) and the cloud iMessage provider. Group messaging requires the project's dedicated Business line.

## Project structure

- `src/index.ts`: Spectrum startup, group-message filtering, household mapping, and replies.
- `src/store.ts`: SQLite persistence, cart revisions, deterministic splits, approvals, and Kroger cart checkout.
- `src/cart.ts`: sample catalog and deterministic item/quantity extraction.
- `src/dashboard.ts`: loopback-only HTTP server: page routes, JSON API, and local demo endpoints.
- `src/ui/shell.ts`: shared UI shell (design tokens, icons, components, `renderPage`). Build every browser page on it; see the comment block at the top.
- `src/ui/*Page.ts`, `src/ui/placeholders.ts`: Home (`/`), Groceries (`/groceries`), Settings (`/settings`), and placeholder Chores/Bills/Calendar pages.
- `src/config.ts`: environment configuration, member allowlist parsing, and handle normalization/masking.
- `src/googleCalendar.ts`: per-member Google OAuth (free/busy scope only), freeBusy API, and the calendar service used by `/calendar` and the `calendar` command; `src/calendarPage.ts`: the `/calendar` page and its routes; `src/availability.ts`: pure overlap/free-time math (`src/availability.test.ts`); `src/calendarDemo.ts`: deterministic sample schedules when Google is not configured.
- `src/membership.ts`: group join/leave events and roster checks against the allowlist.
- `src/connector.ts`: Claude connector, a stateless MCP server at `/mcp` (Streamable HTTP, official SDK) exposing every tool in `listTools()`, with per-member connector tokens (SHA-256 hashes in `connector_tokens`) and the `/api/connector/*` Settings API; `src/coreTools.ts`: core connector tools and `registerSummaryProvider` for `whats_on_my_plate`; `src/ui/connectorCard.ts`: the Settings "Claude" card; `src/remoteAccess.ts`: `isRemoteRequest` and the remote-access guard; `src/connector.test.ts`: end-to-end tests.
- `src/chores.ts`: chores (fair rotation, away status, history, group commands, nudges, `/chores` + `/api/chores*`, connector tools), wired by `setupChores()`; `src/choresLogic.ts`: pure schedule/rotation/parser logic; `src/ui/choresPage.ts`: the page and Home "Chores due" card.

## Environment and credentials

`.env` is gitignored and contains credentials. **Do not read, write, print, or otherwise expose `.env`.** Use `.env.example` only for the variable names and placeholder formats. Never include credentials in source, logs, screenshots, or user-facing output.

Spectrum Cloud uses `PROJECT_ID` and `PROJECT_SECRET`. `GROUP_CART_MEMBERS` is an explicit `handle=name` allowlist (`handle1|handle2=name` maps several handles to one member; compare handles only via `normalizeHandle`). In live mode, only inbound text from these members in iMessage group spaces is handled. Do not remove the allowlist or start processing direct messages unless the product requirements change.

## Safety and product boundaries

- Keep the dashboard bound to `127.0.0.1` unless the user explicitly asks for a network-accessible deployment.
- The user asked for Claude connectivity: each household member may connect their own Claude to `/mcp` with a personal connector token, and may expose it through a tunnel by setting `GROUP_CART_PUBLIC_URL`. The server itself stays bound to `127.0.0.1`. Requests that arrive through a tunnel, proxy, or another device (`isRemoteRequest` in `src/remoteAccess.ts`) may reach only `/mcp`, `/mcp/t/<token>`, sign-in routes (`/signin*`, `/api/auth/*`), or routes that `isRemoteAuthorized()` accepts. Everything else returns 404, so the dashboard stays local-only. Keep the guard as the first statement of the dashboard request handler. Token management (`/api/connector/*`) must stay local-only.
- Store only hashes of connector tokens. Show a token once, at creation, and never log it or put it in page HTML (logs pass through `redactTokens`). A tool call runs as the token's member and nobody else. Connector tools must not check out, place orders, or send real payments.
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
