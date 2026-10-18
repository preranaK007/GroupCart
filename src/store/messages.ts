import type { StoreContext } from "./context.js";

export function helpMessage(ctx: StoreContext): string {
  return [
    "Welcome to GroupCart! Tell me what groceries your group needs. I can search Kroger products and prices for your selected store, build a shared list, and split estimated costs.",
    "Add/search: send one item such as “Vital Farms organic eggs,” or up to 5 separated by commas/and, like “bread, bananas, and eggs.” Choose a numbered Kroger result for each item in order. For plain “milk,” I’ll ask what kind first.",
    "Item budgets: add a per-item unit-price limit, like “pasta under $5” or “pasta under $5, bread up to $3.” Under is strict; “up to” includes the limit. Options without a live price are excluded when a limit is set.",
    "Share: text “start sharing with Maya and Jordan” (household member names). From then on, every item any of you adds is split evenly among you until someone texts “stop sharing”. Items already in the cart keep their split.",
    "Review: “cart” shows items, total, budget, and each person’s share.",
    dashboardMessage(ctx),
    "Remove: say “remove bread” or “I don’t want bread anymore.” For all your items, say “clear mine.”",
    "Clear everyone’s cart: “clear all,” then “confirm clear all” (or “cancel clear all”).",
    "Undo: “undo” reverts the latest cart change; repeat to step back through recent changes.",
    "Recurring lists: the group shares a weekly, every-two-weeks (“biweekly”), and monthly list. Add with “weekly: milk, eggs” or “add paper towels to monthly list”; view with “weekly list” or “lists”; edit with “remove eggs from weekly list” or “set eggs on weekly list to 2”; clear with “clear weekly list”. “load weekly list” copies it into the cart as one undoable change. I’ll ask the group when a list is due; change timing with “weekly list on saturdays” / “monthly list on the 15th”, or “pause weekly reminders”. New here? Text “set up lists”.",
    ctx.krogerCartEnabled
      ? "Approve/Kroger cart: everyone texts “approve,” then “checkout” checks availability at the configured store before asking whose Kroger account to use. If something appears unavailable, GroupCart suggests alternatives but never substitutes automatically; choose one with “replace 1 with 2,” or drop the item for everyone with “remove 1” (“remove unavailable” drops them all). Anyone can text “cancel checkout” during that review. Any changed list needs everyone’s approval again. After sign-in, available UPC items are added to Kroger; you finish ordering there. No order or payment is placed by GroupCart."
      : "Approve/checkout: in the local demo, checkout is simulated. Live Kroger cart transfer requires configured Kroger app credentials and Cart API access. GroupCart never places an order or charges anyone.",
    "Not sure what to say? Text “help” or “commands” anytime.",
  ].join("\n\n");
}

export function dashboardMessage(ctx: StoreContext): string {
  return `Dashboard: ${ctx.dashboardUrl} (open this on the computer running GroupCart; it is local-only and not reachable from other devices).`;
}
