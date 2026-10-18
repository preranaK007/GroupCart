# GroupCart

GroupCart turns messages in one shared iMessage group into a persistent household grocery cart. The Spectrum agent replies in that same group, attributes requests to configured members, tracks each person's estimated share, and requires household approval before checkout. Live checkout adds the approved items to a selected member's Kroger cart; local demo checkout is simulated.

## Local demo

Without Spectrum credentials, the app starts with three demo members and a browser dashboard. Requests, prices, splits, approvals, and checkout are simulated locally.

```sh
npm install
npm run start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Home (`/`) shows today's overview, Chat (`/chat`) is the household conversation (in the demo, the easiest way to try the bot), Groceries (`/groceries`) has two tabs: Cart (the shared cart, with any active sharing session) and Lists (the recurring weekly/biweekly/monthly lists, read-only, plus one-off lists like "Party run"), People (`/people`) shows everyone's profile, Settings (`/settings`) shows connections, and Chores (`/chores`), Bills (`/bills`), and Calendar (`/calendar`) are described below. Settings > Appearance (or the palette button in the app bar) switches the look between Classic and the Elden Ring, Minecraft, Red Dead Redemption, and Cyberpunk 2077 skins; the choice is saved in this browser (`gc-skin` cookie), and `?skin=elden` (or `minecraft`, `rdr`, `cyberpunk`) previews one. Data is stored in `./data/groupcart.sqlite` by default; uploaded avatars and chat photos go next to it in `avatars/` and `chat-files/`.

## Connect your Spectrum dedicated line

This project uses the Spectrum Cloud SDK (`spectrum-ts`) and its iMessage provider. Copy `.env.example` to `.env` if needed, then set the existing Spectrum project's credentials and allowlisted group members:

```env
PROJECT_ID=...
PROJECT_SECRET=...
GROUP_CART_MEMBERS=+15555550100=Alex,+15555550101|maya@example.com=Maya
```

Keep `.env` private; never commit it or paste its secrets into chat. Start the app with `npm run start`. It handles inbound text only from configured members in iMessage group conversations, ignores direct messages and the agent's own outbound echoes, and replies in the originating group. The shared group should include the Spectrum dedicated number and each member should send at least one message so their sender identities can be allowlisted.

### Group members

`GROUP_CART_MEMBERS` is an explicit allowlist; GroupCart never enrolls anyone automatically. Each entry is `handle=Name`. List several handles for one person with `|` (for example `+15555550101|maya@example.com=Maya`), because someone added to an existing group often shows up under their Apple ID email rather than their phone. Handles are normalized before comparison: emails are lowercased, phone numbers drop spaces, dashes, dots, and parentheses, and 10-digit US numbers are treated as `+1XXXXXXXXXX`. Existing single-handle entries and saved carts keep working.

Join events require the dedicated Business line (shared-pool lines do not report them). When someone is added to the group, GroupCart replies once: a short welcome for allowlisted people, or a note that an organizer must add their phone or Apple ID to `GROUP_CART_MEMBERS`, with a masked hint (last 4 digits or masked email) of the handle Spectrum sees. No email or other notification is sent, so watch the group chat or console, update `.env`, and restart. After startup, the first message from each group also logs masked handles of any current participants not on the allowlist (covering people added before GroupCart connected). Messages from non-allowlisted senders are ignored and logged with a masked handle.

## Commands in the group

- Text `help`, `commands`, or `hi` for the welcome guide and examples. If a grocery search finds no match, GroupCart points you back to this guide.
- Text `calendar` for the household calendar page link and the next couple of times everyone is free (8 AM–9 PM, at least 30 minutes).
- Text `dashboard` for the companion cart page link. It is bound to `127.0.0.1`, so open it on the computer running GroupCart; it is not reachable from other devices by default.
- Send one grocery item or a short list of up to five separated by commas or `and`, e.g. `2 bananas`, `Darigold 2% milk`, or `bread, bananas, and eggs`. New items belong to the sender unless the sender is in a sharing session (below).
- Add per-item price limits such as `pasta under $5` or `pasta under $5, bread up to $3`. `Under` is strict; `up to` includes the stated price. Limited searches only offer products with a current returned store price that meets the limit.
- For a multi-item request, GroupCart searches each item at the selected Kroger-family store and lists numbered product, size, and price options for each. Reply with one number per item in order, separated by commas (e.g. `1, 2, 1`); nothing is added until all choices are selected. Say `cancel` to discard the pending search.
- If someone requests only `milk`, GroupCart asks for a kind first, then searches live store products and prices.
- `start sharing with Maya and Jordan` (or `start sharing with Maya, Jordan`; first names work, case-insensitive) starts a sharing session for the sender plus the named members. While it is active, every item any participant adds — single items, multi-item lists, milk follow-ups, demo catalog adds — is split evenly among exactly those participants. Members outside the session are unaffected. `stop sharing` (or `stop sharing with Maya, Jordan`) ends the session for everyone in it; it never changes items already in the cart.
  - Sessions are stored in SQLite and survive restarts. Each member can be in one active session at a time: starting a different session while in one, or naming someone who is already in another session, is refused until someone texts `stop sharing`. Unknown, ambiguous, or missing names, and naming yourself, are rejected with no change.
  - The split is decided when the item is actually added. If you search, then start or stop sharing, then pick a numbered result, the session active at pick time applies.
  - Per-item phrases such as `eggs shared with Maya` or `pasta for everyone` no longer share anything; GroupCart adds the item for the sender and points to `start sharing`.
  - `start sharing` / `stop sharing` are not cart changes, so they do not change the cart revision, reset approvals, or appear in `undo`. Undo still reverts item adds made during a session.
- Recurring weekly / every-two-weeks / monthly lists: see [Recurring group lists](#recurring-group-lists) (`weekly: milk, eggs`, `lists`, `load weekly list`, `set up lists`).
- `cart` to review the current cart and estimated shares.
- `remove bread`, `cancel the eggs`, or `I don’t want bread anymore` to cancel an item. If multiple matching lines exist, choose one by number. Removing a shared item withdraws only the sender’s share; other participants keep theirs.
- `clear mine` to remove all of your own items and withdraw your share from shared items, leaving other members’ shares in place.
- `clear all` to request clearing the whole shared cart. Reply `confirm clear all` to confirm, or `cancel clear all` to abort. A changed cart requires a fresh confirmation.
- `undo` to restore the cart to the state before the most recent cart change. Undo is available for the latest 20 cart changes; each undo creates a new cart revision and resets approvals.
- `approve` to approve the current cart revision.
- In live mode, after every household member approves, `checkout` checks each selected UPC against the configured store and pickup/delivery mode. If Kroger reports unavailable products, GroupCart shows in-stock suggestions but does not substitute anything automatically. Choose a suggestion explicitly with `replace 1 with 2`; any changed cart requires everyone to approve again. Once the precheck passes, `checkout` asks whose Kroger account to use. The selected member opens Kroger sign-in and consents; GroupCart then adds the approved live Kroger UPCs to that account's cart and clears the GroupCart list only after Kroger confirms. Availability can change after the check, so verify the Kroger cart. The shopper reviews and places the order on Kroger; GroupCart never submits an order or payment. Local demo checkout remains simulated.
- `splitwise` (or `settle`) shows the Splitwise status of the latest checkout: logged (with who owes whom), simulated, or failed. `splitwise retry` re-sends a failed one after checking that Splitwise doesn't already have it.

## Recurring group lists

The household shares three recurring lists: **weekly**, **every two weeks** (`biweekly`), and **monthly**. They belong to the whole group chat, not one member.

- Build: `weekly: milk, eggs, bread`, `add paper towels to monthly`, `add 2 bananas, oat milk to biweekly list`. In live mode this uses the same Kroger search as the cart: numbered choices (one item: reply `1`–`5`; several: `1, 2, 1`), the milk-type question for plain `milk`, and per-item price limits (`pasta under $4`). Saved items keep the Kroger product ID, UPC, name, size, and the store-specific quote from when they were chosen. In demo mode items come from the sample catalog (prices are estimates). Up to 5 items per message; re-adding a product updates its quantity instead of duplicating it.
- One unfinished selection per member: starting a list search discards that member's unfinished cart selection (the reply says so), and while a list choice is pending, other text is answered with a reminder to pick a number or say `cancel`. Cart commands (`cart`, `approve`, `undo`, …) and list commands always pass through. A cart removal request (`remove bread`) discards an unfinished list selection.
- Manage: `lists` (overview), `weekly list` / `show monthly list`, `remove eggs from weekly list` (or `remove 2 from weekly list` by number), `set eggs on weekly list to 3` (`0` removes), `clear weekly list` then `confirm clear weekly list` (or `yes`; `cancel clear weekly list` / `cancel`). If the list changes before confirmation, GroupCart asks again. List edits don't touch the cart and aren't part of cart `undo`.
- Use: `load weekly list` (also `add weekly list to cart`) copies the list into the cart as normal cart lines owned by the sender, as one cart revision (approvals reset) and one `undo` step. In live mode each Kroger item is re-quoted by product ID at the configured store; if Kroger doesn't return the product or a current price (or the lookup fails), GroupCart uses the last saved quote and flags it in the reply. The availability precheck at `checkout` still catches anything the store no longer carries. Products already in the cart are skipped and listed. If the list was already loaded this cycle, GroupCart warns instead of adding it again; `load weekly list again` adds another copy. Undoing a load also clears its "already loaded" state.
- Asking the group: each list becomes active when it first gets an item (or `start weekly list`). From the next cycle on, when a list is due and hasn't been loaded, GroupCart asks the group, e.g. "Weekly groceries are due… Reply “load weekly list”… or add items with “weekly: …”". Defaults: weekly every Sunday, biweekly every other Sunday, monthly on the 1st; reminders go out at or after 9:00 server-local time on the due day. Change with `weekly list on saturdays`, `biweekly list on fridays`, `monthly list on the 15th` (29–31 use the month's last day in short months). A schedule change never triggers an immediate reminder for a cycle already in progress. `pause weekly reminders` / `resume weekly reminders` toggles one list. `set up lists` asks the group what to put on each list.
- Cadence rules: a load within 2 days before a cycle starts counts for that cycle (loading Saturday suppresses Sunday's reminder). Each list is announced at most once per cycle (persisted in SQLite). If GroupCart was offline on the due day, the reminder is sent at the next opportunity within that cycle.
- Delivery: Spectrum's cloud iMessage provider can send to an existing conversation outside the reply loop (`imessage(app).space.get(chatGuid, { phone })`). GroupCart stores the household group's chat ID and serving line whenever an allowlisted member messages from a group, and only ever sends check-ins there. Every `GROUP_CART_LIST_REMINDER_CHECK_MINUTES` it claims due lists in SQLite, sends one message, and releases the claim if sending fails. As a fallback, a due check-in that hasn't been sent is appended to the next group reply. Nothing is sent before the bot has seen the group. In local demo mode nothing is sent; a due check-in appears with the demo reply, labelled `[Demo reminder]`.

Configure Kroger Production app credentials, Cart API access, and a `KROGER_LOCATION_ID` to use live product search and cart preparation; this must match the pickup/delivery store selected in the Kroger account. The precheck uses Kroger's Products API availability at that location and fulfillment mode, then searches that same location for suggestions. It is a point-in-time check and cannot guarantee stock at pickup. Add the exact `KROGER_REDIRECT_URI` to your Kroger app's allowed redirect URIs; for local testing it defaults to `http://127.0.0.1:3000/api/kroger/oauth/callback`. If you later deploy behind a protected public hostname, set both `GROUP_CART_PUBLIC_URL` and `KROGER_REDIRECT_URI` to matching URLs. `KROGER_CART_MODALITY` defaults to `PICKUP`; set it to `DELIVERY` if needed. The member selected in iMessage must sign in to their own Kroger account in the browser. GroupCart uses Kroger's user-authorized Cart API to add selected products by UPC and quantity; sample items without a Kroger UPC block the entire transfer. This adds items to the Kroger account but cannot read the resulting cart or place an order. Review the cart and finish checkout directly in Kroger. The dashboard reads the same SQLite cart and refreshes every 2.5 seconds. In Spectrum live mode it remains a read-only companion view; item changes, approvals, totals, and splits still come from the iMessage group. The dashboard is bound to `127.0.0.1`, so only the machine running GroupCart can open it unless you separately deploy it.

## Splitwise

After a successful checkout (in live mode, only after Kroger confirms the items were added), GroupCart logs one expense in the household's Splitwise group: the member whose Kroger account received the items paid the full total, and each member owes exactly the share GroupCart computed (shares always sum to the total to the cent). The checkout reply includes a short Splitwise summary, and the dashboard shows the latest status (`GET /api/splitwise` returns it as JSON). A Splitwise failure (bad key, rate limit, unmapped member) never undoes the checkout; it is reported and can be retried. Each checkout is logged at most once.

Set `SPLITWISE_API_KEY` (a personal API key from [secure.splitwise.com/apps](https://secure.splitwise.com/apps)), `SPLITWISE_GROUP_ID`, and `SPLITWISE_MEMBERS` (e.g. `Alex=12345,Maya=maya@example.com`, mapping each GroupCart member name to a Splitwise user id or email). In the local demo, or while these are unset, checkouts are simulated: GroupCart records and shows the expense it would have sent, but makes no Splitwise request. Each member's owed share comes from the cart split, so items added during a sharing session are divided among its participants.

## Household calendar

Open [http://127.0.0.1:3000/calendar](http://127.0.0.1:3000/calendar) (also linked from the dashboard). It shows a week view with one lane per member in their own color, shades times when two or more people are busy at once (darker as more overlap), highlights windows when everyone is free, and lists the best shared free times for the week (1 hour or longer, 8 AM–9 PM), which is handy for picking a pickup or delivery slot. Use the arrows or ←/→ to change weeks and **Today** (or `t`) to jump back.

Without Google credentials the page runs in demo mode with generated sample schedules (stable for each week). To use real calendars, create an OAuth 2.0 **Web application** client in Google Cloud, enable the Google Calendar API, register the exact `GOOGLE_REDIRECT_URI` (default `http://127.0.0.1:3000/api/google/oauth/callback`), and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Each member then presses **Connect Google Calendar** on their row and signs in with their own Google account. GroupCart requests only the `calendar.freebusy` scope, so it sees busy blocks from the primary calendar and never event titles, attendees, or details. Refresh tokens are stored in the local SQLite database and never returned by the dashboard API. If Google revokes access, the member's row shows **Reconnect**; **Disconnect** deletes the stored token and revokes it with Google. Free time is computed only from connected calendars, and the page says when some members are missing.

## AI assistants (Claude, ChatGPT & dots, Grok)

Each roommate can add GroupCart to their own AI assistant as a custom MCP connector: Claude (Claude Code, Claude Desktop, claude.ai), ChatGPT and its dots, or Grok. GroupCart serves an MCP endpoint at `/mcp` (Streamable HTTP), and every tool call runs as the roommate who connected the assistant. Tools include `whats_on_my_plate`, `view_cart`, `add_to_cart` / `choose_product` (the same path as a group-chat request; who shares an item follows the caller's sharing session, and sharing or recurring-list commands go through `send_group_message` instead), `approve_cart`, `household_members`, `free_times`, `recent_activity`, and `post_to_group`. Tools that feature modules register through `registerTools()` in `src/platform.ts` appear automatically. Posts and approvals are attributed to the assistant, for example "Maya via Grok: ..." or "Alex via Claude: ...". Assistants cannot check out, place orders, or pay.

Open **Settings > AI assistants**. The setup tabs there walk through each assistant:

- **Claude Code**: press **Connect Claude** and run the `claude mcp add --transport http groupcart http://127.0.0.1:3000/mcp --header "Authorization: Bearer <token>"` command it shows. The personal connector token is shown once; GroupCart stores only its SHA-256 hash.
- **claude.ai or Claude Desktop**: Settings > Connectors > Add custom connector, then paste the public `https://<public-host>/mcp` URL.
- **ChatGPT and dots**: turn on Developer mode (Settings > Apps & Connectors > Advanced). Add a custom connector with the public `/mcp` URL and OAuth authentication, leaving the client ID and secret blank. dots use the same connectors.
- **Grok**: grok.com/connectors > New Connector > Custom, then the public `/mcp` URL.

When a hosted assistant connects, it registers itself (OAuth 2.1 dynamic client registration) and opens GroupCart's sign-in page. Enter a one-time **pairing code** from Settings (press **Pairing code** next to your name; codes work once and expire after 10 minutes), then approve on the consent screen. Settings lists each roommate's connected assistants with their last use, and you can disconnect each one.

The OAuth layer is in `src/connectorOAuth.ts`:

- Discovery: RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource[/mcp]`, advertised in the `WWW-Authenticate` header of a 401, and RFC 8414 server metadata at `/.well-known/oauth-authorization-server`.
- Registration at `/oauth/register`. Redirect URIs must be https, or http on loopback, and must match exactly.
- `/oauth/authorize` requires PKCE S256.
- `/oauth/token` supports `authorization_code` and `refresh_token`. Access tokens last 1 hour. Refresh tokens last 30 days and rotate on every use; replaying an old refresh token or auth code revokes the connection.
- RFC 7009 revocation at `/oauth/revoke`.

Codes, tokens, client secrets, and pairing codes are stored only as hashes.

**Public HTTPS (tunnel).** GroupCart stays bound to `127.0.0.1` unless `GROUP_CART_HOST` is set. ChatGPT, Grok, and claude.ai need a public HTTPS URL; Grok rejects localhost and private addresses. Run a tunnel on this computer, for example `cloudflared tunnel --url http://127.0.0.1:3000`, set `GROUP_CART_PUBLIC_URL` to the `https://….trycloudflare.com` address it prints, and restart GroupCart. Quick-tunnel addresses change on every run, so update the connector URL in each assistant when that happens.

Without a signed-in session, requests that come through a tunnel, proxy, or another device (non-loopback `Host` or socket, or any `X-Forwarded-*` / `Forwarded` / `CF-Connecting-IP` header) may reach only `/mcp`, `/mcp/t/<token>`, `/oauth/*`, `/.well-known/*`, and sign-in routes (`src/remoteAccess.ts`, enforced by `remoteAccessGuard` in `src/auth.ts`). Everything else (dashboard pages, `/api/*`, demo endpoints, and the Kroger/Google OAuth starts) redirects to `/signin` or is refused. Token and pairing-code management (`/api/connector/*`) works only on the computer running GroupCart, even for signed-in users. Because those callbacks stay local, keep `KROGER_REDIRECT_URI` and `GOOGLE_REDIRECT_URI` set to the `127.0.0.1` URLs. A personal URL `…/mcp/t/<token>` (in the Connect Claude dialog) works with assistants set to no authentication; treat it like a password. Failed token, pairing-code, and OAuth attempts are rate-limited.

## Chores

Open [http://127.0.0.1:3000/chores](http://127.0.0.1:3000/chores). A Mon–Sun week strip shows each day's chores in the assignee's color (late ones get a red dot and move to today; done ones are struck through; later weeks show the planned rotation). Below are **Up next** (tap the circle to mark done, **⋮** to skip, give the turn to someone, or delete), **People** (completions in the last 30 days, plus an away toggle), and **Recent**. **Add chore** picks a name, an icon, One-off / Weekly / Monthly, and who is in the rotation. Home shows a **Chores due** card with today's and overdue chores. The page can change chores in demo and live mode; it only accepts same-origin JSON requests.

- **Schedules:** weekly on a weekday (or every 2–8 weeks), monthly on a day (29–31 fall on the last day of shorter months; "monthly" alone means the last day), or one-off by a date. Doing a chore early counts for the current cycle; doing it late moves to the next date after today. A chore can be marked done once a day, and not again until its next cycle starts.
- **Fair rotation:** the next turn goes to whoever in the chore's rotation has gone longest without doing it, then fewest completions, then name order. Members who are away are skipped. `skip` passes the current turn on (the skipper is still first in line next time); `swap` hands it to someone else. If someone covers, the person whose turn it was stays up next.
- **Group chat:** `chores` (due this week and who's up), `my chores`, `done dishes` / `I did the dishes` / `I took out the trash`, `skip dishes`, `swap dishes with Maya`, `away until Oct 30` / `I'm back`, and `add chore vacuum every Sunday`, `add chore take out trash weekly on Tuesday`, `add chore deep clean fridge monthly`, `add chore fix lamp by Friday` (add `for Maya and Jordan` to limit the rotation). Replies are idempotent by message ID; phrases that don't name a chore (like "finished the milk") fall through to groceries.
- **Nudges:** a morning digest of what's due today (after 9 AM, only if something is due) and at most one overdue nudge per chore per day, e.g. "🍽️ Maya hasn’t done the dishes in 2 weeks. Maya’s up next." Sent between 9 AM and 9 PM server time; in the demo they appear in `GET /api/feed`.
- **Claude connector tools:** `list_chores`, `my_chores`, `complete_chore`, `add_chore`, `skip_chore`, `set_away` (run as the calling member).
- **API:** `GET /api/chores?week=YYYY-MM-DD`; JSON `POST /api/chores` (create), `/api/chores/done`, `/undo`, `/skip`, `/assign`, `/delete`, `/restore`, `/away`.

The local demo seeds sample chores and history (dishes, trash, vacuum, bathroom, plants, recycling, fridge) once; live mode starts empty. Data lives in `chore_*` tables in the same SQLite file.

## One-off lists and household events

Besides the recurring lists, the household can keep **one-off lists** for a single trip or occasion: `new list party run: chips, soda`, `add salsa to party run`, `remove soda from party run`, `party run to cart` (adds the open items to the cart as the sender, split by their sharing session), and `one-off lists`. They also live in the Lists tab on Groceries, where items can be checked off and, in the demo, moved to the cart. One-off list commands never claim the recurring-list phrases (`lists`, `weekly …`, `load weekly list`) or `start/stop sharing`.

**Events and plans:** `add event house meeting Sunday 7pm`, `events`, `cancel event house meeting`, `plan house meeting 1h` (GroupCart suggests times from everyone's calendars; reply `1`–`3` to book). Casual messages such as “hey we all want to watch a movie” or “game night this week?” start a vote on a few free times; reply with numbers (`1 3`, `can’t do 2`), and `book 2` decides. Movie ideas: `add movie Dune`, `vote Dune`; RSVP with `I’m in` / `can’t make it`. A bare number goes to the plan vote unless GroupCart asked you a grocery question (product pick, milk kind, list selection) more recently. Booked events show on the Calendar page and the Home “Upcoming” card; GroupCart reminds the group a day and an hour before (through the same household group as other notifications). Connector tools: `list_lists`, `add_to_list`, `move_list_to_cart`, `list_events`, `add_event`, `suggest_event_times`, `plan_activity`, `vote`, `book_event`, `rsvp_event`. The demo seeds a one-off list, a few events, a game night, and a movie-night vote.

## House

Open [http://127.0.0.1:3000/house](http://127.0.0.1:3000/house). The top row holds pinned info tiles: Wi-Fi, door codes, trash day, and the landlord's number (tap to call). Passwords and codes stay masked until you tap the eye (or copy them); the page fetches them only then, so they never sit in the page. House rules, emergency info, and notes sit as small pills underneath. Tap any tile to edit, pin or unpin, or move it. Below are **Repairs** (status chips and photo thumbnails; open one for its photo, status Open → Reported → Fixed, who's on it, and its timeline), **Guests & quiet hours**, and **Polls** (vote bars). Home shows at most one line from House under the date (extra quiet hours tonight, guests today, or open repairs), and quiet hours appear as a light hatched band on the Calendar.

- **Info:** `wifi`, `door code` (or `gate code`, `lockbox code`), `house rules`, `landlord`, `trash day`, `emergency`. `wifi` and `door code` answer in the group (it's the household's own chat), with a tip to tap-to-reveal on the House page next time.
- **Repairs:** `broken: kitchen faucet leaking`, `leaky faucet`, or `the dishwasher won't drain`; send a photo with a "broken …" caption, or right after (within 5 minutes). `reported faucet` (or `told the landlord about the faucet`), `I'll handle the faucet` / `assign faucet to Maya`, `fixed faucet`, `repairs`. Requests open 7+ days get one reminder a week (9 AM–9 PM, not during quiet hours).
- **Guests:** `having friends over Fri 8pm`, `my sister is staying Sat–Sun`, `my parents are visiting this weekend`. GroupCart adds a 🧳 household event (so it shows on the Calendar and Home and gets the usual event reminders) and posts a heads-up; others reply `ok` or `concern: exam Saturday`.
- **Quiet hours:** a household default (weeknights 11 PM–8 AM; change it on the page or with `set quiet hours 11pm-7am weeknights`), plus one-night requests like `quiet hours tonight from 10pm` or `exam tomorrow, quiet please after 9`. `quiet hours` shows them; `cancel quiet hours` drops tonight's extra window.
- **Polls:** `poll: takeout tonight? thai, pizza, sushi` or `poll: thermostat 68 or 70?` (no options means yes/no). Vote with a number; a bare number goes to the poll only while it is the newest question you were asked (a newer grocery choice or event plan vote keeps it). One vote each; a poll closes when everyone has voted or after 24 hours (announced in the group, not during quiet hours). `polls`, `close poll`.
- **AI assistants:** `get_house_info` (passwords and codes masked unless `include_secrets`, which returns them only to the calling member), `create_maintenance_request`, `update_maintenance_request`, `announce_guest`, `set_quiet_hours`, `create_poll`, `vote_poll`; `whats_on_my_plate` gains a `house` section.

The demo seeds a board (sample Wi-Fi, a door code, rules, the landlord "Pat Rivera, 555-0100"), an open repair with a sample photo, a guest visit, tonight's quiet hours, and an open thermostat poll. Data lives in `house_*` tables; repair photos in `house-files/` next to the database.

## Profiles, sign-in, and web chat

Each member has a profile at `/people/<id>`: a name, a photo or emoji avatar, optional pronouns (GroupCart never guesses; it uses names or they/them), a short bio, dietary notes and allergies, favorite snacks, movie and game picks, a birthday, and a payment handle such as Venmo. Open your own profile from the avatar menu in the top right to edit it.

`/chat` shows the group conversation the way iMessage does. In live mode it mirrors the iMessage group: every message from allowlisted members, GroupCart's replies, and group notifications. A message you send from the website is posted to the group as “Maya: …” and handled exactly like the same text in the group, so “2 bananas”, “cart”, and photos of bills all work. In the demo, nothing is sent anywhere.

Everything GroupCart sends on its own in live mode (recurring-list check-ins, chore nudges, bill reminders, assistant posts, and web chat relays) goes to one place: the household group remembered by the store whenever an allowlisted member writes from it (see the Delivery note under [Recurring group lists](#recurring-group-lists)). It is reopened with `imessage(app).space.get(chatGuid, { phone })` after a restart, so nothing waits for someone to text first; `src/householdGroup.ts` holds this logic. These messages also appear in `/chat` and `GET /api/feed`. In the demo, a due list check-in shows up as `[Demo reminder]` in the reply in `/chat` and in the feed.

On the computer running GroupCart you are already signed in; the avatar menu's **Viewing as** list picks which member you act as. To use GroupCart from your own phone or laptop, set `GROUP_CART_HOST=0.0.0.0` (or put it behind a tunnel), open `/signin`, and enter the phone number or Apple ID you use in the group. GroupCart texts you a 6-digit code by iMessage (valid 10 minutes, single use). Sessions last 30 days. If iMessage isn't connected, sign-in from other devices is unavailable and the page says so. In the demo the code is shown on screen.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PROJECT_ID` | Spectrum Cloud project ID | unset (local demo) |
| `PROJECT_SECRET` | Spectrum Cloud project secret | unset (local demo) |
| `GROUP_CART_MEMBERS` | Comma-separated `handle=name` allowlist; `handle1\|handle2=name` for several handles | demo users in local mode |
| `GROUP_CART_HOUSEHOLD` | Shared cart identity | `apartment-4b` |
| `GROUP_CART_DB` | SQLite file path | `./data/groupcart.sqlite` |
| `GROUP_CART_BUDGET_CENTS` | Sample budget in cents | `5000` |
| `GROUP_CART_PUBLIC_URL` | Public base URL used in links; a non-loopback HTTPS value (e.g. a tunnel) also becomes the public AI assistant connector URL | `http://127.0.0.1:$PORT` |
| `PORT` | Local dashboard port | `3000` |
| `GROUP_CART_HOST` | Address the dashboard listens on. `0.0.0.0` serves your network; other devices must sign in | `127.0.0.1` (this computer only) |
| `KROGER_CLIENT_ID` | Kroger Production app client ID for product search and user-authorized cart access | unset (live Kroger features disabled) |
| `KROGER_CLIENT_SECRET` | Kroger Production app client secret | unset (live Kroger features disabled) |
| `KROGER_LOCATION_ID` | Kroger-family store ID for local availability/prices | unset |
| `GROUP_CART_PUBLIC_URL` | Base URL in the Kroger sign-in link | `http://127.0.0.1:3000` |
| `KROGER_REDIRECT_URI` | OAuth callback URL registered with Kroger | dashboard URL + `/api/kroger/oauth/callback` |
| `KROGER_CART_MODALITY` | Fulfillment modality for added items (`PICKUP` or `DELIVERY`) | `PICKUP` |
| `SPLITWISE_API_KEY` | Splitwise personal API key (sent as a bearer token) | unset (Splitwise simulated) |
| `SPLITWISE_GROUP_ID` | Numeric id of the household's Splitwise group | unset (Splitwise simulated) |
| `SPLITWISE_MEMBERS` | Comma-separated `memberName=splitwiseUserIdOrEmail` mapping | unset (Splitwise simulated) |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 web client ID for per-member calendar free/busy | unset (sample schedules) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret | unset (sample schedules) |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL registered with Google | `GROUP_CART_PUBLIC_URL` + `/api/google/oauth/callback` |
| `GROUP_CART_LIST_REMINDERS` | Set to `off` to disable recurring-list check-ins (proactive and reply-attached) | on |
| `GROUP_CART_LIST_REMINDER_HOUR` | Server-local hour (0–23) on the due day after which a check-in is sent | `9` |
| `GROUP_CART_LIST_REMINDER_CHECK_MINUTES` | How often live mode checks for due lists | `15` |

## Development

```sh
npm run dev
npm run typecheck
node --import=tsx --test src/*.test.ts              # everything below
node --import=tsx --test src/store.test.ts          # store facade: sharing → Splitwise, members, help, the persisted household group
node --import=tsx --test src/availability.test.ts   # overlap / free-time checks
node --import=tsx --test src/connector.test.ts      # connector: tokens, tunnel guard, MCP over HTTP
node --import=tsx --test src/connectorOAuth.test.ts # connector OAuth: discovery, DCR, PKCE, refresh rotation, revocation
node --import=tsx --test src/house.test.ts          # House: parsers, masking, polls and number disambiguation, nudges
```

See the [Spectrum iMessage provider guide](https://photon.codes/docs/spectrum-ts/providers/imessage) for dedicated-line and group-chat requirements.
