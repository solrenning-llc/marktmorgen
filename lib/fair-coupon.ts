/**
 * The coupons on a creator's own Stripe account that take a fair price for a
 * country off at checkout (lib/fair-price.ts): one per percentage, made the
 * first time a buyer needs it and kept from then on, as a sale's coupon is.
 *
 * Its id is fixed (mm_fair_<percent>), so a second checkout racing the first
 * finds the same coupon rather than making another. Its name is what Stripe
 * shows the buyer beside the amount taken off.
 */
import { redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { fairCouponId } from "@/lib/fair-price";
import { type CouponFields, stillThere } from "@/lib/coupon-check";

const madeKey = (account: string, percent: number) => `nl:fair:c:${account}:${percent}`;

/** The coupon's id, made on the account if it is not there yet. Throws when Stripe has neither made nor found it. */
export async function fairCoupon(account: string, percent: number): Promise<string> {
  const id = fairCouponId(percent);
  const [known] = await redisPipeline([["GET", madeKey(account, percent)]]).catch(() => [null]);
  // Noted as made: checked at Stripe before it is handed to a checkout (#4377), since a coupon the creator deleted
  // there is no longer accepted. Gone, or no longer what it should be, the note goes and the coupon is made again.
  if (known === "1") {
    if (await stillThere(account, id, (found) => sameFair(found, percent))) return id;
    await redisPipeline([["DEL", madeKey(account, percent)]]).catch(() => undefined);
  }
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
    // if it takes off what this one should.
    if (!(error instanceof StripeError) || error.code !== "resource_already_exists") throw error;
    const found = (await onAccount("GET", account, `/coupons/${encodeURIComponent(id)}`)) as CouponFields;
    if (!sameFair(found, percent)) throw new Error(`coupon ${id} is not the fair price it should be`);
  }
  await redisPipeline([["SET", madeKey(account, percent), "1"]]).catch(() => undefined);
  return id;
}

/** Whether a coupon at Stripe takes off this fair price's percentage and is still valid. */
function sameFair(found: CouponFields, percent: number): boolean {
  return Number(found.percent_off) === percent && found.valid !== false;
}
