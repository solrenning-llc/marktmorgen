/**
 * Orders past what a plan covers: since 17 October 2026, nothing is billed
 * for them (lib/order-rules.ts says why; lib/order-admission.ts stops a paid
 * store's new orders at its plan's figure instead). What is left here is the
 * one record the daily job still needs: that the creator was written to,
 * once, about a month whose orders reached the figure (app/api/cron/usage).
 *
 *   nl:orders:told:<folder>:<month>     the creator was written to about that month
 */
import { type Meter, firstWordOf, giveFirstWordBack, takeFirstWordOf } from "@/lib/usage-billing";
import { orderedFolders, ordersIn } from "@/lib/orders";
import { ORDERS_INCLUDED } from "@/lib/order-rules";

const ORDERS: Meter = {
  name: "orders",
  measured: ordersIn,
  owed: () => 0,
  byPlan: true,
  covered: Math.min(...Object.values(ORDERS_INCLUDED)),
  describe: () => "",
  folders: orderedFolders,
};

/** Whether the creator still has to be written to about this month's orders: true the first time it is asked, and never again. */
export function firstWordOnOrders(folder: string, month: string): Promise<boolean> {
  return firstWordOf(ORDERS, folder, month);
}

/** firstWordOnOrders, keeping the mark's value: given back with giveOrdersWordBack when the notice was certainly not sent. */
export function takeOrdersWord(folder: string, month: string): Promise<string | null> {
  return takeFirstWordOf(ORDERS, folder, month);
}

/** Gives the month's mark back after a certain refusal, while it still holds this run's value (lib/usage-billing.ts). */
export function giveOrdersWordBack(folder: string, month: string, value: string): Promise<void> {
  return giveFirstWordBack(ORDERS, folder, month, value);
}
