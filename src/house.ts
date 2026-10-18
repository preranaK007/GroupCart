// House: the household's pinned info board (Wi-Fi, door codes, trash day, landlord, house rules, emergency info,
// notes), maintenance requests with photos and a weekly nudge, guest heads-ups with ok/concern reactions, quiet
// hours (a household default plus "quiet hours tonight from 10pm"), and quick polls for anything.
//
// setupHouse(...) wires it through src/platform.ts: group commands (registered ahead of bills, so a "broken: …"
// photo isn't read as a bill), /house + /api/house/*, connector tools, a "house" section in whats_on_my_plate,
// one schedule (poll auto-close and the repair nudge), help lines, and the demo seed. Tables use the house_
// prefix; repair photos live in <data dir>/house-files and are served only through /api/house/files.
//
// Guest visits are household events (src/events.ts, emoji 🧳), created through EventsService.create, so they
// show on /calendar and Home "Upcoming" and get the events module's own reminders; House adds the heads-up and
// the reactions. Secrets (Wi-Fi password, door codes) never appear in page HTML or GET JSON: the page fetches
// them on "reveal" (POST /api/house/reveal), which the remote-access guard limits to signed-in members and the
// computer running GroupCart. The group commands "wifi" and "door code" answer in the household's own group.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { HttpError, isLocalRequest, isSameOriginMutation, readJsonBody, readRawBody } from "./auth.js";
import { addDays, dayOfWeek, localDate, zonedTimeToEpoch } from "./availability.js";
import { config } from "./config.js";
import { registerSummaryProvider } from "./coreTools.js";
import { EventsService, type EventRecord, type OccurrenceView } from "./events.js";
import { formatDay, localMinutes } from "./eventsParse.js";
import { CalendarService } from "./googleCalendar.js";
import {
  CARD_KINDS, CARD_KIND_ORDER, DEFAULT_QUIET, capitalize, clockLabel, isCardKind, maskFields, matchScore, nightsLabel, normalizeText,
  parseGuest, parseHouseCommand, parseQuiet, parseReaction, parseRepairNew, parseVoteText, repairKey, secretKeys, trashHint,
  type CardKind, type GuestRequest, type QuietCommand, type QuietDefault,
} from "./houseParse.js";
import { NamedListsService } from "./namedLists.js";
import {
  notifyGroup, registerCommand, registerHelp, registerRoute, registerTools, requestMember, scheduleEvery,
  type CommandAttachment, type CommandContext, type ToolCaller, type ToolSpec,
} from "./platform.js";
import { avatarFor, sniffImage } from "./profiles.js";
import type { CartStore } from "./store.js";
import { renderHousePage, setQuietCalendarProvider } from "./ui/housePage.js";

const execFileAsync = promisify(execFile);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const POLL_TTL = 24 * HOUR;
const PHOTO_LIMIT = 15 * 1024 * 1024;
const PHOTO_FOLLOW_UP = 5 * 60_000;
const NUDGE_AFTER_DAYS = 7;
const GUEST_EMOJI = "🧳";
const FILE_NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp|heic|svg)$/;
const FILE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml" };

type Member = { id: string; name: string };
type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number };

export type CardView = {
  id: string; kind: CardKind; title: string; emoji: string; pinned: boolean; position: number;
  /** Secret fields are masked ("••••••••"); see reveal(). */
  fields: Record<string, string>;
  /** Secret fields that have a value (the page shows reveal/copy buttons for these). */
  secrets: string[];
  hint: string | null;
  updatedAt: string; updatedBy: string | null;
};
export type RepairStatus = "open" | "reported" | "fixed";
export type RepairLogEntry = { kind: string; memberId: string | null; note: string | null; at: string };
export type RepairView = {
  id: string; number: number; title: string; status: RepairStatus; assigneeId: string | null; createdBy: string | null;
  createdAt: string; updatedAt: string; closedAt: string | null; photoUrl: string | null; ageDays: number; log: RepairLogEntry[];
};
export type GuestView = {
  eventId: string; title: string; emoji: string; label: string; date: string; endDate: string; start: number; end: number; allDay: boolean;
  hostId: string | null; announcedAt: string | null; reactions: Record<string, { reaction: "ok" | "concern"; note: string | null }>;
};
export type QuietWindow = { id: string | null; kind: "default" | "adhoc"; start: number; end: number; night: string; reason: string | null; createdBy: string | null; label: string };
export type HousePoll = {
  id: string; question: string; options: string[]; createdBy: string | null; createdAt: string; closesAt: number;
  status: "open" | "closed"; closedAt: string | null; closedReason: string | null;
  /** member id → option number (1-based). */
  votes: Record<string, number>; counts: number[]; leaders: number[];
};

type CardRow = { id: string; kind: string; title: string; fields_json: string; pinned: number; position: number; updated_by: string | null; updated_at: string };
type RepairRow = { id: string; number: number; title: string; status: string; assignee_id: string | null; photo_file: string | null; created_by: string | null; created_at: string; updated_at: string; closed_at: string | null };
type QuietRow = { id: string; start_at: number; end_at: number; reason: string | null; created_by: string | null };
type PollRow = { id: string; question: string; options_json: string; created_by: string | null; created_at: string; closes_at: number; status: string; closed_at: string | null; closed_reason: string | null };

export type HouseOptions = {
  /** Guest visits are created through the events module; without it, guests are off. */
  events?: EventsService;
  timeZone?: string;
  now?: () => number;
  filesDir?: string;
  demoMode?: boolean;
  publicUrl?: string;
  notify?: (text: string) => Promise<void>;
};

const jsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

export class HouseService {
  readonly #store: CartStore;
  readonly #db: DatabaseSync;
  readonly #events: EventsService | undefined;
  readonly #now: () => number;
  readonly #notify: (text: string) => Promise<void>;
  readonly #filesDir: string;
  readonly timeZone: string;
  readonly demoMode: boolean;
  readonly publicUrl: string;

  constructor(store: CartStore, options: HouseOptions = {}) {
    this.#store = store;
    this.#db = store.database;
    this.#events = options.events;
    this.#now = options.now ?? Date.now;
    this.#notify = options.notify ?? notifyGroup;
    this.#filesDir = options.filesDir ?? join(dirname(resolve(config.databasePath)), "house-files");
    this.timeZone = options.timeZone ?? CalendarService.serverTimeZone();
    this.demoMode = Boolean(options.demoMode);
    this.publicUrl = (options.publicUrl ?? config.dashboardPublicUrl).replace(/\/+$/, "");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS house_cards (
        id TEXT PRIMARY KEY, household_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, fields_json TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS house_repairs (
        id TEXT PRIMARY KEY, household_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        assignee_id TEXT, photo_file TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS house_repair_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repair_id TEXT NOT NULL, kind TEXT NOT NULL, member_id TEXT, note TEXT, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS house_guests (event_id TEXT PRIMARY KEY, household_id TEXT NOT NULL, host_id TEXT, announced_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS house_guest_reactions (
        event_id TEXT NOT NULL, member_id TEXT NOT NULL, reaction TEXT NOT NULL, note TEXT, at TEXT NOT NULL, PRIMARY KEY (event_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS house_quiet (
        id TEXT PRIMARY KEY, household_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, reason TEXT,
        created_by TEXT, created_at TEXT NOT NULL, cancelled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS house_polls (
        id TEXT PRIMARY KEY, household_id TEXT NOT NULL, question TEXT NOT NULL, options_json TEXT NOT NULL, created_by TEXT,
        created_at TEXT NOT NULL, closes_at INTEGER NOT NULL, status TEXT NOT NULL, closed_at TEXT, closed_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS house_votes (poll_id TEXT NOT NULL, member_id TEXT NOT NULL, option INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (poll_id, member_id));
      CREATE TABLE IF NOT EXISTS house_nudges (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS house_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  // --- Basics ----------------------------------------------------------------

  now(): number { return this.#now(); }
  #iso(at = this.#now()): string { return new Date(at).toISOString(); }
  today(): string { return localDate(this.#now(), this.timeZone); }
  #nowMin(): number { return localMinutes(this.#now(), this.timeZone); }
  get #household(): string { return this.#store.household; }
  get houseUrl(): string { return `${this.publicUrl}/house`; }

  members(): Member[] {
    return this.#store.getMembers().map(({ id, name }) => ({ id, name }));
  }

  memberName(id: string | null | undefined): string {
    return this.members().find((member) => member.id === id)?.name ?? "Someone";
  }

  #actor(memberId: string, via?: string): string {
    return via ? `${this.memberName(memberId)} via ${via}` : this.memberName(memberId);
  }

  meta(key: string): string | undefined {
    return (this.#db.prepare("SELECT value FROM house_meta WHERE key = ?").get(`${this.#household}:${key}`) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO house_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${this.#household}:${key}`, value);
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try { const value = fn(); this.#db.exec("COMMIT"); return value; } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  // --- Info cards ------------------------------------------------------------

  #cardRows(): CardRow[] {
    return this.#db.prepare("SELECT * FROM house_cards WHERE household_id = ? ORDER BY pinned DESC, position, updated_at").all(this.#household) as CardRow[];
  }

  #cardRow(id: string): CardRow | undefined {
    return this.#db.prepare("SELECT * FROM house_cards WHERE id = ? AND household_id = ?").get(id, this.#household) as CardRow | undefined;
  }

  #cardView(row: CardRow): CardView {
    const kind = (isCardKind(row.kind) ? row.kind : "note") as CardKind;
    const fields = jsonParse<Record<string, string>>(row.fields_json, {});
    const hint = kind === "trash" ? trashHint(`${fields.trash ?? ""}`, this.today(), this.#nowMin()) ?? (fields.recycling ? trashHint(fields.recycling, this.today(), this.#nowMin()) : null) : null;
    return {
      id: row.id, kind, title: row.title, emoji: CARD_KINDS[kind].emoji, pinned: Boolean(row.pinned), position: row.position,
      fields: maskFields(kind, fields), secrets: secretKeys(kind).filter((key) => fields[key]), hint, updatedAt: row.updated_at, updatedBy: row.updated_by,
    };
  }

  cards(): CardView[] {
    return this.#cardRows().map((row) => this.#cardView(row));
  }

  /** Unmasked fields of every card of one kind (for the group commands and get_house_info with include_secrets). */
  cardsOf(kind: CardKind): Array<{ id: string; title: string; fields: Record<string, string> }> {
    return this.#cardRows().filter((row) => row.kind === kind).map((row) => ({ id: row.id, title: row.title, fields: jsonParse<Record<string, string>>(row.fields_json, {}) }));
  }

  /** A card's secret values (the page's reveal / copy buttons). */
  reveal(cardId: string): Record<string, string> | null {
    const row = this.#cardRow(cardId);
    if (!row || !isCardKind(row.kind)) return null;
    const fields = jsonParse<Record<string, string>>(row.fields_json, {});
    return Object.fromEntries(secretKeys(row.kind).filter((key) => fields[key]).map((key) => [key, fields[key]!]));
  }

  /** Creates or edits a card. Fields missing from `fields` keep their value; "" clears one. */
  saveCard(input: { id?: string | null; kind?: unknown; title?: unknown; fields?: Record<string, unknown>; pinned?: unknown }, actorId: string | null): Result<{ card: CardView }> {
    const existing = input.id ? this.#cardRow(input.id) : undefined;
    if (input.id && !existing) return { ok: false, error: "That card no longer exists.", status: 404 };
    const kind = existing?.kind ?? input.kind;
    if (!isCardKind(kind)) return { ok: false, error: "Pick a card type." };
    const fields = jsonParse<Record<string, string>>(existing?.fields_json, {});
    for (const spec of CARD_KINDS[kind].fields) {
      if (!input.fields || !Object.hasOwn(input.fields, spec.key)) continue;
      const raw = input.fields[spec.key];
      const value = typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim().slice(0, spec.secret ? 128 : spec.multiline ? 2000 : 200) : "";
      if (value) fields[spec.key] = value; else delete fields[spec.key];
    }
    if (!Object.keys(fields).length) return { ok: false, error: "Fill in at least one field." };
    const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : existing?.title ?? CARD_KINDS[kind].label).replace(/\s+/g, " ").slice(0, 40);
    const stamp = this.#iso();
    if (existing) {
      const pinned = typeof input.pinned === "boolean" ? (input.pinned ? 1 : 0) : existing.pinned;
      this.#db.prepare("UPDATE house_cards SET title = ?, fields_json = ?, pinned = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(title, JSON.stringify(fields), pinned, actorId, stamp, existing.id);
      return { ok: true, card: this.#cardView(this.#cardRow(existing.id)!) };
    }
    const pinned = typeof input.pinned === "boolean" ? input.pinned : ["wifi", "door", "trash", "landlord"].includes(kind);
    const position = Number((this.#db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM house_cards WHERE household_id = ?").get(this.#household) as { next: number }).next);
    const id = randomUUID();
    this.#db.prepare("INSERT INTO house_cards (id, household_id, kind, title, fields_json, pinned, position, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, this.#household, kind, title, JSON.stringify(fields), pinned ? 1 : 0, position, actorId, stamp);
    return { ok: true, card: this.#cardView(this.#cardRow(id)!) };
  }

  deleteCard(id: string): boolean {
    return Number(this.#db.prepare("DELETE FROM house_cards WHERE id = ? AND household_id = ?").run(id, this.#household).changes) > 0;
  }

  setPinned(id: string, pinned: boolean): boolean {
    const position = Number((this.#db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM house_cards WHERE household_id = ?").get(this.#household) as { next: number }).next);
    return Number(this.#db.prepare("UPDATE house_cards SET pinned = ?, position = ? WHERE id = ? AND household_id = ?").run(pinned ? 1 : 0, position, id, this.#household).changes) > 0;
  }

  /** Moves a card one place earlier (-1) or later (1) among the cards in the same group (pinned or not). */
  moveCard(id: string, direction: number): boolean {
    const rows = this.#cardRows();
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return false;
    const group = rows.filter((candidate) => candidate.pinned === row.pinned);
    const index = group.indexOf(row);
    const other = group[index + (direction < 0 ? -1 : 1)];
    if (!other) return false;
    this.#tx(() => {
      // Renumber the group so equal positions can't stall a swap.
      group.forEach((candidate, order) => this.#db.prepare("UPDATE house_cards SET position = ? WHERE id = ?").run(order * 10, candidate.id));
      const a = group.indexOf(row) * 10;
      const b = group.indexOf(other) * 10;
      this.#db.prepare("UPDATE house_cards SET position = ? WHERE id = ?").run(b, row.id);
      this.#db.prepare("UPDATE house_cards SET position = ? WHERE id = ?").run(a, other.id);
    });
    return true;
  }

  // --- Repairs ---------------------------------------------------------------

  #repairRows(where = "1 = 1", ...args: Array<string | number>): RepairRow[] {
    return this.#db.prepare(`SELECT * FROM house_repairs WHERE household_id = ? AND ${where} ORDER BY created_at DESC`).all(this.#household, ...args) as RepairRow[];
  }

  #repairRow(id: string): RepairRow | undefined {
    return this.#db.prepare("SELECT * FROM house_repairs WHERE id = ? AND household_id = ?").get(id, this.#household) as RepairRow | undefined;
  }

  #repairView(row: RepairRow): RepairView {
    const log = (this.#db.prepare("SELECT kind, member_id, note, at FROM house_repair_log WHERE repair_id = ? ORDER BY at, id").all(row.id) as Array<{ kind: string; member_id: string | null; note: string | null; at: string }>)
      .map((entry) => ({ kind: entry.kind, memberId: entry.member_id, note: entry.note, at: entry.at }));
    const end = row.closed_at ? Date.parse(row.closed_at) : this.#now();
    return {
      id: row.id, number: row.number, title: row.title, status: (["open", "reported", "fixed"].includes(row.status) ? row.status : "open") as RepairStatus,
      assigneeId: row.assignee_id, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at,
      photoUrl: row.photo_file ? `/api/house/files/${row.photo_file}` : null, ageDays: Math.max(0, Math.floor((end - Date.parse(row.created_at)) / DAY)), log,
    };
  }

  repairs(): { open: RepairView[]; fixed: RepairView[] } {
    return {
      open: this.#repairRows("status != 'fixed'").map((row) => this.#repairView(row)).reverse(),
      fixed: this.#repairRows("status = 'fixed'").sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? "")).slice(0, 5).map((row) => this.#repairView(row)),
    };
  }

  getRepair(id: string): RepairView | undefined {
    const row = this.#repairRow(id);
    return row ? this.#repairView(row) : undefined;
  }

  #log(repairId: string, kind: string, memberId: string | null, note: string | null = null, at = this.#iso()): void {
    this.#db.prepare("INSERT INTO house_repair_log (repair_id, kind, member_id, note, at) VALUES (?, ?, ?, ?, ?)").run(repairId, kind, memberId, note, at);
  }

  async createRepair(input: { title: string; memberId: string; photo?: Buffer | null; createdAt?: number; /** Demo seed: an already stored file. */ photoFile?: string }): Promise<Result<{ repair: RepairView; photoError: string | null }>> {
    const title = capitalize(normalizeText(input.title).replace(/[.!]+$/, "")).slice(0, 80);
    if (title.length < 2) return { ok: false, error: "What’s broken? e.g. “broken: kitchen faucet leaking”." };
    const stamp = this.#iso(input.createdAt ?? this.#now());
    const id = randomUUID();
    const number = Number((this.#db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM house_repairs WHERE household_id = ?").get(this.#household) as { next: number }).next);
    this.#db.prepare("INSERT INTO house_repairs (id, household_id, number, title, status, assignee_id, photo_file, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?)")
      .run(id, this.#household, number, title, input.photoFile ?? null, input.memberId, stamp, stamp);
    this.#log(id, "opened", input.memberId, null, stamp);
    if (input.photoFile) this.#log(id, "photo", input.memberId, null, stamp);
    let photoError: string | null = null;
    if (input.photo) {
      const stored = await this.setPhoto(id, input.photo, input.memberId);
      if (!stored.ok) photoError = stored.error;
    }
    return { ok: true, repair: this.getRepair(id)!, photoError };
  }

  /** Stores (or replaces) a repair's photo after checking it is really an image. */
  async setPhoto(repairId: string, data: Buffer, memberId: string | null, file?: string): Promise<Result<{ repair: RepairView }>> {
    const row = this.#repairRow(repairId);
    if (!row) return { ok: false, error: "That repair no longer exists.", status: 404 };
    let stored = file ?? null;
    if (!stored) {
      const saved = await this.#storePhoto(data);
      if ("error" in saved) return { ok: false, error: saved.error, status: 415 };
      stored = saved.file;
    }
    if (row.photo_file && row.photo_file !== stored) rmSync(join(this.#filesDir, row.photo_file), { force: true });
    this.#db.prepare("UPDATE house_repairs SET photo_file = ?, updated_at = ? WHERE id = ?").run(stored, this.#iso(), repairId);
    this.#log(repairId, "photo", memberId);
    return { ok: true, repair: this.getRepair(repairId)! };
  }

  async #storePhoto(input: Buffer): Promise<{ file: string } | { error: string }> {
    if (input.length > PHOTO_LIMIT) return { error: "That photo is too large (15 MB max)." };
    const type = sniffImage(input);
    if (!type) return { error: "Send a PNG, JPEG, GIF, WebP, or HEIC photo." };
    mkdirSync(this.#filesDir, { recursive: true });
    const id = randomUUID();
    let data = input;
    let ext = type.ext;
    if (type.mimeType === "image/heic") {
      // iPhone photos: browsers other than Safari can't show HEIC, so convert with macOS sips when it's there.
      const converted = await heicToJpeg(input, this.#filesDir, id);
      if (converted) { data = converted; ext = "jpg"; }
    }
    writeFileSync(join(this.#filesDir, `${id}.${ext}`), data);
    return { file: `${id}.${ext}` };
  }

  /** Writes a generated file (demo seed) and returns its stored name. */
  storeGenerated(content: string | Buffer, ext: "svg" | "png"): string {
    mkdirSync(this.#filesDir, { recursive: true });
    const file = `${randomUUID()}.${ext}`;
    writeFileSync(join(this.#filesDir, file), content);
    return file;
  }

  /** Status, assignee, or a note. Returns what changed (for replies and notifications). */
  updateRepair(id: string, input: { status?: unknown; assigneeId?: unknown; note?: unknown }, actorId: string | null, at = this.#now()): Result<{ repair: RepairView; changed: string[] }> {
    const row = this.#repairRow(id);
    if (!row) return { ok: false, error: "That repair no longer exists.", status: 404 };
    const changed: string[] = [];
    const stamp = this.#iso(at);
    if (input.status !== undefined && input.status !== row.status) {
      if (input.status !== "open" && input.status !== "reported" && input.status !== "fixed") return { ok: false, error: "Status is open, reported, or fixed." };
      const reopened = row.status === "fixed";
      this.#db.prepare("UPDATE house_repairs SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(input.status, input.status === "fixed" ? stamp : null, stamp, id);
      this.#log(id, input.status === "fixed" ? "fixed" : reopened ? "reopened" : input.status === "reported" ? "reported" : "reopened", actorId, null, stamp);
      changed.push(input.status);
    }
    if (input.assigneeId !== undefined) {
      const assignee = input.assigneeId === null || input.assigneeId === "" ? null : String(input.assigneeId);
      if (assignee && !this.members().some((member) => member.id === assignee)) return { ok: false, error: "Pick someone in the household." };
      if (assignee !== row.assignee_id) {
        this.#db.prepare("UPDATE house_repairs SET assignee_id = ?, updated_at = ? WHERE id = ?").run(assignee, stamp, id);
        this.#log(id, assignee ? "assigned" : "unassigned", actorId, assignee, stamp);
        changed.push("assignee");
      }
    }
    if (typeof input.note === "string" && input.note.trim()) {
      this.#log(id, "note", actorId, input.note.trim().slice(0, 300), stamp);
      changed.push("note");
    }
    return { ok: true, repair: this.getRepair(id)!, changed };
  }

  /** Best-matching repairs for "fixed faucet" / "#3"; open ones only unless `all`. */
  findRepairs(query: string, options: { all?: boolean } = {}): RepairRow[] {
    const rows = this.#repairRows(options.all ? "1 = 1" : "status != 'fixed'");
    const number = query.trim().match(/^#?(\d{1,4})$/);
    if (number) return rows.filter((row) => row.number === Number(number[1]));
    if (/^(?:it|that|this|that one|this one)$/i.test(query.trim())) return rows.length === 1 ? rows : [];
    const scored = rows.map((row) => ({ row, score: matchScore(query, row.title) })).filter((entry) => entry.score > 0);
    const best = Math.max(0, ...scored.map((entry) => entry.score));
    return scored.filter((entry) => entry.score === best).map((entry) => entry.row);
  }

  #statusWord(status: string): string {
    return status === "reported" ? "reported" : status === "fixed" ? "fixed" : "open";
  }

  // --- Guests ----------------------------------------------------------------

  /** Upcoming guest visits: household events with the 🧳 emoji or announced here, next `days` days. */
  guests(days = 21): GuestView[] {
    if (!this.#events) return [];
    const now = this.#now();
    const hosts = new Map((this.#db.prepare("SELECT event_id, host_id, announced_at FROM house_guests WHERE household_id = ?").all(this.#household) as Array<{ event_id: string; host_id: string | null; announced_at: string }>)
      .map((row) => [row.event_id, row]));
    const seen = new Set<string>();
    return this.#events.occurrences(now - DAY, now + days * DAY)
      .filter((occurrence) => occurrence.end > now && occurrence.kind === "house" && (occurrence.emoji === GUEST_EMOJI || hosts.has(occurrence.eventId)))
      .filter((occurrence) => !seen.has(occurrence.eventId) && Boolean(seen.add(occurrence.eventId)))
      .map((occurrence) => {
        const host = hosts.get(occurrence.eventId);
        return {
          eventId: occurrence.eventId, title: occurrence.title, emoji: occurrence.emoji, label: occurrence.label, date: occurrence.date, endDate: occurrence.endDate,
          start: occurrence.start, end: occurrence.end, allDay: occurrence.allDay,
          hostId: host?.host_id ?? this.#events!.getEvent(occurrence.eventId)?.createdBy ?? null, announcedAt: host?.announced_at ?? null,
          reactions: this.#reactions(occurrence.eventId),
        };
      });
  }

  #reactions(eventId: string): GuestView["reactions"] {
    const rows = this.#db.prepare("SELECT member_id, reaction, note FROM house_guest_reactions WHERE event_id = ?").all(eventId) as Array<{ member_id: string; reaction: string; note: string | null }>;
    return Object.fromEntries(rows.map((row) => [row.member_id, { reaction: row.reaction === "concern" ? "concern" : "ok", note: row.note }]));
  }

  /** Creates the guest visit as a household event and returns the group heads-up. */
  announceGuest(input: { title: string; date: string; endDate?: string | null; startMin?: number | null; durationMin?: number | null; note?: string | null; hostId: string; via?: string; announcedAt?: number }): Result<{ guest: GuestView; text: string; event: EventRecord }> {
    if (!this.#events) return { ok: false, error: "Guest visits need the events module." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, error: "When? e.g. “having friends over Fri 8pm”." };
    const startMin = input.startMin ?? null;
    const created = this.#events.create({
      title: input.title, emoji: GUEST_EMOJI, kind: "house", date: input.date, endDate: startMin === null ? input.endDate ?? input.date : null,
      startMin, durationMin: startMin === null ? null : input.durationMin ?? 180,
      notes: [`Guest visit · ${this.memberName(input.hostId)} hosting`, input.note?.trim()].filter(Boolean).join("\n").slice(0, 500),
    }, input.hostId);
    if (!created.ok) return { ok: false, error: created.error };
    const next = this.#events.nextOccurrence(created.event);
    if (!next) {
      this.#events.cancel(created.event.id);
      return { ok: false, error: "That time has already passed." };
    }
    this.#db.prepare("INSERT OR REPLACE INTO house_guests (event_id, household_id, host_id, announced_at) VALUES (?, ?, ?, ?)").run(created.event.id, this.#household, input.hostId, this.#iso(input.announcedAt ?? this.#now()));
    const guest = this.guests(400).find((candidate) => candidate.eventId === created.event.id) ?? this.#guestFrom(next, input.hostId);
    // A visit that runs into (or ends within an hour of) quiet hours gets a gentle reminder.
    const quiet = startMin !== null ? this.quietWindows(next.start, next.end + HOUR).find((window) => window.start < next.end + HOUR && window.end > next.start) : undefined;
    const by = input.via ? ` (${this.#actor(input.hostId, input.via)})` : "";
    const quietNote = quiet ? ` Quiet hours start ${clockLabel(localMinutes(quiet.start, this.timeZone))}.` : "";
    const text = `${GUEST_EMOJI} Heads-up${by}: ${created.event.title} · ${next.label}.${quietNote}\nReply “ok” or “concern”.`;
    return { ok: true, guest, text, event: created.event };
  }

  #guestFrom(occurrence: OccurrenceView, hostId: string | null): GuestView {
    return {
      eventId: occurrence.eventId, title: occurrence.title, emoji: occurrence.emoji, label: occurrence.label, date: occurrence.date, endDate: occurrence.endDate,
      start: occurrence.start, end: occurrence.end, allDay: occurrence.allDay, hostId, announcedAt: null, reactions: {},
    };
  }

  /** "my sister" + host → "Maya’s sister staying" (web form and connector; chat phrases use parseGuest). */
  guestTitle(who: string, hostId: string, startMin: number | null, endDate: string | null): string {
    const host = this.memberName(hostId);
    if (/\b(?:over|staying|visiting|by)$/i.test(who)) return capitalize(who.replace(/^my\s+/i, `${host}’s `).replace(/^our\s+/i, "Our "));
    const label = /^(?:my|our)\s+/i.test(who) ? who.replace(/^my\s+/i, `${host}’s `).replace(/^our\s+/i, "Our ") : /^(?:friends?|guests?|people|family)$/i.test(who) ? `${host}’s ${who.toLowerCase().replace(/^people$/, "guests")}` : who;
    return `${capitalize(label)} ${startMin === null ? (endDate ? "staying" : "visiting") : "over"}`.slice(0, 60);
  }

  /** Records (or clears, with null) a member's reaction to a guest visit. */
  react(eventId: string, memberId: string, reaction: "ok" | "concern" | null, note: string | null = null): Result<{ guest: GuestView }> {
    const guest = this.guests(400).find((candidate) => candidate.eventId === eventId);
    if (!guest) return { ok: false, error: "That visit is over or was cancelled.", status: 404 };
    if (reaction === null) this.#db.prepare("DELETE FROM house_guest_reactions WHERE event_id = ? AND member_id = ?").run(eventId, memberId);
    else this.#db.prepare("INSERT INTO house_guest_reactions (event_id, member_id, reaction, note, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id, member_id) DO UPDATE SET reaction = excluded.reaction, note = excluded.note, at = excluded.at")
      .run(eventId, memberId, reaction, note, this.#iso());
    return { ok: true, guest: { ...guest, reactions: this.#reactions(eventId) } };
  }

  reactionLine(guest: GuestView, memberId: string, reaction: "ok" | "concern", note: string | null): string {
    const others = this.members().filter((member) => member.id !== guest.hostId);
    const oks = others.filter((member) => guest.reactions[member.id]?.reaction === "ok").length;
    if (reaction === "ok") return `👍 ${this.memberName(memberId)} is OK with ${guest.title} (${oks} of ${others.length}).`;
    const host = guest.hostId && guest.hostId !== memberId ? ` ${this.memberName(guest.hostId)}, maybe talk it through?` : "";
    return `⚠️ ${this.memberName(memberId)} has a concern about ${guest.title}${note ? `: ${note.replace(/[.!]+$/, "")}.` : "."}${host}`;
  }

  /** The heads-up a bare "ok"/"concern" answers: the newest one (last 24h), unless this member posted it. */
  #headsUpFor(memberId: string): GuestView | undefined {
    const since = this.#iso(this.#now() - DAY);
    const latest = this.guests(400)
      .filter((guest) => guest.announcedAt && guest.announcedAt >= since)
      .sort((a, b) => (b.announcedAt ?? "").localeCompare(a.announcedAt ?? ""))[0];
    return latest && latest.hostId !== memberId ? latest : undefined;
  }

  // --- Quiet hours -----------------------------------------------------------

  quietDefault(): QuietDefault {
    const saved = jsonParse<Partial<QuietDefault> | null>(this.meta("quiet_default"), null);
    if (!saved) return { ...DEFAULT_QUIET, nights: [...DEFAULT_QUIET.nights] };
    return {
      enabled: saved.enabled !== false,
      startMin: Number.isInteger(saved.startMin) ? saved.startMin! : DEFAULT_QUIET.startMin,
      endMin: Number.isInteger(saved.endMin) ? saved.endMin! : DEFAULT_QUIET.endMin,
      nights: Array.isArray(saved.nights) ? saved.nights.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [...DEFAULT_QUIET.nights],
    };
  }

  setQuietDefault(input: { enabled?: unknown; startMin?: unknown; endMin?: unknown; nights?: unknown }): Result<{ quiet: QuietDefault }> {
    const current = this.quietDefault();
    const minutes = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1440 ? value : fallback);
    const next: QuietDefault = {
      enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
      startMin: minutes(input.startMin, current.startMin),
      endMin: minutes(input.endMin, current.endMin),
      nights: Array.isArray(input.nights) ? [...new Set(input.nights.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : current.nights,
    };
    if (next.startMin === next.endMin) return { ok: false, error: "Start and end can’t be the same." };
    this.setMeta("quiet_default", JSON.stringify(next));
    return { ok: true, quiet: next };
  }

  defaultLabel(quiet = this.quietDefault()): string {
    return quiet.enabled && quiet.nights.length ? `${nightsLabel(quiet.nights)} ${clockLabel(quiet.startMin)}–${clockLabel(quiet.endMin)}` : "Off";
  }

  /** The evening a window belongs to (a 1am start counts for the night before). */
  #night(at: number): string {
    return localDate(at - 6 * HOUR, this.timeZone);
  }

  #windowLabel(start: number, end: number): string {
    const night = this.#night(start);
    const tonight = this.#night(this.#now());
    const day = night === tonight ? "Tonight" : night === addDays(tonight, 1) ? "Tomorrow night" : formatDay(night, this.today());
    const from = clockLabel(localMinutes(start, this.timeZone));
    const to = clockLabel(localMinutes(end, this.timeZone));
    return start <= this.#now() && end > this.#now() ? `Now until ${to}` : `${day} ${from}–${to}`;
  }

  /** Quiet windows overlapping [from, to): ad-hoc ones replace the household default for their night. */
  quietWindows(from: number, to: number): QuietWindow[] {
    const adhoc = (this.#db.prepare("SELECT id, start_at, end_at, reason, created_by FROM house_quiet WHERE household_id = ? AND cancelled_at IS NULL AND end_at > ? AND start_at < ? ORDER BY start_at")
      .all(this.#household, from - 2 * DAY, to + 2 * DAY) as QuietRow[])
      .map((row) => ({ id: row.id, kind: "adhoc" as const, start: Number(row.start_at), end: Number(row.end_at), night: this.#night(Number(row.start_at)), reason: row.reason, createdBy: row.created_by, label: "" }));
    const nights = new Set(adhoc.map((window) => window.night));
    const windows: QuietWindow[] = [...adhoc];
    const quiet = this.quietDefault();
    if (quiet.enabled && quiet.nights.length) {
      const startAbs = quiet.startMin < 12 * 60 ? quiet.startMin + 1440 : quiet.startMin;
      let endAbs = quiet.endMin;
      while (endAbs <= startAbs) endAbs += 1440;
      const first = addDays(localDate(from, this.timeZone), -1);
      const last = localDate(to, this.timeZone);
      for (let date = first; date <= last; date = addDays(date, 1)) {
        if (!quiet.nights.includes(dayOfWeek(date)) || nights.has(date)) continue;
        const start = zonedTimeToEpoch(addDays(date, Math.floor(startAbs / 1440)), startAbs % 1440, this.timeZone);
        const end = zonedTimeToEpoch(addDays(date, Math.floor(endAbs / 1440)), endAbs % 1440, this.timeZone);
        windows.push({ id: null, kind: "default", start, end, night: date, reason: null, createdBy: null, label: "" });
      }
    }
    return windows.filter((window) => window.end > from && window.start < to)
      .sort((a, b) => a.start - b.start)
      .map((window) => ({ ...window, label: this.#windowLabel(window.start, window.end) }));
  }

  /** Tonight's quiet hours (still to come or happening now), or null. */
  tonightQuiet(): QuietWindow | null {
    const now = this.#now();
    const tonight = this.#night(now);
    return this.quietWindows(now, now + 30 * HOUR).find((window) => window.night === tonight && window.end > now) ?? null;
  }

  inQuiet(at = this.#now()): boolean {
    return this.quietWindows(at, at + 1).some((window) => window.start <= at && window.end > at);
  }

  /**
   * Ad-hoc quiet hours for one night. startMin/endMin count from midnight of `date` (1440+ is after midnight);
   * null start/end use the household default times. Overlapping ad-hoc windows are replaced.
   */
  addQuiet(input: { date: string; startMin: number | null; endMin: number | null; reason: string | null; memberId: string | null }): Result<{ window: QuietWindow; replaced: number }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, error: "Which night?" };
    const quiet = this.quietDefault();
    const startAbs = input.startMin ?? (quiet.startMin < 12 * 60 ? quiet.startMin + 1440 : quiet.startMin);
    if (startAbs < 0 || startAbs >= 2 * 1440) return { ok: false, error: "That start time doesn’t look right." };
    let endAbs = input.endMin ?? quiet.endMin + 1440;
    while (endAbs <= startAbs) endAbs += 1440;
    if (endAbs - startAbs > 16 * 60) return { ok: false, error: "Quiet hours can run up to 16 hours." };
    const start = zonedTimeToEpoch(addDays(input.date, Math.floor(startAbs / 1440)), startAbs % 1440, this.timeZone);
    const end = zonedTimeToEpoch(addDays(input.date, Math.floor(endAbs / 1440)), endAbs % 1440, this.timeZone);
    if (end <= this.#now()) return { ok: false, error: "That time has already passed." };
    const stamp = this.#iso();
    const replaced = Number(this.#db.prepare("UPDATE house_quiet SET cancelled_at = ? WHERE household_id = ? AND cancelled_at IS NULL AND start_at < ? AND end_at > ?").run(stamp, this.#household, end, start).changes);
    const id = randomUUID();
    this.#db.prepare("INSERT INTO house_quiet (id, household_id, start_at, end_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, this.#household, start, end, input.reason?.trim().slice(0, 80) || null, input.memberId, stamp);
    const window = this.quietWindows(start, end).find((candidate) => candidate.id === id)!;
    return { ok: true, window, replaced };
  }

  cancelQuiet(id: string): boolean {
    return Number(this.#db.prepare("UPDATE house_quiet SET cancelled_at = ? WHERE id = ? AND household_id = ? AND cancelled_at IS NULL").run(this.#iso(), id, this.#household).changes) > 0;
  }

  quietLine(window: QuietWindow): string {
    const by = window.createdBy ? ` — ${this.memberName(window.createdBy)}${window.reason ? `: ${window.reason.charAt(0).toLowerCase()}${window.reason.slice(1)}` : ""}` : window.reason ? ` — ${window.reason}` : "";
    return `🤫 Quiet hours ${window.label.charAt(0).toLowerCase()}${window.label.slice(1)}${by}.`;
  }

  /** Windows for the calendar overlay (embedded in /calendar so the band draws with the week). */
  calendarQuiet(): { windows: Array<{ start: number; end: number; kind: string; label: string; reason: string | null; by: string | null }>; label: string } {
    const now = this.#now();
    return {
      label: this.defaultLabel(),
      windows: this.quietWindows(now - 21 * DAY, now + 63 * DAY).map((window) => ({ start: window.start, end: window.end, kind: window.kind, label: window.label, reason: window.reason, by: window.createdBy ? this.memberName(window.createdBy) : null })),
    };
  }

  // --- Polls -----------------------------------------------------------------

  #pollView(row: PollRow): HousePoll {
    const options = jsonParse<string[]>(row.options_json, []);
    const votes = Object.fromEntries((this.#db.prepare("SELECT member_id, option FROM house_votes WHERE poll_id = ?").all(row.id) as Array<{ member_id: string; option: number }>).map((vote) => [vote.member_id, Number(vote.option)]));
    const counts = options.map((_, index) => Object.values(votes).filter((option) => option === index + 1).length);
    const top = Math.max(0, ...counts);
    return {
      id: row.id, question: row.question, options, createdBy: row.created_by, createdAt: row.created_at, closesAt: Number(row.closes_at),
      status: row.status === "closed" ? "closed" : "open", closedAt: row.closed_at, closedReason: row.closed_reason,
      votes, counts, leaders: top ? counts.map((count, index) => (count === top ? index + 1 : 0)).filter(Boolean) : [],
    };
  }

  getPoll(id: string): HousePoll | undefined {
    const row = this.#db.prepare("SELECT * FROM house_polls WHERE id = ? AND household_id = ?").get(id, this.#household) as PollRow | undefined;
    return row ? this.#pollView(row) : undefined;
  }

  /** Open polls, newest first. */
  openPolls(): HousePoll[] {
    return (this.#db.prepare("SELECT * FROM house_polls WHERE household_id = ? AND status = 'open' ORDER BY created_at DESC").all(this.#household) as PollRow[]).map((row) => this.#pollView(row));
  }

  closedPolls(limit = 3): HousePoll[] {
    return (this.#db.prepare("SELECT * FROM house_polls WHERE household_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT ?").all(this.#household, limit) as PollRow[]).map((row) => this.#pollView(row));
  }

  createPoll(input: { question: string; options: string[]; memberId: string | null; createdAt?: number }): Result<{ poll: HousePoll }> {
    const question = normalizeText(input.question).slice(0, 120);
    const seen = new Set<string>();
    const options = input.options.map((option) => capitalize(normalizeText(String(option))).slice(0, 40)).filter((option) => option && !seen.has(option.toLowerCase()) && seen.add(option.toLowerCase()));
    if (!question) return { ok: false, error: "What’s the question?" };
    if (options.length < 2) return { ok: false, error: "Give at least two options." };
    if (options.length > 6) return { ok: false, error: "Keep it to 6 options or fewer." };
    const created = input.createdAt ?? this.#now();
    const id = randomUUID();
    this.#db.prepare("INSERT INTO house_polls (id, household_id, question, options_json, created_by, created_at, closes_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')")
      .run(id, this.#household, /[?.!]$/.test(question) ? question : `${question}?`, JSON.stringify(options), input.memberId, this.#iso(created), created + POLL_TTL);
    return { ok: true, poll: this.getPoll(id)! };
  }

  pollText(poll: HousePoll, via?: string): string {
    const by = poll.createdBy ? ` from ${this.#actor(poll.createdBy, via)}` : "";
    return `📊 Poll${by}: ${poll.question}\n${poll.options.map((option, index) => `${index + 1}) ${option}`).join("\n")}\nReply with a number. Closes in 24h or when everyone votes.`;
  }

  tally(poll: HousePoll): string {
    return poll.options.map((option, index) => `${option} ${poll.counts[index] ?? 0}`).join(" · ");
  }

  resultText(poll: HousePoll): string {
    const total = Object.keys(poll.votes).length;
    const head = `📊 ${poll.closedReason === "everyone" ? "Everyone voted" : "Poll closed"}: ${poll.question}`;
    if (!total) return `${head}\nNo votes.`;
    const leaders = poll.leaders.map((index) => poll.options[index - 1]!);
    const verdict = leaders.length === 1
      ? `→ ${leaders[0]} wins (${poll.counts[poll.leaders[0]! - 1]} of ${total}).`
      : `→ Tie: ${leaders.join(" and ")} (${poll.counts[poll.leaders[0]! - 1]} each).`;
    return `${head}\n${verdict}${poll.options.length > 2 || leaders.length > 1 ? `\n${this.tally(poll)}` : ""}`;
  }

  /** One vote per member (voting again changes it); closes the poll when everyone has voted. */
  vote(pollId: string, memberId: string, option: number): Result<{ poll: HousePoll; closedText: string | null }> {
    const poll = this.getPoll(pollId);
    if (!poll || poll.status !== "open") return { ok: false, error: "That poll is closed.", status: 409 };
    if (!Number.isInteger(option) || option < 1 || option > poll.options.length) return { ok: false, error: `Pick a number from 1 to ${poll.options.length}.` };
    this.#db.prepare("INSERT INTO house_votes (poll_id, member_id, option, at) VALUES (?, ?, ?, ?) ON CONFLICT(poll_id, member_id) DO UPDATE SET option = excluded.option, at = excluded.at")
      .run(pollId, memberId, option, this.#iso());
    const updated = this.getPoll(pollId)!;
    const everyone = this.members().every((member) => updated.votes[member.id]);
    const closedText = everyone ? this.closePoll(pollId, "everyone") : null;
    return { ok: true, poll: this.getPoll(pollId)!, closedText };
  }

  /** Closes an open poll once (atomic) and returns the result text, or null when it was already closed. */
  closePoll(pollId: string, reason: "time" | "everyone" | "manual"): string | null {
    const changed = Number(this.#db.prepare("UPDATE house_polls SET status = 'closed', closed_at = ?, closed_reason = ? WHERE id = ? AND household_id = ? AND status = 'open'").run(this.#iso(), reason, pollId, this.#household).changes);
    return changed ? this.resultText(this.getPoll(pollId)!) : null;
  }

  // --- Group chat ------------------------------------------------------------

  /** When this member was last asked something else that a bare number (or "ok") could answer. */
  #otherQuestionAt(memberId: string, kind: "number" | "ok"): string | null {
    let latest = this.#store.pendingQuestionAt(memberId);
    const later = (at: string | null | undefined) => { if (at && (!latest || at > latest)) latest = at; };
    if (kind === "number" && this.#events) {
      // Mirrors the events module: an open plan vote (or the member's own pick list) takes bare numbers too.
      for (const poll of this.#events.openPolls()) if (poll.mode === "vote" || poll.organizerId === memberId) later(poll.createdAt);
    }
    if (kind === "ok") {
      // A bill draft waiting for "ok" (src/bills.ts) is newer than the heads-up → leave "ok" to bills.
      try {
        later((this.#db.prepare("SELECT updated_at AS at FROM bill_pending WHERE household_id = ? AND member_id = ?").get(this.#household, memberId) as { at: string } | undefined)?.at);
      } catch { /* bills not set up */ }
    }
    return latest;
  }

  /** Replies to house phrases; null for anything else. Idempotent by message id. */
  async handleCommand(context: CommandContext): Promise<string | null> {
    const text = normalizeText(context.text);
    const image = context.attachments.find((attachment) => /^image\//i.test(attachment.mimeType));
    if (!text && !image) return null;
    const plan = this.#plan(context, text, image);
    if (!plan) return null;
    const recorded = this.#store.recordedReply(context.messageId);
    if (recorded !== undefined) return recorded;
    const reply = await plan();
    if (reply) this.#store.recordCommandReply(context.messageId, reply);
    return reply;
  }

  /** Decides whether a message is for House (without changing anything) and returns the action. */
  #plan(context: CommandContext, text: string, image: CommandAttachment | undefined): (() => Promise<string | null>) | null {
    const memberId = context.memberId;
    if (image) {
      const title = parseRepairNew(text) ?? (/^(?:broken|fix(?: this| me)?|needs fixing|repair)[!.]*$/i.test(text) ? "Something’s broken (see photo)" : null);
      if (title) return () => this.#newRepairReply(title, memberId, image);
      const recent = !text ? this.#repairRows("status != 'fixed' AND photo_file IS NULL AND created_by = ? AND created_at >= ?", memberId, this.#iso(this.#now() - PHOTO_FOLLOW_UP))[0] : undefined;
      if (recent) return () => this.#photoReply(recent, memberId, image);
      if (!text) return null;
    }

    const command = parseHouseCommand(text);
    if (command) {
      switch (command.kind) {
        case "info": return async () => this.#infoReply(command.topic, command.hint);
        case "poll.new": return async () => this.#newPollReply(command.question, command.options, memberId);
        case "poll.invalid": return async () => command.error;
        case "poll.list": return async () => this.#pollsReply();
        case "poll.close": {
          const poll = this.#pollToClose(command.hint, memberId);
          return poll ? async () => this.closePoll(poll.id, "manual") ?? "That poll is already closed." : null;
        }
        case "repair.list": return async () => this.#repairsReply();
        case "repair.new": return () => this.#newRepairReply(command.title, memberId, null);
        case "repair.fixed":
        case "repair.reported":
        case "repair.assign": {
          const matches = this.findRepairs(command.query);
          if (!matches.length) return null;
          return async () => this.#repairUpdateReply(command, matches, memberId);
        }
      }
    }

    const members = this.members();
    const guest = parseGuest(text, this.today(), this.#nowMin(), context.memberName || this.memberName(memberId), members.map((member) => member.name));
    if (guest && this.#events) return async () => this.#guestReply(guest, memberId);

    const quiet = parseQuiet(text, this.today(), this.#nowMin());
    if (quiet) return async () => this.#quietReply(quiet, memberId);

    const reaction = parseReaction(text);
    if (reaction) {
      const headsUp = this.#headsUpFor(memberId);
      const other = this.#otherQuestionAt(memberId, "ok");
      if (headsUp?.announcedAt && (!other || headsUp.announcedAt > other)) {
        return async () => {
          const result = this.react(headsUp.eventId, memberId, reaction.reaction, reaction.note);
          return result.ok ? this.reactionLine(result.guest, memberId, reaction.reaction, reaction.note) : result.error;
        };
      }
    }

    const vote = parseVoteText(text);
    if (vote) {
      const poll = this.openPolls()[0];
      const other = this.#otherQuestionAt(memberId, "number");
      if (poll && (!other || poll.createdAt > other)) {
        if (vote.kind === "multi") return async () => `One pick per person: reply ${poll.options.map((_, index) => index + 1).join(", ").replace(/, (\d)$/, ", or $1")}.`;
        const option = vote.kind === "number" ? vote.option : poll.options.findIndex((candidate) => candidate.toLowerCase() === vote.text.toLowerCase()) + 1;
        if (option > 0) return async () => this.#voteReply(poll, memberId, option);
      }
    }
    return null;
  }

  #infoReply(topic: string, hint?: string): string {
    const missing = (what: string) => `No ${what} saved yet. Add it on the House page: ${this.houseUrl}`;
    switch (topic) {
      case "wifi": {
        const cards = this.cardsOf("wifi");
        if (!cards.length) return missing("Wi-Fi");
        return cards.map((card) => `📶 ${card.title}: ${card.fields.network ?? "(no name)"}${card.fields.password ? `\nPassword: ${card.fields.password}` : ""}`).join("\n\n");
      }
      case "door": {
        let cards = this.cardsOf("door");
        if (!cards.length) return missing("door code");
        if (hint && hint !== "door") {
          const wanted = cards.filter((card) => matchScore(hint, card.title) > 0);
          if (wanted.length) cards = wanted;
        }
        const lines = cards.map((card) => `🔑 ${card.title}: ${card.fields.code ?? "(not set)"}${card.fields.note ? ` (${card.fields.note})` : ""}`);
        return `${lines.join("\n")}\nNext time you can tap to reveal codes on the House page, so they stay out of the chat: ${this.houseUrl}`;
      }
      case "rules": {
        const card = this.cardsOf("rules")[0];
        if (!card?.fields.text) return missing("house rules");
        const rules = card.fields.text.split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
        return `📜 ${card.title}:\n${rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}`;
      }
      case "landlord": {
        const card = this.cardsOf("landlord")[0];
        if (!card) return missing("landlord contact");
        const parts = [card.fields.name, card.fields.phone, card.fields.email].filter(Boolean);
        return `🏢 ${card.title}: ${parts.join(" · ") || "(no details)"}${card.fields.note ? `\n${card.fields.note}` : ""}`;
      }
      case "trash": {
        const card = this.cardsOf("trash")[0];
        if (!card) return missing("trash day");
        const hint = this.#cardView(this.#cardRow(card.id)!).hint;
        const parts = [card.fields.trash ? `Trash: ${card.fields.trash}` : "", card.fields.recycling ? `Recycling: ${card.fields.recycling}` : ""].filter(Boolean);
        return `🗑️ ${parts.join(" · ")}${hint ? ` (${hint.toLowerCase()}!)` : ""}`;
      }
      case "emergency": {
        const card = this.cardsOf("emergency")[0];
        if (!card?.fields.text) return missing("emergency info");
        return `🚨 ${card.title}:\n${card.fields.text}`;
      }
      default: {
        const open = this.repairs().open.length;
        const quiet = this.tonightQuiet();
        const polls = this.openPolls().length;
        const bits = [open ? `${open} open repair${open === 1 ? "" : "s"}` : "", quiet ? `quiet hours ${quiet.label.charAt(0).toLowerCase()}${quiet.label.slice(1)}` : "", polls ? `${polls} open poll${polls === 1 ? "" : "s"}` : ""].filter(Boolean);
        return `🏠 House: Wi-Fi, door codes, rules, and the landlord’s number are on ${this.houseUrl}${bits.length ? `\n${capitalize(bits.join(" · "))}.` : ""}\nTry “wifi”, “house rules”, “broken: …”, “poll: …”.`;
      }
    }
  }

  async #newRepairReply(title: string, memberId: string, image: CommandAttachment | null): Promise<string> {
    let photo: Buffer | null = null;
    let photoNote = "";
    if (image) {
      try { photo = await image.read(); } catch { photoNote = " (I couldn’t download the photo; send it again.)"; }
    }
    const created = await this.createRepair({ title, memberId, photo });
    if (!created.ok) return created.error;
    const key = repairKey(created.repair.title);
    const photoLine = created.repair.photoUrl ? " 📷" : created.photoError ? ` (${created.photoError})` : photoNote || " Send a photo if it helps.";
    return `🔧 Repair #${created.repair.number} logged: ${created.repair.title}.${photoLine}\nUpdates: “reported ${key}”, “fixed ${key}”.`;
  }

  async #photoReply(row: RepairRow, memberId: string, image: CommandAttachment): Promise<string> {
    let data: Buffer;
    try { data = await image.read(); } catch { return "I couldn’t download that photo. Try sending it again."; }
    const result = await this.setPhoto(row.id, data, memberId);
    return result.ok ? `📷 Added the photo to repair #${row.number}: ${row.title}.` : result.error;
  }

  #repairsReply(): string {
    const { open } = this.repairs();
    if (!open.length) return "🔧 Nothing broken right now. Log one with “broken: …” (a photo helps).";
    const lines = open.map((repair) => `• #${repair.number} ${repair.title} · ${repair.status === "reported" ? "reported" : "open"} ${repair.ageDays ? `${repair.ageDays}d` : "today"}${repair.assigneeId ? ` · ${this.memberName(repair.assigneeId)}` : ""}${repair.photoUrl ? " 📷" : ""}`);
    return `🔧 Open repairs:\n${lines.join("\n")}\nDetails: ${this.houseUrl}`;
  }

  #repairUpdateReply(command: { kind: "repair.fixed" | "repair.reported" | "repair.assign"; query: string; who?: string }, matches: RepairRow[], memberId: string): string {
    if (matches.length > 1) return `Which one? ${matches.map((row) => `#${row.number} ${row.title}`).join(" · ")}. Say “${command.kind === "repair.fixed" ? "fixed" : command.kind === "repair.reported" ? "reported" : "assign"} #${matches[0]!.number}”${command.kind === "repair.assign" ? " to …" : ""}.`;
    const row = matches[0]!;
    if (command.kind === "repair.fixed") {
      const result = this.updateRepair(row.id, { status: "fixed" }, memberId);
      if (!result.ok) return result.error;
      return `✅ Fixed: ${row.title} (#${row.number}${result.repair.ageDays ? `, open ${result.repair.ageDays} day${result.repair.ageDays === 1 ? "" : "s"}` : ""}). Thanks, ${this.memberName(memberId)}!`;
    }
    if (command.kind === "repair.reported") {
      const result = this.updateRepair(row.id, { status: "reported" }, memberId);
      if (!result.ok) return result.error;
      const landlord = this.cardsOf("landlord")[0]?.fields.name;
      return `📨 Reported${landlord ? ` to ${landlord}` : " to the landlord"}: ${row.title} (#${row.number}).`;
    }
    const who = command.who === "me" ? memberId : this.#memberByName(command.who ?? "", memberId);
    if (!who) return `I don’t know who “${command.who}” is.`;
    const result = this.updateRepair(row.id, { assigneeId: who }, memberId);
    if (!result.ok) return result.error;
    return `👍 ${this.memberName(who)} is on it: ${row.title} (#${row.number}).`;
  }

  #memberByName(name: string, senderId: string): string | null {
    const wanted = name.trim().toLowerCase();
    if (wanted === "me" || wanted === "myself") return senderId;
    const members = this.members();
    return (members.find((member) => member.name.toLowerCase() === wanted) ?? members.find((member) => member.name.split(/\s+/)[0]!.toLowerCase() === wanted))?.id ?? null;
  }

  #guestReply(guest: GuestRequest, memberId: string): string {
    if (!guest.date) return `When? e.g. “having friends over Fri 8pm” or “my sister is staying Sat–Sun”.`;
    const result = this.announceGuest({ title: guest.title, date: guest.date, endDate: guest.endDate, startMin: guest.startMin, durationMin: guest.durationMin, hostId: memberId });
    return result.ok ? result.text : result.error;
  }

  #quietReply(command: QuietCommand, memberId: string): string {
    const quiet = this.quietDefault();
    if (command.kind === "status") {
      const tonight = this.tonightQuiet();
      return `🤫 Quiet hours: ${this.defaultLabel(quiet).toLowerCase()}.${tonight ? `\n${tonight.label}${tonight.kind === "adhoc" && tonight.createdBy ? ` (${this.memberName(tonight.createdBy)}${tonight.reason ? `: ${tonight.reason.toLowerCase()}` : ""})` : ""}.` : ""}`;
    }
    if (command.kind === "cancel") {
      const tonight = this.tonightQuiet();
      if (!tonight) return "No quiet hours tonight.";
      if (tonight.kind === "default") return `Tonight is the household default (${clockLabel(quiet.startMin)}–${clockLabel(quiet.endMin)}). Change it on the House page: ${this.houseUrl}`;
      this.cancelQuiet(tonight.id!);
      const fallback = this.tonightQuiet();
      return `Cancelled tonight’s extra quiet hours.${fallback ? ` The usual ${clockLabel(quiet.startMin)}–${clockLabel(quiet.endMin)} still applies.` : ""}`;
    }
    if (command.kind === "default.invalid") return "Say it like “set quiet hours 11pm–8am weeknights”.";
    if (command.kind === "default") {
      const result = this.setQuietDefault({ enabled: true, startMin: command.startMin, endMin: command.endMin, nights: command.nights ?? quiet.nights });
      return result.ok ? `🤫 Quiet hours are now ${this.defaultLabel(result.quiet).toLowerCase()}.` : result.error;
    }
    // Ad hoc: if tonight's default already covers it, say so instead of stacking.
    if (command.startMin === null && command.endMin === null && !command.reason) {
      const existing = this.quietWindows(zonedTimeToEpoch(command.date, 12 * 60, this.timeZone), zonedTimeToEpoch(addDays(command.date, 1), 12 * 60, this.timeZone)).find((window) => window.night === command.date);
      if (existing) return `🤫 Quiet hours ${existing.label.charAt(0).toLowerCase()}${existing.label.slice(1)} already.`;
    }
    const result = this.addQuiet({ date: command.date, startMin: command.startMin, endMin: command.endMin, reason: command.reason, memberId });
    return result.ok ? this.quietLine(result.window) : result.error;
  }

  #newPollReply(question: string, options: string[], memberId: string): string {
    const created = this.createPoll({ question, options, memberId });
    return created.ok ? this.pollText(created.poll) : created.error;
  }

  #pollsReply(): string {
    const open = this.openPolls();
    if (!open.length) return "No open polls. Start one: “poll: takeout tonight? thai, pizza, sushi”.";
    const members = this.members().length;
    return `📊 Open polls:\n${open.map((poll) => `• ${poll.question} ${this.tally(poll)} (${Object.keys(poll.votes).length} of ${members} voted)`).join("\n")}\nReply with a number to vote on the newest one.`;
  }

  #pollToClose(hint: string | null, memberId: string): HousePoll | undefined {
    const open = this.openPolls();
    if (!open.length) return undefined;
    if (hint) {
      const matched = open.map((poll) => ({ poll, score: matchScore(hint, `${poll.question} ${poll.options.join(" ")}`) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score)[0];
      if (matched) return matched.poll;
    }
    // Otherwise "close poll" means the newest house poll unless an events plan vote is newer (that's the events module's).
    const other = this.#otherQuestionAt(memberId, "number");
    return !other || open[0]!.createdAt > other ? open[0] : undefined;
  }

  #voteReply(poll: HousePoll, memberId: string, option: number): string {
    const result = this.vote(poll.id, memberId, option);
    if (!result.ok) return result.error;
    if (result.closedText) return result.closedText;
    const waiting = this.members().filter((member) => !result.poll.votes[member.id]).map((member) => member.name);
    return `📊 ${this.memberName(memberId)} → ${poll.options[option - 1]}. ${this.tally(result.poll)}${waiting.length ? ` · waiting on ${waiting.join(", ")}` : ""}`;
  }

  // --- Schedules -------------------------------------------------------------

  /** Closes polls past 24h (not during quiet hours) and nudges about repairs open 7+ days, once per week each. */
  async tick(): Promise<string[]> {
    const sent: string[] = [];
    const now = this.#now();
    const due = this.openPolls().filter((poll) => poll.closesAt <= now);
    if (due.length && !this.inQuiet(now)) {
      for (const poll of due) {
        const text = this.closePoll(poll.id, "time");
        if (text) { await this.#notify(text); sent.push(text); }
      }
    }
    const hour = Math.floor(this.#nowMin() / 60);
    if (!this.demoMode && (hour < 9 || hour >= 21)) return sent;
    if (this.inQuiet(now)) return sent;
    const lines: string[] = [];
    for (const repair of this.repairs().open) {
      if (repair.ageDays < NUDGE_AFTER_DAYS) continue;
      const key = `${this.#household}:repair:${repair.id}:w${Math.floor(repair.ageDays / 7)}`;
      // Claim first (restart-safe): only a newly inserted key sends.
      if (!Number(this.#db.prepare("INSERT OR IGNORE INTO house_nudges (key, sent_at) VALUES (?, ?)").run(key, this.#iso()).changes)) continue;
      const word = repairKey(repair.title);
      lines.push(repair.status === "reported"
        ? `🔧 ${repair.title} (#${repair.number}) was reported ${repair.ageDays} days ago and isn’t fixed yet. Maybe follow up? “fixed ${word}” when it’s done.`
        : `🔧 ${repair.title} (#${repair.number}) has been open ${repair.ageDays} days. Told the landlord? “reported ${word}”. Fixed? “fixed ${word}”.`);
    }
    if (lines.length) {
      const text = lines.join("\n");
      await this.#notify(text);
      sent.push(text);
    }
    return sent;
  }

  // --- Summaries -------------------------------------------------------------

  /** One compact line for Home (at most one): extra quiet hours tonight, guests today, open repairs, or tonight's quiet hours. */
  homeLine(): { text: string; icon: "moon" | "guests" | "wrench"; tone: "neutral" | "warning" } | null {
    const tonight = this.tonightQuiet();
    if (tonight && tonight.kind === "adhoc") return { text: `Quiet hours ${tonight.label.replace(/^Tonight /, "tonight ").replace(/^Now /, "now ").replace(/–.*$/, "")}`, icon: "moon", tone: "neutral" };
    const today = this.today();
    const guest = this.guests(2).find((candidate) => candidate.date <= today && candidate.endDate >= today);
    if (guest) return { text: `${guest.title} · ${guest.label}`, icon: "guests", tone: "neutral" };
    const open = this.repairs().open.length;
    if (open) return { text: `${open} open repair${open === 1 ? "" : "s"}`, icon: "wrench", tone: "warning" };
    if (tonight) return { text: `Quiet hours ${tonight.label.replace(/^Tonight /, "tonight ").replace(/^Now /, "now ").replace(/–.*$/, "")}`, icon: "moon", tone: "neutral" };
    return null;
  }

  /** The caller's slice for whats_on_my_plate. */
  summaryFor(memberId: string): unknown {
    const { open } = this.repairs();
    const tonight = this.tonightQuiet();
    return {
      openRepairs: open.length,
      repairsAssignedToYou: open.filter((repair) => repair.assigneeId === memberId).map((repair) => `#${repair.number} ${repair.title}`),
      quietHoursTonight: tonight ? tonight.label : null,
      pollsWaitingOnYou: this.openPolls().filter((poll) => !poll.votes[memberId]).map((poll) => ({ pollId: poll.id, question: poll.question, options: poll.options })),
      upcomingGuests: this.guests(7).map((guest) => `${guest.title} · ${guest.label}`),
    };
  }

  /** Everything the /house page shows (secrets masked). */
  state(viewerId: string | null): Record<string, unknown> {
    const quiet = this.quietDefault();
    const now = this.#now();
    return {
      demoMode: this.demoMode, timeZone: this.timeZone, now, today: this.today(), viewerId,
      members: this.members().map((member) => ({ ...member, ...avatarFor(member.id) })),
      kinds: Object.fromEntries(CARD_KIND_ORDER.map((kind) => [kind, CARD_KINDS[kind]])),
      cards: this.cards(),
      repairs: this.repairs(),
      guests: this.guests(21),
      quiet: {
        default: { ...quiet, label: this.defaultLabel(quiet) },
        tonight: this.tonightQuiet(),
        upcoming: this.quietWindows(now, now + 14 * DAY).filter((window) => window.kind === "adhoc"),
      },
      polls: { open: this.openPolls(), closed: this.closedPolls(3), closesIn: POLL_TTL },
    };
  }

  // --- HTTP ------------------------------------------------------------------

  #viewer(request: IncomingMessage): string | null {
    const resolved = requestMember(request)?.memberId;
    if (resolved && this.members().some((member) => member.id === resolved)) return resolved;
    return isLocalRequest(request) ? this.members()[0]?.id ?? null : null;
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (path === "/house" || path === "/house/") {
      if (request.method !== "GET") return false;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderHousePage({ demoMode: this.demoMode }));
      return true;
    }
    if (path !== "/api/house" && !path.startsWith("/api/house/")) return false;
    try {
      await this.#api(request, response, url);
    } catch (error) {
      if (error instanceof HttpError) send(response, error.status, { error: error.message });
      else {
        console.warn("House request failed:", error instanceof Error ? error.message : error);
        send(response, 500, { error: "Something went wrong." });
      }
    }
    return true;
  }

  async #api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const viewer = this.#viewer(request);
    if (request.method === "GET") {
      if (path === "/api/house") return send(response, 200, this.state(viewer));
      if (path === "/api/house/summary") return send(response, 200, { line: this.homeLine() });
      const file = /^\/api\/house\/files\/([^/]+)$/.exec(path)?.[1];
      if (file) return this.#serveFile(response, file);
      return send(response, 404, { error: "Not found." });
    }
    if (request.method !== "POST") return send(response, 405, { error: "Method not allowed." });
    if (!isSameOriginMutation(request)) return send(response, 403, { error: "Use the GroupCart House page." });
    if (!viewer) return send(response, 401, { error: "Sign in to GroupCart first.", signIn: "/signin" });

    if (path === "/api/house/repairs/photo") {
      const id = url.searchParams.get("id") ?? "";
      const data = await readRawBody(request, PHOTO_LIMIT + 1);
      const result = await this.setPhoto(id, data, viewer);
      return send(response, result.ok ? 200 : result.status ?? 400, result.ok ? { ok: true, repair: result.repair } : { error: result.error });
    }
    const body = await readJsonBody(request, 32_768);
    const id = typeof body.id === "string" ? body.id : "";
    const reply = (result: Result<Record<string, unknown>>) => send(response, result.ok ? 200 : result.status ?? 400, result.ok ? result : { error: result.error });
    switch (path) {
      case "/api/house/reveal": {
        const secrets = this.reveal(id);
        return secrets ? send(response, 200, { fields: secrets }) : send(response, 404, { error: "That card no longer exists." });
      }
      case "/api/house/cards": return reply(this.saveCard({ id: id || null, kind: body.kind, title: body.title, fields: body.fields && typeof body.fields === "object" ? body.fields as Record<string, unknown> : undefined, pinned: body.pinned }, viewer));
      case "/api/house/cards/delete": return reply(this.deleteCard(id) ? { ok: true } : { ok: false, error: "That card no longer exists.", status: 404 });
      case "/api/house/cards/pin": return reply(this.setPinned(id, body.pinned === true) ? { ok: true } : { ok: false, error: "That card no longer exists.", status: 404 });
      case "/api/house/cards/move": return reply(this.moveCard(id, Number(body.direction) < 0 ? -1 : 1) ? { ok: true } : { ok: false, error: "It can’t move further." });
      case "/api/house/repairs": {
        const created = await this.createRepair({ title: typeof body.title === "string" ? body.title : "", memberId: viewer });
        if (created.ok) await this.#notify(`🔧 ${this.memberName(viewer)} logged repair #${created.repair.number}: ${created.repair.title}.`);
        return reply(created);
      }
      case "/api/house/repairs/update": {
        const before = this.getRepair(id);
        const result = this.updateRepair(id, { status: body.status, assigneeId: body.assigneeId, note: body.note }, viewer);
        if (result.ok && before) await this.#announceRepairChange(before, result.repair, result.changed, viewer);
        return reply(result);
      }
      case "/api/house/guests": {
        const startMin = typeof body.startTime === "string" && /^\d{2}:\d{2}$/.test(body.startTime) ? Number(body.startTime.slice(0, 2)) * 60 + Number(body.startTime.slice(3)) : null;
        const who = typeof body.who === "string" ? normalizeText(body.who).slice(0, 40) : "";
        if (!who) return send(response, 400, { error: "Who’s coming?" });
        const endDate = typeof body.endDate === "string" && body.endDate ? body.endDate : null;
        const result = this.announceGuest({
          title: this.guestTitle(who, viewer, startMin, endDate),
          date: typeof body.date === "string" ? body.date : "", endDate,
          startMin, durationMin: null, note: typeof body.note === "string" ? body.note : null, hostId: viewer,
        });
        if (result.ok) await this.#notify(result.text.replace(/^🧳 Heads-up/, `🧳 Heads-up from ${this.memberName(viewer)}`));
        return reply(result.ok ? { ok: true, guest: result.guest } : result);
      }
      case "/api/house/guests/react": {
        const reaction = body.reaction === "ok" || body.reaction === "concern" ? body.reaction : null;
        return reply(this.react(typeof body.eventId === "string" ? body.eventId : "", viewer, reaction, typeof body.note === "string" ? body.note.slice(0, 200) : null));
      }
      case "/api/house/quiet": {
        const minutes = (value: unknown) => (typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null);
        const date = typeof body.date === "string" ? body.date : this.#night(this.#now());
        let startMin = minutes(body.start);
        if (startMin !== null && startMin < 12 * 60) startMin += 1440;
        const result = this.addQuiet({ date, startMin, endMin: minutes(body.end), reason: typeof body.reason === "string" ? body.reason : null, memberId: viewer });
        if (result.ok) await this.#notify(this.quietLine(result.window));
        return reply(result);
      }
      case "/api/house/quiet/default": return reply(this.setQuietDefault(body));
      case "/api/house/quiet/cancel": return reply(this.cancelQuiet(id) ? { ok: true } : { ok: false, error: "Already cancelled.", status: 404 });
      case "/api/house/polls": {
        const options = Array.isArray(body.options) ? body.options.filter((option): option is string => typeof option === "string") : [];
        const created = this.createPoll({ question: typeof body.question === "string" ? body.question : "", options, memberId: viewer });
        if (created.ok) await this.#notify(this.pollText(created.poll));
        return reply(created);
      }
      case "/api/house/polls/vote": {
        const result = this.vote(typeof body.pollId === "string" ? body.pollId : "", viewer, Number(body.option));
        if (result.ok && result.closedText) await this.#notify(result.closedText);
        return reply(result);
      }
      case "/api/house/polls/close": {
        const text = this.closePoll(typeof body.pollId === "string" ? body.pollId : "", "manual");
        if (text) await this.#notify(text);
        return reply(text ? { ok: true } : { ok: false, error: "That poll is already closed.", status: 409 });
      }
      default: return send(response, 404, { error: "Not found." });
    }
  }

  async #announceRepairChange(before: RepairView, after: RepairView, changed: string[], actorId: string, via?: string): Promise<void> {
    const who = this.#actor(actorId, via);
    if (changed.includes("fixed")) await this.#notify(`✅ ${who} marked ${after.title} (#${after.number}) fixed.`);
    else if (changed.includes("reported")) await this.#notify(`📨 ${who} reported ${after.title} (#${after.number}) to the landlord.`);
    else if (changed.includes("open") && before.status === "fixed") await this.#notify(`🔧 ${who} reopened ${after.title} (#${after.number}).`);
    else if (changed.includes("assignee") && after.assigneeId) await this.#notify(`👍 ${this.memberName(after.assigneeId)} is on ${after.title} (#${after.number}).`);
  }

  #serveFile(response: ServerResponse, file: string): void {
    const ext = FILE_NAME.exec(file)?.[1];
    const known = ext ? Boolean(this.#db.prepare("SELECT 1 FROM house_repairs WHERE household_id = ? AND photo_file = ?").get(this.#household, file)) : false;
    const path = join(this.#filesDir, file);
    if (!ext || !known || !existsSync(path)) return send(response, 404, { error: "Not found." });
    response.writeHead(200, {
      "content-type": FILE_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    response.end(readFileSync(path));
  }

  // --- Connector tools -------------------------------------------------------

  tools(): ToolSpec[] {
    const repairOut = (repair: RepairView) => ({
      number: repair.number, title: repair.title, status: repair.status, assignee: repair.assigneeId ? this.memberName(repair.assigneeId) : null,
      openedBy: this.memberName(repair.createdBy), openedAt: repair.createdAt, closedAt: repair.closedAt, hasPhoto: Boolean(repair.photoUrl), ageDays: repair.ageDays,
    });
    const pollOut = (poll: HousePoll) => ({
      pollId: poll.id, question: poll.question, status: poll.status, closesAt: new Date(poll.closesAt).toISOString(),
      options: poll.options.map((option, index) => ({ option: index + 1, label: option, votes: poll.counts[index] ?? 0 })),
      voted: Object.keys(poll.votes).map((id) => this.memberName(id)),
    });
    const repairFor = (value: unknown): RepairRow | { error: string } => {
      const query = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
      if (!query.trim()) return { error: "Say which repair (its number or a word from its title)." };
      const found = this.findRepairs(query, { all: true });
      if (!found.length) return { error: `No repair matches “${query}”.` };
      if (found.length > 1) return { error: `Several repairs match: ${found.map((row) => `#${row.number} ${row.title}`).join(", ")}. Use the number.` };
      return found[0]!;
    };
    const time = (value: unknown): number | null => {
      if (typeof value !== "string") return null;
      const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
      return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null;
    };
    return [
      {
        name: "get_house_info",
        description: "House board: Wi-Fi, door/gate codes, house rules, landlord contact, trash day, emergency info, notes, plus open repairs, tonight's quiet hours, upcoming guests, and open polls. Passwords and codes are masked unless include_secrets is true; then they are returned only to you (the calling member), never posted to the group.",
        inputSchema: { type: "object", properties: { include_secrets: { type: "boolean", default: false, description: "Return Wi-Fi passwords and door codes unmasked, for the calling member only." } } },
        handler: (args) => {
          const reveal = args.include_secrets === true;
          return {
            cards: this.#cardRows().map((row) => {
              const kind = (isCardKind(row.kind) ? row.kind : "note") as CardKind;
              const fields = jsonParse<Record<string, string>>(row.fields_json, {});
              return { kind, title: row.title, pinned: Boolean(row.pinned), fields: reveal ? fields : maskFields(kind, fields) };
            }),
            secretsIncluded: reveal,
            openRepairs: this.repairs().open.map(repairOut),
            quietHours: { default: this.defaultLabel(), tonight: this.tonightQuiet()?.label ?? null },
            upcomingGuests: this.guests(14).map((guest) => ({ eventId: guest.eventId, title: guest.title, when: guest.label, host: guest.hostId ? this.memberName(guest.hostId) : null })),
            openPolls: this.openPolls().map(pollOut),
            page: this.houseUrl,
          };
        },
      },
      {
        name: "create_maintenance_request",
        description: "Log a repair/maintenance request for the household (e.g. \"Kitchen faucet leaking\"). It is announced in the group as from the calling member.",
        mutates: true,
        inputSchema: { type: "object", properties: { title: { type: "string", description: "What's broken, e.g. \"Dishwasher won't drain\"." }, assign_to_me: { type: "boolean", description: "Assign it to the calling member." } }, required: ["title"] },
        handler: async (args, caller) => {
          const created = await this.createRepair({ title: typeof args.title === "string" ? args.title : "", memberId: caller.memberId });
          if (!created.ok) return { ok: false, error: created.error };
          if (args.assign_to_me === true) this.updateRepair(created.repair.id, { assigneeId: caller.memberId }, caller.memberId);
          await this.#notify(`🔧 ${this.#actor(caller.memberId, caller.via)} logged repair #${created.repair.number}: ${created.repair.title}.`);
          return { ok: true, repair: repairOut(this.getRepair(created.repair.id)!) };
        },
      },
      {
        name: "update_maintenance_request",
        description: "Update a repair by number or title words: status open → reported (to the landlord) → fixed, the assignee (a member's name, or \"me\"), and/or a note. Status changes are announced in the group.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            request: { type: "string", description: "Repair number (\"3\") or words from its title (\"faucet\")." },
            status: { type: "string", enum: ["open", "reported", "fixed"] },
            assignee: { type: "string", description: "Member name, \"me\", or \"nobody\"." },
            note: { type: "string" },
          },
          required: ["request"],
        },
        handler: async (args, caller) => {
          const row = repairFor(args.request);
          if ("error" in row) return { ok: false, error: row.error };
          let assigneeId: string | null | undefined;
          if (typeof args.assignee === "string" && args.assignee.trim()) {
            if (/^(?:nobody|no one|none|unassign)$/i.test(args.assignee.trim())) assigneeId = null;
            else {
              assigneeId = this.#memberByName(args.assignee, caller.memberId);
              if (!assigneeId) return { ok: false, error: `I don’t know who “${args.assignee}” is.` };
            }
          }
          const before = this.getRepair(row.id)!;
          const result = this.updateRepair(row.id, { status: args.status, assigneeId, note: args.note }, caller.memberId);
          if (!result.ok) return { ok: false, error: result.error };
          await this.#announceRepairChange(before, result.repair, result.changed, caller.memberId, caller.via);
          return { ok: true, changed: result.changed, repair: repairOut(result.repair) };
        },
      },
      {
        name: "announce_guest",
        description: "Give the household a heads-up about guests (adds a 🧳 event to the calendar and posts the heads-up to the group as from the calling member; roommates can reply ok/concern). Use start_time for a visit (\"friends over Fri 8pm\") or end_date for an overnight stay.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            who: { type: "string", description: "Who is coming, e.g. \"my sister\", \"friends\", \"Sam\"." },
            date: { type: "string", description: "YYYY-MM-DD (household time zone)." },
            start_time: { type: "string", description: "HH:MM 24-hour, for a visit with a start time." },
            end_date: { type: "string", description: "YYYY-MM-DD last day, for a stay." },
            duration_minutes: { type: "number", description: "Visit length (default 3 hours)." },
            note: { type: "string" },
          },
          required: ["who", "date"],
        },
        handler: async (args, caller) => {
          const who = typeof args.who === "string" ? normalizeText(args.who).slice(0, 40) : "";
          if (!who) return { ok: false, error: "Who is coming?" };
          const startMin = time(args.start_time);
          const result = this.announceGuest({
            title: this.guestTitle(who, caller.memberId, startMin, typeof args.end_date === "string" && args.end_date ? args.end_date : null),
            date: typeof args.date === "string" ? args.date : "", endDate: typeof args.end_date === "string" ? args.end_date : null, startMin,
            durationMin: typeof args.duration_minutes === "number" ? args.duration_minutes : null, note: typeof args.note === "string" ? args.note : null,
            hostId: caller.memberId, via: caller.via ?? "AI assistant",
          });
          if (!result.ok) return { ok: false, error: result.error };
          await this.#notify(result.text);
          return { ok: true, eventId: result.event.id, title: result.guest.title, when: result.guest.label, posted: result.text };
        },
      },
      {
        name: "set_quiet_hours",
        description: "Set quiet hours for one night (e.g. tonight from 22:00 because of an exam; announced in the group), or change the household default with default=true (e.g. 23:00–08:00 on weeknights).",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD evening the quiet hours start (default: tonight)." },
            start_time: { type: "string", description: "HH:MM 24-hour; times before noon count as after midnight." },
            end_time: { type: "string", description: "HH:MM 24-hour next morning (default: the household end time)." },
            reason: { type: "string" },
            default: { type: "boolean", description: "Change the household default instead of one night." },
            nights: { type: "array", items: { type: "number" }, description: "With default: evenings it applies (0 = Sunday … 6 = Saturday)." },
            enabled: { type: "boolean", description: "With default: turn the default on or off." },
          },
        },
        handler: async (args, caller) => {
          if (args.default === true) {
            const result = this.setQuietDefault({ enabled: args.enabled, startMin: time(args.start_time) ?? undefined, endMin: time(args.end_time) ?? undefined, nights: args.nights });
            return result.ok ? { ok: true, default: this.defaultLabel(result.quiet) } : { ok: false, error: result.error };
          }
          let startMin = time(args.start_time);
          if (startMin !== null && startMin < 12 * 60) startMin += 1440;
          const result = this.addQuiet({
            date: typeof args.date === "string" && args.date ? args.date : this.#night(this.#now()), startMin, endMin: time(args.end_time),
            reason: typeof args.reason === "string" ? args.reason : null, memberId: caller.memberId,
          });
          if (!result.ok) return { ok: false, error: result.error };
          const text = this.quietLine(result.window).replace(` — ${this.memberName(caller.memberId)}`, ` — ${this.#actor(caller.memberId, caller.via ?? "AI assistant")}`);
          await this.#notify(text);
          return { ok: true, quietHours: result.window.label, posted: text };
        },
      },
      {
        name: "create_poll",
        description: "Start a quick household poll (2–6 options, one vote each; closes after 24 hours or when everyone has voted). Posted to the group as from the calling member; people vote by replying with a number.",
        mutates: true,
        inputSchema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 } }, required: ["question", "options"] },
        handler: async (args, caller) => {
          const options = Array.isArray(args.options) ? args.options.filter((option): option is string => typeof option === "string") : [];
          const created = this.createPoll({ question: typeof args.question === "string" ? args.question : "", options, memberId: caller.memberId });
          if (!created.ok) return { ok: false, error: created.error };
          await this.#notify(this.pollText(created.poll, caller.via ?? "AI assistant"));
          return { ok: true, poll: pollOut(created.poll) };
        },
      },
      {
        name: "vote_poll",
        description: "Vote in a household poll as the calling member (one vote each; voting again changes it). Without poll_id, votes in the newest open poll. The option is its number or its label.",
        mutates: true,
        inputSchema: { type: "object", properties: { poll_id: { type: "string" }, option: { type: ["number", "string"], description: "Option number (1-based) or label." } }, required: ["option"] },
        handler: async (args, caller) => {
          const poll = typeof args.poll_id === "string" && args.poll_id ? this.getPoll(args.poll_id) : this.openPolls()[0];
          if (!poll) return { ok: false, error: "No open poll." };
          const option = typeof args.option === "number" ? args.option : /^\d+$/.test(String(args.option ?? "").trim()) ? Number(String(args.option).trim())
            : poll.options.findIndex((label) => label.toLowerCase() === String(args.option ?? "").trim().toLowerCase()) + 1;
          const result = this.vote(poll.id, caller.memberId, option);
          if (!result.ok) return { ok: false, error: result.error };
          if (result.closedText) await this.#notify(result.closedText);
          return { ok: true, poll: pollOut(result.poll), closed: Boolean(result.closedText) };
        },
      },
    ];
  }

  // --- Demo seed -------------------------------------------------------------

  /** Sample board, a repair with a photo, a guest visit, tonight's quiet hours, and a thermostat poll (once). */
  seedDemo(): boolean {
    if (this.meta("demo_seeded")) return false;
    const members = this.members();
    if (members.length < 2 || this.#cardRows().length) {
      this.setMeta("demo_seeded", "skipped");
      return false;
    }
    this.setMeta("demo_seeded", this.#iso());
    const byName = (name: string, fallback: number) => members.find((member) => member.name.toLowerCase() === name)?.id ?? members[fallback % members.length]!.id;
    const alex = byName("alex", 0);
    const maya = byName("maya", 1);
    const jordan = byName("jordan", 2);
    const now = this.#now();

    this.saveCard({ kind: "wifi", title: "Wi-Fi", fields: { network: "Apt4B-5G", password: "sunny-otter-42" } }, alex);
    this.saveCard({ kind: "door", title: "Front door", fields: { code: "4821", note: "press # after" } }, maya);
    this.saveCard({ kind: "trash", title: "Trash day", fields: { trash: "Tuesday night", recycling: "Every other Thursday" } }, jordan);
    this.saveCard({ kind: "landlord", title: "Landlord", fields: { name: "Pat Rivera", phone: "555-0100", email: "pat@example.com", note: "Text first for repairs; call for emergencies." } }, alex);
    this.saveCard({ kind: "rules", title: "House rules", fields: { text: "Quiet hours 11pm–8am on weeknights\nLabel your food in the fridge\nDishes done by bedtime\nGive a heads-up before overnight guests" } }, maya, );
    this.saveCard({ kind: "emergency", title: "Emergency", fields: { text: "Water shutoff: under the kitchen sink\nBreaker panel: hall closet\nBuilding emergency line: 555-0199" } }, jordan);
    this.saveCard({ kind: "door", title: "Bike room", pinned: false, fields: { code: "1357" } }, jordan);
    this.saveCard({ kind: "note", title: "Parking", fields: { text: "Spot #12 is ours. Guests park on the street after 6pm." } }, alex);

    void this.createRepair({ title: "Kitchen faucet dripping", memberId: jordan, createdAt: now - 3 * DAY - 2 * HOUR, photoFile: this.storeGenerated(sampleRepairSvg(), "svg") }).then((created) => {
      if (created.ok) this.updateRepair(created.repair.id, { assigneeId: alex }, maya, now - 2 * DAY);
    });
    void this.createRepair({ title: "Hallway light out", memberId: maya, createdAt: now - 12 * DAY }).then((created) => {
      if (created.ok) this.updateRepair(created.repair.id, { status: "fixed" }, alex, now - 9 * DAY);
    });

    if (this.#events) {
      const today = this.today();
      const saturday = addDays(today, ((6 - dayOfWeek(today) + 7) % 7) || 7);
      const guest = this.announceGuest({ title: "Jordan’s friends over", date: saturday, startMin: 20 * 60, durationMin: 180, hostId: jordan, announcedAt: now - 5 * HOUR });
      if (guest.ok) this.react(guest.event.id, alex, "ok");
    }

    const tonight = this.#night(now);
    this.addQuiet({ date: tonight, startMin: 22 * 60, endMin: null, reason: "Exam tomorrow", memberId: maya });

    const poll = this.createPoll({ question: "Thermostat at night: 68 or 70?", options: ["68°F", "70°F"], memberId: alex, createdAt: now - 2 * HOUR });
    if (poll.ok) {
      this.vote(poll.poll.id, alex, 2);
      this.vote(poll.poll.id, maya, 1);
    }
    return true;
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function heicToJpeg(data: Buffer, dir: string, id: string): Promise<Buffer | null> {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sips")) return null;
  const source = join(dir, `${id}.tmp.heic`);
  const target = join(dir, `${id}.tmp.jpg`);
  try {
    writeFileSync(source, data);
    await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", "2000", source, "--out", target], { timeout: 30_000 });
    return existsSync(target) ? readFileSync(target) : null;
  } catch {
    return null;
  } finally {
    rmSync(source, { force: true });
    rmSync(target, { force: true });
  }
}

/** Demo-only placeholder photo: a dripping kitchen faucet (original SVG). */
export function sampleRepairSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360">
<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8eef3"/><stop offset="1" stop-color="#cfd9e1"/></linearGradient>
<linearGradient id="m" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8d99a6"/><stop offset=".5" stop-color="#d7dee5"/><stop offset="1" stop-color="#7d8995"/></linearGradient></defs>
<rect width="480" height="360" fill="url(#w)"/>
<g fill="#b9c6d0"><rect x="0" y="0" width="480" height="4"/>${Array.from({ length: 6 }, (_, row) => Array.from({ length: 7 }, (_, col) => `<rect x="${col * 72 - (row % 2) * 36 + 2}" y="${row * 36 + 6}" width="68" height="32" rx="3" fill="#dfe7ed"/>`).join("")).join("")}</g>
<rect x="0" y="230" width="480" height="130" fill="#6b5844"/><rect x="0" y="226" width="480" height="12" fill="#857059"/>
<path d="M90 238h300v26c0 34-28 62-62 62H152c-34 0-62-28-62-62z" fill="#f4f6f8" stroke="#aab4bd" stroke-width="3"/>
<ellipse cx="240" cy="246" rx="132" ry="10" fill="#c8d1d8"/>
<rect x="226" y="150" width="28" height="84" rx="6" fill="url(#m)"/>
<path d="M240 158c0-36 18-58 64-58h28a10 10 0 0 1 10 10v22h-26v-8h-12c-26 0-38 12-38 34z" fill="url(#m)"/>
<rect x="318" y="128" width="26" height="12" rx="3" fill="#6f7b86"/>
<rect x="198" y="198" width="22" height="10" rx="4" fill="#9aa5af"/><rect x="260" y="198" width="22" height="10" rx="4" fill="#9aa5af"/>
<g fill="#3d8bfd"><path d="M331 152c-5 8-8 12-8 16a8 8 0 0 0 16 0c0-4-3-8-8-16z"/><path d="M331 190c-4 6-6 9-6 12a6 6 0 0 0 12 0c0-3-2-6-6-12z" opacity=".8"/><path d="M331 220c-3 4-4 6-4 8a4 4 0 0 0 8 0c0-2-1-4-4-8z" opacity=".6"/></g>
<ellipse cx="331" cy="246" rx="18" ry="4" fill="#3d8bfd" opacity=".35"/>
<rect x="18" y="18" width="150" height="34" rx="17" fill="#202124" opacity=".72"/><text x="93" y="41" font-family="Arial, sans-serif" font-size="16" fill="#fff" text-anchor="middle">Sample photo</text>
</svg>`;
}

/** Wires House into the app (one call from index.ts). */
export function setupHouse(options: { store: CartStore; calendar?: CalendarService; demoMode: boolean; publicUrl?: string; events?: EventsService }): HouseService {
  const timeZone = CalendarService.serverTimeZone();
  // Guest visits are household events. EventsService keeps all its state in SQLite, so House uses its own handle on the
  // same event tables (no change to the lists & events setup); visits show on /calendar, Home, and get its reminders.
  const events = options.events ?? new EventsService(options.store, { calendar: options.calendar, lists: new NamedListsService(options.store, { timeZone }), timeZone, notify: notifyGroup });
  const service = new HouseService(options.store, { events, timeZone, demoMode: options.demoMode, publicUrl: options.publicUrl, notify: notifyGroup });
  // Ahead of bills (and chores/events): a "broken: …" photo must not become a bill draft. House phrases are narrow;
  // bare numbers and "ok" are taken only when a House question is the sender's newest one.
  registerCommand("house", (context) => service.handleCommand(context), { before: "bills" });
  registerRoute((request, response, url) => service.handleRequest(request, response, url));
  registerTools(service.tools());
  registerSummaryProvider("house", (caller: ToolCaller) => service.summaryFor(caller.memberId));
  registerHelp("House: “wifi”, “door code”, “house rules”, “landlord”, “trash day”. Repairs: “broken: kitchen faucet leaking” (add a photo), “fixed faucet”, “repairs”.");
  registerHelp("Guests & quiet: “having friends over Fri 8pm”, “my sister is staying Sat–Sun” (reply “ok” or “concern”), “quiet hours tonight from 10pm”.");
  registerHelp("Polls: “poll: takeout tonight? thai, pizza, sushi”, then vote with a number; “polls”, “close poll”.");
  scheduleEvery("house", 60_000, async () => { await service.tick(); });
  setQuietCalendarProvider(() => service.calendarQuiet());
  if (options.demoMode && service.seedDemo()) console.log("House: added a sample board, a repair, a guest visit, quiet hours, and a poll for the demo.");
  return service;
}
