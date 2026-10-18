import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { startDashboard } from "./dashboard.js";
import { config, findMember, maskHandle, validateSpectrumConfig } from "./config.js";
import { KrogerClient } from "./kroger.js";
import { CalendarService, GoogleCalendarClient } from "./googleCalendar.js";
import { googleCalendarConfig } from "./config.js";
import { auditGroupRoster, handleMembershipEvent, isMembershipEvent } from "./membership.js";
import { CartStore } from "./store.js";
import { splitwiseConfig } from "./config.js";
import { SplitwiseService } from "./splitwise.js";
import { registerCommand, runCommands, setGroupSender, stopSchedules, type CommandAttachment } from "./platform.js";
import { setupConnector } from "./connector.js";
import { setupBills } from "./bills.js";
import { setupChores } from "./chores.js";

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
);
// Group-chat commands registered by feature modules run before cart processing (see src/platform.ts).
registerCommand("calendar", ({ messageId, text }) => (text ? calendar.replyToCommand(messageId, text) : null));
// --- end Google Calendar ---
// --- Claude connector: /mcp for each roommate's own Claude (src/connector.ts) ---
setupConnector({ store, demoMode: !liveMode, calendar, krogerClient, port: config.port, publicUrl: config.dashboardPublicUrl });
// --- end Claude connector ---
// --- Bills: capture, split, balances, reminders, Splitwise logging (src/bills.ts) ---
setupBills({ store, liveMode });
// --- end Bills ---
// --- Chores: rotations, nudges, /chores page, connector tools (src/chores.ts) ---
setupChores({ store, demoMode: !liveMode });
// --- end Chores ---
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
  const auditedSpaces = new Set<string>();

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
      // Remember the latest group so features can post proactive updates (nudges, reminders).
      setGroupSender(async (text) => { await space.send(text); });

      const senderHandle = message.sender?.id;
      if (!senderHandle) continue;
      const configuredMember = findMember(members, senderHandle);
      if (!configuredMember) {
        console.warn(`Ignored a group message from ${maskHandle(senderHandle)}, which is not listed in GROUP_CART_MEMBERS.`);
        continue;
      }

      const member = store.memberForHandle(configuredMember.handle);
      if (!member) continue;
      const content = message.content;
      const attachments: CommandAttachment[] = content.type === "attachment"
        ? [{ mimeType: content.mimeType, name: content.name, read: () => content.read() }]
        : [];
      const commandReply = await runCommands({
        messageId: message.id,
        memberId: member.id,
        memberName: member.name,
        text: content.type === "text" ? content.text : "",
        attachments,
      });
      if (commandReply) {
        await space.responding(async () => {
          await space.send(commandReply);
        });
        continue;
      }
      if (content.type !== "text") continue;
      const reply = krogerClient
        ? await store.processLiveIncomingText(
          message.id,
          member.id,
          content.text,
          (query) => krogerClient.searchProducts(query),
          krogerClient.selectedLocationId,
          true,
          (items) => krogerClient.checkCartAvailability(items),
        )
        : /^(checkout|finish checkout)$/i.test(content.text.trim())
          ? "Kroger cart checkout is not connected because Kroger app credentials are missing. GroupCart has not placed an order or changed any Kroger cart."
          : store.processIncomingText(message.id, member.id, content.text);
      if (!reply) continue;

      await space.responding(async () => {
        await space.send(reply);
      });
      console.log(`Replied in the household group for ${configuredMember.name}.`);
    }
  } finally {
    stopSchedules();
    dashboard.close();
    store.close();
    await app.stop();
  }
}
