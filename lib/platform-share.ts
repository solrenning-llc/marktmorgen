/**
 * The share of each sale that goes with the prices decided on October 12,
 * 2026 (lib/plan.ts COMMISSION_BPS), taken on the creator's own Stripe
 * account as an application fee, and never more than is owed.
 *
 * Nothing here does anything while COMMISSION_LIVE is off: every rate reads
 * as zero, no fee is set on a checkout, and the daily job finds nothing to
 * settle. It is built ahead of the company that will run it so that, once
 * Stripe has the platform, the switch is the last step rather than the first.
 *
 * What is owed, and on what:
 *
 *   - the plan's share, in lib/plan.ts, of what the buyer paid for the goods:
 *     after any discount, before tax, and without shipping, which is a cost
 *     the creator passes on and not a sale;
 *   - nothing on a sale made inside the creator's free trial, because the
 *     trial is said to be free and a share is a charge;
 *   - nothing for a store that subscribed before the share, which keeps the
 *     price it chose (Store.shared);
 *   - nothing once a plan has ended: no plan, no share;
 *   - less in proportion to what was refunded, and nothing on a sale lost to
 *     a dispute, because a share of money the creator does not keep is a
 *     share of nothing.
 *
 * How it is taken. A fee on a single payment has to be fixed before the buyer
 * pays, and Stripe decides some of what they pay afterward: the code typed in
 * its box, the tax. So the fee set on a checkout is the share of the LEAST the
 * buyer can pay for the goods, which can never be more than the payment
 * itself, and the daily job (settleShares) gives back whatever was taken
 * above the share of what was actually paid. A membership's fee is a
 * percentage Stripe works out on each payment, and is settled the same way.
 * Nothing here can ever take more than the share: the job only gives back.
 */
import { COMMISSION_BPS, COMMISSION_LIVE } from "@/lib/plan";
import type { Store } from "@/lib/store";

/**
 * Whether what this file does has been run against Stripe's test mode, on
 * the platform account that will take the share, and seen to work. Code
 * cannot see that, so it is said here, by whoever saw it, and the switch in
 * lib/plan.ts cannot be turned on until it is (tests/plan-margin.test.ts).
 * Stripe's own advice, in writing on October 11, 2026, was to test these
 * flows in test mode before relying on them, because a fee across borders
 * depends on the countries and the configuration. What has to be seen:
 *
 *   1. A checkout with a fee, on a connected account in the United States,
 *      Canada, the United Kingdom and one EEA country, paid, with the fee
 *      landing on the platform.
 *   2. A checkout whose code takes more off than leaves room for the fee is
 *      never set up that way: codesMayTakeOff lowers the fee first. And one
 *      with a code of 100% off still opens and completes.
 *   3. A membership with a percentage, renewed once, the fee on the renewal.
 *   4. settleShares giving back the excess after a discount and the tax, the
 *      share of a refund made from the creator's own dashboard, and all of it
 *      after a dispute is lost; and moving a store's memberships to a new
 *      percentage when its plan changes.
 *   5. A fee on a charge in euros, pounds and Canadian dollars: that the
 *      fee is reported in the charge's currency, which settleShares needs
 *      (it leaves alone a fee in any other), and that it reaches the
 *      platform converted to dollars without a bank account abroad.
 *
 * Read from Stripe's own pages on October 12, 2026 ("Collect application
 * fees", "Create direct charges"): the fee must be less than the charge,
 * which the least-paid rule above keeps; it is not given back by itself
 * when a payment is refunded, which settleShares does; and no fee may be
 * taken from a Brazilian account, where no store can be opened
 * (lib/stripe-connect.ts COUNTRIES).
 */
export const SHARE_PROVED_IN_TEST_MODE = false;

/**
 * The stores whose sales pay a share right now, by their key (lib/store.ts
 * storeRef): written where a store's plan is written down, setSubscription,
 * and read by the daily job (lib/share-settle.ts).
 */
export const SHARING_INDEX = "nl:share:stores";

/**
 * The percentage last written on each store's memberships, by store key: by
 * the daily job once it has read them all (lib/share-settle.ts), and, when a
 * store's plan share changes or stops, by setSubscription (lib/store.ts) with
 * the share its checkouts wrote until then, so that the memberships sold
 * before the job's next run are read even when the store leaves the list.
 */
export const SHARE_APPLIED = "nl:share:applied";

/** The parts of a store the share is decided by. */
export type ShareStanding = Pick<Store, "shared" | "subscriptionActive" | "trialEnds" | "tier">;

/** The share this store's sales pay right now, in basis points. */
export function shareBps(store: ShareStanding, nowSeconds = Date.now() / 1000, live = COMMISSION_LIVE): number {
  if (!live || !store.shared || !store.subscriptionActive) return 0;
  if (store.trialEnds > nowSeconds) return 0;
  return COMMISSION_BPS[store.tier];
}

/**
 * The rate a membership sold by this store is set up with: the plan's own,
 * even inside the trial. A membership outlives the trial, and a percentage
 * of zero written on it would be zero for good; what it charges inside the
 * trial is given back by settleShares.
 */
export function planShareBps(store: ShareStanding, live = COMMISSION_LIVE): number {
  if (!live || !store.shared || !store.subscriptionActive) return 0;
  return COMMISSION_BPS[store.tier];
}

/** A share of an amount, rounded down: a creator is never charged a fraction of a cent. */
export function shareOf(bps: number, cents: number): number {
  if (!Number.isFinite(cents) || cents <= 0 || !Number.isFinite(bps) || bps <= 0) return 0;
  return Math.floor((Math.floor(cents) * Math.floor(bps)) / 10_000);
}

/** A percentage Stripe takes on a subscription: at most two decimals. */
export function percentOf(bps: number): string {
  return (Math.floor(bps) / 100).toFixed(2);
}

/**
 * What the lines of a checkout charge, before any discount: each line's
 * amount times its quantity. A line whose amount is not in the body — a
 * saved Price, which is how a choose-your-price product is sold — counts as
 * `unpriced`, and the caller says what the least of it is.
 */
export function linesTotal(body: URLSearchParams): { cents: number; unpriced: number[] } {
  let cents = 0;
  const unpriced: number[] = [];
  for (let i = 0; i < 100; i += 1) {
    const quantity = body.get(`line_items[${i}][quantity]`);
    if (quantity === null) break;
    const count = Math.max(0, Math.floor(Number(quantity)) || 0);
    const amount = body.get(`line_items[${i}][price_data][unit_amount]`);
    if (amount === null) {
      unpriced.push(i);
      continue;
    }
    cents += Math.max(0, Math.floor(Number(amount)) || 0) * count;
  }
  return { cents, unpriced };
}

/** A discount that may come off a checkout. */
export type MayComeOff =
  /** A percentage of the whole. */
  | { kind: "percent"; percent: number }
  /** An amount in the checkout's currency. */
  | { kind: "cents"; cents: number }
  /** Something whose size is not known here: nothing can be counted on. */
  | { kind: "unknown" };

/**
 * The least a buyer can pay for the goods, before tax and shipping: the
 * lines' total, less the largest of the discounts that may come off it.
 */
export function leastPaid(total: number, discounts: MayComeOff[]): number {
  let least = Math.max(0, Math.floor(total));
  for (const off of discounts) {
    if (off.kind === "unknown") return 0;
    const after = off.kind === "percent" ? total - Math.round((total * Math.min(100, Math.max(0, off.percent))) / 100) : total - Math.max(0, off.cents);
    least = Math.min(least, Math.max(0, Math.floor(after)));
  }
  return least;
}

/**
 * Sets the share on a checkout about to be opened on a creator's account,
 * and says what it set, in cents for a payment and in basis points for a
 * membership. Zero, and nothing written, while the share is off or the store
 * owes none.
 *
 * `least` is the least the buyer can pay for the goods (leastPaid); a
 * membership ignores it, because its percentage is worked out by Stripe on
 * each payment.
 */
export function applyShare(
  body: URLSearchParams,
  store: ShareStanding,
  input: { recurring: boolean; least: number },
  nowSeconds = Date.now() / 1000,
  live = COMMISSION_LIVE,
): number {
  if (input.recurring) {
    const bps = planShareBps(store, live);
    if (bps <= 0) return 0;
    body.set("subscription_data[application_fee_percent]", percentOf(bps));
    body.set("subscription_data[metadata][share_bps]", String(bps));
    return bps;
  }
  const bps = shareBps(store, nowSeconds, live);
  const fee = shareOf(bps, input.least);
  if (fee <= 0) return 0;
  body.set("payment_intent_data[application_fee_amount]", String(fee));
  body.set("payment_intent_data[metadata][share_bps]", String(bps));
  return fee;
}

/**
 * The same for a payment made outside a checkout, whose amount is known
 * exactly (an offer taken in one click after checkout, lib/upsell.ts).
 */
export function applyShareToPayment(body: URLSearchParams, store: ShareStanding, cents: number, nowSeconds = Date.now() / 1000, live = COMMISSION_LIVE): number {
  const bps = shareBps(store, nowSeconds, live);
  const fee = shareOf(bps, cents);
  if (fee <= 0) return 0;
  body.set("application_fee_amount", String(fee));
  body.set("metadata[share_bps]", String(bps));
  body.set("metadata[share_base]", String(Math.floor(cents)));
  return fee;
}

/**
 * What is owed on one payment, now: the share of what was paid for the
 * goods, less the part of it refunded, and nothing on a payment lost to a
 * dispute. `base` is what was paid for the goods (after discounts, before
 * tax and shipping); `amount` and `refunded` are the charge's own.
 */
export function owedOn(input: { bps: number; base: number; amount: number; refunded: number; lostDispute: boolean }): number {
  if (input.lostDispute || input.amount <= 0) return 0;
  const kept = Math.max(0, input.amount - Math.max(0, input.refunded));
  const share = shareOf(input.bps, Math.min(input.base, input.amount));
  return Math.floor((share * kept) / input.amount);
}

/** What to give back on a fee: whatever was taken above what is owed. Never negative. */
export function toGiveBack(fee: { amount: number; refunded: number }, owed: number): number {
  const held = Math.max(0, fee.amount - Math.max(0, fee.refunded));
  return Math.max(0, held - Math.max(0, owed));
}
