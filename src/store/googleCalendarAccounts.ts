import type { StoreContext } from "./context.js";
import type { GoogleCalendarAccount } from "./types.js";

/**
 * Per-member Google Calendar (free/busy) connections used by src/googleCalendar.ts.
 * Refresh tokens stay in this local SQLite file and are never returned by any dashboard API.
 */
export class GoogleCalendarAccounts {
  constructor(private readonly ctx: StoreContext) {}

  account(memberId: string): GoogleCalendarAccount | undefined {
    const row = this.ctx.db.prepare(
      "SELECT member_id, refresh_token, scope, status, last_error, connected_at FROM google_calendar_accounts WHERE member_id = ?",
    ).get(memberId) as { member_id: string; refresh_token: string; scope: string; status: string; last_error: string | null; connected_at: string } | undefined;
    return row ? {
      memberId: row.member_id,
      refreshToken: row.refresh_token,
      scope: row.scope,
      status: row.status === "needs_reconnect" ? "needs_reconnect" : "connected",
      lastError: row.last_error,
      connectedAt: row.connected_at,
    } : undefined;
  }

  save(memberId: string, refreshToken: string, scope: string): void {
    const now = new Date().toISOString();
    this.ctx.db.prepare(
      "INSERT INTO google_calendar_accounts (member_id, refresh_token, scope, status, last_error, connected_at, updated_at) VALUES (?, ?, ?, 'connected', NULL, ?, ?) ON CONFLICT(member_id) DO UPDATE SET refresh_token = excluded.refresh_token, scope = excluded.scope, status = 'connected', last_error = NULL, connected_at = excluded.connected_at, updated_at = excluded.updated_at",
    ).run(memberId, refreshToken, scope, now, now);
  }

  markNeedsReconnect(memberId: string, reason: string): void {
    this.ctx.db.prepare(
      "UPDATE google_calendar_accounts SET status = 'needs_reconnect', last_error = ?, updated_at = ? WHERE member_id = ?",
    ).run(reason.slice(0, 240), new Date().toISOString(), memberId);
  }

  delete(memberId: string): void {
    this.ctx.db.prepare("DELETE FROM google_calendar_accounts WHERE member_id = ?").run(memberId);
  }
}
