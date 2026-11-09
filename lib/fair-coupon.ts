/**
 * The coupons on a creator's own Stripe account that take a fair price for a
 * country off at checkout (lib/fair-price.ts): one per percentage, made the
 * first time a buyer needs it and kept from then on, as a sale's coupon is.
 *
 * Its id is fixed (mm_fair_<percent>), so a second checkout racing the first
 * finds the same coupon rather than making another. Its name is what Stripe
 * shows the buyer beside the amount taken off.
 *
 * The note that it was made is read and written exactly (lib/coupon-note.ts):
 * a lost or unreadable note is said in the log and asks Stripe again, which
 * finds this same coupon by its id and never makes a second one.
 */
import { couponNoted, noteCoupon } from "@/lib/coupon-note";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { fairCouponId } from "@/lib/fair-price";

const madeKey = (account: string, percent: number) => `nl:fair:c:${account}:${percent}`;

/** The coupon's id, made on the account if it is not there yet. Throws when Stripe has neither made nor found it. */
export async function fairCoupon(account: string, percent: number): Promise<string> {
  const id = fairCouponId(percent);
  if (await couponNoted(madeKey(account, percent))) return id;
  try {
    await onAccount(
      "POST",
      account,
      "/coupons",
      new URLSearchParams({
        id,
        percent_off: String(percent),
        duration: "once",
        name: "Fair price for your country",
        "metadata[made_by]": "marktmorgen",
        "metadata[purpose]": "fair-price",
      }),
    );
  } catch (error) {
    // Made already, by an earlier checkout whose note was lost: it is used only
    // if it takes off what this one should, once (a "forever" coupon would take
    // the fair price off every renewal of a membership), and Stripe says it is valid.
    if (!(error instanceof StripeError) || error.code !== "resource_already_exists") throw error;
    const found = (await onAccount("GET", account, `/coupons/${encodeURIComponent(id)}`)) as { percent_off?: unknown; duration?: unknown; valid?: unknown };
    if (Number(found.percent_off) !== percent || found.duration !== "once" || found.valid !== true) throw new Error(`coupon ${id} is not the fair price it should be`);
  }
  await noteCoupon(madeKey(account, percent));
  return id;
}
