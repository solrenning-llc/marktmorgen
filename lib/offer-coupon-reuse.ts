/**
 * Whether an offer's stored coupon can be kept when the creator saves the same offer again (#4703).
 *
 * A coupon lives on the Stripe account that made it. A store that disconnected one account and connected another
 * still has the old coupon's id in its welcome, stay and come-back offers, and a checkout on the new account refuses
 * it ("No such coupon"). So a stored coupon is kept only when Stripe, on the account connected now, answers it as a
 * valid coupon of exactly the offer's terms; otherwise the route makes a coupon there before it saves the offer.
 *
 * Apart from the routes so the three of them read it the same way.
 */
import { StripeError, onAccount } from "@/lib/stripe-account";
import type { Store } from "@/lib/store";

const COUPON_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * True when `coupon` is, on the store's connected account, a valid coupon of `percent`% off for `months` payments (one
 * month is a coupon for once). False when that account does not hold it or it reads otherwise. Throws a StripeError
 * when Stripe could not be read, so the route refuses rather than keep a coupon it did not confirm.
 */
export async function couponStillFits(store: Store, coupon: string, percent: number, months: number): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account || !COUPON_PATTERN.test(coupon)) return false;
  let read: Record<string, unknown>;
  try {
    read = await onAccount("GET", account, `/coupons/${encodeURIComponent(coupon)}`);
  } catch (error) {
    // Not on this account (made on one the store has since let go): a new coupon is made instead.
    if (error instanceof StripeError && error.status === 404) return false;
    throw error;
  }
  if (!read || read.id !== coupon || read.object !== "coupon" || read.valid !== true || read.deleted === true) return false;
  if (read.percent_off !== percent || (read.amount_off !== undefined && read.amount_off !== null)) return false;
  if (months === 1) return read.duration === "once";
  return read.duration === "repeating" && read.duration_in_months === months;
}
