/**
 * Orders a store hands over, and what a plan covers of them: the rules.
 *
 * Every order costs us something however small it is: the email that
 * confirms it (and, for a physical product, the one that says it was
 * shipped), the pages and the jobs that settle it, the writes to the
 * database. About a fifth of a cent all told (tests/plan-margin.test.ts has
 * the sum). It went into no limit at all, because the receipts were counted
 * as a fixed number of emails in each plan's worst month. A store that sells
 * a hundred thousand copies of a video in a month on a plan with no share
 * of its sales would cost more than that plan brings in, and a free product
 * given away to that many addresses would cost the same with nothing paid
 * at all.
 *
 * So orders are covered and priced the way visits are (lib/traffic-rules.ts):
 *
 *   - An order is one purchase confirmed (whatever it holds, a bundle or a
 *     cart of several products included), one offer taken after paying, one
 *     place taken in a purchase made for several people, and one free copy
 *     sent to an address. Counted once, however often it is looked at
 *     (lib/orders.ts).
 *   - An order that paid a share of its sale (lib/platform-share.ts) is
 *     covered by that share and is not counted: the smallest share there is,
 *     on the smallest payment Stripe takes, is several times what the order
 *     costs. While no share is taken, every order counts.
 *   - Every plan covers a number of orders in a calendar month
 *     (ORDERS_INCLUDED), more on a larger plan.
 *   - Since 17 October 2026 orders past that are not sold. They were billed
 *     at ORDER_CENTS_PER_THOUSAND_OVER, half a cent an order, against about a
 *     fifth of a cent of cost: more than the 17.2% of a price a cost may be
 *     and still leave the owner's 60% after a 27.5% tax. The price is not
 *     changed; it is no longer charged. Instead a paid store's new orders stop
 *     at its plan's figure (lib/order-admission.ts): every checkout, cart,
 *     tip, offer after paying, PayPal order, purchase for several people and
 *     free copy is admitted only while the month's orders, with the checkouts
 *     opened in the last day that may still be paid, are under the figure. A
 *     buyer past it is told plainly that the store is not taking new orders
 *     right now and nothing is charged; a checkout already open is never cut
 *     off, so a buyer in the middle of paying finishes, and gets everything.
 *   - A store in its free trial has no invoice to add an order to. A paid
 *     order there still costs its buyer a card payment, which nobody runs up
 *     for fun; a free copy costs nobody anything, so free copies in a trial
 *     stop at TRIAL_ORDERS a month (lib/free.ts), until the plan is paid or
 *     the month turns. A store with no plan gives no free copies at all.
 *
 * Nothing here touches the network or a secret: the pages that publish
 * these figures read the same ones the bill is made from.
 */
import type { Tier } from "@/lib/plan";
import { type PlanFields, standingOf } from "@/lib/plan-standing";

/**
 * Orders every plan covers, per store, per calendar month, and where a paid
 * store's new orders stop.
 *
 * Store was 500 until October 17, 2026 and 400 that day (tests/spend-floor.test.ts);
 * the same day, when the per-plan worst case came to count every feature
 * (tests/plan-cost-registry.ts), Store went to 250, Studio from 1,500 to
 * 750 and Scale from 3,000 to 1,500. Orders are the cut that harms a
 * creator least for what they cost: an order is counted only while no share
 * of its sale is taken, and each figure is far more than the plan's visits
 * sell at an ordinary conversion rate (250 of Store's 2,850 public visits is
 * almost 9%, 750 of Studio's 9,500 about 8%). The same day, when the uses
 * that had no monthly figure (the studio, the API, emails, public requests,
 * calls) were priced in, Store went to 200 and Studio to 450: still 7% and
 * almost 5% of their public visits.
 */
export const ORDERS_INCLUDED: Record<Tier, number> = {
  creator: 200,
  pro: 450,
  scale: 1_500,
};

/**
 * What a thousand orders past that cost the creator, in cents, until 17
 * October 2026: half a cent an order. Kept as the published price it was;
 * nothing is billed at it any more (see the top of this file).
 */
export const ORDER_CENTS_PER_THOUSAND_OVER = 500;

/**
 * Orders a store has in its free trial, paid and free copies together,
 * whichever plan the trial is of (since 17 October 2026; Store's figure
 * before, for free copies only).
 */
export const TRIAL_ORDERS = 100;

/** The orders a store's plan covers in a month. */
export function ordersIncluded(tier: Tier): number {
  return ORDERS_INCLUDED[tier] ?? ORDERS_INCLUDED.creator;
}

/**
 * How many orders a store may have in a month before free copies stop: the
 * plan's figure for a store that pays (where its paid orders stop too,
 * lib/order-admission.ts), the trial's in a trial. A store with no plan gives
 * no free copies whatever this says (lib/free.ts).
 */
export function freeCopiesLimitFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): number {
  const standing = standingOf(store, nowSeconds);
  if (standing === "paid") return ordersIncluded(store.tier ?? "creator");
  return standing === "trial" ? TRIAL_ORDERS : 0;
}

/**
 * Where a store's new orders stop in its window, or null where they do not:
 * the plan's figure for a store that pays, and since 17 October 2026 the
 * trial's for a store in its free trial, whose orders were a funded exposure
 * with no count at all; paid orders and free copies share it there, as they
 * do on a plan. A store with no plan takes no payment (its checkout is
 * closed) and gives no free copies (lib/free.ts).
 */
export function paidOrdersLimitFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): number | null {
  const standing = standingOf(store, nowSeconds);
  if (standing === "paid") return ordersIncluded(store.tier ?? "creator");
  return standing === "trial" ? TRIAL_ORDERS : null;
}

/**
 * Orders one booked call is counted as (since 17 October 2026, when calls
 * stopped being outside every count): its confirmation to the buyer and to
 * the host, and the buyer's two reminders before the time it was booked at,
 * are four emails, two orders' worth (tests/plan-cost-registry.ts,
 * ORDER_COST). The host's reminders and those for a time the booking was
 * moved to are taken from the store's own emails as they go, as the move
 * notices are (lib/call-reminders.ts, reminderMeter; 9 November 2026: before,
 * they were sent on this order too, six emails and up to ten with moves).
 * Admitted before the checkout opens, as any order is
 * (lib/order-admission.ts, lib/calls.ts).
 */
export const CALL_ORDER_UNITS = 2;

/** "1,204 orders", "1 order". */
export function ordersWords(orders: number): string {
  const counted = Number.isFinite(orders) && orders > 0 ? Math.floor(orders) : 0;
  return `${counted.toLocaleString("en-US")} ${counted === 1 ? "order" : "orders"}`;
}
