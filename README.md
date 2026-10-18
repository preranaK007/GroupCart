# GroupCart

GroupCart turns messages in one shared iMessage group into a persistent household grocery cart. The Spectrum agent replies in that same group, attributes requests to configured members, tracks each person's estimated share, and requires household approval before checkout. Live checkout adds the approved items to a selected member's Kroger cart; local demo checkout is simulated.

## Local demo

Without Spectrum credentials, the app starts with three demo members and a browser dashboard. Requests, prices, splits, approvals, and checkout are simulated locally.

```sh
npm install
npm run start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Data is stored in `./data/groupcart.sqlite` by default.

## Connect your Spectrum dedicated line

This project uses the Spectrum Cloud SDK (`spectrum-ts`) and its iMessage provider. Copy `.env.example` to `.env` if needed, then set the existing Spectrum project's credentials and allowlisted group members:

```env
PROJECT_ID=...
PROJECT_SECRET=...
GROUP_CART_MEMBERS=+15555550100=Alex,+15555550101=Maya
```

Keep `.env` private; never commit it or paste its secrets into chat. Start the app with `npm run start`. It handles inbound text only from configured members in iMessage group conversations, ignores direct messages and the agent's own outbound echoes, and replies in the originating group. The shared group should include the Spectrum dedicated number and each member should send at least one message so their sender identities can be allowlisted.

## Commands in the group

- Text `help`, `commands`, or `hi` for the welcome guide and examples. If a grocery search finds no match, GroupCart points you back to this guide.
- Text `dashboard` for the companion cart page link. It is bound to `127.0.0.1`, so open it on the computer running GroupCart; it is not reachable from other devices by default.
- Send one grocery item or a short list of up to five separated by commas or `and`, e.g. `2 bananas`, `Darigold 2% milk`, `bread, bananas, and eggs`, or `Vital Farms organic eggs shared with Anupritaa and Prerana`.
- Add per-item price limits such as `pasta under $5` or `pasta under $5, bread up to $3`. `Under` is strict; `up to` includes the stated price. Limited searches only offer products with a current returned store price that meets the limit.
- For a multi-item request, GroupCart searches each item at the selected Kroger-family store and lists numbered product, size, and price options for each. Reply with one number per item in order, separated by commas (e.g. `1, 2, 1`); nothing is added until all choices are selected. Say `cancel` to discard the pending search.
- If someone requests only `milk`, GroupCart asks for a kind first, then searches live store products and prices.
- Shared requests preserve named participants while the product choice is pending. If the exact same live SKU is already in GroupCart, a shared request updates its split rather than duplicating that live item.
- Recurring weekly / every-two-weeks / monthly lists: see [Recurring group lists](#recurring-group-lists) (`weekly: milk, eggs`, `lists`, `load weekly list`, `set up lists`).
- `cart` to review the current cart and estimated shares.
- `remove bread`, `cancel the eggs`, or `I don’t want bread anymore` to cancel an item. If multiple matching lines exist, choose one by number. Removing a shared item withdraws only the sender’s share; other participants keep theirs.
- `clear mine` to remove all of your own items and withdraw your share from shared items, leaving other members’ shares in place.
- `clear all` to request clearing the whole shared cart. Reply `confirm clear all` to confirm, or `cancel clear all` to abort. A changed cart requires a fresh confirmation.
- `undo` to restore the cart to the state before the most recent cart change. Undo is available for the latest 20 cart changes; each undo creates a new cart revision and resets approvals.
- `approve` to approve the current cart revision.
- In live mode, after every household member approves, `checkout` checks each selected UPC against the configured store and pickup/delivery mode. If Kroger reports unavailable products, GroupCart shows in-stock suggestions but does not substitute anything automatically. Choose a suggestion explicitly with `replace 1 with 2`; any changed cart requires everyone to approve again. Once the precheck passes, `checkout` asks whose Kroger account to use. The selected member opens Kroger sign-in and consents; GroupCart then adds the approved live Kroger UPCs to that account's cart and clears the GroupCart list only after Kroger confirms. Availability can change after the check, so verify the Kroger cart. The shopper reviews and places the order on Kroger; GroupCart never submits an order or payment. Local demo checkout remains simulated.

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

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PROJECT_ID` | Spectrum Cloud project ID | unset (local demo) |
| `PROJECT_SECRET` | Spectrum Cloud project secret | unset (local demo) |
| `GROUP_CART_MEMBERS` | Comma-separated `senderHandle=name` allowlist | demo users in local mode |
| `GROUP_CART_HOUSEHOLD` | Shared cart identity | `apartment-4b` |
| `GROUP_CART_DB` | SQLite file path | `./data/groupcart.sqlite` |
| `GROUP_CART_BUDGET_CENTS` | Sample budget in cents | `5000` |
| `PORT` | Local dashboard port | `3000` |
| `KROGER_CLIENT_ID` | Kroger Production app client ID for product search and user-authorized cart access | unset (live Kroger features disabled) |
| `KROGER_CLIENT_SECRET` | Kroger Production app client secret | unset (live Kroger features disabled) |
| `KROGER_LOCATION_ID` | Kroger-family store ID for local availability/prices | unset |
| `GROUP_CART_PUBLIC_URL` | Base URL in the Kroger sign-in link | `http://127.0.0.1:3000` |
| `KROGER_REDIRECT_URI` | OAuth callback URL registered with Kroger | dashboard URL + `/api/kroger/oauth/callback` |
| `KROGER_CART_MODALITY` | Fulfillment modality for added items (`PICKUP` or `DELIVERY`) | `PICKUP` |
| `GROUP_CART_LIST_REMINDERS` | Set to `off` to disable recurring-list check-ins (proactive and reply-attached) | on |
| `GROUP_CART_LIST_REMINDER_HOUR` | Server-local hour (0–23) on the due day after which a check-in is sent | `9` |
| `GROUP_CART_LIST_REMINDER_CHECK_MINUTES` | How often live mode checks for due lists | `15` |

## Development

```sh
npm run dev
npm run typecheck
```

See the [Spectrum iMessage provider guide](https://photon.codes/docs/spectrum-ts/providers/imessage) for dedicated-line and group-chat requirements.
