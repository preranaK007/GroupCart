// The one household group target for everything GroupCart sends on its own (live mode): recurring-list
// check-ins (src/reminders.ts), notifyGroup() (chore nudges, bill reminders, connector notes), and web chat relays.
//
// Where the group is: the store persists it (upstream's store.rememberGroupSpace / store.groupSpace, an app_state
// row) whenever an allowlisted member writes from a group, so it survives restarts. How to reach it: the live Space
// from the message loop when we have one, otherwise Spectrum's `imessage(app).space.get(chatGuid, { phone })`.
// Nothing is ever sent before the bot has seen the household group.
import { attachment, poll, type Space } from "spectrum-ts";
import type { GroupChannel } from "./chat.js";
import type { GroupTarget } from "./reminders.js";
import type { CartStore } from "./store.js";

export type GroupRef = { id: string; phone?: string };
/** Opens an existing conversation by chat id (and serving line), e.g. `imessage(app).space.get(id, { phone })`. */
export type GroupOpener = (ref: GroupRef) => Promise<Space & { type?: string }>;

export class HouseholdGroup {
  readonly #store: CartStore;
  readonly #open: GroupOpener;
  #live: { id: string; space: Space } | null = null;
  #warnedUnknown = false;

  constructor(store: CartStore, open: GroupOpener) {
    this.#store = store;
    this.#open = open;
  }

  /** Message loop: an allowlisted member wrote in this group. Persist it and keep the live handle. */
  remember(space: Space, phone?: string): void {
    this.#store.rememberGroupSpace(space.id, phone);
    this.#live = { id: space.id, space };
  }

  /** Whether GroupCart knows the household group (it may still need to be reopened). */
  get known(): boolean {
    return Boolean(this.#store.groupSpace());
  }

  /** The persisted household group, or null before the bot has seen it. Throws if it can't be opened. */
  async space(): Promise<Space | null> {
    const ref = this.#store.groupSpace();
    if (!ref) return null;
    if (this.#live?.id === ref.id) return this.#live.space;
    const space = await this.#open(ref);
    if (space.type !== undefined && space.type !== "group") throw new Error("The saved household conversation is not a group chat.");
    this.#live = { id: ref.id, space };
    return space;
  }

  async #require(): Promise<Space> {
    const space = await this.space();
    if (!space) throw new Error("GroupCart hasn’t seen the household group yet.");
    return space;
  }

  /** notifyGroup() sender: posts into the household group. Quietly skips (logged once) before the group is known. */
  async send(text: string): Promise<void> {
    const space = await this.space();
    if (!space) {
      if (!this.#warnedUnknown) console.log("Group notifications wait until a household member messages GroupCart from the group.");
      this.#warnedUnknown = true;
      return;
    }
    await space.send(text);
  }

  /** Posts a native iMessage poll into the household group (votes come back as poll_option messages). */
  async sendPoll(title: string, options: string[]): Promise<void> {
    await (await this.#require()).send(poll(title, options));
  }

  /**
   * Target for upstream's deliverDueListReminders(): the same persisted group; `onSent` runs after a successful
   * send (index.ts mirrors the check-in into the web chat and feed).
   */
  async reminderTarget(onSent: (text: string) => void): Promise<GroupTarget> {
    const space = await this.#require();
    return {
      type: "group",
      send: async (text) => {
        await space.send(text);
        onSent(text);
      },
    };
  }

  /** Web chat relays (src/chat.ts) go to the same persisted group. */
  channel(): GroupChannel {
    return {
      sendText: async (text) => { await (await this.#require()).send(text); },
      sendImage: async (path, mimeType, name) => { await (await this.#require()).send(attachment(path, { name, mimeType })); },
      respond: async (text) => {
        const space = await this.#require();
        await space.responding(async () => { await space.send(text); });
      },
    };
  }
}
