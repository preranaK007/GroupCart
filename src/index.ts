import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { startDashboard } from "./dashboard.js";
import { config, validateSpectrumConfig } from "./config.js";
import { KrogerClient } from "./kroger.js";
import { deliverDueListReminders } from "./reminders.js";
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
  { reminderHour: config.listReminderHour },
);
store.registerMembers(members);
const krogerClient = config.krogerClientId && config.krogerClientSecret
  ? new KrogerClient(config.krogerClientId, config.krogerClientSecret, config.krogerLocationId, config.krogerRedirectUri, config.krogerCartModality)
  : undefined;
const dashboard = startDashboard(store, config.port, !liveMode, krogerClient);

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
        const result = await deliverDueListReminders(
          store,
          (ref) => imessage(app).space.get(ref.id, ref.phone ? { phone: ref.phone } : undefined),
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
      store.rememberGroupSpace(space.id, imessage(space).phone);
      const reply = krogerClient
        ? await store.processLiveIncomingText(
          message.id,
          member.id,
          message.content.text,
          (query) => krogerClient.searchProducts(query),
          krogerClient.selectedLocationId,
          true,
          (items) => krogerClient.checkCartAvailability(items),
          (productId) => krogerClient.getProduct(productId),
        )
        : /^(checkout|finish checkout)$/i.test(message.content.text.trim())
          ? "Kroger cart checkout is not connected because Kroger app credentials are missing. GroupCart has not placed an order or changed any Kroger cart."
          : store.processIncomingText(message.id, member.id, message.content.text);
      if (!reply) continue;

      // Fallback delivery: a due list check-in not yet sent rides along with
      // this group reply (still at most once per cycle).
      const reminder = config.listRemindersEnabled ? store.claimDueListReminders() : null;
      const outgoing = reminder ? `${reply}\n\n${reminder.text}` : reply;
      try {
        await space.responding(async () => {
          await space.send(outgoing);
        });
      } catch (error) {
        if (reminder) store.releaseListReminders(reminder);
        throw error;
      }
      console.log(`Replied in the household group for ${configuredMember.name}.`);
    }
  } finally {
    if (reminderTimer) clearInterval(reminderTimer);
    dashboard.close();
    store.close();
    await app.stop();
  }
}
