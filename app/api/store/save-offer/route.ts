import type { NextRequest } from "next/server";
import { setSaveOffer, storeForEmail } from "@/lib/store";
import { NO_SAVE, SAVE_MONTHS, SAVE_PERCENTS } from "@/lib/save-offer";
import { makeSaveCoupon } from "@/lib/save-offer-coupon";
import { couponStillFits } from "@/lib/offer-coupon-reuse";
import { StripeError } from "@/lib/stripe-account";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * Sets the offer made once to a member on their way out, or takes it away.
 *
 * The coupon is made here, when the creator saves, on their own Stripe
 * account — never while a member is waiting on the cancel page. A setting
 * that cannot get its coupon made is refused, so the studio never says "on"
 * about an offer no member would ever see.
 *
 * The same percent and length saved twice keeps the coupon it already has: a
 * creator pressing Save again should not litter their Stripe dashboard with
 * identical coupons.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  const percent = Number(guarded.body.percent);
  const months = Number(guarded.body.months);

  try {
    const store = await storeForEmail(guarded.ref);
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });

    // Off always works, for anyone, whatever state their payments are in.
    if (!percent) {
      const result = await setSaveOffer(guarded.ref, { ...NO_SAVE });
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
      return Response.json({ ok: true, save: result.store.save });
    }

    if (!(SAVE_PERCENTS as readonly number[]).includes(percent)) return Response.json({ ok: false, error: "percent" }, { status: 400 });
    if (!(SAVE_MONTHS as readonly number[]).includes(months)) return Response.json({ ok: false, error: "months" }, { status: 400 });
    if (!store.stripeAccountId) return Response.json({ ok: false, error: "stripe" }, { status: 400 });

    // The same offer keeps its coupon only while the account connected now holds it with those terms (#4703).
    const same = store.save.percent === percent && store.save.months === months && store.save.coupon && (await couponStillFits(store, store.save.coupon, percent, months));
    const coupon = same ? store.save.coupon : await makeSaveCoupon(store, percent, months);
    const result = await setSaveOffer(guarded.ref, { percent, months, coupon });
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
    return Response.json({ ok: true, save: result.store.save });
  } catch (error) {
    // Stripe said no to the coupon: the setting is not saved, and the studio
    // says so, rather than showing an offer that could not be made.
    if (error instanceof StripeError) {
      console.error("making the stay-offer coupon failed", error);
      return Response.json({ ok: false, error: "stripe_refused" }, { status: 502 });
    }
    console.error("saving the stay offer failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
