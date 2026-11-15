import type { NextRequest } from "next/server";
import { setWinBack, storeForEmail } from "@/lib/store";
import { MAX_WINBACK_ADDRESS, NO_WINBACK, WINBACK_DAYS, WINBACK_MONTHS, WINBACK_PERCENTS } from "@/lib/winback";
import { makeSaveCoupon } from "@/lib/save-offer-coupon";
import { couponStillFits } from "@/lib/offer-coupon-reuse";
import { StripeError } from "@/lib/stripe-account";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * Sets the come-back offer emailed after a membership ends (lib/winback.ts),
 * or switches it off.
 *
 * The coupon is made here, when the creator saves, on their own Stripe
 * account, so an email never goes out promising a discount that could not be
 * made. The same percent and length saved again keeps the coupon it has.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const percent = Number(body.percent);
  const months = Number(body.months);
  const days = Number(body.days);
  const address = typeof body.address === "string" ? body.address.replace(/\s+/g, " ").trim() : "";
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    const store = await storeForEmail(guarded.ref);
    if (!store) return fail("none");

    // Off always works, and keeps the address and the day for next time.
    if (!percent) {
      const result = await setWinBack(guarded.ref, { ...NO_WINBACK, days: store.winback.days, address: address || store.winback.address });
      if (!result.ok) return fail(result.reason);
      return Response.json({ ok: true, winback: result.store.winback });
    }

    if (!(WINBACK_PERCENTS as readonly number[]).includes(percent)) return fail("percent");
    if (!(WINBACK_MONTHS as readonly number[]).includes(months)) return fail("months");
    if (!(WINBACK_DAYS as readonly number[]).includes(days)) return fail("days");
    if (!address || address.length > MAX_WINBACK_ADDRESS) return fail("address");
    if (!store.stripeAccountId) return fail("stripe");

    // The same offer keeps its coupon only while the account connected now holds it with those terms (#4703).
    const same = store.winback.percent === percent && store.winback.months === months && store.winback.coupon && (await couponStillFits(store, store.winback.coupon, percent, months));
    const coupon = same ? store.winback.coupon : await makeSaveCoupon(store, percent, months, "win-back");
    const result = await setWinBack(guarded.ref, { percent, months, days, coupon, address });
    if (!result.ok) return fail(result.reason);
    return Response.json({ ok: true, winback: result.store.winback });
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("making the come-back coupon failed", error);
      return fail("stripe_refused", 502);
    }
    console.error("saving the come-back offer failed", error);
    return fail("server_error", 500);
  }
}
