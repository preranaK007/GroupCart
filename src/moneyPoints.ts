// Money & points: one setupMoneyPoints(...) call from index.ts wires
//   - pay-back links (src/payLinks.ts): GET /api/pay-links, the "who owes" chat reply (src/bills.ts), the tool get_pay_links
//   - points, streaks, MVP (src/points.ts): commands "points" / "leaderboard", tools get_leaderboard / my_points,
//     GET /api/points, /api/points/me, POST /api/points/seen, the profile "Points" card, a streak check every 15 min,
//     and the grocery checkout hook (added next to Splitwise's, never replacing it)
//   - the Sunday digest (src/digest.ts): command "digest", tool get_weekly_digest, GET /api/digest/preview, and a
//     check every 10 min that posts it once a week (Sunday 6pm server time)
// Other features call awardPoints()/revokePoints() from small marked blocks (chores, bills, events, one-off lists).
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSameOriginMutation, readJsonBody } from "./auth.js";
import { CATEGORY_EMOJI, CATEGORY_LABEL } from "./billParse.js";
import { billsService } from "./bills.js";
import { choreService } from "./chores.js";
import { registerSummaryProvider } from "./coreTools.js";
import { DigestService, emptyDigestData, nextDigestLabel, type DigestData } from "./digest.js";
import { listsEventsServices } from "./listsEvents.js";
import { amountText, DEFAULT_PAY_NOTE, payOptionsFor, setPayHandleSource } from "./payLinks.js";
import { notifyGroup, registerCommand, registerHelp, registerRoute, registerTools, requestMember, scheduleEvery, type CommandContext } from "./platform.js";
import {
  addDaysIso, localIso, monthName, monthOf, PointsService, previousMonth, RULES_TEXT, setActivePoints, weekOf,
  type AwardInput,
} from "./points.js";
import { registerProfileSection } from "./profiles.js";
import type { CartStore, CheckoutHooks, CompletedCheckout } from "./store.js";
import { pointsSectionHtml, pointsSectionTitle } from "./ui/pointsUi.js";

export type MoneyPointsOptions = {
  store: CartStore;
  demoMode: boolean;
  /** The checkout hooks already installed (Splitwise); ours run alongside them. */
  checkoutHooks?: CheckoutHooks;
  /** Profile payment text per member ("Venmo @alex-k · Cash App $alexk"). */
  paymentHandle?: (memberId: string) => string;
  now?: () => Date;
};

export const POINTS_PATTERN = /^(?:my\s+)?(?:points|xp|score|streak|level)[?!.]*$/i;
export const LEADERBOARD_PATTERN = /^(?:the\s+)?(?:leaderboard|leader\s+board|scoreboard|standings|rankings|who'?s\s+winning|mvp)[?!.]*$/i;
export const DIGEST_PATTERN = /^(?:(?:the|weekly|sunday|preview(?:\s+the)?|show(?:\s+the)?)\s+)?(?:weekly\s+)?digest[?!.]*$|^week\s+ahead[?!.]*$/i;

/** Runs `observe` after the existing hooks record a checkout (same transaction); everything else is delegated. */
export function withCheckoutObserver(base: CheckoutHooks | undefined, observe: (checkout: CompletedCheckout) => void): CheckoutHooks {
  return {
    record(checkout) {
      base?.record(checkout);
      try { observe(checkout); } catch (error) { console.warn("Checkout points were not recorded:", error instanceof Error ? error.message : error); }
    },
    summary: (key) => base?.summary(key),
    finish: async (key) => (base ? base.finish(key) : undefined),
    status: () => base?.status() ?? "Splitwise logging isn’t set up in this GroupCart.",
    retry: async () => (base ? base.retry() : "Splitwise logging isn’t set up in this GroupCart."),
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function shortDay(iso: string, today: string): string {
  if (iso === today) return "today";
  if (iso === addDaysIso(today, 1)) return "tomorrow";
  const date = new Date(`${iso}T12:00:00`);
  return iso <= addDaysIso(today, 6) ? date.toLocaleDateString("en-US", { weekday: "short" }) : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function setupMoneyPoints(options: MoneyPointsOptions): { points: PointsService; digest: DigestService } {
  const { store, demoMode } = options;
  const now = options.now ?? (() => new Date());
  const members = () => store.getMembers();
  const nameOf = (id: string | null | undefined) => members().find((member) => member.id === id)?.name ?? null;

  // --- Pay-back links ---
  if (options.paymentHandle) setPayHandleSource(options.paymentHandle);

  // --- Points ---
  const points = new PointsService({
    db: store.database,
    household: store.household,
    members,
    now,
    // Level-ups are rare (50, 125, 225, ... points); tell the group outside any open transaction.
    onLevelUp: (member, level) => { setTimeout(() => { void notifyGroup(`⭐ ${member.name.split(/\s+/)[0]} reached level ${level}!`); }, 0); },
  });
  setActivePoints(points);

  // --- Sunday digest ---
  const digest: DigestService = new DigestService({
    db: store.database,
    household: store.household,
    now,
    gather: () => gatherDigest(),
    send: (text) => notifyGroup(text),
    // Live mode: wait until the bot knows the household group, so the week isn't used up on nobody.
    canSend: () => demoMode || Boolean(store.groupSpace()),
  });

  function funStat(today: string): string | null {
    const standings = points.standings();
    const candidates: string[] = [];
    const leader = standings[0];
    if (leader && leader.month > 0) candidates.push(`🏆 MVP so far: ${leader.name.split(/\s+/)[0]} (${leader.month} points in ${monthName(monthOf(now()))})`);
    const streaker = [...standings].sort((a, b) => b.streak - a.streak)[0];
    if (streaker && streaker.streak >= 2) candidates.push(`🔥 Longest streak: ${streaker.name.split(/\s+/)[0]}, ${streaker.streak} weeks of chores on time`);
    const bought = digest.mostBought();
    if (bought) candidates.push(`🥇 Most bought lately: ${bought.name.toLowerCase()} (${bought.count}×)`);
    if (!candidates.length) return null;
    const week = Math.floor(Date.parse(`${weekOf(addDaysIso(today, 1))}T12:00:00Z`) / (7 * 86_400_000));
    return candidates[week % candidates.length]!;
  }

  function gatherDigest(): DigestData {
    const data = emptyDigestData();
    const today = localIso(now());
    const horizon = addDaysIso(today, 7);
    try {
      data.chores = (choreService()?.openChores() ?? []).filter((chore) => chore.dueDate <= horizon)
        .map((chore) => ({ emoji: chore.emoji, name: chore.name, who: nameOf(chore.assigneeId), late: chore.status === "late" }));
    } catch (error) { console.warn("Digest: chores unavailable:", error instanceof Error ? error.message : error); }
    try {
      const bills = billsService();
      if (bills) {
        data.transfers = bills.balances().transfers.map((transfer) => ({ from: transfer.fromName, to: transfer.toName, cents: transfer.cents }));
        data.bills = bills.listBills(["saved"])
          .filter((bill) => !bill.paidAt && bill.dueDate && bill.totalCents && bill.dueDate <= horizon)
          .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
          .map((bill) => ({ emoji: CATEGORY_EMOJI[bill.category], vendor: bill.vendor || CATEGORY_LABEL[bill.category], cents: bill.totalCents!, when: shortDay(bill.dueDate!, today), overdue: bill.dueDate! < today }));
      }
    } catch (error) { console.warn("Digest: bills unavailable:", error instanceof Error ? error.message : error); }
    try {
      const events = listsEventsServices()?.events;
      if (events) {
        data.events = events.upcoming(3, 8).map((occurrence) => ({ emoji: occurrence.emoji, title: occurrence.title, when: occurrence.label }));
        data.polls = events.openPolls().map((poll) => poll.title);
      }
    } catch (error) { console.warn("Digest: events unavailable:", error instanceof Error ? error.message : error); }
    try {
      data.lists = store.listsSnapshot()
        .filter((list) => list.active && list.remindersEnabled && (list.dueNow || (list.nextReminderAt && localIso(new Date(list.nextReminderAt)) <= horizon)))
        .map((list) => ({ title: `${list.title.toLowerCase()} list`, when: list.dueNow ? "now" : shortDay(localIso(new Date(list.nextReminderAt!)), today) }));
    } catch (error) { console.warn("Digest: lists unavailable:", error instanceof Error ? error.message : error); }
    try { data.stat = funStat(today); } catch { data.stat = null; }
    return data;
  }

  // --- Checkout hook: shopper points and purchase counts, alongside Splitwise ---
  store.setCheckoutHooks(withCheckoutObserver(options.checkoutHooks, (checkout) => {
    if (checkout.payer) points.award({ kind: "checkout", memberId: checkout.payer.id, key: `checkout:${checkout.checkoutKey}`, label: "Grocery checkout", at: checkout.completedAt });
    digest.recordPurchases(checkout.checkoutKey, checkout.items, checkout.completedAt);
  }));

  // --- Group chat ---
  registerCommand("points", ({ memberId, text }: CommandContext) => {
    const trimmed = text.trim();
    if (POINTS_PATTERN.test(trimmed)) return points.pointsReply(memberId);
    if (LEADERBOARD_PATTERN.test(trimmed)) return points.leaderboardReply();
    return null;
  });
  registerCommand("digest", ({ text }: CommandContext) => (DIGEST_PATTERN.test(text.trim()) ? digest.text(true) : null));
  registerHelp("Points: “points” shows yours and your streak; “leaderboard” shows this month’s standings.");
  registerHelp("Digest: every Sunday at 6pm I post the week ahead; “digest” previews it.");

  // --- Web ---
  const payLinksView = (viewerId: string | null) => {
    const bills = billsService();
    const debts = viewerId && bills
      ? bills.balances().transfers.filter((transfer) => transfer.fromId === viewerId)
        .map((transfer) => ({ toId: transfer.toId, toName: transfer.toName, cents: transfer.cents, options: payOptionsFor(transfer.toId, transfer.cents) }))
      : [];
    return { viewerId, memberIds: members().map((member) => member.id), debts };
  };
  registerRoute(async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const path = url.pathname;
    if (path !== "/api/pay-links" && path !== "/api/digest/preview" && path !== "/api/points" && !path.startsWith("/api/points/")) return false;
    const viewerId = requestMember(request)?.memberId ?? null;
    if (request.method === "GET" && path === "/api/pay-links") { sendJson(response, 200, payLinksView(viewerId)); return true; }
    if (request.method === "GET" && path === "/api/digest/preview") {
      sendJson(response, 200, { text: digest.text(true), next: nextDigestLabel(now()), lastSent: digest.lastSent() });
      return true;
    }
    if (request.method === "GET" && path === "/api/points") {
      const month = monthOf(now());
      sendJson(response, 200, { month, monthLabel: monthName(month), standings: points.standings(), rules: RULES_TEXT });
      return true;
    }
    if (request.method === "GET" && path === "/api/points/me") {
      const summary = viewerId ? points.summary(viewerId) : null;
      sendJson(response, 200, summary ? { ...summary, levelUp: points.pendingLevelUp(summary.memberId) } : { memberId: null, levelUp: null });
      return true;
    }
    if (request.method === "POST" && path === "/api/points/seen") {
      if (!isSameOriginMutation(request)) { sendJson(response, 403, { error: "This request must come from the GroupCart page." }); return true; }
      await readJsonBody(request, 1_024).catch(() => ({}));
      if (viewerId) points.markLevelsSeen(viewerId);
      sendJson(response, 200, { ok: true });
      return true;
    }
    sendJson(response, 404, { error: "Not found." });
    return true;
  });

  registerProfileSection(({ memberId }) => {
    const summary = points.summary(memberId);
    return summary ? { title: pointsSectionTitle(), icon: "spark", order: 5, html: pointsSectionHtml(summary) } : null;
  });

  // --- AI assistant tools (read-only; nothing here moves money) ---
  registerTools([
    {
      name: "get_leaderboard",
      description: "This month's household points leaderboard: points, level, chore streak, and the MVP so far (plus last month's MVP).",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const month = monthOf(now());
        const last = points.mvp(previousMonth(month));
        return {
          month: monthName(month),
          standings: points.standings().map((entry) => ({ rank: entry.rank, member: entry.name, points_this_month: entry.month, total_points: entry.total, level: entry.level, streak_weeks: entry.streak, mvp_so_far: entry.mvp && entry.month > 0 })),
          last_month_mvp: last ? { member: last.name, points: last.points } : null,
          how_points_work: RULES_TEXT,
        };
      },
    },
    {
      name: "my_points",
      description: "Your own points: this month and all-time, level and how far to the next, chore streak (weeks with every chore on time), badges, and recent awards.",
      inputSchema: { type: "object", properties: {} },
      handler: (_args, caller) => {
        const me = points.summary(caller.memberId);
        if (!me) return { error: "You are not a household member." };
        return {
          you: me.name, points_this_month: me.month, total_points: me.total, level: me.level, points_to_next_level: me.next - me.total,
          rank_this_month: me.rank, streak_weeks: me.streak, badges: me.badges.map((badge) => `${badge.emoji} ${badge.label}`),
          recent: me.recent.map((entry) => ({ points: entry.points, for: entry.label, at: entry.at })), how_points_work: RULES_TEXT,
        };
      },
    },
    {
      name: "get_weekly_digest",
      description: "Preview the Sunday digest GroupCart posts to the group (chores this week and who has them, who owes whom, upcoming plans, lists and bills coming due, one fun stat).",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({ text: digest.text(true), sends: "Sundays at 6pm (server time), once a week", next: nextDigestLabel(now()), last_sent: digest.lastSent() }),
    },
    {
      name: "get_pay_links",
      description: "Links to pay back what you owe roommates (Venmo, Cash App, or PayPal with the amount filled in), from their profile payment handles. Links only open the payment app; nothing is paid automatically. After the user pays, record it with record_payment.",
      inputSchema: { type: "object", properties: {} },
      handler: (_args, caller) => {
        const view = payLinksView(caller.memberId);
        return {
          you: caller.memberName,
          owe: view.debts.map((debt) => ({
            to: debt.toName,
            amount: amountText(debt.cents),
            links: debt.options.map((option) => ({ service: option.label, handle: option.handle, url: option.url, ...(option.appUrl ? { app_url: option.appUrl } : {}) })),
            ...(debt.options.length ? {} : { note: `${debt.toName.split(/\s+/)[0]} hasn’t added a payment handle to their profile.` }),
          })),
          note: `Payment note: “${DEFAULT_PAY_NOTE}”. GroupCart never sends money; record the payback after paying.`,
        };
      },
    },
  ]);
  registerSummaryProvider("points", (caller) => {
    const me = points.summary(caller.memberId);
    return me ? { this_month: me.month, level: me.level, streak_weeks: me.streak, rank: me.rank } : null;
  });

  // --- Schedules ---
  // Streaks: a chore that goes overdue on someone's turn counts against that week (recorded once per occurrence).
  const recordMisses = () => {
    for (const chore of choreService()?.openChores() ?? []) {
      if (chore.status === "late" && chore.assigneeId) points.recordMiss(chore.id, chore.dueDate, chore.assigneeId);
    }
  };
  scheduleEvery("points streaks", 15 * 60_000, recordMisses);
  scheduleEvery("weekly digest", 10 * 60_000, async () => {
    const result = await digest.tick();
    if (result === "sent") console.log("Posted the Sunday digest to the household group.");
  });

  // --- Demo: credit the seeded history once the other demo seeds have run ---
  if (demoMode) {
    setTimeout(() => {
      try {
        const added = seedDemoPoints(store, points, digest, now());
        recordMisses();
        if (added) console.log(`Points: credited ${added} demo actions (chores, bills, paybacks, events).`);
      } catch (error) {
        console.warn("Demo points seed failed:", error instanceof Error ? error.message : error);
      }
    }, 1_500).unref?.();
  }

  return { points, digest };
}

/** Credits the demo's seeded history with the same keys the live hooks use, plus a little older history. */
export function seedDemoPoints(store: CartStore, points: PointsService, digest: DigestService, now: Date): number {
  if (points.meta("demo_seeded")) return 0;
  const db = store.database;
  const awards: AwardInput[] = [];
  const known = new Set(store.getMembers().map((member) => member.id));
  try {
    const rows = db.prepare("SELECT l.id, l.member_id, l.due_date, l.on_date, l.at, c.name FROM chore_log l JOIN chore_chores c ON c.id = l.chore_id WHERE l.kind = 'done' AND c.household_id = ?")
      .all(store.household) as Array<{ id: number; member_id: string | null; due_date: string | null; on_date: string; at: string; name: string }>;
    for (const row of rows) {
      if (!row.member_id || !known.has(row.member_id)) continue;
      awards.push({ kind: "chore", memberId: row.member_id, key: `chore:${row.id}`, label: row.name, onTime: !row.due_date || row.on_date <= row.due_date, day: row.due_date ?? row.on_date, at: row.at });
    }
  } catch { /* chores not set up */ }
  try {
    const bills = db.prepare("SELECT id, vendor, payer_member_id, due_date, paid_at FROM bill_bills WHERE household_id = ? AND state = 'saved' AND paid_at IS NOT NULL")
      .all(store.household) as Array<{ id: string; vendor: string; payer_member_id: string | null; due_date: string | null; paid_at: string }>;
    for (const bill of bills) {
      if (!bill.payer_member_id) continue;
      awards.push({ kind: "bill", memberId: bill.payer_member_id, key: `bill:${bill.id}`, label: `Paid ${bill.vendor}`, onTime: !bill.due_date || localIso(new Date(bill.paid_at)) <= bill.due_date, at: bill.paid_at });
    }
    const payments = db.prepare("SELECT from_member_id, to_member_id, created_at FROM bill_payments WHERE household_id = ?").all(store.household) as Array<{ from_member_id: string; to_member_id: string; created_at: string }>;
    for (const payment of payments) {
      const day = localIso(new Date(payment.created_at));
      const to = store.getMembers().find((member) => member.id === payment.to_member_id)?.name.split(/\s+/)[0] ?? "someone";
      awards.push({ kind: "payback", memberId: payment.from_member_id, key: `payback:${payment.from_member_id}:${payment.to_member_id}:${day}`, label: `Paid ${to} back`, at: payment.created_at });
    }
  } catch { /* bills not set up */ }
  try {
    const events = db.prepare("SELECT id, title, kind, all_day, created_by, created_at FROM event_events WHERE household_id = ? AND cancelled_at IS NULL AND created_by IS NOT NULL")
      .all(store.household) as Array<{ id: string; title: string; kind: string; all_day: number; created_by: string; created_at: string }>;
    for (const event of events) awards.push({ kind: "event", memberId: event.created_by, key: `event:${event.id}`, label: event.title, social: event.kind !== "house", timed: !event.all_day, at: event.created_at });
  } catch { /* events not set up */ }
  // Two earlier grocery runs (shopper points and "most bought" history).
  const ids = store.getMembers().map((member) => member.id);
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const runs = [
    { key: "demo-run-1", payer: ids[1] ?? ids[0], at: daysAgo(20), items: [{ name: "Bananas", quantity: 3 }, { name: "Oat milk", quantity: 2 }, { name: "Eggs", quantity: 1 }] },
    { key: "demo-run-2", payer: ids[0], at: daysAgo(6), items: [{ name: "Bananas", quantity: 2 }, { name: "Oat milk", quantity: 1 }, { name: "Pasta", quantity: 2 }] },
  ];
  for (const run of runs) {
    if (!run.payer) continue;
    awards.push({ kind: "checkout", memberId: run.payer, key: `checkout:${run.key}`, label: "Grocery checkout", at: run.at });
    digest.recordPurchases(run.key, run.items, run.at);
  }
  const added = points.seedDemo({ awards });
  points.setMeta("demo_seeded", now.toISOString());
  return added;
}
