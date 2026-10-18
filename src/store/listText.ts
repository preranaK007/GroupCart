import { money } from "../cart.js";
import { LIST_COMMAND_NAMES, LIST_KEYS, LIST_LABELS, LIST_TITLES, describeSchedule, friendlyDate, type ListKey } from "../lists.js";
import type { StoreContext, StoreModules } from "./context.js";

/** Reply text for recurring lists: views, overview, reminders, and setup prompts. */
export class ListText {
  constructor(private readonly ctx: StoreContext, private readonly m: StoreModules) {}

  nextReminderText(list: ListKey): string {
    const next = this.m.lists.listDueInfo(this.m.lists.listRow(list), this.ctx.now()).nextReminderAt;
    if (!next) return "not scheduled";
    return next <= this.ctx.now() ? "due now" : `${friendlyDate(next)}`;
  }

  reminderHourText(): string {
    const hour = this.ctx.reminderHour % 12 === 0 ? 12 : this.ctx.reminderHour % 12;
    return `${hour}:00 ${this.ctx.reminderHour < 12 ? "AM" : "PM"}`;
  }

  reminderText(list: ListKey): string {
    const title = LIST_TITLES[list];
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const items = this.m.lists.listItems(list);
    if (!items.length) {
      return `${title} groceries are due, but the ${label} list is empty. What should be on it? Add items with “${command}: milk, eggs”.`;
    }
    const estimate = this.m.lists.listEstimate(items);
    const names = items.slice(0, 6).map((item) => `${item.quantity > 1 ? `${item.quantity} × ` : ""}${this.m.lists.listItemName(item)}`);
    const more = items.length > 6 ? `, and ${items.length - 6} more` : "";
    return `${title} groceries are due. The ${label} list has ${items.length} item${items.length === 1 ? "" : "s"} (about ${money(estimate.cents)} estimated): ${names.join(", ")}${more}. Reply “load ${command} list” to add them to the cart, or add items with “${command}: …”.`;
  }

  formatListView(list: ListKey): string {
    const row = this.m.lists.listRow(list);
    const label = LIST_LABELS[list];
    const command = LIST_COMMAND_NAMES[list];
    const items = this.m.lists.listItems(list);
    const schedule = describeSchedule(list, this.m.lists.listSchedule(row));
    const header = `${LIST_TITLES[list]} list (shared by the household · due ${schedule})`;
    const lines = items.map((item, index) => {
      const unit = this.m.lists.listItemUnitPrice(item);
      const price = unit === null
        ? "no saved price"
        : item.price_source === "kroger"
          ? `${money(unit * item.quantity)} Kroger quote${item.quoted_at ? ` from ${friendlyDate(new Date(item.quoted_at))}` : ""}`
          : `${money(unit * item.quantity)} sample estimate`;
      return `${index + 1}) ${item.quantity} × ${this.m.lists.listItemName(item)}${item.size ? ` · ${item.size}` : ""} — ${price}`;
    });
    const estimate = this.m.lists.listEstimate(items);
    const body = items.length
      ? `${lines.join("\n")}\nEstimated total: ${money(estimate.cents)}${estimate.unpriced ? ` (+${estimate.unpriced} unpriced)` : ""}. Kroger prices are re-quoted when the list is loaded.`
      : `The list is empty. Add items with “${command}: milk, eggs, bread”.`;
    const statusParts: string[] = [];
    if (!row.active_since) statusParts.push(`Not started yet — reminders begin once it has items (or text “start ${command} list”).`);
    else if (row.reminders_enabled !== 1) statusParts.push(`Reminders paused (“resume ${command} reminders”).`);
    else statusParts.push(`Next check-in: ${this.nextReminderText(list)}.`);
    if (row.last_loaded_at) {
      const by = row.last_loaded_by ? this.ctx.getMembers().find((member) => member.id === row.last_loaded_by)?.name : undefined;
      statusParts.push(`Last loaded ${friendlyDate(new Date(row.last_loaded_at))}${by ? ` by ${by}` : ""}.`);
    }
    return `${header}\n${body}\n${statusParts.join(" ")}\nLoad into the cart: “load ${command} list”. Remove: “remove eggs from ${command} list”. Change amount: “set eggs on ${command} list to 2”.`;
  }

  formatListsOverview(): string {
    const lines = LIST_KEYS.map((list) => {
      const row = this.m.lists.listRow(list);
      const items = this.m.lists.listItems(list);
      const estimate = this.m.lists.listEstimate(items);
      const size = items.length ? `${items.length} item${items.length === 1 ? "" : "s"}, about ${money(estimate.cents)}` : "empty";
      const status = !row.active_since
        ? "not started"
        : row.reminders_enabled !== 1
          ? "reminders paused"
          : `next check-in ${this.nextReminderText(list)}`;
      return `• ${LIST_TITLES[list]} (“${LIST_COMMAND_NAMES[list]} list”) — ${size} · due ${describeSchedule(list, this.m.lists.listSchedule(row))} · ${status}`;
    });
    return `Household recurring lists:\n${lines.join("\n")}\nAdd: “weekly: milk, eggs” · View: “monthly list” · Use: “load weekly list” · Timing: “weekly list on saturdays” or “monthly list on the 15th”.`;
  }

  listSetupPrompt(mode: "catalog" | "live"): string {
    const describe = (list: ListKey): string => describeSchedule(list, this.m.lists.listSchedule(this.m.lists.listRow(list)));
    const lookup = mode === "live"
      ? "I’ll search Kroger and ask you to pick each product, just like adding to the cart."
      : "In this demo I match items to the sample catalog.";
    return [
      "Let’s set up the household’s recurring grocery lists. What should go on each one?",
      `• Weekly (${describe("weekly")}): reply like “weekly: milk, eggs, bread”`,
      `• Every two weeks (${describe("biweekly")}): “biweekly: paper towels, coffee”`,
      `• Monthly (${describe("monthly")}): “monthly: olive oil, rice”`,
      `${lookup} Each list belongs to the whole group. When a list is due I’ll ask the group whether to load it into the cart; change timing with “weekly list on saturdays” or “monthly list on the 15th”. Text “lists” anytime to review.`,
    ].join("\n");
  }
}
