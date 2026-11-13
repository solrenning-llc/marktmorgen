/**
 * The coupons on a creator's own Stripe account that take a membership's
 * introductory price off at checkout (lib/intro-price.ts): one per currency,
 * amount taken off and number of payments, made the first time a buyer needs
 * it and kept from then on, as a fair price's coupon is (lib/fair-coupon.ts).
 *
 * Its id is fixed, so a second checkout racing the first finds the same
 * coupon rather than making another. Its name is what Stripe shows the buyer
 * beside the amount taken off.
 */
import { redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { introCouponId } from "@/lib/intro-price";
import { type CouponFields, stillThere } from "@/lib/coupon-check";

const madeKey = (account: string, id: string) => `nl:intro:c:${account}:${id}`;

/** The coupon's id, made on the account if it is not there yet. Throws when Stripe has neither made nor found it. */
export async function introCoupon(account: string, currency: string, offCents: number, count: number): Promise<string> {
  const id = introCouponId(currency, offCents, count);
  const [known] = await redisPipeline([["GET", madeKey(account, id)]]).catch(() => [null]);
  // Noted as made: checked at Stripe before it is handed to a checkout (#4377), since a coupon the creator deleted
  // there is no longer accepted. Gone, or no longer what it should be, the note goes and the coupon is made again.
  if (known === "1") {
    if (await stillThere(account, id, (found) => sameIntro(found, currency, offCents, count))) return id;
    await redisPipeline([["DEL", madeKey(account, id)]]).catch(() => undefined);
  }
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
    const found = (await onAccount("GET", account, `/coupons/${encodeURIComponent(id)}`)) as CouponFields;
    const same = sameIntro(found, currency, offCents, count);
    if (!same) throw new Error(`coupon ${id} is not the introductory price it should be`);
  }
  await redisPipeline([["SET", madeKey(account, id), "1"]]).catch(() => undefined);
  return id;
}

/** Whether a coupon at Stripe takes off what this introductory price should, for as long, and is still valid. */
function sameIntro(found: CouponFields, currency: string, offCents: number, count: number): boolean {
  return (
    Number(found.amount_off) === offCents &&
    String(found.currency).toLowerCase() === currency.toLowerCase() &&
    found.duration === (count > 1 ? "repeating" : "once") &&
    (count > 1 ? Number(found.duration_in_months) === count : true) &&
    found.valid !== false
  );
}
