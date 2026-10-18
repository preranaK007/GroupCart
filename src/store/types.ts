import type { KrogerProduct } from "../kroger.js";
import type { ListKey } from "../lists.js";

export type ListRow = {
  list_key: ListKey;
  anchor_weekday: number;
  anchor_date: string | null;
  day_of_month: number;
  active_since: string | null;
  last_loaded_at: string | null;
  last_loaded_by: string | null;
  last_reminded_cycle: string | null;
  reminders_enabled: number;
  revision: number;
};
export type ListItemRow = {
  id: string;
  list_key: ListKey;
  product_id: string;
  product_name: string | null;
  quantity: number;
  unit_price_cents: number | null;
  price_source: string;
  upc: string | null;
  size: string | null;
  added_by: string | null;
  created_at: string;
  quoted_at: string | null;
};
export type ListRequest = { query: string; quantity: number; maxPriceCents?: number; maxPriceInclusive?: boolean };
export type PendingListSelection = { listKey: ListKey; requests: ListRequest[]; results: BatchProductResult[] | null };
export type ListDueInfo = {
  cycleStart: Date;
  cycleKey: string;
  loadedThisCycle: boolean;
  dueNow: boolean;
  shouldRemind: boolean;
  nextReminderAt: Date | null;
};
export type ProductQuote = { product: KrogerProduct | null; error?: string };

export type ProductQuoter = (productId: string) => Promise<KrogerProduct | null>;
export type ListReminderClaim = {
  text: string;
  claims: Array<{ listKey: ListKey; cycleKey: string; previous: string | null }>;
};
export type RecurringListSnapshot = {
  key: ListKey;
  title: string;
  command: string;
  schedule: string;
  active: boolean;
  remindersEnabled: boolean;
  dueNow: boolean;
  nextReminderAt: string | null;
  lastLoadedAt: string | null;
  lastLoadedByName: string | null;
  estimatedCents: number;
  items: Array<{ id: string; name: string; quantity: number; unitPriceCents: number | null; priceSource: "sample" | "kroger"; size: string | null; quotedAt: string | null }>;
};
export type CartStoreOptions = {
  /** Injectable clock for recurring-list cadence (tests); defaults to the real time. */
  now?: () => Date;
  /** Local hour (0-23) on a cycle's start day after which a due list is announced. */
  reminderHour?: number;
};

export type MemberConfig = { handle: string; name: string };
export type Member = { id: string; handle: string; name: string };
export type ItemRow = {
  id: string;
  product_id: string;
  quantity: number;
  owner_id: string;
  participants_json: string;
  product_name: string | null;
  unit_price_cents: number | null;
  price_source: string | null;
  upc: string | null;
};

export type PendingRetailerChoice = {
  query: string;
  quantity: number;
  products: KrogerProduct[];
};

export type BatchRequest = {
  query: string;
  quantity: number;
  maxPriceCents?: number;
  maxPriceInclusive?: boolean;
};
export type BatchProductResult = { total: number; products: KrogerProduct[] };
export type SharingSession = { id: string; participantIds: string[]; startedBy: string; startedAt: string };

export type CartSnapshot = {
  householdId: string;
  revision: number;
  budgetCents: number;
  totalCents: number;
  items: Array<{
    id: string;
    productId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    priceSource: "sample" | "kroger";
    upc: string | null;
    ownerId: string;
    ownerName: string;
    participantIds: string[];
    participantNames: string[];
  }>;
  members: Array<{ id: string; name: string; handle: string; shareCents: number; approved: boolean }>;
  sharingSessions: Array<{ id: string; participantIds: string[]; participantNames: string[]; startedAt: string }>;
  checkedOutRevision: number | null;
};

export type PendingKrogerCheckout = { requesterId: string; revision: number; selectedMemberId: string | null; status: string };
export type ProductSearchFn = (query: string) => Promise<{ total: number; products: KrogerProduct[] }>;
