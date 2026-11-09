/**
 * The coupons on a creator's own Stripe account that take a membership's
 * introductory price off at checkout (lib/intro-price.ts): one per currency,
 * amount taken off and number of payments, made the first time a buyer needs
 * it and kept from then on, as a fair price's coupon is (lib/fair-coupon.ts).
 *
 * Its id is fixed, so a second checkout racing the first finds the same
 * coupon rather than making another. Its name is what Stripe shows the buyer
 * beside the amount taken off.
 *
 * The note that it was made is read and written exactly (lib/coupon-note.ts):
 * a lost or unreadable note is said in the log and asks Stripe again, which
 * finds this same coupon by its id and never makes a second one.
 */
import { couponNoted, noteCoupon } from "@/lib/coupon-note";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { introCouponId } from "@/lib/intro-price";

const madeKey = (account: string, id: string) => `nl:intro:c:${account}:${id}`;

/** The coupon's id, made on the account if it is not there yet. Throws when Stripe has neither made nor found it. */
export async function introCoupon(account: string, currency: string, offCents: number, count: number): Promise<string> {
  const id = introCouponId(currency, offCents, count);
  if (await couponNoted(madeKey(account, id))) return id;
  try {
    await onAccount(
      "POST",
      account,
      "/coupons",
      new URLSearchParams({
        id,
        amount_off: String(offCents),
        currency,
        // The first payment, or the first months of a monthly membership: then the regular price, by itself.
        duration: count > 1 ? "repeating" : "once",
        ...(count > 1 ? { duration_in_months: String(count) } : {}),
        name: "Introductory price",
        "metadata[made_by]": "marktmorgen",
        "metadata[purpose]": "intro-price",
      }),
    );
  } catch (error) {
    // Made already, by an earlier checkout whose note was lost: it is used only
    // if it takes off what this one should, for as long.
    if (!(error instanceof StripeError) || error.code !== "resource_already_exists") throw error;
    const found = (await onAccount("GET", account, `/coupons/${encodeURIComponent(id)}`)) as {
      amount_off?: unknown;
      currency?: unknown;
      duration?: unknown;
      duration_in_months?: unknown;
      valid?: unknown;
    };
    const same =
      Number(found.amount_off) === offCents &&
      String(found.currency).toLowerCase() === currency.toLowerCase() &&
      found.duration === (count > 1 ? "repeating" : "once") &&
      (count > 1 ? Number(found.duration_in_months) === count : true) &&
      // Valid only as Stripe says it: a coupon whose answer does not say so is not used.
      found.valid === true;
    if (!same) throw new Error(`coupon ${id} is not the introductory price it should be`);
  }
  await noteCoupon(madeKey(account, id));
  return id;
}
