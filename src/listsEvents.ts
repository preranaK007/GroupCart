// Wires grocery lists (staples + one-off lists) and household events/plans into the
// app through src/platform.ts: group-chat commands, dashboard routes (/api/lists*,
// /api/events*), Claude connector tools, background schedules, help lines, and the
// demo seed. index.ts calls setupListsAndEvents(...) once.
import type { IncomingMessage, ServerResponse } from "node:http";
import { addDays, localDate } from "./availability.js";
import { EventsService, durationLabel, planShape, type EventKind, type EventRecord, type PollView } from "./events.js";
import {
  ACTIVITIES, activityByKey, detectActivity, formatDay, formatSlot, matchPlanningIntent, nextMonthDay, nextWeekdayDate, parseDayHint,
  parseDuration, parseRsvp, parseVote, parseWhen, pickEmoji, splitEmoji, type RsvpStatus,
} from "./eventsParse.js";
import { CalendarService } from "./googleCalendar.js";
import type { KrogerClient } from "./kroger.js";
import {
  ListsService, cadenceLabel, cartPromptAt, parseCadence, parseWho, resolveMemberNames, type CadenceUnit, type ListView, type StapleView, type Who,
} from "./lists.js";
import { notifyGroup, registerCommand, registerHelp, registerRoute, registerTools, scheduleEvery, type CommandContext, type ToolCaller } from "./platform.js";
import type { CartStore } from "./store.js";

export type ListsEventsOptions = {
  store: CartStore;
  calendar?: CalendarService;
  demoMode: boolean;
  kroger?: KrogerClient;
  now?: () => number;
};

export function setupListsAndEvents(options: ListsEventsOptions): { lists: ListsService; events: EventsService } {
  const { store, demoMode } = options;
  const timeZone = CalendarService.serverTimeZone();
  const lists = new ListsService(store, { timeZone, kroger: options.kroger, notify: notifyGroup, now: options.now });
  const events = new EventsService(store, { calendar: options.calendar, lists, timeZone, notify: notifyGroup, now: options.now });
  const chat = new ChatCommands(store, lists, events);

  registerCommand("events", (context) => chat.events(context));
  registerCommand("lists", (context) => chat.lists(context));
  registerRoute((request, response, url) => handleRoutes({ store, lists, events, demoMode }, request, response, url));
  registerTools(buildTools(store, lists, events));
  registerHelp("Staples: “add staple milk every week” (add “shared” or “for Maya”), “staples”, “remove staple milk”.");
  registerHelp("Lists: “new list party run: chips, soda”, “add salsa to party run”, “party run to cart”, “lists”.");
  registerHelp("Events: “add event house meeting Sunday 7pm”, “events”, “plan house meeting 1h” (reply 1–3 to book), “cancel event house meeting”.");
  registerHelp("Plans: say “we all want to watch a movie” or “game night this week?” and vote with numbers (“1 3”, “can’t do 2”); “book 2” decides. Movies: “add movie Dune”, “vote Dune”. RSVP: “I’m in” / “can’t make it”.");
  scheduleEvery("staples", 60_000, async () => { await lists.runDueStaples(); });
  scheduleEvery("event reminders", 60_000, async () => { await events.runReminders(); });
  if (demoMode) void seedDemo(store, lists, events).catch((error) => console.warn("Lists/events demo seed failed:", error instanceof Error ? error.message : error));
  return { lists, events };
}

// ---------------------------------------------------------------------------
// Group chat

const normalize = (text: string) => text.trim().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
const lower = (text: string) => (/^(?:Today|Tomorrow)$/.test(text) ? text.toLowerCase() : text);
const splitItems = (text: string) => text.split(/\s*(?:,|;|\n|\band\b)\s*/i).map((item) => item.trim()).filter(Boolean);

class ChatCommands {
  constructor(private readonly store: CartStore, private readonly listsService: ListsService, private readonly eventsService: EventsService) {}

  /** Replays a recorded reply for a redelivered message; otherwise runs `handler` and records its reply. */
  async #once(context: CommandContext, handler: () => Promise<string | null> | string | null): Promise<string | null> {
    if (!context.text.trim()) return null;
    const recorded = this.store.recordedReply(context.messageId);
    if (recorded !== undefined) return recorded;
    const reply = await handler();
    if (reply) this.store.recordCommandReply(context.messageId, reply);
    return reply;
  }

  // --- Lists ---------------------------------------------------------------

  async lists(context: CommandContext): Promise<string | null> {
    return this.#once(context, () => this.#lists(context));
  }

  async #lists(context: CommandContext): Promise<string | null> {
    const text = normalize(context.text);
    const lists = this.listsService;
    const members = lists.members();
    let match: RegExpMatchArray | null;

    if (/^(?:staples|my staples|show staples|list staples|staple list|our staples)[?!.]*$/i.test(text)) return this.#staplesText();

    if ((match = text.match(/^add (?:a |new )?staples?:?\s+(.+)$/i))) {
      let body = match[1]!;
      let startDate: string | null = null;
      const start = body.match(/\b(?:starting|from|beginning)\s+(.+)$/i);
      if (start) {
        const when = parseWhen(start[1]!, lists.today(), 0);
        if (when.date) { startDate = when.date; body = body.slice(0, start.index); }
      }
      const cadence = parseCadence(body);
      const who = parseWho(cadence.rest, members, context.memberId);
      const created = lists.addStaple({ name: who.rest.replace(/^(?:a|an|some)\s+/i, ""), cadence: cadence.cadence, who: who.who, createdBy: context.memberId, startDate });
      if (!created.ok) return created.error;
      const staple = created.staple;
      const forText = staple.everyone ? "shared" : `for ${lists.whoLabel({ everyone: false, memberIds: staple.memberIds })}`;
      const head = `🔁 ${staple.name} · ${staple.cadence.toLowerCase()} · ${forText}.`;
      if (lists.isDue(staple)) {
        const result = await lists.processStaple(staple);
        const next = lists.getStaple(staple.id);
        const nextText = next ? ` Next: ${formatDay(next.nextDate, lists.today())}.` : "";
        if (result.kind === "added") return `${head} Added to the cart now.${nextText}`;
        if (result.kind === "in_cart") return `${head} Already in the cart.${nextText}`;
        if (result.kind === "deferred") return `${head} I’ll add it after ${lists.memberName(staple.requesterId)}’s open grocery question is answered.`;
        return `${head}${result.line ? `\n${result.line}` : ""}`;
      }
      return `${head} First add: ${formatDay(staple.nextDate, lists.today())}.`;
    }

    if ((match = text.match(/^(?:remove|delete|stop|cancel|drop) (?:the |my |our )?staple:?\s+(.+?)[.!]*$/i)) || (match = text.match(/^(?:remove|delete|stop) (.+?) (?:from|off) (?:the |my |our )?staples[.!]*$/i))) {
      const found = this.#pickStaple(match[1]!, context.memberId);
      if (typeof found === "string") return found;
      lists.removeStaple(found.id);
      return `Removed the ${found.name.toLowerCase()} staple${found.everyone ? "" : ` for ${lists.whoLabel({ everyone: false, memberIds: found.memberIds })}`}.`;
    }

    if ((match = text.match(/^skip (?:the )?(?:next )?staple:?\s+(.+?)[.!]*$/i)) || (match = text.match(/^skip (.+?) (?:this|next) (?:week|time|month)[.!]*$/i))) {
      const found = this.#pickStaple(match[1]!, context.memberId);
      if (typeof found === "string") return found;
      const skipped = lists.skipStaple(found.id);
      return skipped ? `Skipped. ${skipped.name} is next added ${formatDay(skipped.nextDate, lists.today())}.` : null;
    }

    if ((match = text.match(/^(?:new|create|make|start) (?:a )?list:?\s+(.+)$/i))) {
      const [rawName, rawItems] = splitOnce(match[1]!);
      const personal = /\b(?:just for me|for me|just me|mine)\b/i.test(rawName);
      const parsedWho = personal ? null : parseWho(rawName, members, context.memberId);
      const who: Who = personal ? { everyone: false, memberIds: [context.memberId] } : parsedWho!.found ? parsedWho!.who : { everyone: true, memberIds: [] };
      const name = (personal ? rawName.replace(/\b(?:just for me|for me|just me|mine)\b/gi, " ") : parsedWho!.rest).replace(/\b(?:called|named)\b/gi, " ").replace(/\s+/g, " ").trim();
      const created = lists.createList({ name, items: rawItems ? splitItems(rawItems) : [], who, createdBy: context.memberId });
      if (!created.ok) return created.error;
      return `📝 ${created.list.name}${created.list.items.length ? `: ${created.list.items.map((item) => item.name.toLowerCase()).join(", ")}` : " is ready"}. Add more with “add salsa to ${created.list.name.toLowerCase()}”; send it with “${created.list.name.toLowerCase()} to cart”.`;
    }

    if (/^(?:lists|my lists|show lists|our lists|grocery lists|show my lists)[?!.]*$/i.test(text)) return this.#listsText();

    if ((match = text.match(/^(?:move |send |add |put )?(?:the |our |my )?(.+?)(?: list)? (?:to|in|into|on) (?:the )?cart[.!]*$/i))) {
      const list = lists.findList(match[1]!);
      if (!list) return null;
      const result = await lists.moveToCart(list.id, context.memberId);
      return result.message;
    }

    if ((match = text.match(/^(?:add|put) (.+?) (?:to|on|onto) (?:the |our |my )?(.+?)(?: list)?[.!]*$/i))) {
      const list = lists.findList(match[2]!);
      if (!list) return null;
      const added = lists.addItems(list.id, splitItems(match[1]!), context.memberId);
      const updated = lists.getList(list.id)!;
      if (!added.length) return `${match[1]} is already on ${list.name}.`;
      return `📝 ${updated.name}: ${updated.items.filter((item) => !item.checked).map((item) => item.name.toLowerCase()).join(", ")}.`;
    }

    if ((match = text.match(/^(?:remove|delete|take|drop) (.+?) (?:from|off|off of) (?:the |our |my )?(.+?)(?: list)?[.!]*$/i))) {
      const list = lists.findList(match[2]!);
      if (!list) return null;
      const removed = lists.removeItems(list.id, splitItems(match[1]!));
      if (!removed.length) return `I couldn’t find ${match[1]} on ${list.name}.`;
      const updated = lists.getList(list.id)!;
      return `Removed ${removed.map((name) => name.toLowerCase()).join(", ")}. ${updated.name}: ${updated.items.filter((item) => !item.checked).map((item) => item.name.toLowerCase()).join(", ") || "empty"}.`;
    }

    if ((match = text.match(/^(?:check off|check|got|bought|done with) (.+?) (?:on|from|in|off) (?:the |our |my )?(.+?)(?: list)?[.!]*$/i))) {
      const list = lists.findList(match[2]!);
      if (!list) return null;
      const names = splitItems(match[1]!).map((name) => name.toLowerCase());
      const items = list.items.filter((item) => names.some((name) => item.name.toLowerCase().includes(name)));
      if (!items.length) return `I couldn’t find ${match[1]} on ${list.name}.`;
      for (const item of items) lists.setItemChecked(item.id, true);
      return `✓ ${items.map((item) => item.name.toLowerCase()).join(", ")}. ${lists.getList(list.id)!.remaining} left on ${list.name}.`;
    }

    if ((match = text.match(/^(?:delete|remove|clear|archive) (?:the )?list:?\s+(.+?)[.!]*$/i))) {
      const list = lists.findList(match[1]!);
      if (!list) return `I couldn’t find a list called “${match[1]}”.`;
      lists.deleteList(list.id);
      return `Deleted ${list.name}.`;
    }

    if ((match = text.match(/^(?:show|view|open|what'?s on|whats on) (?:the |our |my )?(.+?)(?: list)?[?!.]*$/i))) {
      const list = lists.findList(match[1]!);
      if (!list) return null;
      return this.#listText(list);
    }
    return null;
  }

  /** Finds one staple by name ("coffee", "coffee for Maya"), preferring the sender's own. */
  #pickStaple(query: string, memberId: string): StapleView | string {
    const lists = this.listsService;
    const who = parseWho(query, lists.members(), memberId);
    let found = lists.findStaples(who.rest);
    if (!found.length) return `I couldn’t find a staple called “${who.rest}”. Text “staples” to see them.`;
    if (who.found) found = found.filter((staple) => staple.everyone === who.who.everyone && (staple.everyone || who.who.memberIds.every((id) => staple.memberIds.includes(id))));
    else if (found.length > 1) {
      const mine = found.filter((staple) => !staple.everyone && staple.memberIds.length === 1 && staple.memberIds[0] === memberId);
      if (mine.length === 1) found = mine;
    }
    if (found.length === 1) return found[0]!;
    if (!found.length) return `I couldn’t find that staple. Text “staples” to see them.`;
    return `Which one? ${found.map((staple) => `${staple.name.toLowerCase()} ${staple.everyone ? "shared" : `for ${lists.whoLabel({ everyone: false, memberIds: staple.memberIds })}`}`).join(", ")}.`;
  }

  #staplesText(): string {
    const lists = this.listsService;
    const staples = lists.listStaples();
    if (!staples.length) return "No staples yet. Add one: “add staple milk every week” (or “paper towels monthly shared”).";
    const today = lists.today();
    const lines = staples.map((staple) => `• ${staple.name} · ${staple.cadence.toLowerCase()} · ${staple.everyone ? "shared" : lists.whoLabel({ everyone: false, memberIds: staple.memberIds })} · next ${lower(formatDay(staple.nextDate, today))}`);
    return `🔁 Staples:\n${lines.join("\n")}`;
  }

  #listText(list: ListView): string {
    const open = list.items.filter((item) => !item.checked).map((item) => item.name.toLowerCase());
    const done = list.items.length - open.length;
    return `📝 ${list.name}: ${open.join(", ") || "all done"}${done ? ` (${done} done)` : ""}.${open.length ? ` “${list.name.toLowerCase()} to cart” adds the rest.` : ""}`;
  }

  #listsText(): string {
    const all = this.listsService.allLists();
    if (!all.length) return "No lists yet. Start one: “new list party run: chips, soda, cups”.";
    return `📝 Lists:\n${all.slice(0, 8).map((list) => `• ${list.emoji ? `${list.emoji} ` : ""}${list.name} · ${list.remaining ? `${list.remaining} left` : "done"}${list.remaining ? `: ${list.items.filter((item) => !item.checked).slice(0, 5).map((item) => item.name.toLowerCase()).join(", ")}` : ""}`).join("\n")}`;
  }

  // --- Events and plans ------------------------------------------------------

  async events(context: CommandContext): Promise<string | null> {
    return this.#once(context, () => this.#events(context));
  }

  async #events(context: CommandContext): Promise<string | null> {
    const text = normalize(context.text);
    const events = this.eventsService;
    const memberId = context.memberId;
    let match: RegExpMatchArray | null;

    if (/^(?:events|upcoming|upcoming events|what'?s (?:coming )?up|whats up next|house events|calendar events|our events|plans)[?!.]*$/i.test(text)) return this.#upcomingText();

    if ((match = text.match(/^(?:add|new|create|schedule) (?:an? |the )?event:?\s+(.+)$/i))) return this.#addEvent(match[1]!, memberId);

    if ((match = text.match(/^(?:cancel|delete|remove|call off) (?:the )?event:?\s+(.+?)[.!]*$/i))) {
      const found = events.findEvents(match[1]!);
      if (!found.length) return `I couldn’t find an event called “${match[1]}”. Text “events” to see what’s planned.`;
      const sorted = found.map((event) => ({ event, next: events.nextOccurrence(event) })).sort((a, b) => (a.next?.start ?? Infinity) - (b.next?.start ?? Infinity));
      const titles = new Set(sorted.map(({ event }) => event.title.toLowerCase()));
      if (titles.size > 1) return `Which one? ${[...titles].join(", ")}.`;
      const target = sorted[0]!.event;
      events.cancel(target.id);
      return `Cancelled ${target.emoji} ${target.title}${target.recurrence !== "none" ? ` (the ${target.recurrence} series)` : sorted[0]!.next ? ` (${sorted[0]!.next.label})` : ""}.`;
    }

    if ((match = text.match(/^plan(?: a| an| our)?\s+(.+?)[.!?]*$/i))) return this.#plan(match[1]!, memberId, "pick");
    if ((match = text.match(/^(?:poll|vote on|let'?s vote on)(?: a| an| the)?\s+(.+?)[.!?]*$/i))) return this.#plan(match[1]!, memberId, "vote");

    if (/^(?:cancel|close|stop|end|drop) (?:the )?(?:poll|plan|vote|voting|planning)[.!]*$/i.test(text)) {
      const poll = this.#currentPoll(memberId);
      if (!poll) return "There’s no open plan.";
      if (poll.organizerId && poll.organizerId !== memberId) return `Only ${events.memberName(poll.organizerId)} can cancel this plan.`;
      events.cancelPoll(poll.id);
      return `Cancelled the ${poll.emoji} ${poll.title} plan.`;
    }

    if ((match = text.match(/^book\s+(?:option\s+)?#?(\d)[.!]*$/i))) {
      const poll = this.#currentPoll(memberId);
      if (!poll) return "There’s no open plan to book. Start one with “plan game night” or “movie night this week?”.";
      if (poll.mode === "vote" && poll.organizerId && poll.organizerId !== memberId) return `${events.memberName(poll.organizerId)} started this plan, so they can “book” it. Vote with the number instead.`;
      const booked = events.book(poll.id, Number(match[1]), memberId);
      return booked.ok ? events.announcement(booked.event) : booked.error;
    }

    if (/^(?:suggest (?:a |some )?movies?|movie ideas|movies|movie list|watchlist|what should we watch|any movie ideas)[?!.]*$/i.test(text)) return events.ideasLine("movie");
    if ((match = text.match(/^(?:add|suggest) (?:a )?movie:?\s+(.+)$/i))) {
      const added = events.addIdea("movie", match[1]!, memberId);
      if (!added.ok) return added.error;
      return `${added.added ? `🍿 Added ${added.idea.title}.` : `🍿 ${added.idea.title} is already on the list.`}\n${events.ideasLine("movie")}`;
    }
    if ((match = text.match(/^(?:remove|delete) (?:the )?movie:?\s+(.+?)[.!]*$/i))) {
      const idea = events.findIdea("movie", match[1]!);
      if (!idea) return `“${match[1]}” isn’t on the movie list.`;
      events.removeIdea(idea.id);
      return `Removed ${idea.title}.`;
    }
    if ((match = text.match(/^(?:vote|vote for|i vote for|i vote)\s+(.+?)[.!]*$/i)) && !/^#?\d/.test(match[1]!)) {
      const idea = events.findIdea("movie", match[1]!);
      if (idea) {
        events.voteIdea(idea.id, memberId);
        return `🍿 Vote counted for ${idea.title}.\n${events.ideasLine("movie")}`;
      }
    }

    const rsvp = parseRsvp(text);
    if (rsvp) return this.#rsvp(rsvp.status, rsvp.hint, memberId);

    const voteReply = this.#vote(text, memberId);
    if (voteReply) return voteReply;

    const intent = matchPlanningIntent(text, events.today());
    if (intent) {
      const shape = planShape(intent.match.activity.key, { label: intent.match.label, emoji: intent.match.emoji, minutes: intent.durationMin });
      const created = await events.createPoll({ shape, organizerId: memberId, mode: "vote", dates: intent.dates, durationMin: intent.durationMin });
      if (!created.ok) return created.error;
      const extra = shape.kind === "movie" ? `\n🍿 Got a movie in mind? “add movie <title>”` : "";
      return `${events.pollText(created.poll, created.basis)}${extra}`;
    }
    return null;
  }

  /** The poll a bare number from this member is most likely about. */
  #currentPoll(memberId: string): PollView | undefined {
    const open = this.eventsService.openPolls();
    const picks = open.filter((poll) => poll.mode === "pick" && poll.organizerId === memberId);
    const votes = open.filter((poll) => poll.mode === "vote");
    return [...picks, ...votes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  #vote(text: string, memberId: string): string | null {
    const events = this.eventsService;
    const poll = this.#currentPoll(memberId);
    if (!poll) {
      // A late vote right after a plan was booked: point to the booked event instead of the cart.
      const booked = events.recentlyBooked();
      const event = booked?.eventId ? events.getEvent(booked.eventId) : undefined;
      if (!booked || !event || !parseVote(text, booked.options.length) || cartPromptAt(this.listsService.database, memberId)) return null;
      return `${event.emoji} ${event.title} is already booked: ${events.nextOccurrence(event)?.label ?? "soon"}. Reply “I’m in” or “can’t make it”.`;
    }
    const parsed = parseVote(text, poll.options.length);
    if (!parsed) return null;
    // A grocery question asked after this poll owns bare numbers ("2" = the second product).
    const askedAt = cartPromptAt(this.listsService.database, memberId);
    if (askedAt && askedAt > poll.createdAt && /^\s*\d\s*$/.test(text)) return null;
    if (poll.mode === "pick") {
      if (parsed.yes.length !== 1) return `Reply with one number (1–${poll.options.length}) to book ${poll.title}.`;
      const booked = events.book(poll.id, parsed.yes[0]!, memberId);
      return booked.ok ? events.announcement(booked.event, "is booked") : booked.error;
    }
    const result = events.vote(poll.id, memberId, parsed);
    if (result.booked) return events.announcement(result.booked);
    const name = events.memberName(memberId);
    const mine = [...parsed.yes.map((n) => `${n} ✓`), ...parsed.no.map((n) => `${n} ✗`)].join(" ");
    const waiting = result.poll.attendeeIds.filter((id) => !result.poll.responded.includes(id)).map((id) => events.memberName(id));
    return `${poll.emoji} ${name}: ${mine}. Votes — ${events.tallyLine(result.poll)}${waiting.length ? ` · waiting on ${waiting.join(", ")}` : ""}`;
  }

  #rsvp(status: RsvpStatus, hint: string | null, memberId: string): string | null {
    const events = this.eventsService;
    let target: EventRecord | undefined;
    if (hint) target = events.findEvents(hint)[0];
    if (!target) {
      // Prefer a social event booked in the last day (people answer the announcement), else the soonest one.
      const social = events.upcoming(20, 14).filter((occurrence) => occurrence.kind !== "house").map((occurrence) => events.getEvent(occurrence.eventId)).filter((event): event is EventRecord => Boolean(event));
      const recent = social.filter((event) => events.now() - Date.parse(event.createdAt) < 86_400_000).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      target = recent ?? social[0];
    }
    if (!target) {
      const poll = this.#currentPoll(memberId);
      if (poll && poll.mode === "vote") return `${poll.emoji} ${poll.title} isn’t booked yet. Which times work? ${poll.options.map((option) => `${option.index}) ${option.label}`).join(" ")}`;
      return null;
    }
    events.setRsvp(target.id, memberId, status);
    return events.rsvpLine(target);
  }

  async #addEvent(body: string, memberId: string): Promise<string> {
    const events = this.eventsService;
    const now = events.now();
    const today = events.today();
    const parsed = parseWhen(body, today, minutesNow(now, events.timeZone));
    if (!parsed.title) return "What’s the event called? e.g. “add event house meeting Sunday 7pm”.";
    if (!parsed.date) return `When is ${parsed.title.toLowerCase()}? e.g. “add event ${parsed.title.toLowerCase()} Sunday 7pm” or “… on the 1st monthly”.`;
    const created = events.create({
      title: parsed.title,
      date: parsed.date,
      endDate: parsed.endDate,
      startMin: parsed.startMin,
      durationMin: parsed.durationMin,
      recurrence: parsed.recurrence,
    }, memberId);
    if (!created.ok) return created.error;
    return events.announcement(created.event, "is set");
  }

  async #plan(body: string, memberId: string, mode: "pick" | "vote"): Promise<string> {
    const events = this.eventsService;
    const today = events.today();
    const durationMin = parseDuration(body);
    const dates = parseDayHint(body, today);
    const cleaned = body
      .replace(/\bfor\s+(?:an?\s+hour(?:\s+and\s+a\s+half)?|half\s+an\s+hour|\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|m|mins?|minutes?))\b/gi, " ")
      .replace(/\b\d+(?:\.\d+)?\s*(?:h|hrs?|hours?)(?:\s*\d+\s*(?:m|mins?|minutes?))?\b|\b\d+\s*(?:m|mins?|minutes?)\b/gi, " ")
      .replace(/\b(?:tonight|today|tomorrow|this weekend|weekend|next week|this week|(?:this |next |on )?(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?)\b/gi, " ")
      .replace(/\s+/g, " ").trim();
    const split = splitEmoji(cleaned);
    const activity = detectActivity(split.title);
    const title = split.title ? split.title.charAt(0).toUpperCase() + split.title.slice(1) : activity?.label ?? "House meeting";
    const shape = planShape(activity?.activity.key ?? "house", { label: title, emoji: split.emoji ?? activity?.emoji ?? pickEmoji(title), minutes: durationMin });
    const created = await events.createPoll({ shape, title, organizerId: memberId, mode, dates, durationMin });
    if (!created.ok) return created.error;
    return events.pollText(created.poll, created.basis);
  }

  #upcomingText(): string {
    const events = this.eventsService;
    const seen = new Set<string>();
    const upcoming = events.upcoming(20, 21).filter((occurrence) => !seen.has(occurrence.eventId) && seen.add(occurrence.eventId)).slice(0, 6);
    const polls = events.openPolls("vote");
    const lines: string[] = [];
    if (upcoming.length) {
      lines.push("📅 Coming up:");
      for (const occurrence of upcoming) {
        const going = Object.values(occurrence.rsvps).filter((status) => status === "going").length;
        lines.push(`• ${occurrence.emoji} ${occurrence.title} · ${occurrence.label}${occurrence.recurrence !== "none" ? ` (${occurrence.recurrence})` : ""}${occurrence.kind !== "house" && going ? ` · ${going} going` : ""}`);
      }
    }
    for (const poll of polls) lines.push(`🗳️ ${poll.emoji} ${poll.title}: ${poll.options.map((option) => `${option.index}) ${option.label} (${option.yes.length})`).join(" ")}`);
    if (!lines.length) return "Nothing planned. Try “add event house meeting Sunday 7pm” or “game night this week?”.";
    return lines.join("\n");
  }
}

function splitOnce(text: string): [string, string] {
  const colon = text.match(/^(.+?)\s*(?::|—|–| - |\bwith\b)\s*(.*)$/i);
  return colon ? [colon[1]!, colon[2]!] : [text, ""];
}

function minutesNow(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(now));
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24 * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}

// ---------------------------------------------------------------------------
// HTTP routes (loopback dashboard). POSTs are JSON-only and same-origin.

type RouteContext = { store: CartStore; lists: ListsService; events: EventsService; demoMode: boolean };

function sendJson(response: ServerResponse, status: number, value: unknown): true {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
  return true;
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 16_384) { reject(new Error("Request body is too large.")); request.destroy(); }
    });
    request.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {});
      } catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}

/** Rejects cross-site browser POSTs: require JSON (forces a CORS preflight) and a same-host Origin when present. */
function isSameOriginJson(request: IncomingMessage): boolean {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

const str = (value: unknown, max = 200): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const int = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];

function stapleJson(lists: ListsService, staple: StapleView) {
  return { ...staple, who: staple.everyone ? "Everyone" : lists.whoLabel({ everyone: false, memberIds: staple.memberIds }) };
}

function listJson(lists: ListsService, events: EventsService, list: ListView) {
  const event = list.eventId ? events.getEvent(list.eventId) : undefined;
  const next = event ? events.nextOccurrence(event) : null;
  return { ...list, event: event ? { id: event.id, title: event.title, emoji: event.emoji, label: next?.label ?? null } : null };
}

function pollJson(poll: PollView, timeZone: string, today: string) {
  return { ...poll, options: poll.options.map((option) => ({ ...option, range: formatSlot(option.start, option.end, timeZone, today) })) };
}

async function handleRoutes(context: RouteContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/lists") && !path.startsWith("/api/events")) return false;
  const { lists, events, demoMode } = context;
  const members = lists.members();
  const today = events.today();

  if (request.method === "GET") {
    if (path === "/api/lists") {
      return sendJson(response, 200, {
        demoMode, mode: lists.mode, timeZone: lists.timeZone, today, members,
        staples: lists.listStaples().map((staple) => stapleJson(lists, staple)),
        lists: lists.allLists().map((list) => listJson(lists, events, list)),
      });
    }
    if (path === "/api/events") {
      const now = events.now();
      const from = Number(url.searchParams.get("from")) || now - 7 * 86_400_000;
      const to = Number(url.searchParams.get("to")) || now + 14 * 86_400_000;
      if (to <= from || to - from > 62 * 86_400_000) return sendJson(response, 400, { error: "Choose a range up to 62 days." });
      return sendJson(response, 200, {
        demoMode, timeZone: events.timeZone, now, today, members, calendarMode: events.calendarMode,
        occurrences: events.occurrences(from, to),
        polls: events.openPolls("vote").map((poll) => pollJson(poll, events.timeZone, today)),
      });
    }
    if (path === "/api/events/upcoming") {
      let nextFree: { start: number; end: number } | null = null;
      let freeBasis = { included: 0, total: members.length };
      if (events.calendar) {
        try {
          const free = await events.calendar.upcomingFreeTimes(events.now(), 7, 1);
          nextFree = free.times[0] ?? null;
          freeBasis = { included: free.included, total: free.total };
        } catch (error) {
          console.warn("Could not load free times:", error instanceof Error ? error.message : error);
        }
      }
      return sendJson(response, 200, {
        demoMode, timeZone: events.timeZone, now: events.now(), today, members,
        events: events.upcoming(4, 30),
        polls: events.openPolls("vote").map((poll) => pollJson(poll, events.timeZone, today)),
        nextFree: nextFree ? { ...nextFree, label: formatSlot(nextFree.start, nextFree.end, events.timeZone, today) } : null,
        freeBasis, calendarMode: events.calendarMode,
      });
    }
    if (path === "/api/events/detail") {
      const detail = events.detail(url.searchParams.get("id") ?? "");
      if (!detail) return sendJson(response, 404, { error: "That event no longer exists." });
      const poll = detail.event.pollId ? events.getPoll(detail.event.pollId) : undefined;
      return sendJson(response, 200, {
        demoMode, members, timeZone: events.timeZone, ...detail,
        list: detail.list ? listJson(lists, events, detail.list) : null,
        range: detail.next ? (detail.event.allDay ? detail.next.label : formatSlot(detail.next.start, detail.next.end, events.timeZone, today)) : null,
        poll: poll ? pollJson(poll, events.timeZone, today) : null,
      });
    }
    if (path === "/api/events/suggest") {
      const kind = (url.searchParams.get("activity") ?? "house") as EventKind;
      const minutes = int(url.searchParams.get("minutes"));
      const shape = planShape(activityByKey(kind) ? kind : "house", { minutes });
      const date = url.searchParams.get("date");
      const found = await events.suggest(shape, {
        durationMin: minutes,
        days: int(url.searchParams.get("days")) ?? 7,
        count: Math.min(5, Math.max(1, int(url.searchParams.get("count")) ?? 3)),
        dates: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? [date] : null,
      });
      return sendJson(response, 200, { ...found, slots: found.slots.map((slot) => ({ ...slot, date: localDate(slot.start, events.timeZone), label: formatSlot(slot.start, slot.end, events.timeZone, today) })) });
    }
    return false;
  }

  if (request.method !== "POST") return false;
  if (!isSameOriginJson(request)) return sendJson(response, 403, { error: "Use the GroupCart page to make changes." });
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." }); }
  const demoOnly = (what: string) => sendJson(response, 403, { error: `In live mode, ${what} in the iMessage group.` });
  const memberOr = (value: unknown, fallback: string | null) => {
    const id = str(value, 64);
    return id && members.some((member) => member.id === id) ? id : fallback;
  };
  const whoFrom = (value: Record<string, unknown>): Who => {
    const chosen = ids(value.memberIds).filter((id) => members.some((member) => member.id === id));
    return value.everyone === true || !chosen.length ? { everyone: true, memberIds: [] } : { everyone: chosen.length >= members.length, memberIds: chosen.length >= members.length ? [] : chosen };
  };

  try {
    switch (path) {
      case "/api/lists/staples": {
        const unit = (["day", "week", "month"] as const).find((candidate) => candidate === body.unit) ?? "week";
        const created = lists.addStaple({ name: str(body.name, 80) ?? "", cadence: { every: int(body.every) ?? 1, unit: unit as CadenceUnit }, who: whoFrom(body), createdBy: memberOr(body.createdBy, null), startDate: str(body.startDate, 10) });
        if (!created.ok) return sendJson(response, 400, { error: created.error });
        if (lists.isDue(created.staple)) await lists.runDueStaples();
        return sendJson(response, 200, { ok: true, staple: stapleJson(lists, lists.getStaple(created.staple.id) ?? created.staple) });
      }
      case "/api/lists/staples/delete":
        return sendJson(response, lists.removeStaple(str(body.id, 64) ?? "") ? 200 : 404, { ok: true });
      case "/api/lists/staples/skip": {
        const staple = lists.skipStaple(str(body.id, 64) ?? "");
        return staple ? sendJson(response, 200, { ok: true, staple: stapleJson(lists, staple) }) : sendJson(response, 404, { error: "Staple not found." });
      }
      case "/api/lists/new": {
        const items = Array.isArray(body.items) ? ids(body.items) : splitItems(str(body.items, 1000) ?? "");
        const created = lists.createList({ name: str(body.name, 80) ?? "", items, who: whoFrom(body), createdBy: memberOr(body.createdBy, null), emoji: str(body.emoji, 16) });
        return created.ok ? sendJson(response, 200, { ok: true, list: created.list }) : sendJson(response, 400, { error: created.error });
      }
      case "/api/lists/items": {
        const listId = str(body.listId, 64) ?? "";
        if (!lists.getList(listId)) return sendJson(response, 404, { error: "List not found." });
        const names = Array.isArray(body.names) ? ids(body.names) : splitItems(str(body.name, 200) ?? "");
        return sendJson(response, 200, { ok: true, added: lists.addItems(listId, names, null) });
      }
      case "/api/lists/items/toggle":
        return sendJson(response, lists.setItemChecked(str(body.itemId, 64) ?? "", body.checked === true) ? 200 : 404, { ok: true });
      case "/api/lists/items/delete":
        return sendJson(response, lists.deleteItem(str(body.itemId, 64) ?? "") ? 200 : 404, { ok: true });
      case "/api/lists/delete":
        return sendJson(response, lists.deleteList(str(body.listId, 64) ?? "") ? 200 : 404, { ok: true });
      case "/api/lists/to-cart": {
        if (!demoMode) return demoOnly("text “<list> to cart”");
        const list = lists.getList(str(body.listId, 64) ?? "");
        if (!list) return sendJson(response, 404, { error: "List not found." });
        const memberId = memberOr(body.memberId, null) ?? memberOr(list.createdBy, null) ?? members[0]?.id;
        if (!memberId) return sendJson(response, 400, { error: "Add household members first." });
        const result = await lists.moveToCart(list.id, memberId);
        if (result.added.length) await notifyGroup(result.message);
        return sendJson(response, result.ok ? 200 : 400, result.ok ? result : { error: result.message, ...result });
      }
      case "/api/events": {
        const time = str(body.time, 5);
        const startMin = body.allDay === true ? null : time && /^\d{1,2}:\d{2}$/.test(time) ? Number(time.split(":")[0]) * 60 + Number(time.split(":")[1]) : int(body.startMin);
        const kind = str(body.kind, 16);
        const created = events.create({
          title: str(body.title, 80) ?? "",
          emoji: str(body.emoji, 16),
          kind: kind && (kind === "house" || activityByKey(kind)) ? kind as EventKind : null,
          date: str(body.date, 10) ?? "",
          endDate: str(body.endDate, 10),
          startMin,
          durationMin: int(body.durationMin),
          recurrence: body.recurrence === "weekly" || body.recurrence === "monthly" ? body.recurrence : "none",
          everyone: whoFrom(body).everyone,
          attendeeIds: whoFrom(body).memberIds,
          notes: str(body.notes, 500),
        }, memberOr(body.createdBy, null));
        if (!created.ok) return sendJson(response, 400, { error: created.error });
        await notifyGroup(events.announcement(created.event, "is set"));
        return sendJson(response, 200, { ok: true, event: created.event });
      }
      case "/api/events/cancel": {
        const event = events.cancel(str(body.id, 64) ?? "");
        if (!event) return sendJson(response, 404, { error: "Event not found." });
        await notifyGroup(`Cancelled ${event.emoji} ${event.title}${event.recurrence !== "none" ? ` (${event.recurrence})` : ""}.`);
        return sendJson(response, 200, { ok: true });
      }
      case "/api/events/rsvp": {
        if (!demoMode) return demoOnly("RSVP with “I’m in” or “can’t make it”");
        const event = events.getEvent(str(body.eventId, 64) ?? "");
        const memberId = memberOr(body.memberId, null);
        const status = (["going", "maybe", "no"] as const).find((candidate) => candidate === body.status);
        if (!event || !memberId || !status) return sendJson(response, 400, { error: "Choose an event, member, and status." });
        events.setRsvp(event.id, memberId, status);
        return sendJson(response, 200, { ok: true, rsvps: events.rsvps(event.id) });
      }
      case "/api/events/tasks/toggle":
        return sendJson(response, events.setTaskDone(str(body.taskId, 64) ?? "", body.done === true) ? 200 : 404, { ok: true });
      case "/api/events/polls": {
        const kind = str(body.kind, 16) ?? "house";
        const shape = planShape(activityByKey(kind) ? kind as EventKind : "house", { label: str(body.title, 60) ?? undefined, emoji: str(body.emoji, 16) ?? undefined, minutes: int(body.durationMin) });
        const created = await events.createPoll({ shape, title: str(body.title, 60), organizerId: memberOr(body.organizerId, null), mode: "vote", durationMin: int(body.durationMin), days: int(body.days) ?? 7 });
        if (!created.ok) return sendJson(response, 400, { error: created.error });
        await notifyGroup(events.pollText(created.poll, created.basis));
        return sendJson(response, 200, { ok: true, poll: pollJson(created.poll, events.timeZone, today) });
      }
      case "/api/events/polls/vote": {
        if (!demoMode) return demoOnly("vote with the option numbers");
        const poll = events.getPoll(str(body.pollId, 64) ?? "");
        const memberId = memberOr(body.memberId, null);
        const option = int(body.option);
        if (!poll || poll.status !== "open" || !memberId || !option || option > poll.options.length) return sendJson(response, 400, { error: "That vote isn’t available." });
        const result = events.vote(poll.id, memberId, body.yes === false ? { yes: [], no: [option] } : { yes: [option], no: [] });
        if (result.booked) await notifyGroup(events.announcement(result.booked));
        return sendJson(response, 200, { ok: true, booked: result.booked, poll: pollJson(result.poll, events.timeZone, today) });
      }
      case "/api/events/polls/book": {
        const booked = events.book(str(body.pollId, 64) ?? "", int(body.option) ?? 0, null);
        if (!booked.ok) return sendJson(response, 400, { error: booked.error });
        await notifyGroup(events.announcement(booked.event));
        return sendJson(response, 200, { ok: true, event: booked.event });
      }
      case "/api/events/polls/cancel":
        return sendJson(response, events.cancelPoll(str(body.pollId, 64) ?? "") ? 200 : 404, { ok: true });
      default:
        return false;
    }
  } catch (error) {
    console.warn("Lists/events request failed:", error instanceof Error ? error.message : error);
    return sendJson(response, 500, { error: "Something went wrong. Please try again." });
  }
}

// ---------------------------------------------------------------------------
// Claude connector tools

function buildTools(store: CartStore, lists: ListsService, events: EventsService) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const today = () => events.today();
  const whoFromNames = (value: unknown, caller: ToolCaller): Who => {
    if (value === undefined || value === null || value === "me") return { everyone: false, memberIds: [caller.memberId] };
    if (value === "everyone" || value === "shared" || value === "all") return { everyone: true, memberIds: [] };
    const names = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(",") : typeof value === "string" ? value : "";
    const resolved = resolveMemberNames(names, lists.members(), caller.memberId);
    if (!resolved.length) return { everyone: false, memberIds: [caller.memberId] };
    return resolved.length >= lists.members().length ? { everyone: true, memberIds: [] } : { everyone: false, memberIds: resolved };
  };
  const nameOf = (id: string) => lists.memberName(id);
  const pollOut = (poll: PollView) => ({
    pollId: poll.id, title: poll.title, emoji: poll.emoji, mode: poll.mode, status: poll.status, organizer: poll.organizerId ? nameOf(poll.organizerId) : null,
    majority: poll.majority, waitingOn: poll.attendeeIds.filter((id) => !poll.responded.includes(id)).map(nameOf),
    options: poll.options.map((option) => ({ option: option.index, start: iso(option.start), end: iso(option.end), label: formatSlot(option.start, option.end, events.timeZone, today()), yes: option.yes.map(nameOf), no: option.no.map(nameOf) })),
  });
  const pollFor = (args: Record<string, unknown>, caller: ToolCaller): PollView | undefined => {
    const id = typeof args.pollId === "string" ? args.pollId : null;
    if (id) return events.getPoll(id);
    const open = events.openPolls();
    return open.find((poll) => poll.mode === "pick" && poll.organizerId === caller.memberId) ?? open.find((poll) => poll.mode === "vote");
  };
  const activityEnum = [...ACTIVITIES.map((activity) => activity.key), "house"];

  return [
    {
      name: "list_staples",
      description: "List the household's recurring grocery staples (e.g. milk every week) with who each is for and the next date it will be added to the shared cart.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: () => ({
        timeZone: lists.timeZone,
        staples: lists.listStaples().map((staple) => ({ id: staple.id, item: staple.name, cadence: staple.cadence, for: staple.everyone ? "everyone" : staple.memberIds.map(nameOf), nextAddDate: staple.nextDate, lastAdded: staple.lastDate, lastResult: staple.lastStatus })),
      }),
    },
    {
      name: "add_staple",
      description: "Add a recurring grocery staple that GroupCart adds to the shared cart on a schedule, as if the member had requested it (e.g. coffee every 2 weeks for me, paper towels monthly for everyone).",
      mutates: true,
      inputSchema: {
        type: "object" as const,
        properties: {
          item: { type: "string", description: "Item name, e.g. \"oat milk\" or \"2 bananas\"." },
          every: { type: "integer", minimum: 1, maximum: 52, default: 1, description: "Repeat interval count." },
          unit: { type: "string", enum: ["day", "week", "month"], default: "week" },
          for: { description: "\"me\" (default), \"everyone\", or a list of member first names to share with.", oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
          startDate: { type: "string", description: "First add date YYYY-MM-DD (default today)." },
        },
        required: ["item"],
      },
      handler: async (args: Record<string, unknown>, caller: ToolCaller) => {
        const unit = (["day", "week", "month"] as const).find((candidate) => candidate === args.unit) ?? "week";
        const created = lists.addStaple({ name: String(args.item ?? ""), cadence: { every: int(args.every) ?? 1, unit }, who: whoFromNames(args.for, caller), createdBy: caller.memberId, startDate: typeof args.startDate === "string" ? args.startDate : null });
        if (!created.ok) return { ok: false, error: created.error };
        let note: string | null = null;
        if (lists.isDue(created.staple)) note = (await lists.runDueStaples()) ?? null;
        const staple = lists.getStaple(created.staple.id) ?? created.staple;
        return { ok: true, staple: { id: staple.id, item: staple.name, cadence: staple.cadence, for: staple.everyone ? "everyone" : staple.memberIds.map(nameOf), nextAddDate: staple.nextDate }, groupNotice: note };
      },
    },
    {
      name: "list_lists",
      description: "List the household's one-off grocery lists (e.g. \"Party run\") with their items and which are checked off or already moved to the cart.",
      inputSchema: { type: "object" as const, properties: { name: { type: "string", description: "Optional list name to show just that list." } } },
      handler: (args: Record<string, unknown>) => {
        const all = typeof args.name === "string" && args.name.trim() ? [lists.findList(args.name)].filter((list): list is ListView => Boolean(list)) : lists.allLists();
        return { lists: all.map((list) => ({ id: list.id, name: list.name, for: list.everyone ? "everyone" : list.memberIds.map(nameOf), remaining: list.remaining, items: list.items.map((item) => ({ name: item.name, done: item.checked, inCart: item.carted })) })) };
      },
    },
    {
      name: "add_to_list",
      description: "Add items to a named one-off grocery list, creating the list (shared with everyone) if it doesn't exist yet.",
      mutates: true,
      inputSchema: {
        type: "object" as const,
        properties: {
          list: { type: "string", description: "List name, e.g. \"Party run\"." },
          items: { type: "array", items: { type: "string" }, minItems: 1, description: "Item names to add." },
          create: { type: "boolean", default: true, description: "Create the list if missing." },
        },
        required: ["list", "items"],
      },
      handler: (args: Record<string, unknown>, caller: ToolCaller) => {
        const names = ids(args.items);
        if (!names.length) return { ok: false, error: "Give at least one item." };
        let list = lists.findList(String(args.list ?? ""));
        if (!list) {
          if (args.create === false) return { ok: false, error: "No list by that name." };
          const created = lists.createList({ name: String(args.list ?? ""), items: [], createdBy: caller.memberId });
          if (!created.ok) return { ok: false, error: created.error };
          list = created.list;
        }
        const added = lists.addItems(list.id, names, caller.memberId);
        const updated = lists.getList(list.id)!;
        return { ok: true, list: updated.name, added, items: updated.items.filter((item) => !item.checked).map((item) => item.name) };
      },
    },
    {
      name: "move_list_to_cart",
      description: "Move every unchecked item on a one-off list into the shared grocery cart as the calling member (demo: sample catalog; live: Kroger product choices the member then picks in the group chat).",
      mutates: true,
      inputSchema: { type: "object" as const, properties: { list: { type: "string", description: "List name." } }, required: ["list"] },
      handler: async (args: Record<string, unknown>, caller: ToolCaller) => {
        const list = lists.findList(String(args.list ?? ""));
        if (!list) return { ok: false, error: "No list by that name." };
        const result = await lists.moveToCart(list.id, caller.memberId);
        if (result.ok) await notifyGroup(`${caller.memberName} (via Claude): ${result.message}`);
        return result;
      },
    },
    {
      name: "list_events",
      description: "List upcoming household events (one-off and repeating, e.g. cleaning day, rent due, game night) with RSVPs, plus any open time polls.",
      inputSchema: { type: "object" as const, properties: { days: { type: "integer", minimum: 1, maximum: 60, default: 14 } } },
      handler: (args: Record<string, unknown>) => {
        const days = Math.min(60, Math.max(1, int(args.days) ?? 14));
        return {
          timeZone: events.timeZone,
          events: events.upcoming(30, days).map((occurrence) => ({
            eventId: occurrence.eventId, title: occurrence.title, emoji: occurrence.emoji, allDay: occurrence.allDay,
            start: occurrence.allDay ? occurrence.date : iso(occurrence.start), end: occurrence.allDay ? occurrence.endDate : iso(occurrence.end),
            label: occurrence.label, repeats: occurrence.recurrence, rsvps: Object.fromEntries(Object.entries(occurrence.rsvps).map(([id, status]) => [nameOf(id), status])),
          })),
          openPolls: events.openPolls().map(pollOut),
        };
      },
    },
    {
      name: "add_event",
      description: "Add a household event to the shared calendar and announce it in the group. Give either `when` in plain words (\"Sunday 7pm\", \"Fri-Sun\", \"on the 1st monthly\") or a structured date/time.",
      mutates: true,
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "e.g. \"House meeting\" or \"Game night\"." },
          when: { type: "string", description: "Plain-language time, e.g. \"Sunday 7pm\", \"tomorrow 6-8pm\", \"Fri-Sun\", \"on the 1st monthly\"." },
          date: { type: "string", description: "YYYY-MM-DD (household time zone)." },
          time: { type: "string", description: "HH:MM 24h start; omit for all-day." },
          durationMinutes: { type: "integer", minimum: 15, maximum: 1440 },
          endDate: { type: "string", description: "Last day (YYYY-MM-DD) for multi-day all-day events." },
          recurrence: { type: "string", enum: ["none", "weekly", "monthly"], default: "none" },
          emoji: { type: "string" },
          attendees: { type: "array", items: { type: "string" }, description: "Member first names; default everyone." },
          notes: { type: "string" },
        },
        required: ["title"],
      },
      handler: (args: Record<string, unknown>, caller: ToolCaller) => {
        let date = typeof args.date === "string" ? args.date : null;
        let startMin: number | null = typeof args.time === "string" && /^\d{1,2}:\d{2}$/.test(args.time) ? Number(args.time.split(":")[0]) * 60 + Number(args.time.split(":")[1]) : null;
        let endDate = typeof args.endDate === "string" ? args.endDate : null;
        let durationMin = int(args.durationMinutes);
        let recurrence = args.recurrence === "weekly" || args.recurrence === "monthly" ? args.recurrence : "none";
        if (typeof args.when === "string" && args.when.trim()) {
          const parsed = parseWhen(args.when, today(), minutesNow(events.now(), events.timeZone));
          date = parsed.date ?? date;
          startMin = parsed.startMin ?? startMin;
          endDate = parsed.endDate ?? endDate;
          durationMin = parsed.durationMin ?? durationMin;
          if (parsed.recurrence !== "none") recurrence = parsed.recurrence;
        }
        if (!date) return { ok: false, error: "Give `when` or `date`." };
        const attendees = Array.isArray(args.attendees) ? resolveMemberNames(ids(args.attendees).join(","), lists.members(), caller.memberId) : [];
        const created = events.create({
          title: String(args.title ?? ""), emoji: typeof args.emoji === "string" ? args.emoji : null, date, startMin, endDate, durationMin,
          recurrence: recurrence as "none" | "weekly" | "monthly", everyone: !attendees.length, attendeeIds: attendees, notes: typeof args.notes === "string" ? args.notes : null,
        }, caller.memberId);
        if (!created.ok) return { ok: false, error: created.error };
        const announcement = events.announcement(created.event, "is set");
        void notifyGroup(`${announcement}\n(added by ${caller.memberName})`);
        return { ok: true, eventId: created.event.id, announcement };
      },
    },
    {
      name: "suggest_event_times",
      description: "Suggest the best times in the next days when everyone in the household is free (from connected calendars and existing household events) for an event of a given length.",
      inputSchema: {
        type: "object" as const,
        properties: {
          durationMinutes: { type: "integer", minimum: 15, maximum: 720, default: 60 },
          activity: { type: "string", enum: activityEnum, default: "house", description: "Sets the time window: movie/game evenings, dinner 6-9 PM, outing daytime, house 8 AM-9 PM." },
          days: { type: "integer", minimum: 1, maximum: 14, default: 7 },
          count: { type: "integer", minimum: 1, maximum: 5, default: 3 },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const kind = typeof args.activity === "string" && activityByKey(args.activity) ? args.activity as EventKind : "house";
        const found = await events.suggest(planShape(kind), { durationMin: int(args.durationMinutes) ?? (kind === "house" ? 60 : null), days: int(args.days) ?? 7, count: Math.min(5, Math.max(1, int(args.count) ?? 3)) });
        return { timeZone: events.timeZone, calendarsIncluded: found.included, members: found.total, slots: found.slots.map((slot) => ({ start: iso(slot.start), end: iso(slot.end), label: formatSlot(slot.start, slot.end, events.timeZone, today()) })) };
      },
    },
    {
      name: "plan_activity",
      description: "Start a group plan for a social activity (movie night, game night, dinner, hike/outing, party, hangout): finds the top 3 everyone-free times and posts a vote in the group chat. Members vote by number; it books automatically on a majority.",
      mutates: true,
      inputSchema: {
        type: "object" as const,
        properties: {
          activity: { type: "string", description: "One of movie, game, dinner, outing, party, hangout, house, or a phrase like \"watch a movie\"." },
          title: { type: "string", description: "Optional custom title." },
          when: { type: "string", description: "Optional day hint: \"this weekend\", \"friday\", \"tomorrow\", \"next week\"." },
          days: { type: "integer", minimum: 1, maximum: 14, default: 7 },
          durationMinutes: { type: "integer", minimum: 15, maximum: 720 },
          announce: { type: "boolean", default: true, description: "Post the vote in the group chat." },
        },
        required: ["activity"],
      },
      handler: async (args: Record<string, unknown>, caller: ToolCaller) => {
        const text = String(args.activity ?? "");
        const key = activityByKey(text) ? text as EventKind : text === "house" ? "house" : detectActivity(text)?.activity.key ?? "hangout";
        const detected = detectActivity(text);
        const shape = planShape(key, { label: typeof args.title === "string" && args.title.trim() ? args.title.trim() : detected && detected.activity.key === key ? detected.label : undefined, emoji: detected && detected.activity.key === key ? detected.emoji : undefined, minutes: int(args.durationMinutes) });
        const dates = typeof args.when === "string" ? parseDayHint(args.when, today()) : null;
        const created = await events.createPoll({ shape, title: typeof args.title === "string" ? args.title : null, organizerId: caller.memberId, mode: "vote", dates, durationMin: int(args.durationMinutes), days: int(args.days) ?? 7 });
        if (!created.ok) return { ok: false, error: created.error };
        if (args.announce !== false) await notifyGroup(`${caller.memberName} wants to plan: ${events.pollText(created.poll, created.basis)}`);
        return { ok: true, ...pollOut(created.poll) };
      },
    },
    {
      name: "vote",
      description: "Vote in an open group plan as the calling member: which option numbers work (and optionally which don't). Books automatically when an option reaches a majority.",
      mutates: true,
      inputSchema: {
        type: "object" as const,
        properties: {
          pollId: { type: "string", description: "Defaults to the newest open plan." },
          options: { type: "array", items: { type: "integer", minimum: 1, maximum: 5 }, description: "Option numbers that work." },
          cannot: { type: "array", items: { type: "integer", minimum: 1, maximum: 5 }, description: "Option numbers that don't work." },
        },
      },
      handler: async (args: Record<string, unknown>, caller: ToolCaller) => {
        const poll = pollFor(args, caller);
        if (!poll || poll.status !== "open") return { ok: false, error: "No open plan." };
        const valid = (value: unknown) => (Array.isArray(value) ? value : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= poll.options.length);
        const yes = valid(args.options);
        const no = valid(args.cannot).filter((n) => !yes.includes(n));
        if (!yes.length && !no.length) return { ok: false, error: `Give option numbers 1-${poll.options.length}.` };
        if (poll.mode === "pick") {
          if (poll.organizerId !== caller.memberId || yes.length !== 1) return { ok: false, error: "This is a pick list; the organizer books one option with book_event." };
        }
        const result = events.vote(poll.id, caller.memberId, { yes, no });
        if (result.booked) await notifyGroup(events.announcement(result.booked));
        else await notifyGroup(`${poll.emoji} ${caller.memberName}: ${[...yes.map((n) => `${n} ✓`), ...no.map((n) => `${n} ✗`)].join(" ")}. Votes — ${events.tallyLine(result.poll)}`);
        return { ok: true, booked: result.booked ? { eventId: result.booked.id, announcement: events.announcement(result.booked) } : null, poll: pollOut(result.poll) };
      },
    },
    {
      name: "book_event",
      description: "Book one option of an open group plan as a calendar event (organizer only for group votes), then announce it with tasks and the snack list.",
      mutates: true,
      inputSchema: {
        type: "object" as const,
        properties: { pollId: { type: "string", description: "Defaults to the newest open plan." }, option: { type: "integer", minimum: 1, maximum: 5 } },
        required: ["option"],
      },
      handler: async (args: Record<string, unknown>, caller: ToolCaller) => {
        const poll = pollFor(args, caller);
        if (!poll || poll.status !== "open") return { ok: false, error: "No open plan." };
        if (poll.mode === "vote" && poll.organizerId && poll.organizerId !== caller.memberId) return { ok: false, error: `${nameOf(poll.organizerId)} started this plan; ask them to book, or vote instead.` };
        const booked = events.book(poll.id, int(args.option) ?? 0, caller.memberId);
        if (!booked.ok) return { ok: false, error: booked.error };
        const announcement = events.announcement(booked.event);
        await notifyGroup(announcement);
        return { ok: true, eventId: booked.event.id, announcement };
      },
    },
    {
      name: "rsvp_event",
      description: "RSVP the calling member to a household event (going, maybe, or no).",
      mutates: true,
      inputSchema: {
        type: "object" as const,
        properties: { event: { type: "string", description: "Event title or id." }, status: { type: "string", enum: ["going", "maybe", "no"] } },
        required: ["event", "status"],
      },
      handler: (args: Record<string, unknown>, caller: ToolCaller) => {
        const target = events.getEvent(String(args.event ?? "")) ?? events.findEvents(String(args.event ?? ""))[0];
        const status = (["going", "maybe", "no"] as const).find((candidate) => candidate === args.status);
        if (!target || !status) return { ok: false, error: "Give an event title and a status." };
        events.setRsvp(target.id, caller.memberId, status);
        return { ok: true, rsvps: events.rsvpLine(target) };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Demo seed (demo mode only, once per database)

async function seedDemo(store: CartStore, lists: ListsService, events: EventsService): Promise<void> {
  if (lists.meta("demo_seeded") || events.meta("demo_seeded")) return;
  const members = store.getMembers();
  if (lists.listStaples().length || lists.allLists().length || events.activeEvents().length || members.length < 2) {
    lists.setMeta("demo_seeded", "skipped");
    events.setMeta("demo_seeded", "skipped");
    return;
  }
  lists.setMeta("demo_seeded", new Date().toISOString());
  events.setMeta("demo_seeded", new Date().toISOString());
  const byName = (name: string, fallback: number) => members.find((member) => member.name.toLowerCase() === name)?.id ?? members[fallback % members.length]!.id;
  const alex = byName("alex", 0);
  const jordan = byName("jordan", 1);
  const maya = byName("maya", 2);
  const today = lists.today();
  const just = (id: string): Who => ({ everyone: false, memberIds: [id] });
  const everyone: Who = { everyone: true, memberIds: [] };

  lists.addStaple({ name: "Bananas", cadence: { every: 1, unit: "week" }, who: just(jordan), createdBy: jordan, startDate: today });
  lists.addStaple({ name: "Oat milk", cadence: { every: 1, unit: "week" }, who: just(maya), createdBy: maya, startDate: addDays(today, 2) });
  lists.addStaple({ name: "Eggs", cadence: { every: 1, unit: "week" }, who: everyone, createdBy: alex, startDate: addDays(today, 3) });
  lists.addStaple({ name: "Coffee", cadence: { every: 2, unit: "week" }, who: { everyone: false, memberIds: [alex, jordan] }, createdBy: alex, startDate: addDays(today, 5) });
  lists.addStaple({ name: "Paper towels", cadence: { every: 1, unit: "month" }, who: everyone, createdBy: maya, startDate: nextMonthDay(addDays(today, 1), 1) });

  const pasta = lists.createList({ name: "Pasta night", items: ["Pasta", "Tomato sauce", "Parmesan", "Garlic bread"], who: everyone, createdBy: maya, emoji: "🍝" });
  if (pasta.ok) {
    const parmesan = pasta.list.items.find((item) => item.name === "Parmesan");
    if (parmesan) lists.setItemChecked(parmesan.id, true);
  }

  events.create({ title: "Cleaning day", emoji: "🧹", date: nextWeekdayDate(today, 6), startMin: 10 * 60, durationMin: 120, recurrence: "weekly" }, alex);
  events.create({ title: "Rent due", emoji: "💸", date: nextMonthDay(addDays(today, 1), 1), recurrence: "monthly" }, maya);
  events.create({ title: "House meeting", emoji: "🏠", date: nextWeekdayDate(today, 0, { strict: true }), startMin: 19 * 60, durationMin: 60 }, jordan);
  const guestsStart = (() => { const friday = nextWeekdayDate(today, 5, { strict: true }); return friday < addDays(today, 4) ? addDays(friday, 7) : friday; })();
  events.create({ title: "Guests visiting", emoji: "🧳", date: guestsStart, endDate: addDays(guestsStart, 2), notes: "Maya’s parents are staying in the living room." }, maya);

  // A booked game night with RSVPs, tasks, and a snack list.
  const gameDates = [addDays(today, 2), addDays(today, 3), addDays(today, 4)];
  const gameSlot = (await events.suggest(planShape("game"), { dates: gameDates, count: 1 })).slots[0];
  const gameDate = gameSlot ? localDate(gameSlot.start, events.timeZone) : gameDates[1]!;
  const gameStart = gameSlot ? minutesNow(gameSlot.start, events.timeZone) : 19 * 60 + 30;
  events.create({ title: "Game night", emoji: "🎲", kind: "game", date: gameDate, startMin: gameStart, durationMin: 150 }, alex, { rsvps: { [alex]: "going", [maya]: "going", [jordan]: "maybe" } });

  // A movie night vote in progress, plus a few movie ideas.
  const movie = await events.createPoll({ shape: planShape("movie"), organizerId: maya, mode: "vote" });
  if (movie.ok && movie.poll.options.length >= 2) {
    events.vote(movie.poll.id, alex, { yes: [1], no: [] });
    events.vote(movie.poll.id, maya, { yes: [2], no: [] });
  }
  events.addIdea("movie", "Dune: Part Two", alex);
  events.addIdea("movie", "Paddington 2", maya);
  const spirited = events.addIdea("movie", "Spirited Away", jordan);
  const paddington = events.findIdea("movie", "Paddington 2");
  if (spirited.ok && paddington) events.voteIdea(paddington.id, jordan);
  console.log("Seeded demo staples, lists, events, and a movie night vote.");
}

