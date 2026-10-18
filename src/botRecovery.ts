import type { DatabaseSync } from "node:sqlite";
import type { GroupRef } from "./householdGroup.js";

type Delivery = {
  message_id: string; space_id: string; phone: string | null; reply: string | null;
  status: "processing" | "pending" | "sent"; attempts: number;
};

/** Durable reply delivery. Retrying a send never runs a member's command again. */
export class BotRecovery {
  #drainTask: Promise<void> | null = null;
  #drainAgain = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly householdId: string,
    private readonly send: (ref: GroupRef, reply: string) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = console.warn,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS bot_reply_deliveries (
      household_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      phone TEXT,
      reply TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(household_id, message_id)
    )`);
    // A crash between applying a command and queuing its reply is recovered from the store's idempotency log.
    // Unknown outcomes are reported honestly; they are never replayed automatically.
    const interrupted = db.prepare("SELECT * FROM bot_reply_deliveries WHERE household_id = ? AND status = 'processing'").all(householdId) as Delivery[];
    for (const row of interrupted) {
      const recorded = db.prepare("SELECT reply_text FROM processed_messages WHERE message_id = ?").get(row.message_id) as { reply_text: string | null } | undefined;
      this.#complete(row.message_id, recorded ? recorded.reply_text : "GroupCart restarted before finishing your last message. Check “cart” or the relevant feature before trying it again; some changes may already have been saved.");
    }
  }

  async handle(messageId: string, ref: GroupRef, process: () => Promise<string | null>): Promise<void> {
    const inserted = this.db.prepare("INSERT OR IGNORE INTO bot_reply_deliveries (household_id, message_id, space_id, phone, status) VALUES (?, ?, ?, ?, 'processing')")
      .run(this.householdId, messageId, ref.id, ref.phone ?? null);
    if (Number(inserted.changes)) {
      let reply: string | null;
      try {
        reply = await process();
      } catch {
        this.log("A household message failed; the bot is continuing with the next message.");
        const recorded = this.db.prepare("SELECT reply_text FROM processed_messages WHERE message_id = ?").get(messageId) as { reply_text: string | null } | undefined;
        reply = recorded ? recorded.reply_text : "I couldn’t finish that message. Check “cart” or the relevant feature before trying again; some changes may already have been saved.";
      }
      this.#complete(messageId, reply);
    }
    await this.drain();
  }

  #complete(messageId: string, reply: string | null): void {
    this.db.prepare("UPDATE bot_reply_deliveries SET reply = ?, status = ?, next_attempt_at = 0 WHERE household_id = ? AND message_id = ?")
      .run(reply, reply ? "pending" : "sent", this.householdId, messageId);
  }

  drain(): Promise<void> {
    if (this.#drainTask) {
      this.#drainAgain = true;
      return this.#drainTask;
    }
    this.#drainTask = (async () => {
      do {
        this.#drainAgain = false;
        await this.#deliver();
      } while (this.#drainAgain);
    })().finally(() => { this.#drainTask = null; });
    return this.#drainTask;
  }

  async waitForIdle(): Promise<void> { await this.#drainTask; }

  async #deliver(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM bot_reply_deliveries WHERE household_id = ? AND status = 'pending' AND next_attempt_at <= ? ORDER BY rowid LIMIT 20")
      .all(this.householdId, this.now()) as Delivery[];
    for (const row of rows) {
      try {
        await this.send({ id: row.space_id, ...(row.phone ? { phone: row.phone } : {}) }, row.reply!);
        this.db.prepare("UPDATE bot_reply_deliveries SET status = 'sent' WHERE household_id = ? AND message_id = ?").run(this.householdId, row.message_id);
      } catch {
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
        this.db.prepare("UPDATE bot_reply_deliveries SET attempts = attempts + 1, next_attempt_at = ? WHERE household_id = ? AND message_id = ?")
          .run(this.now() + delay, this.householdId, row.message_id);
        this.log("A group reply could not be confirmed; it is saved for retry.");
      }
    }
  }
}
