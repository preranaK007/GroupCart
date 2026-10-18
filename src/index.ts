import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { startDashboard } from "./dashboard.js";
import { config, findMember, maskHandle, validateSpectrumConfig } from "./config.js";
import { KrogerClient } from "./kroger.js";
import { CalendarService, GoogleCalendarClient } from "./googleCalendar.js";
import { googleCalendarConfig } from "./config.js";
import { HouseholdGroup } from "./householdGroup.js";
import { auditGroupRoster, handleMembershipEvent, isMembershipEvent } from "./membership.js";
import { deliverDueListReminders } from "./reminders.js";
import { CartStore } from "./store.js";
import { splitwiseConfig } from "./config.js";
import { SplitwiseService } from "./splitwise.js";
import { setupConnector } from "./connector.js";
import { setupBills } from "./bills.js";
import { setupChores } from "./chores.js";
import { setupListsAndEvents } from "./listsEvents.js";
import { setupKitchen } from "./kitchen.js"; // Kitchen: pantry and meal plans
import { setupHouse } from "./house.js";
import { recordGroupMessage, registerCommand, runCommands, setGroupSender, stopSchedules, type CommandContext } from "./platform.js";
import type { HouseholdCoordinator } from "./agent/coordinator.js";
import { setupCoordinator } from "./agent/setup.js";
import { setupProfilesAndChat } from "./profilesAndChat.js";
import { setupMoneyPoints } from "./moneyPoints.js";

validateSpectrumConfig();
const liveMode = Boolean(config.spectrumProjectId && config.spectrumProjectSecret);
const members = liveMode
  ? config.allowedMembers
  : config.allowedMembers.length
    ? config.allowedMembers
    : [
        { handle: "demo:alex", name: "Alex" },
        { handle: "demo:maya", name: "Maya" },
        { handle: "demo:jordan", name: "Jordan" },
      ];

mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });
const store = new CartStore(
  config.databasePath,
  config.householdId,
  config.budgetCents,
  config.dashboardPublicUrl,
  liveMode && Boolean(config.krogerClientId && config.krogerClientSecret),
  { reminderHour: config.listReminderHour },
);
store.registerMembers(members);

// --- Splitwise: log each completed checkout as one expense (simulated in demo mode) ---
const splitwise = new SplitwiseService(store, splitwiseConfig);
store.setCheckoutHooks(splitwise);
for (const warning of splitwise.warnings) console.warn(warning);
if (liveMode && splitwise.configured) {
  void splitwise.checkConnection().then((result) => (result.ok ? console.log : console.warn)(result.message));
} else {
  console.log("Splitwise logging is simulated (demo mode or not configured); nothing is sent to Splitwise.");
}
// --- end Splitwise ---
const krogerClient = config.krogerClientId && config.krogerClientSecret
  ? new KrogerClient(config.krogerClientId, config.krogerClientSecret, config.krogerLocationId, config.krogerRedirectUri, config.krogerCartModality)
  : undefined;
// --- Google Calendar (sample schedules when GOOGLE_CLIENT_ID/SECRET are unset) ---
const calendar = new CalendarService(
  store,
  config.dashboardPublicUrl,
  googleCalendarConfig.clientId && googleCalendarConfig.clientSecret
    ? new GoogleCalendarClient(googleCalendarConfig.clientId, googleCalendarConfig.clientSecret, googleCalendarConfig.redirectUri)
    : undefined,
  { demoCalendarFile: googleCalendarConfig.demoCalendarFile }, // GROUP_CART_DEMO_CALENDAR
);
// Group-chat commands registered by feature modules run before cart processing (see src/platform.ts).
registerCommand("calendar", ({ messageId, text }) => (text ? calendar.replyToCommand(messageId, text) : null));
// --- end Google Calendar ---
// --- Claude connector: /mcp for each roommate's own Claude (src/connector.ts) ---
setupConnector({ store, demoMode: !liveMode, calendar, krogerClient, port: config.port, publicUrl: config.dashboardPublicUrl });
// --- end Claude connector ---
// --- Kitchen: pantry and weekly dinner plans (src/kitchen.ts). Registered before bills and lists/events so a
// --- “yes”/“ok” to a newer kitchen question and “plan dinners” reach it (it leaves everything else alone).
setupKitchen({ store, demoMode: !liveMode, kroger: krogerClient });
// --- end Kitchen ---
// --- Bills: capture, split, balances, reminders, Splitwise logging (src/bills.ts) ---
setupBills({ store, liveMode });
// --- end Bills ---
// --- Chores: rotations, nudges, /chores page, connector tools (src/chores.ts) ---
setupChores({ store, demoMode: !liveMode });
// --- end Chores ---
// --- Lists & events: one-off named lists, household events and plans (src/listsEvents.ts) ---
setupListsAndEvents({ store, calendar, demoMode: !liveMode, kroger: krogerClient });
// --- end Lists & events ---
// --- House: info board, repairs, guests & quiet hours, quick polls (src/house.ts) ---
setupHouse({ store, calendar, demoMode: !liveMode, publicUrl: config.dashboardPublicUrl });
// --- end House ---

// --- Shared member-message processing: the iMessage group loop and the web chat both use this, so a message
// --- sent from the website is handled exactly like the same text from that member in the group.
let coordinator: HouseholdCoordinator | null = null;
async function processMemberMessage(message: CommandContext): Promise<string | null> {
  // While a roommate has the Claude coordinator connected, it handles every message and posts its own replies.
  // (It is set up after the web chat, whose demo seed already sends messages through here.)
  if (coordinator?.status().active) {
    await coordinator.handleMessage(message);
    return null;
  }
  // Feature commands (calendar, chores, bills, ...) run before cart processing, except for the cart, sharing, and
  // recurring-list phrases the store owns (upstream), which go straight to the store.
  const commandReply = store.ownsMessage(message.text, message.memberId) ? null : await runCommands(message);
  if (commandReply) return commandReply;
  const text = message.text;
  if (!text.trim()) return null;
  if (krogerClient) {
    return store.processLiveIncomingText(
      message.messageId,
      message.memberId,
      text,
      (query) => krogerClient.searchProducts(query),
      krogerClient.selectedLocationId,
      liveMode,
      liveMode ? (items) => krogerClient.checkCartAvailability(items) : undefined,
      (productId) => krogerClient.getProduct(productId),
    );
  }
  if (liveMode && /^(checkout|finish checkout)$/i.test(text.trim())) {
    return "Kroger cart checkout is not connected because Kroger app credentials are missing. GroupCart has not placed an order or changed any Kroger cart.";
  }
  return store.processIncomingText(message.messageId, message.memberId, text);
}
// --- end shared member-message processing ---

// --- Recurring-list check-ins in the local demo (upstream behavior): nothing is sent; a due check-in is shown
// --- with the reply, labelled [Demo reminder]. The web chat records it with the reply; the feed gets it too.
async function processDemoMessage(message: CommandContext): Promise<string | null> {
  const reply = await processMemberMessage(message);
  const reminder = store.claimDueListReminders();
  if (!reminder) return reply;
  const shown = `[Demo reminder] ${reminder.text}`;
  recordGroupMessage(shown);
  return `${reply ?? "No response."}\n\n${shown}`;
}
// --- end demo check-ins ---

// --- Profiles, web sign-in, and web chat (src/profilesAndChat.ts) ---
const social = setupProfilesAndChat({
  store,
  memberConfigs: members,
  liveMode,
  databasePath: config.databasePath,
  publicUrl: config.dashboardPublicUrl,
  // Demo /api/demo-message and web chat messages go through the chat, so demo check-ins show up there.
  processMessage: liveMode ? processMemberMessage : processDemoMessage,
});
// --- end profiles, web sign-in, and web chat ---
// --- Household coordinator: one Claude for the apartment, on the connecting roommate's account (src/agent/) ---
coordinator = setupCoordinator({ store, chat: social.chat, kroger: krogerClient ?? null, port: config.port });
// --- end household coordinator ---
// --- Money & points: pay-back links, points/streaks/leaderboard, Sunday digest (src/moneyPoints.ts) ---
setupMoneyPoints({ store, demoMode: !liveMode, checkoutHooks: splitwise, paymentHandle: (memberId) => social.profiles.get(memberId)?.paymentHandle ?? "" });
// --- end money & points ---
const dashboard = startDashboard(store, config.port, !liveMode, krogerClient, calendar);

if (!liveMode) {
  console.log("Spectrum Cloud is not configured. Running the browser-based local demo; no messages are sent.");
  const shutdown = (): void => {
    stopSchedules();
    dashboard.close();
    store.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} else {
  const app = await Spectrum({
    projectId: config.spectrumProjectId!,
    projectSecret: config.spectrumProjectSecret!,
    providers: [imessage.config()],
  });

  console.log(`GroupCart is listening for iMessage group requests from ${members.length} configured household member(s).`);
  // --- One household group for everything GroupCart sends on its own (src/householdGroup.ts). The store persists
  // --- the group an allowlisted member last wrote from (upstream's rememberGroupSpace); after a restart it is
  // --- reopened with Spectrum's `imessage(app).space.get(chatGuid, { phone })`, so chore nudges, bill reminders,
  // --- list check-ins, and web chat relays all work before anyone texts again.
  const group = new HouseholdGroup(store, (ref) => imessage(app).space.get(ref.id, ref.phone ? { phone: ref.phone } : undefined));
  setGroupSender((text) => group.send(text));
  // --- Profiles & chat: sign-in codes go out as 1:1 iMessage DMs (inbound DMs are still ignored) ---
  social.useSpectrum({
    sendDirect: async (handle, text) => {
      const im = imessage(app);
      const dm = await im.space.create(await im.user(handle));
      await dm.send(text);
    },
    group,
  });
  // --- end profiles & chat ---
  const auditedSpaces = new Set<string>();

  // Recurring-list check-ins. Spectrum's cloud iMessage provider can send to an
  // existing conversation outside the reply loop via `space.get(chatGuid, { phone })`.
  // We only ever target the household group space that an allowlisted member has
  // already messaged (persisted by the loop below), and each list's reminder is
  // claimed at most once per cycle in SQLite before sending. A failed send
  // releases the claim so the next attempt (or the next group reply) delivers it.
  let reminderTimer: ReturnType<typeof setInterval> | undefined;
  if (config.listRemindersEnabled) {
    let checking = false;
    const sendDueListReminders = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        // Same persisted group as notifyGroup(); a sent check-in is mirrored into the web chat and feed.
        const result = await deliverDueListReminders(
          store,
          () => group.reminderTarget((text) => recordGroupMessage(text, { mirror: true })),
        );
        if (result.status === "sent") {
          console.log(`Sent a recurring-list check-in to the household group (${result.lists?.join(", ")}).`);
        } else if (result.status === "failed") {
          console.warn(`Could not send the recurring-list check-in; it will be retried or attached to the next group reply. ${result.error ?? ""}`);
        }
      } finally {
        checking = false;
      }
    };
    reminderTimer = setInterval(() => {
      sendDueListReminders().catch((error) => console.warn("Recurring-list check failed:", error instanceof Error ? error.message : error));
    }, config.listReminderCheckMinutes * 60_000);
    reminderTimer.unref();
  }

  try {
    for await (const [space, message] of app.messages) {
      if (message.platform !== "imessage") continue;
      const groupSpace = imessage(space);
      if (groupSpace.type !== "group") continue;
      if (!auditedSpaces.has(space.id)) {
        auditedSpaces.add(space.id);
        void auditGroupRoster(space, members, groupSpace.phone);
      }
      if (message.direction === "outbound") continue;
      // Membership events (dedicated line only) carry no `direction` and are not text, so handle them first.
      if (isMembershipEvent(message.content)) {
        try {
          await handleMembershipEvent(space, message, members, store, groupSpace.phone);
        } catch (error) {
          console.error(`Could not handle a group membership event: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        continue;
      }
      if (message.direction !== "inbound") continue;
      if (message.content.type !== "text" && message.content.type !== "attachment") continue;

      const senderHandle = message.sender?.id;
      if (!senderHandle) continue;
      const configuredMember = findMember(members, senderHandle);
      if (!configuredMember) {
        console.warn(`Ignored a group message from ${maskHandle(senderHandle)}, which is not listed in GROUP_CART_MEMBERS.`);
        continue;
      }

      const member = store.memberForHandle(configuredMember.handle);
      if (!member) continue;
      // Upstream: persist the household group an allowlisted member wrote from. Proactive messages (list
      // check-ins, notifyGroup(), web chat relays) only ever go there (src/householdGroup.ts).
      group.remember(space, groupSpace.phone);
      const content = message.content;
      const text = content.type === "text" ? content.text : "";
      // --- Profiles & chat: mirror into the web chat, process like any member message, reply (and record) ---
      const attachments = social.recordInbound({
        messageId: message.id,
        memberId: member.id,
        memberName: member.name,
        text,
        attachments: content.type === "attachment"
          ? [{ mimeType: content.mimeType, name: content.name, size: content.size, read: () => content.read() }]
          : [],
        at: message.timestamp,
      });
      const reply = await processMemberMessage({ messageId: message.id, memberId: member.id, memberName: member.name, text, attachments });
      if (!reply) continue;

      // Fallback delivery (upstream): a due list check-in not yet sent rides along with
      // this group reply (still at most once per cycle).
      const reminder = config.listRemindersEnabled ? store.claimDueListReminders() : null;
      const outgoing = reminder ? `${reply}\n\n${reminder.text}` : reply;
      try {
        await social.replyInGroup(space, outgoing);
      } catch (error) {
        if (reminder) store.releaseListReminders(reminder);
        throw error;
      }
      if (reminder) recordGroupMessage(reminder.text); // the web chat already has it as part of the reply
      // --- end profiles & chat ---
      console.log(`Replied in the household group for ${configuredMember.name}.`);
    }
  } finally {
    if (reminderTimer) clearInterval(reminderTimer);
    stopSchedules();
    dashboard.close();
    store.close();
    await app.stop();
  }
}
