import type { DatabaseSync } from "node:sqlite";
import type { CartLedger } from "./cartLedger.js";
import type { KrogerCheckout } from "./krogerCheckout.js";
import type { ListCommands } from "./listCommands.js";
import type { ListText } from "./listText.js";
import type { ProductSearch } from "./productSearch.js";
import type { RecurringLists } from "./recurringLists.js";
import type { SharingSessions } from "./sharing.js";
import type { Member } from "./types.js";

/** The feature modules behind CartStore. Each one can call the others through this registry. */
export type StoreModules = {
  cart: CartLedger;
  sharing: SharingSessions;
  checkout: KrogerCheckout;
  search: ProductSearch;
  lists: RecurringLists;
  listCommands: ListCommands;
  listText: ListText;
};

/** Database handle, household settings, and the reply/member helpers every module shares. */
export class StoreContext {
  constructor(
    readonly db: DatabaseSync,
    readonly householdId: string,
    readonly dashboardUrl: string,
    readonly krogerCartEnabled: boolean,
    readonly now: () => Date,
    readonly reminderHour: number,
  ) {}

  getMembers(): Member[] {
    return this.db.prepare(
      "SELECT id, handle, name FROM members WHERE household_id = ? ORDER BY name COLLATE NOCASE",
    ).all(this.householdId) as Member[];
  }

  existingReply(messageId: string): string | null | undefined {
    const row = this.db.prepare(
      "SELECT reply_text FROM processed_messages WHERE message_id = ?",
    ).get(messageId) as { reply_text: string | null } | undefined;
    return row ? row.reply_text : undefined;
  }

  recordReply(messageId: string, reply: string | null): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO processed_messages (message_id, reply_text, processed_at) VALUES (?, ?, ?)",
    ).run(messageId, reply, new Date().toISOString());
  }

  saveMessageReply(messageId: string, reply: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.recordReply(messageId, reply);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  saveAndReturnReply(messageId: string, reply: string): string {
    this.saveMessageReply(messageId, reply);
    return reply;
  }

  /** Run `produce` in a transaction and record its reply for this message ID (idempotent). */
  transactReply(messageId: string, produce: () => string): string | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.existingReply(messageId);
      if (existing !== undefined) {
        this.db.exec("COMMIT");
        return existing;
      }
      const reply = produce();
      this.recordReply(messageId, reply);
      this.db.exec("COMMIT");
      return reply;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  memberNames(ids: string[]): string[] {
    return this.getMembers().filter((member) => ids.includes(member.id)).map((member) => member.name);
  }

  joinNames(names: string[]): string {
    if (names.length <= 1) return names.join("");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
}
