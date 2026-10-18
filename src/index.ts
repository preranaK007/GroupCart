import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { startDashboard } from "./dashboard.js";
import { config, validateSpectrumConfig } from "./config.js";
import { KrogerClient } from "./kroger.js";
import { CalendarService, GoogleCalendarClient } from "./googleCalendar.js";
import { googleCalendarConfig } from "./config.js";
import { CartStore } from "./store.js";

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
// --- end Google Calendar ---
const dashboard = startDashboard(store, config.port, !liveMode, krogerClient, calendar);

if (!liveMode) {
  console.log("Spectrum Cloud is not configured. Running the browser-based local demo; no messages are sent.");
  const shutdown = (): void => {
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

  try {
    for await (const [space, message] of app.messages) {
      if (message.direction !== "inbound" || message.platform !== "imessage") continue;
      if (message.content.type !== "text") continue;
      if (imessage(space).type !== "group") continue;

      const senderHandle = message.sender?.id;
      if (!senderHandle) continue;
      const normalizedHandle = senderHandle.includes("@") ? senderHandle.toLocaleLowerCase() : senderHandle;
      const configuredMember = members.find((member) => member.handle === normalizedHandle);
      if (!configuredMember) {
        console.warn("Ignored a group message from a sender not listed in GROUP_CART_MEMBERS.");
        continue;
      }

      const member = store.memberForHandle(configuredMember.handle);
      if (!member) continue;
      // Google Calendar: "calendar" command (read-only; answered before cart processing).
      const calendarReply = await calendar.replyToCommand(message.id, message.content.text).catch((error: unknown) => {
        console.warn("Calendar command failed:", error instanceof Error ? error.message : error);
        return "I couldn’t check the household calendar just now. Please try again in a moment.";
      });
      if (calendarReply) {
        await space.responding(async () => {
          await space.send(calendarReply);
        });
        continue;
      }
      const reply = krogerClient
        ? await store.processLiveIncomingText(
          message.id,
          member.id,
          message.content.text,
          (query) => krogerClient.searchProducts(query),
          krogerClient.selectedLocationId,
          true,
          (items) => krogerClient.checkCartAvailability(items),
        )
        : /^(checkout|finish checkout)$/i.test(message.content.text.trim())
          ? "Kroger cart checkout is not connected because Kroger app credentials are missing. GroupCart has not placed an order or changed any Kroger cart."
          : store.processIncomingText(message.id, member.id, message.content.text);
      if (!reply) continue;

      await space.responding(async () => {
        await space.send(reply);
      });
      console.log(`Replied in the household group for ${configuredMember.name}.`);
    }
  } finally {
    dashboard.close();
    store.close();
    await app.stop();
  }
}
