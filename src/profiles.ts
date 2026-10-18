// Member profiles: display name, avatar (photo, emoji, or initial in the member's color), optional pronouns,
// a short bio, dietary notes, favorite snacks and genres, birthday, and a payment handle.
//
// For other feature modules:
//   registerProfileSection(fn)  add a summary card to /people/<id> (chores, bills, events...)
//   avatarFor(memberId)         { avatarUrl?, avatarEmoji? } for JSON APIs (pages get avatars automatically)
//   displayNameFor(memberId)    the name a member chose (falls back to the allowlist name)
//   referTo(memberId)           name + pronouns to use in generated text; unknown pronouns => they/them
//
// Tables use the profile_ prefix; uploaded photos live in <data dir>/avatars and are served at /avatars/<file>.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Member } from "./store.js";
import type { IconName } from "./ui/shell.js";

export type AvatarKind = "initial" | "emoji" | "photo";
export type AvatarInfo = { kind: AvatarKind; emoji?: string; url?: string };

export type Profile = {
  memberId: string;
  /** Allowlist name (what the group chat bot matches, e.g. "shared with Maya"). */
  name: string;
  /** Name shown on the website; defaults to `name`. */
  displayName: string;
  /** Free text such as "she/her"; empty when not shared. Never guess: use the name or they/them instead. */
  pronouns: string;
  bio: string;
  dietary: string;
  snacks: string;
  genres: string;
  /** "YYYY-MM-DD", "--MM-DD" (no year), or "". */
  birthday: string;
  paymentHandle: string;
  avatar: AvatarInfo;
  updatedAt: string | null;
};

export type ProfilePatch = Partial<Pick<Profile, "displayName" | "pronouns" | "bio" | "dietary" | "snacks" | "genres" | "birthday" | "paymentHandle">> & {
  /** "emoji" needs avatarEmoji (or a saved one); "photo" needs an uploaded photo. */
  avatarKind?: AvatarKind;
  avatarEmoji?: string;
};

export const PROFILE_LIMITS = { displayName: 40, pronouns: 24, bio: 160, dietary: 160, snacks: 120, genres: 120, paymentHandle: 40 } as const;
const TEXT_FIELDS = ["displayName", "pronouns", "bio", "dietary", "snacks", "genres", "paymentHandle"] as const;
const COLUMN: Record<(typeof TEXT_FIELDS)[number] | "birthday", string> = {
  displayName: "display_name", pronouns: "pronouns", bio: "bio", dietary: "dietary", snacks: "snacks", genres: "genres", paymentHandle: "payment_handle", birthday: "birthday",
};

// ---------------------------------------------------------------------------
// Images (avatars and chat attachments): type is sniffed from the bytes, never trusted from the client.
// SVG is never accepted (it can carry script).
// ---------------------------------------------------------------------------

export type ImageType = { mimeType: string; ext: string };

export function sniffImage(bytes: Buffer): ImageType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG") return { mimeType: "image/png", ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: "image/jpeg", ext: "jpg" };
  if (bytes.toString("latin1", 0, 4) === "GIF8") return { mimeType: "image/gif", ext: "gif" };
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return { mimeType: "image/webp", ext: "webp" };
  if (bytes.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(bytes.toString("latin1", 8, 12))) return { mimeType: "image/heic", ext: "heic" };
  return null;
}

export const IMAGE_MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" };

/** Safe stored-file name check: letters, digits, dash, underscore, and a known image extension. */
export function isStoredImageName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}\.(png|jpg|gif|webp|heic)$/.test(name);
}

// ---------------------------------------------------------------------------
// Profile sections (filled by other modules)
// ---------------------------------------------------------------------------

export type ProfileSectionContext = { memberId: string; memberName: string; viewerId: string | null; isSelf: boolean };
export type ProfileSection = {
  title: string;
  icon?: IconName;
  /** Card body HTML (escape user text yourself). */
  html: string;
  /** Optional "Open" link in the card header. */
  href?: string;
  /** Lower comes first (default 50). */
  order?: number;
};
export type ProfileSectionProvider = (context: ProfileSectionContext) => ProfileSection | null | Promise<ProfileSection | null>;

const sectionProviders: ProfileSectionProvider[] = [];

/** Adds a summary card (e.g. "Chores", "Bills", "Events") to every /people/<id> page. Return null to skip. */
export function registerProfileSection(provider: ProfileSectionProvider): void {
  sectionProviders.push(provider);
}

export async function profileSections(context: ProfileSectionContext): Promise<ProfileSection[]> {
  const sections: ProfileSection[] = [];
  for (const provider of sectionProviders) {
    try {
      const section = await provider(context);
      if (section) sections.push(section);
    } catch (error) {
      console.warn("A profile section failed:", error instanceof Error ? error.message : error);
    }
  }
  return sections.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

// ---------------------------------------------------------------------------
// Module-level helpers for other features
// ---------------------------------------------------------------------------

let activeProfiles: ProfileService | null = null;

export function avatarFor(memberId: string): { avatarUrl?: string; avatarEmoji?: string } {
  const avatar = activeProfiles?.get(memberId)?.avatar;
  if (avatar?.kind === "photo" && avatar.url) return { avatarUrl: avatar.url };
  if (avatar?.kind === "emoji" && avatar.emoji) return { avatarEmoji: avatar.emoji };
  return {};
}

export function displayNameFor(memberId: string): string | undefined {
  return activeProfiles?.get(memberId)?.displayName;
}

export type PronounSet = { subject: string; object: string; possessive: string; known: boolean };

/** Parses shared pronouns ("she/her", "he/him", "they/them"); anything unknown or unshared becomes they/them. */
export function pronounSet(pronouns: string): PronounSet {
  const first = pronouns.toLowerCase().split(/[\s/,]+/).filter(Boolean)[0];
  if (first === "she") return { subject: "she", object: "her", possessive: "her", known: true };
  if (first === "he") return { subject: "he", object: "him", possessive: "his", known: true };
  if (first === "they") return { subject: "they", object: "them", possessive: "their", known: true };
  return { subject: "they", object: "them", possessive: "their", known: false };
}

/** Name and pronouns to use when generating text about a member. */
export function referTo(memberId: string): { name: string } & PronounSet {
  const profile = activeProfiles?.get(memberId);
  return { name: profile?.displayName ?? "", ...pronounSet(profile?.pronouns ?? "") };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type ProfileRow = {
  member_id: string; display_name: string | null; pronouns: string | null; bio: string | null; dietary: string | null;
  snacks: string | null; genres: string | null; birthday: string | null; payment_handle: string | null;
  avatar_kind: string; avatar_emoji: string | null; avatar_file: string | null; updated_at: string | null;
};

function clean(value: unknown, max: number): string {
  // Collapse whitespace and drop control characters; keep emoji.
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function validBirthday(value: string): boolean {
  const match = /^(?:(\d{4})-|--)(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const year = match[1] === undefined ? 2000 : Number(match[1]);
  if (match[1] !== undefined && (year < 1900 || year > new Date().getFullYear())) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** One emoji (or a short emoji sequence such as a flag or skin-tone variant). */
export function validEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16) return false;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(trimmed)) return false;
  return !/[\p{L}\p{N}]/u.test(trimmed.replace(/\p{Extended_Pictographic}|\p{Emoji_Component}/gu, ""));
}

export class ProfileService {
  readonly #db: DatabaseSync;
  readonly #members: () => Member[];
  readonly #avatarDir: string;

  constructor(options: { db: DatabaseSync; members: () => Member[]; avatarDir: string }) {
    this.#db = options.db;
    this.#members = options.members;
    this.#avatarDir = options.avatarDir;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS profile_profiles (
        member_id TEXT PRIMARY KEY,
        display_name TEXT,
        pronouns TEXT,
        bio TEXT,
        dietary TEXT,
        snacks TEXT,
        genres TEXT,
        birthday TEXT,
        payment_handle TEXT,
        avatar_kind TEXT NOT NULL DEFAULT 'initial',
        avatar_emoji TEXT,
        avatar_file TEXT,
        updated_at TEXT
      );
    `);
    activeProfiles = this;
  }

  get avatarDir(): string {
    return this.#avatarDir;
  }

  #row(memberId: string): ProfileRow | undefined {
    return this.#db.prepare("SELECT * FROM profile_profiles WHERE member_id = ?").get(memberId) as ProfileRow | undefined;
  }

  #toProfile(member: Member, row: ProfileRow | undefined): Profile {
    const kind: AvatarKind = row?.avatar_kind === "photo" && row.avatar_file ? "photo" : row?.avatar_kind === "emoji" && row.avatar_emoji ? "emoji" : "initial";
    const avatar: AvatarInfo = kind === "photo" ? { kind, url: `/avatars/${row!.avatar_file}` } : kind === "emoji" ? { kind, emoji: row!.avatar_emoji! } : { kind };
    if (row?.avatar_emoji && kind !== "emoji") avatar.emoji = row.avatar_emoji;
    return {
      memberId: member.id,
      name: member.name,
      displayName: row?.display_name || member.name,
      pronouns: row?.pronouns ?? "",
      bio: row?.bio ?? "",
      dietary: row?.dietary ?? "",
      snacks: row?.snacks ?? "",
      genres: row?.genres ?? "",
      birthday: row?.birthday ?? "",
      paymentHandle: row?.payment_handle ?? "",
      avatar,
      updatedAt: row?.updated_at ?? null,
    };
  }

  get(memberId: string): Profile | null {
    const member = this.#members().find((candidate) => candidate.id === memberId);
    return member ? this.#toProfile(member, this.#row(memberId)) : null;
  }

  list(): Profile[] {
    const rows = new Map((this.#db.prepare("SELECT * FROM profile_profiles").all() as ProfileRow[]).map((row) => [row.member_id, row]));
    return this.#members().map((member) => this.#toProfile(member, rows.get(member.id)));
  }

  /** Finds a member by id, allowlist name, or display name (case-insensitive). */
  find(query: string): Profile | null {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return null;
    return this.list().find((profile) => profile.memberId === query.trim() || profile.name.toLowerCase() === wanted || profile.displayName.toLowerCase() === wanted) ?? null;
  }

  #ensureRow(memberId: string): void {
    this.#db.prepare("INSERT OR IGNORE INTO profile_profiles (member_id, avatar_kind) VALUES (?, 'initial')").run(memberId);
  }

  update(memberId: string, patch: ProfilePatch): { ok: true; profile: Profile } | { ok: false; error: string } {
    const current = this.get(memberId);
    if (!current) return { ok: false, error: "Member not found." };
    const sets: string[] = [];
    const values: Array<string | null> = [];
    for (const field of TEXT_FIELDS) {
      if (patch[field] === undefined) continue;
      const value = clean(patch[field], PROFILE_LIMITS[field]);
      sets.push(`${COLUMN[field]} = ?`);
      values.push(value || null);
    }
    if (patch.birthday !== undefined) {
      const birthday = clean(patch.birthday, 10);
      if (birthday && !validBirthday(birthday)) return { ok: false, error: "Birthday should be a real date." };
      sets.push("birthday = ?");
      values.push(birthday || null);
    }
    if (patch.avatarEmoji !== undefined) {
      const emoji = patch.avatarEmoji.trim();
      if (emoji && !validEmoji(emoji)) return { ok: false, error: "Pick a single emoji for your avatar." };
      sets.push("avatar_emoji = ?");
      values.push(emoji || null);
    }
    if (patch.avatarKind !== undefined) {
      const row = this.#row(memberId);
      const emoji = patch.avatarEmoji !== undefined ? patch.avatarEmoji.trim() : row?.avatar_emoji;
      if (patch.avatarKind === "emoji" && !emoji) return { ok: false, error: "Pick an emoji first." };
      if (patch.avatarKind === "photo" && !row?.avatar_file) return { ok: false, error: "Upload a photo first." };
      if (!["initial", "emoji", "photo"].includes(patch.avatarKind)) return { ok: false, error: "Unknown avatar type." };
      sets.push("avatar_kind = ?");
      values.push(patch.avatarKind);
    }
    if (!sets.length) return { ok: true, profile: current };
    this.#ensureRow(memberId);
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    this.#db.prepare(`UPDATE profile_profiles SET ${sets.join(", ")} WHERE member_id = ?`).run(...values, memberId);
    return { ok: true, profile: this.get(memberId)! };
  }

  /** Stores an uploaded avatar photo (PNG, JPEG, GIF, or WebP) and switches the avatar to it. */
  saveAvatarPhoto(memberId: string, bytes: Buffer): { ok: true; profile: Profile } | { ok: false; error: string } {
    if (!this.get(memberId)) return { ok: false, error: "Member not found." };
    const type = sniffImage(bytes);
    if (!type || type.ext === "heic") return { ok: false, error: "Use a PNG, JPEG, GIF, or WebP image." };
    mkdirSync(this.#avatarDir, { recursive: true });
    const fileName = `${memberId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-${Date.now().toString(36)}.${type.ext}`;
    writeFileSync(join(this.#avatarDir, fileName), bytes);
    this.#ensureRow(memberId);
    const previous = this.#row(memberId)?.avatar_file;
    this.#db.prepare("UPDATE profile_profiles SET avatar_file = ?, avatar_kind = 'photo', updated_at = ? WHERE member_id = ?").run(fileName, new Date().toISOString(), memberId);
    if (previous && previous !== fileName) this.#deleteFile(previous);
    return { ok: true, profile: this.get(memberId)! };
  }

  removeAvatarPhoto(memberId: string): Profile | null {
    const row = this.#row(memberId);
    if (row?.avatar_file) {
      this.#deleteFile(row.avatar_file);
      this.#db.prepare("UPDATE profile_profiles SET avatar_file = NULL, avatar_kind = CASE WHEN avatar_emoji IS NOT NULL THEN 'emoji' ELSE 'initial' END, updated_at = ? WHERE member_id = ?").run(new Date().toISOString(), memberId);
    }
    return this.get(memberId);
  }

  #deleteFile(fileName: string): void {
    if (!isStoredImageName(fileName)) return;
    try { unlinkSync(join(this.#avatarDir, fileName)); } catch { /* already gone */ }
  }

  /** Absolute path of a stored avatar, or null when the name is not one of ours. */
  avatarPath(fileName: string): string | null {
    if (!isStoredImageName(fileName)) return null;
    const path = join(this.#avatarDir, fileName);
    return existsSync(path) ? path : null;
  }

  /** Avatar lookup for every page (see setAvatarDirectory in src/ui/shell.ts). */
  directory(): Record<string, { name: string; avatarUrl?: string; avatarEmoji?: string }> {
    const entries: Record<string, { name: string; avatarUrl?: string; avatarEmoji?: string }> = {};
    for (const profile of this.list()) {
      entries[profile.memberId] = {
        name: profile.displayName,
        ...(profile.avatar.kind === "photo" ? { avatarUrl: profile.avatar.url } : {}),
        ...(profile.avatar.kind === "emoji" ? { avatarEmoji: profile.avatar.emoji } : {}),
      };
    }
    return entries;
  }

  /** Demo mode: friendly sample profiles for the default demo members (only where none exist yet). */
  seedDemo(): void {
    const samples: Record<string, ProfilePatch> = {
      alex: {
        avatarEmoji: "🧗", avatarKind: "emoji", pronouns: "he/him",
        bio: "Climbs on weekends. Usually cooking Sunday dinner.",
        dietary: "No shellfish", snacks: "Kettle chips, clementines", genres: "Sci-fi, co-op board games",
        birthday: "--03-14", paymentHandle: "Venmo @alex-k",
      },
      maya: {
        avatarEmoji: "🌿", avatarKind: "emoji", pronouns: "she/her",
        bio: "Plant parent. Hosts game nights.",
        dietary: "Vegetarian", snacks: "Dark chocolate, hummus", genres: "Rom-coms, Codenames",
        birthday: "--06-02", paymentHandle: "Venmo @maya-r",
      },
      jordan: {
        avatarEmoji: "🎧", avatarKind: "emoji",
        bio: "Night owl. Makes a playlist for everything.",
        dietary: "Lactose intolerant (oat milk, please)", snacks: "Popcorn, gummy bears", genres: "Horror, Mario Kart",
        paymentHandle: "Venmo @jordan-p",
      },
    };
    for (const member of this.#members()) {
      const sample = samples[member.name.toLowerCase()];
      if (!sample || this.#row(member.id)) continue;
      const result = this.update(member.id, sample);
      if (!result.ok) console.warn(`Demo profile for ${member.name} was not seeded: ${result.error}`);
    }
  }
}
