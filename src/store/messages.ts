import { registeredHelp } from "../platform.js";
import type { StoreContext } from "./context.js";

export function helpMessage(ctx: StoreContext): string {
  return [
    "Hi! I’m GroupCart. Text what the house needs and I’ll keep one shared cart and split the cost.",
    "Add: “bread, bananas, and eggs” (up to 5). Budget: “pasta under $5”. Plain “milk” gets a quick “which kind?”.",
    "Share: “start sharing with Maya and Jordan” splits what any of you add until “stop sharing”.",
    "Cart: “cart” shows items and shares. “remove bread”, “clear mine”, “clear all”, and “undo” fix mistakes.",
    dashboardMessage(ctx),
    `Calendar: “calendar” shows when everyone is free (${ctx.dashboardUrl.replace(/\/$/, "")}/calendar).`,
    "Recurring lists: “weekly: milk, eggs”, “weekly list”, “load weekly list”, “weekly list on saturdays”. New here? “set up lists”.",
    ctx.krogerCartEnabled
      ? "Checkout: everyone texts “approve”, then “checkout” checks Kroger availability and asks whose account to use (or tap Approve and Order with Kroger on the Groceries page). GroupCart never places an order or pays."
      : "Checkout: everyone texts “approve”, then “checkout” (simulated in the demo). GroupCart never places an order or pays.",
    "Splits: after checkout each share counts in the Bills balances. “splitwise” shows whether it went to Splitwise.",
    // Lines registered by feature modules (chores, bills, web chat, ...) through src/platform.ts.
    ...registeredHelp(),
  ].join("\n");
}

export function dashboardMessage(ctx: StoreContext): string {
  return `Dashboard: ${ctx.dashboardUrl} (on the computer running GroupCart).`;
}
