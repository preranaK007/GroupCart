import type { StoreContext } from "./context.js";
import type { CartSnapshot, CheckoutHooks, SplitwiseExpenseRecord, SplitwiseExpenseStatus } from "./types.js";

/** `splitwise` / `settle` show the latest status; `splitwise retry` re-sends a failed log (live path only). */
export const SPLITWISE_COMMAND_PATTERN = /^(splitwise|settle|settle up|splitwise status|splitwise retry)$/i;
export const SPLITWISE_RETRY_PATTERN = /^splitwise retry$/i;

type SplitwiseExpenseRow = {
  checkout_key: string; revision: number; source: string; payer_member_id: string | null; payer_name: string | null;
  total_cents: number; currency: string; description: string; shares_json: string; request_json: string | null;
  status: string; mode: string; note: string | null; expense_id: string | null; expense_url: string | null;
  error: string | null; attempts: number; created_at: string; updated_at: string;
};

/**
 * Splitwise expense log: persistence for one Splitwise expense per completed
 * checkout, plus the checkout hooks (src/splitwise.ts) that record and send it.
 * Mock checkout and confirmed receipt totals call `recordCheckout` inside their
 * transaction. Merely sending a cart to Kroger must never create an expense.
 */
export class SplitwiseLog {
  #hooks: CheckoutHooks | undefined;

  constructor(private readonly ctx: StoreContext) {}

  setHooks(hooks: CheckoutHooks | undefined): void {
    this.#hooks = hooks;
  }

  /** Reply to “splitwise” / “settle” (status only; no network). */
  statusReply(): string {
    const pending = this.ctx.db.prepare("SELECT count(*) AS n FROM grocery_purchases WHERE household_id = ? AND status IN ('awaiting_total', 'awaiting_confirmation')")
      .get(this.ctx.householdId) as { n: number };
    const status = this.#hooks?.status() ?? "Splitwise logging isn’t set up in this GroupCart.";
    return pending.n ? `${status}\n${pending.n} grocery purchase draft(s) still need the shopper’s paid total and confirmation; they are not expenses. Text “purchases”.` : status;
  }

  /** Reply to “splitwise retry”, or undefined when no hooks are installed (the text falls through to status). */
  async retryReply(): Promise<string | undefined> {
    if (!this.#hooks) return undefined;
    try {
      return await this.#hooks.retry();
    } catch (error) {
      return `Splitwise retry failed (${error instanceof Error ? error.message : "unknown error"}). The checkout itself is unaffected.`;
    }
  }

  /** Inserts the log row for a checkout; returns false if one already exists (idempotent). */
  insert(record: SplitwiseExpenseRecord): boolean {
    const result = this.ctx.db.prepare(
      "INSERT OR IGNORE INTO splitwise_expenses (checkout_key, household_id, revision, source, payer_member_id, payer_name, total_cents, currency, description, shares_json, request_json, status, mode, note, expense_id, expense_url, error, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.checkoutKey, this.ctx.householdId, record.revision, record.source, record.payerMemberId, record.payerName,
      record.totalCents, record.currency, record.description, JSON.stringify(record.shares),
      record.request ? JSON.stringify(record.request) : null, record.status, record.mode, record.note,
      record.expenseId, record.expenseUrl, record.error, record.attempts, record.createdAt, record.updatedAt,
    );
    return Number(result.changes) > 0;
  }

  get(checkoutKey: string): SplitwiseExpenseRecord | undefined {
    const row = this.ctx.db.prepare("SELECT * FROM splitwise_expenses WHERE checkout_key = ? AND household_id = ?")
      .get(checkoutKey, this.ctx.householdId) as SplitwiseExpenseRow | undefined;
    return row ? SplitwiseLog.#record(row) : undefined;
  }

  latest(): SplitwiseExpenseRecord | undefined {
    const row = this.ctx.db.prepare("SELECT * FROM splitwise_expenses WHERE household_id = ? ORDER BY revision DESC LIMIT 1")
      .get(this.ctx.householdId) as SplitwiseExpenseRow | undefined;
    return row ? SplitwiseLog.#record(row) : undefined;
  }

  /** Atomically moves a row from one of `from` to 'sending'; only one caller can win. */
  claim(checkoutKey: string, from: SplitwiseExpenseStatus[]): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const result = this.ctx.db.prepare(
      `UPDATE splitwise_expenses SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE checkout_key = ? AND household_id = ? AND status IN (${placeholders})`,
    ).run(new Date().toISOString(), checkoutKey, this.ctx.householdId, ...from);
    return Number(result.changes) > 0;
  }

  update(
    checkoutKey: string,
    patch: { status: SplitwiseExpenseStatus; expenseId?: string | null; expenseUrl?: string | null; error?: string | null },
  ): void {
    this.ctx.db.prepare(
      "UPDATE splitwise_expenses SET status = ?, expense_id = COALESCE(?, expense_id), expense_url = COALESCE(?, expense_url), error = ?, updated_at = ? WHERE checkout_key = ? AND household_id = ?",
    ).run(patch.status, patch.expenseId ?? null, patch.expenseUrl ?? null, patch.error ?? null, new Date().toISOString(), checkoutKey, this.ctx.householdId);
  }

  /**
   * Hands a completed checkout to the hooks inside the caller's open transaction,
   * isolated by a savepoint. Returns the checkout key, or undefined when nothing was recorded. Never throws.
   */
  recordCheckout(snapshot: CartSnapshot, payerMemberId: string | undefined, source: "mock" | "kroger"): string | undefined {
    if (!this.#hooks) return undefined;
    const checkoutKey = `${this.ctx.householdId}:r${snapshot.revision}`;
    const payer = snapshot.members.find((member) => member.id === payerMemberId);
    this.ctx.db.exec("SAVEPOINT splitwise_log");
    try {
      this.#hooks.record({
        checkoutKey,
        householdId: this.ctx.householdId,
        revision: snapshot.revision,
        source,
        payer: payer ? { id: payer.id, name: payer.name } : null,
        totalCents: snapshot.totalCents,
        items: snapshot.items.map((item) => ({ name: item.name, quantity: item.quantity, totalCents: item.totalCents })),
        shares: snapshot.members.map((member) => ({ memberId: member.id, name: member.name, shareCents: member.shareCents })),
        completedAt: new Date().toISOString(),
      });
      this.ctx.db.exec("RELEASE splitwise_log");
      return checkoutKey;
    } catch (error) {
      this.ctx.db.exec("ROLLBACK TO splitwise_log");
      this.ctx.db.exec("RELEASE splitwise_log");
      console.warn(`Splitwise log for checkout ${checkoutKey} was not recorded: ${error instanceof Error ? error.message : "unknown error"}`);
      return undefined;
    }
  }

  /** Demo checkouts are always simulated (no network), so the summary is ready inside the transaction. */
  summary(checkoutKey: string | undefined): string | undefined {
    return checkoutKey ? this.#hooks?.summary(checkoutKey) : undefined;
  }

  /** After commit: send (live) or summarize (simulated). Never throws. */
  async finishCheckoutLog(checkoutKey: string | undefined): Promise<string | undefined> {
    if (!checkoutKey || !this.#hooks) return undefined;
    try {
      return await this.#hooks.finish(checkoutKey);
    } catch (error) {
      return `Splitwise: couldn’t log this checkout (${error instanceof Error ? error.message : "unknown error"}). The checkout itself is complete.`;
    }
  }

  static #record(row: SplitwiseExpenseRow): SplitwiseExpenseRecord {
    return {
      checkoutKey: row.checkout_key,
      revision: row.revision,
      source: row.source === "kroger" ? "kroger" : "mock",
      payerMemberId: row.payer_member_id,
      payerName: row.payer_name,
      totalCents: row.total_cents,
      currency: row.currency,
      description: row.description,
      shares: JSON.parse(row.shares_json) as SplitwiseExpenseRecord["shares"],
      request: row.request_json ? JSON.parse(row.request_json) as Record<string, string> : null,
      status: row.status as SplitwiseExpenseStatus,
      mode: row.mode === "live" ? "live" : "simulated",
      note: row.note,
      expenseId: row.expense_id,
      expenseUrl: row.expense_url,
      error: row.error,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
