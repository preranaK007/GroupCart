# Handoff: GroupCart roommate app

Branch `roommate-app-handoff` holds the full integrated work (the `integration` branch), built on top of upstream `main` (PR #1: modular store, sharing sessions, recurring lists). Upstream store logic in `src/store/*`, `src/lists.ts`, `src/reminders.ts` and `src/kroger.ts` is unchanged apart from small additive hooks.

PR #2 (`roommate-app-wave2`) is an earlier subset (waves 1–2). This branch supersedes it.

## Done

- **Core shell:** a unified web UI on `src/ui/shell.ts` (tokens, components, `renderPage`), plus plug-in registries in `src/platform.ts` for commands, routes, connector tools, help lines, schedules, group notifications and pending-question helpers.
- **Groceries:** Splitwise logging on checkout, and Kitchen tabs on `/groceries` (Cart | Lists | Pantry | Meals). Meal planning and the pantry live in `src/kitchen.ts`, `src/meals.ts` and `src/pantry.ts`.
- **Calendar:** Google free/busy per member, overlap shading and everyone-free windows. Event titles are opt-in. There is a Google-style Week | Day view with click-through and popovers (`src/calendarPage.ts`, `src/calendarItems.ts`, `src/calendarView.ts`), and `GROUP_CART_DEMO_CALENDAR` supplies showcase data.
- **Household:**
  - Chores: rotation, away status and nudges.
  - Bills: screenshots, splits, balances, reminders, and reading by the user's own AI through the connector, so no key is needed.
  - Pay-back links, points and streaks, and the Sunday digest.
  - Events and "we all want to watch a movie" plan-it polls, plus one-off lists.
  - House: board, repairs, guests, quiet hours and polls.
- **People and chat:** profiles, web sign-in by iMessage code, and an iMessage-style web chat (`/chat`). The Photon fix welcomes new group members and normalizes handles.
- **AI connector:** MCP at `/mcp` for Claude, ChatGPT/dots and Grok, with per-member tokens and OAuth 2.1 using pairing codes.
- **Themes:** Elden Ring, Minecraft, Red Dead and Cyberpunk.
- **Status:** `npm run typecheck` is clean and `node --import=tsx --test src/*.test.ts` passes 101/101.

## Left to do

1. **Polish pass.** Not started; it was stopped for this handoff. In priority order:
   - **Name-agnostic demo seeds:** they must work for any 3–5 members. Verify with `GROUP_CART_MEMBERS="demo:william=William,demo:ashwin=Ashwin,demo:tanmay=Tanmay,demo:sami=Sami"`. Seed no pronouns for these people.
   - **Realistic seeded balances:** keep them in the tens of dollars. Seeded rent currently makes one person owe about $725.
   - **Wording fixes:** replace phrases like "Eggs is out" with "Out of eggs".
   - **One pending-question registry** in `platform.ts`, used by kitchen, house, bills and events/polls for bare "yes"/"ok"/numbers. Remove the cross-module table reads (house reads `bill_pending`, kitchen reads the bill tables).
   - **Quiet bot:** no reply to banter ("lol", "👍", "thanks") when nothing is pending. Grocery items must still reach the cart.
   - **Bills without an API key:** only treat a photo as a bill when nearby text mentions bill, receipt, rent, due or a $ amount.
   - **Navigation:** Home, Chat, Kitchen (`/groceries`), Chores, Money (`/bills`), Calendar, House on desktop; People and Settings go in the avatar menu. On phones the bottom bar shows five items plus a "More" sheet. Update the theme flavor labels to match.
   - **Visual pass:** check every page at 1440px and 375px in Classic light/dark, Minecraft and Cyberpunk. Household events in the calendar Week view currently cover members' event titles.
   - **README:** rewrite the top section as a product overview and keep the upstream sections below it.
2. **Showcase video** (after the polish pass). About 75–90 s at 1080p, and not a slideshow:
   - **Format:** "a week at the apartment" told through the product. The group chat plays on a phone on one side while the web app reacts live on the other, with smooth camera pushes and minimal lower-third captions.
   - **Beats:**
     - "hey we all want to watch a movie" leads to a poll, slots found across real calendars, votes and a booked event.
     - Game night switches the app to the Minecraft skin.
     - A bill photo becomes a split, then "Pay $X" pay-back links. A late-night money scene switches to the Cyberpunk skin.
     - A chore nudge, then "done dishes" and a points celebration.
     - Claude adds to the cart through the connector ("William via Claude: …").
     - The Sunday digest closes the week.
   - **Roommates:** William, Ashwin, Tanmay and Sami.
   - **William's calendar:** pull his real Google Calendar (Oct 12–25, busy events only) into a local JSON for `GROUP_CART_DEMO_CALENDAR`. Show any sensitive personal events as "Personal" (ask William if unsure). **Never commit that file.**
   - **Recording:** drive headless Edge or Chrome over CDP (or Playwright) with scripted demo messages via `POST /api/demo-message` (`{memberId, text}`; member ids from `GET /api/cart`). Capture frames and compose with ffmpeg. No copyrighted music.
3. **Push** tested work to `main` when done. William has authorized direct pushes of tested work to `main`.

## Run it (demo mode, no credentials)

```bash
npm install
PORT=3000 node --import=tsx src/index.ts
```

On Windows PowerShell, set the env vars first, for example `$env:PORT=3000; $env:GROUP_CART_MEMBERS="demo:william=William,demo:ashwin=Ashwin,demo:tanmay=Tanmay,demo:sami=Sami"; node --import=tsx src/index.ts`.

- `npm run start` requires a `.env` file (`--env-file=.env`), so call node directly for the demo.
- Open http://127.0.0.1:3000. Use `/chat` to talk to the bot as any member, and the palette button in the top bar to switch skins.
- Data goes in `./data/groupcart.sqlite` (set `GROUP_CART_DB` to use a scratch file). Demo seeds run on a fresh database.
- iPhone HEIC photo conversion uses macOS `sips`. Elsewhere HEIC files are stored as-is.

## Live mode: `.env` values and sign-ins

See `.env.example`. Never commit `.env`.

- **Spectrum (iMessage):** `PROJECT_ID`, `PROJECT_SECRET` and `GROUP_CART_MEMBERS` (`+1555…|apple-id@icloud.com=Name`, comma-separated). Join events need the dedicated Business line.
- **Kroger:** `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_LOCATION_ID`, `KROGER_REDIRECT_URI`, `KROGER_CART_MODALITY`.
- **Google Calendar:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`. Each member connects on `/calendar`; titles need the per-member opt-in.
- **Splitwise:** `SPLITWISE_API_KEY`, `SPLITWISE_GROUP_ID`, `SPLITWISE_MEMBERS`.
- **Optional:**
  - `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` for server-side bill reading.
  - `GROUP_CART_PUBLIC_URL` with a tunnel (e.g. `cloudflared tunnel --url http://127.0.0.1:3000`) for claude.ai, ChatGPT or Grok connectors and remote sign-in.
  - `GROUP_CART_HOST=0.0.0.0` for LAN access.
  - `GROUP_CART_DEMO_CALENDAR` for showcase calendar JSON.

Not yet exercised against real accounts: live iMessage after the upstream merge, Kroger cart, Google OAuth, Splitwise, and hosted AI clients.
