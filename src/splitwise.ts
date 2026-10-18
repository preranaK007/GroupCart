// Splitwise integration: after a checkout, log one expense in the household's
// Splitwise group. The shopper (payer) paid the full total and each member owes
// the share GroupCart already computed. Demo checkouts, and checkouts while
// Splitwise is not configured, are simulated: the would-be request is recorded
// (the split still counts in Bills balances), but nothing is sent. Only demo
// replies call that "simulated"; a live Kroger checkout just reports the split.
// A Splitwise failure never affects checkout.

import { money } from "./cart.js";
import type {
  CartStore,
  CheckoutHooks,
  CompletedCheckout,
  SplitwiseExpenseRecord,
} from "./store.js";

export const SPLITWISE_API_BASE = "https://secure.splitwise.com/api/v3.0";
const SPLITWISE_WEB_BASE = "https://secure.splitwise.com";
const CURRENCY = "USD";
const REQUEST_TIMEOUT_MS = 15_000;
/** A claim stuck in 'sending' longer than this (e.g. after a crash) may be retried. */
const STALE_SENDING_MS = 2 * 60_000;

export type SplitwiseUserRef = { kind: "user_id"; id: number } | { kind: "email"; email: string };
export type SplitwiseFetch = (input: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Config parsing and mapping
// ---------------------------------------------------------------------------

/** Parses `Alex=12345,Maya=maya@example.com` into lower-cased member name -> Splitwise user. */
export function parseSplitwiseMembers(value: string | undefined): { members: Map<string, SplitwiseUserRef>; warnings: string[] } {
  const members = new Map<string, SplitwiseUserRef>();
  const warnings: string[] = [];
  if (!value?.trim()) return { members, warnings };
  for (const entry of value.split(",")) {
    if (!entry.trim()) continue;
    const separator = entry.lastIndexOf("=");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "";
    const target = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!name || !target) {
      warnings.push(`Ignored a SPLITWISE_MEMBERS entry without name=user (“${entry.trim().slice(0, 40)}”).`);
    } else if (/^\d+$/.test(target)) {
      members.set(name.toLocaleLowerCase(), { kind: "user_id", id: Number(target) });
    } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      members.set(name.toLocaleLowerCase(), { kind: "email", email: target.toLocaleLowerCase() });
    } else {
      warnings.push(`Ignored SPLITWISE_MEMBERS entry for ${name}: expected a numeric Splitwise user id or an email.`);
    }
  }
  return { members, warnings };
}

/** Integer cents -> Splitwise decimal string ("1234" -> "12.34"). Never uses floats. */
export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`Invalid cent amount: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function describeUser(user: SplitwiseUserRef): string {
  return user.kind === "user_id" ? `user_id:${user.id}` : `email:${user.email}`;
}

function parseUserDescription(value: string | null): SplitwiseUserRef | null {
  if (!value) return null;
  if (value.startsWith("user_id:")) return { kind: "user_id", id: Number(value.slice(8)) };
  if (value.startsWith("email:")) return { kind: "email", email: value.slice(6) };
  return null;
}

export type ExpenseShareInput = {
  name: string;
  user: SplitwiseUserRef | null;
  paidCents: number;
  owedCents: number;
};

/**
 * Builds the flat `POST /create_expense` body. Throws if the shares do not sum
 * exactly to the cost (to the cent) or if a user is unmapped and no
 * placeholder label is allowed (placeholders are only for simulated previews).
 */
export function buildCreateExpenseBody(input: {
  groupId: number;
  currency: string;
  description: string;
  details?: string;
  totalCents: number;
  shares: ExpenseShareInput[];
  unmappedPlaceholder?: (name: string) => string;
}): Record<string, string> {
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents <= 0) throw new Error("The checkout total must be a positive amount.");
  const paid = input.shares.reduce((sum, share) => sum + share.paidCents, 0);
  const owed = input.shares.reduce((sum, share) => sum + share.owedCents, 0);
  if (paid !== input.totalCents) throw new Error(`Paid shares (${centsToDecimal(paid)}) don’t equal the total (${centsToDecimal(input.totalCents)}).`);
  if (owed !== input.totalCents) throw new Error(`Owed shares (${centsToDecimal(owed)}) don’t equal the total (${centsToDecimal(input.totalCents)}).`);
  const body: Record<string, string> = {
    cost: centsToDecimal(input.totalCents),
    description: input.description,
    group_id: String(input.groupId),
    currency_code: input.currency,
  };
  if (input.details) body.details = input.details;
  input.shares.forEach((share, index) => {
    if (share.paidCents < 0 || share.owedCents < 0) throw new Error(`Negative share for ${share.name}.`);
    if (share.user?.kind === "user_id") body[`users__${index}__user_id`] = String(share.user.id);
    else if (share.user?.kind === "email") body[`users__${index}__email`] = share.user.email;
    else if (input.unmappedPlaceholder) body[`users__${index}__user_id`] = input.unmappedPlaceholder(share.name);
    else throw new Error(`${share.name} has no Splitwise user in SPLITWISE_MEMBERS.`);
    body[`users__${index}__paid_share`] = centsToDecimal(share.paidCents);
    body[`users__${index}__owed_share`] = centsToDecimal(share.owedCents);
  });
  return body;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export class SplitwiseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when a POST may have reached Splitwise even though we saw a failure. */
    readonly maybeDelivered = false,
  ) {
    super(message);
    this.name = "SplitwiseError";
  }
}

function errorsToText(errors: unknown): string | undefined {
  if (!errors) return undefined;
  if (typeof errors === "string") return errors.trim() || undefined;
  if (Array.isArray(errors)) {
    const parts = errors.flatMap((entry) => errorsToText(entry) ?? []);
    return parts.length ? parts.join("; ") : undefined;
  }
  if (typeof errors === "object") {
    const parts = Object.entries(errors as Record<string, unknown>).flatMap(([key, value]) => {
      const text = errorsToText(value);
      return text ? [key === "base" ? text : `${key}: ${text}`] : [];
    });
    return parts.length ? parts.join("; ") : undefined;
  }
  return String(errors);
}

export class SplitwiseClient {
  readonly #apiKey: string;
  readonly #fetch: SplitwiseFetch;
  readonly #baseUrl: string;

  constructor(apiKey: string, fetchImpl: SplitwiseFetch = (input, init) => fetch(input, init), baseUrl = SPLITWISE_API_BASE) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getCurrentUser(): Promise<{ id: number; first_name?: string; last_name?: string }> {
    const data = await this.#request("GET", "/get_current_user") as { user?: { id: number; first_name?: string; last_name?: string } };
    if (!data.user) throw new SplitwiseError("Splitwise did not return the current user.");
    return data.user;
  }

  async getGroup(groupId: number): Promise<{ id: number; name?: string; members?: Array<{ id: number; email?: string; first_name?: string }> }> {
    const data = await this.#request("GET", `/get_group/${groupId}`) as { group?: { id: number; name?: string; members?: Array<{ id: number; email?: string; first_name?: string }> } };
    if (!data.group) throw new SplitwiseError(`Splitwise did not return group ${groupId}.`);
    return data.group;
  }

  async listGroupExpenses(groupId: number, limit = 50): Promise<Array<{ id: number; details?: string | null; deleted_at?: string | null }>> {
    const data = await this.#request("GET", `/get_expenses?group_id=${groupId}&limit=${limit}`) as { expenses?: Array<{ id: number; details?: string | null; deleted_at?: string | null }> };
    return data.expenses ?? [];
  }

  async createExpense(body: Record<string, string>): Promise<{ id: string }> {
    const data = await this.#request("POST", "/create_expense", body) as { expenses?: Array<{ id?: number | string }> };
    const id = data.expenses?.[0]?.id;
    if (id === undefined || id === null) throw new SplitwiseError("Splitwise accepted the request but returned no expense id.", 200, true);
    return { id: String(id) };
  }

  async #request(method: "GET" | "POST", path: string, body?: Record<string, string>): Promise<unknown> {
    const isPost = method === "POST";
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new SplitwiseError(timedOut ? "Splitwise didn’t respond in time" : "couldn’t reach Splitwise", undefined, isPost);
    }
    let data: unknown = undefined;
    try { data = await response.json(); } catch { /* non-JSON body */ }
    const detail = data && typeof data === "object" ? errorsToText((data as { errors?: unknown; error?: unknown }).errors ?? (data as { error?: unknown }).error) : undefined;
    if (response.status === 401) throw new SplitwiseError("Splitwise rejected the API key (401). Check SPLITWISE_API_KEY.", 401);
    if (response.status === 403) throw new SplitwiseError(`Splitwise denied access (403)${detail ? `: ${detail}` : ""}. Is the key’s user in the group?`, 403);
    if (response.status === 404) throw new SplitwiseError(`Splitwise couldn’t find that resource (404)${detail ? `: ${detail}` : ""}. Check SPLITWISE_GROUP_ID.`, 404);
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new SplitwiseError(`Splitwise rate limit reached (429)${retryAfter ? `; retry after ${retryAfter}s` : ""}`, 429);
    }
    if (!response.ok) {
      throw new SplitwiseError(`Splitwise returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, response.status, isPost && response.status >= 500);
    }
    // A 200 can still carry validation errors; treat any non-empty errors as failure.
    if (detail) throw new SplitwiseError(`Splitwise reported: ${detail}`, response.status);
    if (data === undefined) throw new SplitwiseError("Splitwise returned an unreadable response.", response.status, isPost);
    return data;
  }
}

// ---------------------------------------------------------------------------
// Service: checkout hooks, sending, status text
// ---------------------------------------------------------------------------

export type SplitwiseOptions = {
  apiKey?: string;
  groupId?: string;
  members?: string;
  fetchImpl?: SplitwiseFetch;
};

export class SplitwiseService implements CheckoutHooks {
  readonly configured: boolean;
  readonly groupId: number | undefined;
  readonly warnings: string[];
  readonly #store: CartStore;
  readonly #members: Map<string, SplitwiseUserRef>;
  readonly #client: SplitwiseClient | undefined;

  constructor(store: CartStore, options: SplitwiseOptions) {
    this.#store = store;
    const parsed = parseSplitwiseMembers(options.members);
    this.#members = parsed.members;
    this.warnings = [...parsed.warnings];
    const groupId = options.groupId?.trim();
    this.groupId = groupId && /^\d+$/.test(groupId) ? Number(groupId) : undefined;
    if (groupId && this.groupId === undefined) this.warnings.push("SPLITWISE_GROUP_ID must be the numeric Splitwise group id.");
    const apiKey = options.apiKey?.trim();
    const anySet = Boolean(apiKey || groupId || options.members?.trim());
    this.configured = Boolean(apiKey && this.groupId !== undefined && this.#members.size);
    if (anySet && !this.configured) {
      this.warnings.push("Splitwise is partly configured; set SPLITWISE_API_KEY, SPLITWISE_GROUP_ID, and SPLITWISE_MEMBERS. Checkouts will be simulated until then.");
    }
    this.#client = this.configured ? new SplitwiseClient(apiKey!, options.fetchImpl) : undefined;
  }

  /** Verifies the key and group (GET /get_current_user, /get_group/{id}) and reports mapped users missing from the group. */
  async checkConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.#client || this.groupId === undefined) return { ok: false, message: "Splitwise is not configured; checkouts will be simulated." };
    try {
      const user = await this.#client.getCurrentUser();
      const group = await this.#client.getGroup(this.groupId);
      const ids = new Set((group.members ?? []).map((member) => member.id));
      const emails = new Set((group.members ?? []).flatMap((member) => member.email ? [member.email.toLocaleLowerCase()] : []));
      const missing = [...this.#members.entries()]
        .filter(([, ref]) => ref.kind === "user_id" ? !ids.has(ref.id) : !emails.has(ref.email))
        .map(([name]) => name);
      const groupName = group.name ? `“${group.name}”` : `#${group.id}`;
      return missing.length
        ? { ok: false, message: `Splitwise connected as user #${user.id} to group ${groupName}, but these SPLITWISE_MEMBERS aren’t in that group: ${missing.join(", ")}.` }
        : { ok: true, message: `Splitwise connected as user #${user.id}; expenses will be logged to group ${groupName}.` };
    } catch (error) {
      return { ok: false, message: `Splitwise connection check failed: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }

  // CheckoutHooks ------------------------------------------------------------

  record(checkout: CompletedCheckout): void {
    const now = new Date().toISOString();
    const live = checkout.source === "kroger" && this.configured;
    const note = checkout.source !== "kroger"
      ? "Demo checkout: simulated, nothing was sent to Splitwise."
      : live ? null : "Splitwise isn’t connected (set SPLITWISE_API_KEY, SPLITWISE_GROUP_ID, SPLITWISE_MEMBERS), so nothing was sent.";
    const problems: string[] = [];
    if (!checkout.payer) problems.push("GroupCart couldn’t tell who paid for this checkout.");

    const shares: ExpenseShareInput[] = [];
    const memberIds: string[] = [];
    const unmapped: string[] = [];
    for (const share of checkout.shares) {
      const isPayer = share.memberId === checkout.payer?.id;
      const paidCents = isPayer ? checkout.totalCents : 0;
      if (!paidCents && !share.shareCents) continue;
      const user = this.#members.get(share.name.toLocaleLowerCase()) ?? null;
      if (!user) unmapped.push(share.name);
      shares.push({ name: share.name, user, paidCents, owedCents: share.shareCents });
      memberIds.push(share.memberId);
    }
    // In a simulated run with no mapping configured at all, missing mappings are expected; don't nag.
    if (unmapped.length && (live || this.#members.size)) problems.push(`No Splitwise user in SPLITWISE_MEMBERS for ${unmapped.join(", ")}.`);
    const owedSum = shares.reduce((sum, share) => sum + share.owedCents, 0);
    if (owedSum !== checkout.totalCents) problems.push(`Member shares (${money(owedSum)}) don’t add up to the total (${money(checkout.totalCents)}).`);

    const description = `Groceries · GroupCart ${checkout.source === "kroger" ? "Kroger" : "demo"} checkout`;
    const itemLines = checkout.items.slice(0, 25).map((item) => `${item.quantity} × ${item.name} — ${money(item.totalCents)}`);
    if (checkout.items.length > 25) itemLines.push(`…and ${checkout.items.length - 25} more`);
    const details = `${itemLines.join("\n")}\n\n${this.#marker(checkout.checkoutKey)}`;

    let request: Record<string, string> | null = null;
    let buildError: string | undefined;
    try {
      request = buildCreateExpenseBody({
        groupId: this.groupId ?? 0,
        currency: CURRENCY,
        description,
        details,
        totalCents: checkout.totalCents,
        shares,
        unmappedPlaceholder: live ? undefined : (name) => `<${name}: not in SPLITWISE_MEMBERS>`,
      });
      if (!live && this.groupId === undefined) request.group_id = "<SPLITWISE_GROUP_ID>";
    } catch (error) {
      buildError = error instanceof Error ? error.message : "Couldn’t build the Splitwise request.";
    }
    const allProblems = [...new Set([...problems, ...(buildError && !problems.length ? [buildError] : [])])];

    const record: SplitwiseExpenseRecord = {
      checkoutKey: checkout.checkoutKey,
      revision: checkout.revision,
      source: checkout.source,
      payerMemberId: checkout.payer?.id ?? null,
      payerName: checkout.payer?.name ?? null,
      totalCents: checkout.totalCents,
      currency: CURRENCY,
      description,
      shares: shares.map((share, index) => ({
        memberId: memberIds[index]!,
        name: share.name,
        paidCents: share.paidCents,
        owedCents: share.owedCents,
        splitwiseUser: share.user ? describeUser(share.user) : null,
      })),
      request,
      status: live ? (allProblems.length ? "failed" : "pending") : "simulated",
      mode: live ? "live" : "simulated",
      note: !live && allProblems.length ? `${note} A live send would fail: ${allProblems.join(" ")}` : note,
      expenseId: null,
      expenseUrl: null,
      error: live && allProblems.length ? allProblems.join(" ") : null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    // INSERT OR IGNORE on the checkout key: the same checkout can never get a second row.
    this.#store.insertSplitwiseExpense(record);
  }

  summary(checkoutKey: string): string | undefined {
    const record = this.#store.getSplitwiseExpense(checkoutKey);
    return record ? formatSplitwiseSummary(record) : undefined;
  }

  async finish(checkoutKey: string): Promise<string | undefined> {
    const record = this.#store.getSplitwiseExpense(checkoutKey);
    if (!record) return undefined;
    if (record.status === "pending") await this.#send(record, ["pending"]);
    return this.summary(checkoutKey);
  }

  status(): string {
    const record = this.#store.latestSplitwiseExpense();
    if (!record) {
      return this.configured
        ? "No checkout has been logged to Splitwise yet. After the next checkout, GroupCart will add it to your Splitwise group."
        : "Splitwise isn’t connected, so nothing is sent there. Grocery checkouts still count in the Bills balances.";
    }
    const when = new Date(record.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    return `Latest checkout (revision ${record.revision}, ${when}):\n${formatSplitwiseSummary(record)}`;
  }

  async retry(): Promise<string> {
    const record = this.#store.latestSplitwiseExpense();
    if (!record) return "There isn’t a checkout to log to Splitwise yet.";
    if (record.status === "logged") return `Already logged; nothing to retry.\n${formatSplitwiseSummary(record)}`;
    if (record.status === "simulated") {
      return `${record.source === "kroger" ? "Splitwise isn’t connected" : "That checkout was simulated"}, so there’s nothing to retry.\n${formatSplitwiseSummary(record)}`;
    }
    if (!this.#client || this.groupId === undefined || record.mode !== "live" || !record.request) {
      return `Splitwise can’t retry this checkout: ${record.error ?? "Splitwise is not configured."}`;
    }
    if (record.status === "sending" && Date.now() - Date.parse(record.updatedAt) < STALE_SENDING_MS) {
      return "GroupCart is already sending this checkout to Splitwise. Text “splitwise” in a minute for the result.";
    }
    // Before re-sending, look for an expense a previous attempt may have created.
    try {
      const existing = (await this.#client.listGroupExpenses(this.groupId))
        .find((expense) => !expense.deleted_at && expense.details?.includes(this.#marker(record.checkoutKey)));
      if (existing) {
        const id = String(existing.id);
        this.#store.updateSplitwiseExpense(record.checkoutKey, { status: "logged", expenseId: id, expenseUrl: splitwiseExpenseUrl(this.groupId, id), error: null });
        return `Found this checkout already in Splitwise, so I didn’t add it again.\n${this.summary(record.checkoutKey)}`;
      }
    } catch (error) {
      return `Couldn’t check Splitwise for an earlier copy of this expense (${error instanceof Error ? error.message : "unknown error"}), so I didn’t resend it. Try “splitwise retry” again shortly.`;
    }
    await this.#send(record, ["pending", "failed", "sending"]);
    return this.summary(record.checkoutKey) ?? "Splitwise status is unavailable.";
  }

  // Internals -----------------------------------------------------------------

  #marker(checkoutKey: string): string {
    return `GroupCart checkout ${checkoutKey}`;
  }

  async #send(record: SplitwiseExpenseRecord, from: SplitwiseExpenseRecord["status"][]): Promise<void> {
    if (!this.#client || this.groupId === undefined || !record.request) return;
    if (!this.#store.claimSplitwiseExpense(record.checkoutKey, from)) return; // someone else is sending / already done
    try {
      const { id } = await this.#client.createExpense(record.request);
      this.#store.updateSplitwiseExpense(record.checkoutKey, { status: "logged", expenseId: id, expenseUrl: splitwiseExpenseUrl(this.groupId, id), error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Splitwise request failed";
      const hint = error instanceof SplitwiseError && error.maybeDelivered
        ? " The request may have reached Splitwise; “splitwise retry” checks for an existing copy before resending."
        : "";
      this.#store.updateSplitwiseExpense(record.checkoutKey, { status: "failed", error: `${message}.${hint}` });
      console.warn(`Splitwise logging failed for checkout revision ${record.revision}: ${message}`);
    }
  }
}

/**
 * Web link for a logged expense. Splitwise's API does not return an expense
 * URL; this points at the expense inside its group in the web app.
 */
export function splitwiseExpenseUrl(groupId: number, expenseId: string): string {
  return `${SPLITWISE_WEB_BASE}/#/groups/${groupId}/expenses/${encodeURIComponent(expenseId)}`;
}

// ---------------------------------------------------------------------------
// Presentation (group reply + dashboard JSON)
// ---------------------------------------------------------------------------

function debts(record: SplitwiseExpenseRecord): Array<{ name: string; cents: number }> {
  return record.shares
    .filter((share) => share.memberId !== record.payerMemberId && share.owedCents > 0)
    .map((share) => ({ name: share.name, cents: share.owedCents }));
}

function owesLine(record: SplitwiseExpenseRecord): string {
  const payer = record.payerName ?? "the shopper";
  const owing = debts(record).map((debt) => `${debt.name} owes ${payer} ${money(debt.cents)}`);
  const own = record.shares.find((share) => share.memberId === record.payerMemberId)?.owedCents ?? 0;
  const parts = [...owing, ...(own ? [`${payer}’s own share ${money(own)}`] : [])];
  return parts.length ? parts.join(" · ") : "No one else owes anything.";
}

export function formatSplitwiseSummary(record: SplitwiseExpenseRecord): string {
  const total = money(record.totalCents);
  const payer = record.payerName ?? "the shopper";
  switch (record.status) {
    case "logged":
      return `Splitwise: logged ${total} paid by ${payer}${record.expenseId ? ` (expense #${record.expenseId})` : ""}. ${owesLine(record)}.`;
    case "simulated":
      // A Kroger checkout is live: without Splitwise credentials it isn't simulated, just not copied there. The split
      // still counts in the Bills balances (src/bills.ts reads this log).
      if (record.source === "kroger") return `Split: ${owesLine(record)} (in Bills balances).`;
      return `Splitwise (simulated): would log ${total} paid by ${payer}. ${owesLine(record)}. ${record.note ?? "Nothing was sent."}`;
    case "pending":
    case "sending":
      return `Splitwise: logging ${total} paid by ${payer}… Text “splitwise” for the result.`;
    case "failed":
      return `Splitwise: couldn’t log ${total} (${(record.error ?? "unknown error").replace(/\.$/, "")}). The checkout itself is complete. Text “splitwise retry” to try again.`;
  }
}

/** Dashboard-safe view of the latest record: names and amounts only (no Splitwise ids or emails). */
export function splitwiseDashboardView(record: SplitwiseExpenseRecord | undefined): Record<string, unknown> {
  if (!record) return { state: "none" };
  return {
    state: record.status,
    mode: record.mode,
    revision: record.revision,
    source: record.source,
    totalCents: record.totalCents,
    currency: record.currency,
    payerName: record.payerName,
    debts: debts(record).map((debt) => ({ name: debt.name, owesTo: record.payerName, cents: debt.cents })),
    shares: record.shares.map(({ name, paidCents, owedCents }) => ({ name, paidCents, owedCents })),
    expenseId: record.expenseId,
    expenseUrl: record.expenseUrl,
    error: record.error,
    note: record.note,
    summary: formatSplitwiseSummary(record),
    updatedAt: record.updatedAt,
  };
}
