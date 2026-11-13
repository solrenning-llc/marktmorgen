/**
 * A coupon noted as made on a creator's Stripe account, checked there before a
 * checkout is handed it (lib/intro-coupon.ts, lib/fair-coupon.ts; #4377): a
 * coupon the creator deleted at Stripe is no longer accepted, so a note alone
 * is never proof it is still there.
 */
import { StripeError, onAccount } from "@/lib/stripe-account";

/** The coupon fields the checks read. */
export type CouponFields = {
  amount_off?: unknown;
  percent_off?: unknown;
  currency?: unknown;
  duration?: unknown;
  duration_in_months?: unknown;
  valid?: unknown;
};

/**
 * True when the coupon is at Stripe and `right` holds for it; false when Stripe
 * says it is not there, or it is no longer right (then the caller makes it
 * again). Any other answer throws, so a checkout never opens without the
 * discount the buyer was shown.
 */
export async function stillThere(account: string, id: string, right: (found: CouponFields) => boolean): Promise<boolean> {
  try {
    const found = (await onAccount("GET", account, `/coupons/${encodeURIComponent(id)}`)) as CouponFields;
    return right(found);
  } catch (error) {
    if (error instanceof StripeError && (error.code === "resource_missing" || error.status === 404)) return false;
    throw error;
  }
}
