# GroupCart agent instructions

This repository implements GroupCart using Photon Spectrum (`spectrum-ts`) and the cloud iMessage provider. Group messaging requires the project's dedicated Business line.

## Project structure

- `src/index.ts`: Spectrum startup, group-message filtering, household mapping, and replies.
- `src/store.ts`: SQLite persistence, cart revisions, deterministic splits, approvals, and Kroger cart checkout.
- `src/cart.ts`: sample catalog and deterministic item/quantity extraction.
- `src/dashboard.ts`: loopback-only browser dashboard and local demo endpoints.
- `src/config.ts`: environment configuration.

## Environment and credentials

`.env` is gitignored and contains credentials. **Do not read, write, print, or otherwise expose `.env`.** Use `.env.example` only for the variable names and placeholder formats. Never include credentials in source, logs, screenshots, or user-facing output.

Spectrum Cloud uses `PROJECT_ID` and `PROJECT_SECRET`. `GROUP_CART_MEMBERS` is an explicit `senderHandle=name` allowlist. In live mode, only inbound text from these members in iMessage group spaces is handled. Do not remove the allowlist or start processing direct messages unless the product requirements change.

## Safety and product boundaries

- Keep the dashboard bound to `127.0.0.1` unless the user explicitly asks for a network-accessible deployment.
- Browser approval and checkout controls are local-demo-only. In live mode, approvals and checkout must come through an allowlisted group member's Spectrum conversation.
- Local demo checkout is simulated. Live checkout may add approved items to the selected member's Kroger cart after OAuth consent; it must never place an order or collect payment.
- Label sample prices as estimates and Kroger prices as store-specific quotes. Availability checks are point-in-time and do not guarantee pickup stock.
- Ignore outbound messages to prevent echo loops; keep processing idempotent by Spectrum message ID.
- Keep `.env` out of git.

## Commands

- `npm run start` — run with `.env` loaded, or local demo mode if credentials are absent.
- `npm run dev` — watch-mode startup with `.env` loaded.
- `npm run typecheck` — TypeScript validation.

Follow the repository's `.agents/skills/spectrum` instructions for SDK and provider behavior. In particular, cloud iMessage group features require the dedicated line; do not use the local provider for this group workflow.
