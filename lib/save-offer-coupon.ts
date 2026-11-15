/**
 * Making the stay-offer's coupon on the creator's own Stripe account.
 *
 * Apart from lib/save-offer.ts so the studio's form, which runs in the
 * browser, never imports anything that talks to Stripe with a secret key.
 */
import { onAccount } from "@/lib/stripe-account";
import type { Store } from "@/lib/store";

const COUPON_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * Makes the coupon on the creator's own account.
 *
 * `repeating` for the chosen number of months, which on a monthly membership
 * is that many payments. `max_redemptions` is left unset on purpose: every
 * member who is offered it is a separate customer, and the once-per-membership
 * rule is kept here, where it can be kept exactly, rather than by a counter on
 * the coupon that would run out across the whole store.
 */
export async function makeSaveCoupon(
  store: Store,
  percent: number,
  months: number,
  /** Which offer it is for: the one on the cancel page, the come-back email (lib/winback.ts), or the welcome offer (lib/welcome-offer.ts). */
  purpose: "save-offer" | "win-back" | "welcome" = "save-offer",
): Promise<string> {
  const account = store.stripeAccountId;
  if (!account) throw new Error("no Stripe account to make the coupon on");
  const made = await onAccount(
    "POST",
    account,
    "/coupons",
    new URLSearchParams({
      percent_off: String(percent),
      duration: months === 1 ? "once" : "repeating",
      ...(months === 1 ? {} : { duration_in_months: String(months) }),
      // What the creator sees in their own Stripe dashboard, so a coupon they
      // did not make by hand is not a mystery.
      name: `${purpose === "win-back" ? "Come-back offer" : purpose === "welcome" ? "Welcome offer" : "Stay offer"}: ${percent}% off`.slice(0, 40),
      "metadata[made_by]": "nimbus-labs",
      "metadata[purpose]": purpose,
    }),
  );
  const id = typeof made.id === "string" ? made.id : "";
  if (!COUPON_PATTERN.test(id)) throw new Error("Stripe returned no coupon");
  // Kept only when Stripe's answer is the coupon asked for (#4697): a coupon with another percent, an amount off, another
  // duration or number of months, or one that is not valid would be announced as the offer the creator chose.
  if (!isAskedCoupon(made, percent, months)) throw new Error("Stripe returned a coupon with other terms");
  return id;
}

/** Whether Stripe's answer is a valid coupon of exactly `percent`% off for `months` payments, as made above. */
function isAskedCoupon(made: Record<string, unknown>, percent: number, months: number): boolean {
  if (made.object !== "coupon" || made.valid !== true || made.deleted === true) return false;
  if (made.percent_off !== percent || (made.amount_off !== undefined && made.amount_off !== null)) return false;
  if (months === 1) return made.duration === "once" && (made.duration_in_months === undefined || made.duration_in_months === null);
  return made.duration === "repeating" && made.duration_in_months === months;
}
