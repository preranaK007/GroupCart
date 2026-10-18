// The coordinator's own connector tools: tappable cards (polls, choices, link buttons), grocery lookups,
// follow-ups, and looking at photos people sent. They're ordinary connector tools, so a roommate's own
// assistant can use them too; votes and taps on these cards wake the coordinator when it is on.
import { randomUUID } from "node:crypto";
import type { ChatCard } from "../chat.js";
import type { McpContent, ToolSpec } from "../platform.js";
import type { CoordinatorChannel, HouseholdCoordinator } from "./coordinator.js";
import type { GroceryOption } from "./groceries.js";

export type CoordinatorToolDeps = {
  coordinator: HouseholdCoordinator;
  channel: CoordinatorChannel;
  findGroceries: (query: string, limit: number) => Promise<GroceryOption[]>;
  groceriesFrom: "kroger" | "sample";
  /** The images attached to a chat message. */
  photos: (messageId: number) => Promise<Array<{ mimeType: string; data: Buffer }>>;
  /** Downloads an image from a public https URL and posts it to the group with a caption. */
  postImage: (url: string, caption: string) => Promise<void>;
  /** Runs GroupCart's built-in command handling for a member's text and returns its reply (nothing is posted). */
  runCommand: (memberId: string, text: string) => Promise<string | null>;
  now?: () => Date;
};

/** Card ids start with this owner name; the card handler for it is registered in setup.ts. */
export const CARD_OWNER = "coordinator";

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const records = (value: unknown, max: number) => (Array.isArray(value) ? value : []).slice(0, max).filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");

export function coordinatorTools(deps: CoordinatorToolDeps): ToolSpec[] {
  const now = deps.now ?? (() => new Date());
  const post = async (line: string, card: ChatCard) => {
    const message = await deps.channel.post(line, card);
    return message ? { posted: true, card_id: card.id } : { posted: false, error: "The chat didn't accept the message." };
  };
  return [
    {
      name: "post_poll",
      description: "Post a tappable poll to the group chat (2–6 options). Roommates vote by tapping; the coordinator hears back when everyone has voted. For group decisions: a time, a movie, a restaurant.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "One short line above the poll, e.g. “Movie night this week? Tap what works.”" },
          question: { type: "string", description: "Short poll title, e.g. “Movie night”." },
          options: { type: "array", minItems: 2, maxItems: 6, items: { type: "object", properties: { label: { type: "string" }, detail: { type: "string", description: "Optional second line, e.g. “Everyone’s free”." } }, required: ["label"] } },
          multi: { type: "boolean", description: "True when people may pick several options (e.g. times that work). Default true." },
        },
        required: ["text", "question", "options"],
      },
      mutates: true,
      handler: async (args) => {
        const options = records(args.options, 6).map((option, index) => ({ id: `o${index + 1}`, label: text(option.label, 80), ...(option.detail ? { detail: text(option.detail, 80) } : {}) })).filter((option) => option.label);
        if (options.length < 2) throw new Error("A poll needs at least two options.");
        const question = text(args.question, 80);
        return post(text(args.text, 300) || question, { kind: "poll", id: `${CARD_OWNER}:poll:${randomUUID()}`, question, options, multi: args.multi !== false, votes: {} });
      },
    },
    {
      name: "close_poll",
      description: "Close a poll and show the result on it, e.g. after everyone voted or at a deadline.",
      inputSchema: { type: "object", properties: { card_id: { type: "string" }, result: { type: "string", description: "Short result line, e.g. “Thu 8pm”." } }, required: ["card_id", "result"] },
      mutates: true,
      handler: (args) => {
        const found = deps.channel.findCard(text(args.card_id, 200));
        if (!found || found.card.kind !== "poll") throw new Error("No such poll.");
        deps.channel.updateCard(found.messageId, { ...found.card, closed: true, result: text(args.result, 120) });
        return { closed: true };
      },
    },
    {
      name: "post_choices",
      description: "Post a card listing items (e.g. grocery products found with find_groceries) with buttons such as “Add these” (primary) and “Swap something” (secondary). The coordinator hears back when someone taps a button.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "One short line above the card." },
          title: { type: "string" },
          items: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", properties: { label: { type: "string" }, detail: { type: "string" }, price: { type: "string", description: "e.g. “$3.49”." } }, required: ["label"] } },
          actions: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: { label: { type: "string" }, style: { type: "string", enum: ["primary", "secondary"] } }, required: ["label"] } },
        },
        required: ["text", "title", "items", "actions"],
      },
      mutates: true,
      handler: async (args) => {
        const items = records(args.items, 8).map((item, index) => ({
          id: `i${index + 1}`, label: text(item.label, 80),
          ...(item.detail ? { detail: text(item.detail, 80) } : {}),
          ...(item.price ? { price: text(item.price, 16) } : {}),
        }));
        const actions = records(args.actions, 3).map((action, index) => ({ id: `a${index + 1}`, label: text(action.label, 40), style: action.style === "secondary" ? "secondary" as const : "primary" as const }));
        if (!items.length || !actions.length) throw new Error("A choices card needs items and at least one button.");
        const title = text(args.title, 80);
        return post(text(args.text, 300) || title, { kind: "choices", id: `${CARD_OWNER}:choices:${randomUUID()}`, title, items, actions });
      },
    },
    {
      name: "post_buttons",
      description: "Post a short message with link buttons, e.g. pay-back links from get_pay_links (“Pay Ashwin $24.70”). The buttons open the links.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          buttons: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", properties: { label: { type: "string" }, url: { type: "string", description: "https link." } }, required: ["label", "url"] } },
        },
        required: ["text", "buttons"],
      },
      mutates: true,
      handler: async (args) => {
        const actions = records(args.buttons, 4)
          .filter((button) => /^https:\/\/\S+$/i.test(text(button.url, 2000)))
          .map((button, index) => ({ id: `b${index + 1}`, label: text(button.label, 40), url: text(button.url, 2000), style: index === 0 ? "primary" as const : "secondary" as const }));
        if (!actions.length) throw new Error("Buttons need https links.");
        return post(text(args.text, 300), { kind: "actions", id: `${CARD_OWNER}:links:${randomUUID()}`, actions });
      },
    },
    {
      name: "find_groceries",
      description: "Look up a grocery item (“2% milk”, “flour”) and get a few candidate products with sizes and prices. Show your picks with post_choices before adding them; add confirmed picks with add_to_cart.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", description: "1–5, default 3." } }, required: ["query"] },
      handler: async (args) => ({
        source: deps.groceriesFrom === "kroger" ? "Kroger store quotes" : "sample catalog estimates (Kroger isn't connected)",
        options: await deps.findGroceries(text(args.query, 80), Number(args.limit ?? 3) || 3),
      }),
    },
    {
      name: "schedule_follow_up",
      description: "Have the household coordinator come back later on its own, e.g. to nudge people who haven't voted or to close a poll at a deadline. The note comes back as an event at that time.",
      inputSchema: { type: "object", properties: { at: { type: "string", description: "ISO 8601 time with an offset, e.g. 2026-10-20T18:00:00-07:00." }, note: { type: "string", description: "What to do then, including any card ids." } }, required: ["at", "note"] },
      mutates: true,
      handler: (args) => {
        const at = Date.parse(text(args.at, 64));
        if (!Number.isFinite(at) || at < now().getTime() - 60_000) throw new Error("Give a future ISO time with an offset.");
        deps.coordinator.scheduleFollowUp(new Date(at), text(args.note, 500));
        return { scheduled: new Date(at).toISOString() };
      },
    },
    {
      name: "run_groupcart_command",
      description: "Run one of GroupCart's built-in chat commands as the roommate you're answering, as if they had texted it, and get GroupCart's reply (nothing is posted; relay what matters). For what the other tools don't cover: sharing sessions (“start sharing with Sami”, “stop sharing”), recurring lists (“weekly: milk, eggs”, “load weekly list”), cart steps (“cart”, “approve”, “undo”, “remove eggs”), checkout, and numbered answers to GroupCart's own questions (“2”).",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "The command, written the way the roommate would text it." } }, required: ["text"] },
      mutates: true,
      handler: async (args, caller) => {
        const reply = await deps.runCommand(caller.memberId, text(args.text, 500));
        return { reply: reply ?? "(GroupCart had nothing to say to that.)" };
      },
    },
    {
      name: "post_image",
      description: "Post an image to the group chat (iMessage and the app): a GIF, a meme, or a photo, from a direct https image link (a .gif/.png/.jpg/.webp file, e.g. from media.giphy.com, i.imgur.com, upload.wikimedia.org). Use it sparingly, when it genuinely fits the moment.",
      inputSchema: { type: "object", properties: { url: { type: "string", description: "Direct https link to the image file." }, caption: { type: "string", description: "Optional short line to go with it." } }, required: ["url"] },
      mutates: true,
      handler: async (args) => {
        await deps.postImage(text(args.url, 2000), text(args.caption, 300));
        return { posted: true };
      },
    },
    {
      name: "view_photo",
      description: "Look at the photos attached to a group chat message (e.g. a bill or receipt someone sent). Message ids appear in the chat transcript.",
      inputSchema: { type: "object", properties: { message_id: { type: "number" } }, required: ["message_id"] },
      handler: async (args) => {
        const photos = await deps.photos(Number(args.message_id));
        if (!photos.length) throw new Error("That message has no photos.");
        const content: McpContent[] = photos.map((photo) => ({ type: "image", mimeType: photo.mimeType, data: photo.data.toString("base64") }));
        return { mcpContent: [{ type: "text", text: `${photos.length} photo(s) from message ${Number(args.message_id)}.` }, ...content] };
      },
    },
  ];
}

