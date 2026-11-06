/**
 * The coupons on a creator's own Stripe account that take a fair price for a
 * country off at checkout (lib/fair-price.ts): one per percentage, made the
 * first time a buyer needs it and kept from then on, as a sale's coupon is.
 *
 * Its id is fixed (mm_fair_<percent>), so a second checkout racing the first
 * finds the same coupon rather than making another. Its name is what Stripe
 * shows the buyer beside the amount taken off.
 *
 * A member price (lib/member-price.ts, 620 [SZ4]) is taken off the same way,
 * with its own coupons (mm_member_<percent>, named "Member price").
 */
import { redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { fairCouponId } from "@/lib/fair-price";
import { memberCouponId } from "@/lib/member-price-rules";

const madeKey = (account: string, percent: number) => `nl:fair:c:${account}:${percent}`;
const memberMadeKey = (account: string, percent: number) => `nl:member:c:${account}:${percent}`;

/** The coupon's id, made on the account if it is not there yet. Throws when Stripe has neither made nor found it. */
export async function fairCoupon(account: string, percent: number): Promise<string> {
  return percentCoupon(account, percent, fairCouponId(percent), madeKey(account, percent), "Fair price for your country", "fair-price", "fair price");
}

/**
 * A member price's coupon (lib/member-price.ts, 620 [SZ4]): the same, one per
 * percentage, named so the buyer sees on Stripe's page why the price is lower.
 */
export async function memberCoupon(account: string, percent: number): Promise<string> {
  return percentCoupon(account, percent, memberCouponId(percent), memberMadeKey(account, percent), "Member price", "member-price", "member price");
}

async function percentCoupon(account: string, percent: number, id: string, key: string, name: string, purpose: string, what: string): Promise<string> {
  const [known] = await redisPipeline([["GET", key]]).catch(() => [null]);
  if (known === "1") return id;
  try {
    await onAccount(
      "POST",
      account,
      "/coupons",
      new URLSearchParams({
        id,
        percent_off: String(percent),
        duration: "once",
        name,
        "metadata[made_by]": "marktmorgen",
        "metadata[purpose]": purpose,
      }),
    );
  } catch (error) {
    // Made already, by an earlier checkout whose note was lost: it is used only
    // if it takes off what this one should.
    if (!(error instanceof StripeError) || error.code !== "resource_already_exists") throw error;
    const found = (await onAccount("GET", account, `/coupons/${encodeURIComponent(id)}`)) as { percent_off?: unknown; valid?: unknown };
    if (Number(found.percent_off) !== percent || found.valid === false) throw new Error(`coupon ${id} is not the ${what} it should be`);
  }
  await redisPipeline([["SET", key, "1"]]).catch(() => undefined);
  return id;
}
