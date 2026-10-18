// Core GroupCart tools for the AI assistant connector (registered through src/platform.ts registerTools).
// Each handler runs as the household member who connected the assistant; caller.via names the assistant
// ("Claude", "ChatGPT", "Grok", or "AI assistant") for attribution.
//
// whats_on_my_plate is extensible: feature modules add their own section with
//   registerSummaryProvider("chores", (caller) => ({ dueThisWeek: [...] }))
// and it appears in the caller's summary under that key.
import { randomUUID } from "node:crypto";
import { money } from "./cart.js";
import type { CalendarService } from "./googleCalendar.js";
import type { KrogerClient } from "./kroger.js";
import { notifyGroup, recentFeed, registerTools, type ToolCaller, type ToolSpec } from "./platform.js";
import type { CartStore } from "./store.js";

export type CoreToolDeps = {
  store: CartStore;
  demoMode: boolean;
  calendar?: CalendarService;
  krogerClient?: KrogerClient;
};

export type SummaryProvider = (caller: ToolCaller) => Promise<unknown> | unknown;

const summaryProviders: Array<{ key: string; provider: SummaryProvider }> = [];

/** Adds a section (e.g. "chores", "bills") to the whats_on_my_plate summary. Keys must be unique. */
export function registerSummaryProvider(key: string, provider: SummaryProvider): void {
  if (key === "member" || key === "groceries" || summaryProviders.some((entry) => entry.key === key)) {
    throw new Error(`Duplicate summary section: ${key}`);
  }
  summaryProviders.push({ key, provider });
}

// Group-chat commands that are not "add groceries": add_to_cart and choose_product refuse them, so a
// grocery tool can never approve, check out, clear, or undo by accident.
const RESERVED_TEXT = /^(?:cart|show cart|review cart|dashboard|open dashboard|cart page|approve(?: cart)?|confirm cart|checkout|finish checkout|cancel checkout|clear\b.*|empty cart|confirm clear all|cancel clear all|yes\b.*|no|undo(?: last)?|revert(?: last change)?|splitwise\b.*|settle\b.*|calendar\b.*|(?:hi|hello|hey)(?: there)?|help|commands|menu|start|show commands|what can you do|replace\s+\d.*)[!.?]*$/i;
const CANCEL_TEXT = /^(?:cancel|never ?mind)[!.]*$/i;
const NUMBERS_ONLY = /^\s*\d{1,2}(?:\s*(?:,|\s)\s*\d{1,2})*\s*$/;
const REMOVAL_TEXT = /\b(?:remove|delete|take (?:off|out)|don'?t want|do not want|no longer (?:want|need))\b/i;

function stringArg(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = typeof args[key] === "string" ? (args[key] as string).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim() : "";
  if (!value) throw new Error(`"${key}" can't be empty.`);
  if (value.length > maxLength) throw new Error(`"${key}" must be ${maxLength} characters or fewer.`);
  return value;
}

function intArg(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`"${key}" must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

const PRICE_NOTE = "Sample-catalog prices are estimates; Kroger prices are quotes for the configured store and can change.";

export function registerCoreTools(deps: CoreToolDeps): void {
  const { store, demoMode, calendar, krogerClient } = deps;
  const cartMode = krogerClient ? "kroger" : "sample";

  async function sendCartText(caller: ToolCaller, text: string): Promise<string> {
    const messageId = `claude:${randomUUID()}`;
    const reply = krogerClient
      ? await store.processLiveIncomingText(messageId, caller.memberId, text, (query) => krogerClient.searchProducts(query), krogerClient.selectedLocationId)
      : store.processIncomingText(messageId, caller.memberId, text);
    return reply ?? "GroupCart had no reply.";
  }

  function needsChoice(reply: string): boolean {
    return /\bReply\b|which kind/i.test(reply);
  }

  function hasPendingChoice(memberId: string): boolean {
    for (const table of ["pending_product_choices", "pending_product_batches", "pending_clarifications"]) {
      try {
        if (store.database.prepare(`SELECT 1 FROM ${table} WHERE member_id = ?`).get(memberId)) return true;
      } catch {
        // Table not created in this database; nothing pending there.
      }
    }
    return false;
  }

  const tools: ToolSpec[] = [
    {
      name: "whats_on_my_plate",
      description: "Summary of what needs your attention in the household: your grocery items and share, whether the cart needs your approval, plus chores, bills, and other sections when those features are on. Start here.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, caller) => {
        const snapshot = store.snapshot();
        const me = snapshot.members.find((member) => member.id === caller.memberId);
        const mine = snapshot.items.filter((item) => item.participantIds.includes(caller.memberId));
        const summary: Record<string, unknown> = {
          member: caller.memberName,
          groceries: {
            itemsInCart: snapshot.items.length,
            yourItems: mine.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              itemTotal: money(item.totalCents),
              sharedWith: item.participantNames.filter((_, index) => item.participantIds[index] !== caller.memberId),
            })),
            yourShare: money(me?.shareCents ?? 0),
            cartTotal: money(snapshot.totalCents),
            budget: money(snapshot.budgetCents),
            approval: !snapshot.items.length
              ? "The cart is empty; nothing to approve."
              : me?.approved
                ? `You approved cart revision ${snapshot.revision}.`
                : `Needs your approval (cart revision ${snapshot.revision}). Review with view_cart, then call approve_cart.`,
            othersYetToApprove: snapshot.items.length
              ? snapshot.members.filter((member) => !member.approved && member.id !== caller.memberId).map((member) => member.name)
              : [],
          },
        };
        for (const { key, provider } of summaryProviders) {
          try {
            summary[key] = await provider(caller);
          } catch (error) {
            summary[key] = { error: `Couldn't load ${key}: ${error instanceof Error ? error.message : "unknown error"}` };
          }
        }
        return summary;
      },
    },
    {
      name: "view_cart",
      description: "Shows the shared grocery cart: every item with quantity, price, who added it and who shares it, each member's share, and who has approved the current revision.",
      inputSchema: { type: "object", properties: {} },
      handler: (_args, caller) => {
        const snapshot = store.snapshot();
        const me = snapshot.members.find((member) => member.id === caller.memberId);
        return {
          revision: snapshot.revision,
          total: money(snapshot.totalCents),
          budget: money(snapshot.budgetCents),
          overBudget: snapshot.totalCents > snapshot.budgetCents,
          priceMode: cartMode === "kroger" ? "Kroger product search" : "sample catalog",
          priceNote: PRICE_NOTE,
          items: snapshot.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unitPrice: money(item.unitPriceCents),
            total: money(item.totalCents),
            price: item.priceSource === "kroger" ? "Kroger store quote" : "sample estimate",
            addedBy: item.ownerName,
            sharedBy: item.participantNames,
          })),
          members: snapshot.members.map((member) => ({ name: member.name, share: money(member.shareCents), approved: member.approved })),
          you: { name: caller.memberName, share: money(me?.shareCents ?? 0), approved: Boolean(me?.approved) },
          ...(snapshot.items.length ? {} : { note: "The cart is empty." }),
        };
      },
    },
    {
      name: "add_to_cart",
      description: "Adds groceries to the shared cart for you, exactly as if you had texted the household group. Write it the way you'd text it: \"2 bananas\", \"oat milk for everyone\", \"eggs, bread, pasta\" (up to 5 items). With Kroger connected, GroupCart replies with numbered product options; pass your pick to choose_product.",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string", description: "What to add, in plain words. Add \"for everyone\" or \"shared with Maya\" to split an item." },
        },
        required: ["request"],
      },
      mutates: true,
      handler: async (args, caller) => {
        const text = stringArg(args, "request", 300);
        if (NUMBERS_ONLY.test(text) || CANCEL_TEXT.test(text)) {
          throw new Error("That looks like an answer to GroupCart's question. Use choose_product for numbered picks or \"cancel\".");
        }
        if (RESERVED_TEXT.test(text)) {
          throw new Error("add_to_cart only adds groceries. Use view_cart or approve_cart; checkout, clearing, and undo happen in the group chat.");
        }
        if (REMOVAL_TEXT.test(text)) {
          throw new Error("Removing items isn't available from Claude yet. Ask in the group chat (for example \"I don't want bread anymore\").");
        }
        const reply = await sendCartText(caller, text);
        return {
          reply,
          mode: cartMode,
          ...(needsChoice(reply) ? { next: "GroupCart is waiting for your choice. Call choose_product with the option number (one number per item for a multi-item list, e.g. \"1, 2, 1\"), a milk kind such as \"oat\", or \"cancel\"." } : {}),
        };
      },
    },
    {
      name: "choose_product",
      description: "Answers GroupCart's pending question after add_to_cart: a numbered product option (\"2\"), one number per item for a multi-item search (\"1, 3, 2\"), a milk kind (\"whole\", \"2%\", \"oat\", \"almond\"), or \"cancel\".",
      inputSchema: {
        type: "object",
        properties: {
          choice: { type: "string", description: "Option number(s), milk kind, or \"cancel\"." },
        },
        required: ["choice"],
      },
      mutates: true,
      handler: async (args, caller) => {
        const choice = stringArg(args, "choice", 40);
        if (!CANCEL_TEXT.test(choice) && (RESERVED_TEXT.test(choice) || REMOVAL_TEXT.test(choice))) {
          throw new Error("choose_product only answers a pending product question (a number, a milk kind, or \"cancel\").");
        }
        if (!hasPendingChoice(caller.memberId)) {
          throw new Error("GroupCart isn't waiting for a product choice from you. Call add_to_cart first.");
        }
        const reply = await sendCartText(caller, choice);
        return { reply, ...(needsChoice(reply) && hasPendingChoice(caller.memberId) ? { next: "GroupCart still needs a choice; call choose_product again." } : {}) };
      },
    },
    {
      name: "approve_cart",
      description: "Approves the current revision of the shared grocery cart as you, and tells the group (\"<your name> approved the grocery cart via <assistant>\"). Any later cart change resets approvals. Review it with view_cart first. Checkout itself still happens in the group chat.",
      inputSchema: { type: "object", properties: {} },
      mutates: true,
      handler: async (_args, caller) => {
        const before = store.snapshot();
        const me = before.members.find((member) => member.id === caller.memberId);
        if (before.items.length && me?.approved) {
          return { approved: true, revision: before.revision, message: `You already approved cart revision ${before.revision}.` };
        }
        const result = store.approveForMember(caller.memberId);
        if (!result.ok) throw new Error(result.message);
        await notifyGroup(`${caller.memberName} approved the grocery cart via ${caller.via ?? "AI assistant"}.`);
        return { approved: true, revision: store.snapshot().revision, message: result.message };
      },
    },
    {
      name: "household_members",
      description: "Lists the household members (names and ids), marks which one is you, and shows each person's grocery share and approval.",
      inputSchema: { type: "object", properties: {} },
      handler: (_args, caller) => store.snapshot().members.map((member) => ({
        id: member.id,
        name: member.name,
        you: member.id === caller.memberId,
        groceryShare: money(member.shareCents),
        approvedCurrentCart: member.approved,
      })),
    },
    {
      name: "free_times",
      description: "Finds upcoming times when everyone in the household is free (8 AM to 9 PM, at least 30 minutes), from connected Google Calendars (free/busy only) or sample schedules in the demo.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "integer", description: "How many days ahead to look (1-14, default 7)." },
          count: { type: "integer", description: "How many time windows to return (1-10, default 3)." },
        },
      },
      handler: async (args) => {
        if (!calendar) throw new Error("The household calendar isn't set up in this GroupCart.");
        const days = intArg(args, "days", 1, 14, 7);
        const count = intArg(args, "count", 1, 10, 3);
        const { times, included, total, timeZone } = await calendar.upcomingFreeTimes(Date.now(), days, count);
        const format = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        return {
          timeZone,
          source: calendar.mode === "demo" ? "sample schedules (Google Calendar not configured)" : `${included} of ${total} members' Google Calendars`,
          times: times.map((time) => ({
            start: new Date(time.start).toISOString(),
            end: new Date(time.end).toISOString(),
            label: format.formatRange(new Date(time.start), new Date(time.end)),
          })),
          ...(included === 0 ? { note: "No one has connected a calendar yet." } : times.length ? {} : { note: `No shared free window found in the next ${days} days.` }),
        };
      },
    },
    {
      name: "recent_activity",
      description: "Recent household notifications posted to the group by GroupCart features (reminders, approvals, posts from AI assistants), newest first.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", description: "How many entries (1-50, default 20)." } },
      },
      handler: (args) => {
        const entries = recentFeed(intArg(args, "limit", 1, 50, 20));
        return entries.length ? entries.map(({ at, text }) => ({ at, text })) : { entries: [], note: "No household activity yet since GroupCart started." };
      },
    },
    {
      name: "post_to_group",
      description: "Posts a message to the household group chat on your behalf, shown as \"<your name> via <assistant>: …\" (e.g. \"Maya via Claude\"). Only use it when you're asked to message the household.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "The message to post (up to 500 characters)." } },
        required: ["message"],
      },
      mutates: true,
      handler: async (args, caller) => {
        const message = stringArg(args, "message", 500).replace(/\n{3,}/g, "\n\n");
        const text = `${caller.memberName} via ${caller.via ?? "AI assistant"}: ${message}`;
        await notifyGroup(text);
        return {
          posted: text,
          delivery: demoMode
            ? "Demo mode: added to the GroupCart activity feed only; no iMessage was sent."
            : "Sent to the household iMessage group GroupCart last heard from, and added to the activity feed.",
        };
      },
    },
  ];
  registerTools(tools);
}
