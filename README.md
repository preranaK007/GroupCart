# GroupCart

GroupCart turns messages in one shared iMessage group into a persistent household grocery cart. The Spectrum agent replies in that same group, attributes requests to configured members, tracks each person's estimated share, and requires household approval before checkout. Live checkout adds the approved items to a selected member's Kroger cart; local demo checkout is simulated.

## Local demo

Without Spectrum credentials, the app starts with three demo members and a browser dashboard. Requests, prices, splits, approvals, and checkout are simulated locally.

```sh
npm install
npm run start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Home (`/`) shows today's overview, Chat (`/chat`) is the household conversation (in the demo, the easiest way to try the bot), Groceries (`/groceries`) shows the shared cart, People (`/people`) shows everyone's profile, and Settings (`/settings`) shows connections. Chores, Bills, and Calendar are placeholders for now. Data is stored in `./data/groupcart.sqlite` by default; uploaded avatars and chat photos go next to it in `avatars/` and `chat-files/`.

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
- Send one grocery item or a short list of up to five separated by commas or `and`, e.g. `2 bananas`, `Darigold 2% milk`, `bread, bananas, and eggs`, or `Vital Farms organic eggs shared with Anupritaa and Prerana`.
- Add per-item price limits such as `pasta under $5` or `pasta under $5, bread up to $3`. `Under` is strict; `up to` includes the stated price. Limited searches only offer products with a current returned store price that meets the limit.
- For a multi-item request, GroupCart searches each item at the selected Kroger-family store and lists numbered product, size, and price options for each. Reply with one number per item in order, separated by commas (e.g. `1, 2, 1`); nothing is added until all choices are selected. Say `cancel` to discard the pending search.
- If someone requests only `milk`, GroupCart asks for a kind first, then searches live store products and prices.
- Shared requests preserve named participants while the product choice is pending. If the exact same live SKU is already in GroupCart, a shared request updates its split rather than duplicating that live item.
- `cart` to review the current cart and estimated shares.
- `remove bread`, `cancel the eggs`, or `I don’t want bread anymore` to cancel an item. If multiple matching lines exist, choose one by number. Removing a shared item withdraws only the sender’s share; other participants keep theirs.
- `clear mine` to remove all of your own items and withdraw your share from shared items, leaving other members’ shares in place.
- `clear all` to request clearing the whole shared cart. Reply `confirm clear all` to confirm, or `cancel clear all` to abort. A changed cart requires a fresh confirmation.
- `undo` to restore the cart to the state before the most recent cart change. Undo is available for the latest 20 cart changes; each undo creates a new cart revision and resets approvals.
- `approve` to approve the current cart revision.
- In live mode, after every household member approves, `checkout` checks each selected UPC against the configured store and pickup/delivery mode. If Kroger reports unavailable products, GroupCart shows in-stock suggestions but does not substitute anything automatically. Choose a suggestion explicitly with `replace 1 with 2`; any changed cart requires everyone to approve again. Once the precheck passes, `checkout` asks whose Kroger account to use. The selected member opens Kroger sign-in and consents; GroupCart then adds the approved live Kroger UPCs to that account's cart and clears the GroupCart list only after Kroger confirms. Availability can change after the check, so verify the Kroger cart. The shopper reviews and places the order on Kroger; GroupCart never submits an order or payment. Local demo checkout remains simulated.
- `splitwise` (or `settle`) shows the Splitwise status of the latest checkout: logged (with who owes whom), simulated, or failed. `splitwise retry` re-sends a failed one after checking that Splitwise doesn't already have it.

Configure Kroger Production app credentials, Cart API access, and a `KROGER_LOCATION_ID` to use live product search and cart preparation; this must match the pickup/delivery store selected in the Kroger account. The precheck uses Kroger's Products API availability at that location and fulfillment mode, then searches that same location for suggestions. It is a point-in-time check and cannot guarantee stock at pickup. Add the exact `KROGER_REDIRECT_URI` to your Kroger app's allowed redirect URIs; for local testing it defaults to `http://127.0.0.1:3000/api/kroger/oauth/callback`. If you later deploy behind a protected public hostname, set both `GROUP_CART_PUBLIC_URL` and `KROGER_REDIRECT_URI` to matching URLs. `KROGER_CART_MODALITY` defaults to `PICKUP`; set it to `DELIVERY` if needed. The member selected in iMessage must sign in to their own Kroger account in the browser. GroupCart uses Kroger's user-authorized Cart API to add selected products by UPC and quantity; sample items without a Kroger UPC block the entire transfer. This adds items to the Kroger account but cannot read the resulting cart or place an order. Review the cart and finish checkout directly in Kroger. The dashboard reads the same SQLite cart and refreshes every 2.5 seconds. In Spectrum live mode it remains a read-only companion view; item changes, approvals, totals, and splits still come from the iMessage group. The dashboard is bound to `127.0.0.1`, so only the machine running GroupCart can open it unless you separately deploy it.

## Splitwise

After a successful checkout (in live mode, only after Kroger confirms the items were added), GroupCart logs one expense in the household's Splitwise group: the member whose Kroger account received the items paid the full total, and each member owes exactly the share GroupCart computed (shares always sum to the total to the cent). The checkout reply includes a short Splitwise summary, and the dashboard shows the latest status (`GET /api/splitwise` returns it as JSON). A Splitwise failure (bad key, rate limit, unmapped member) never undoes the checkout; it is reported and can be retried. Each checkout is logged at most once.

Set `SPLITWISE_API_KEY` (a personal API key from [secure.splitwise.com/apps](https://secure.splitwise.com/apps)), `SPLITWISE_GROUP_ID`, and `SPLITWISE_MEMBERS` (e.g. `Alex=12345,Maya=maya@example.com`, mapping each GroupCart member name to a Splitwise user id or email). In the local demo, or while these are unset, checkouts are simulated: GroupCart records and shows the expense it would have sent, but makes no Splitwise request.
## Household calendar

Open [http://127.0.0.1:3000/calendar](http://127.0.0.1:3000/calendar) (also linked from the dashboard). It shows a week view with one lane per member in their own color, shades times when two or more people are busy at once (darker as more overlap), highlights windows when everyone is free, and lists the best shared free times for the week (1 hour or longer, 8 AM–9 PM), which is handy for picking a pickup or delivery slot. Use the arrows or ←/→ to change weeks and **Today** (or `t`) to jump back.

Without Google credentials the page runs in demo mode with generated sample schedules (stable for each week). To use real calendars, create an OAuth 2.0 **Web application** client in Google Cloud, enable the Google Calendar API, register the exact `GOOGLE_REDIRECT_URI` (default `http://127.0.0.1:3000/api/google/oauth/callback`), and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Each member then presses **Connect Google Calendar** on their row and signs in with their own Google account. GroupCart requests only the `calendar.freebusy` scope, so it sees busy blocks from the primary calendar and never event titles, attendees, or details. Refresh tokens are stored in the local SQLite database and never returned by the dashboard API. If Google revokes access, the member's row shows **Reconnect**; **Disconnect** deletes the stored token and revokes it with Google. Free time is computed only from connected calendars, and the page says when some members are missing.

## Profiles, sign-in, and web chat

Each member has a profile at `/people/<id>`: a name, a photo or emoji avatar, optional pronouns (GroupCart never guesses; it uses names or they/them), a short bio, dietary notes and allergies, favorite snacks, movie and game picks, a birthday, and a payment handle such as Venmo. Open your own profile from the avatar menu in the top right to edit it.

`/chat` shows the group conversation the way iMessage does. In live mode it mirrors the iMessage group: every message from allowlisted members, GroupCart's replies, and group notifications. A message you send from the website is posted to the group as “Maya: …” and handled exactly like the same text in the group, so “2 bananas”, “cart”, and photos of bills all work. In the demo, nothing is sent anywhere.

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

## Development

```sh
npm run dev
npm run typecheck
node --import=tsx --test src/availability.test.ts   # overlap / free-time checks
```

See the [Spectrum iMessage provider guide](https://photon.codes/docs/spectrum-ts/providers/imessage) for dedicated-line and group-chat requirements.
