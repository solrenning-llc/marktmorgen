import type { NextRequest } from "next/server";
import { setWelcomeOffer, storeForEmail } from "@/lib/store";
import { MAX_WELCOME_ADDRESS, NO_WELCOME_OFFER, WELCOME_HOURS, WELCOME_PERCENTS } from "@/lib/welcome-offer";
import { canOfferWelcome } from "@/lib/welcome-offer-send";
import { readListing } from "@/lib/catalog";
import { makeSaveCoupon } from "@/lib/save-offer-coupon";
import { couponStillFits } from "@/lib/offer-coupon-reuse";
import { StripeError } from "@/lib/stripe-account";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * Sets the welcome offer with a deadline of each person's own
 * (lib/welcome-offer.ts), or switches it off. The coupon is made here, on the
 * creator's own Stripe account, when they save, so no page ever offers a
 * discount that could not be made; the same percent saved again keeps it.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const percent = Number(body.percent);
  const hours = Number(body.hours);
  const productId = typeof body.product === "string" ? body.product.slice(0, 40) : "";
  const remind = body.remind === true;
  const address = typeof body.address === "string" ? body.address.replace(/\s+/g, " ").trim() : "";
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    const store = await storeForEmail(guarded.ref);
    if (!store) return fail("none");
    if (!percent) {
      const result = await setWelcomeOffer(guarded.ref, { ...NO_WELCOME_OFFER, hours: store.welcomeOffer.hours, remind: store.welcomeOffer.remind, address: address || store.welcomeOffer.address });
      if (!result.ok) return fail(result.reason);
      return Response.json({ ok: true, welcomeOffer: result.store.welcomeOffer });
    }
    if (!(WELCOME_PERCENTS as readonly number[]).includes(percent)) return fail("percent");
    if (!(WELCOME_HOURS as readonly number[]).includes(hours)) return fail("hours");
    if (remind && (!address || address.length > MAX_WELCOME_ADDRESS)) return fail("address");
    if (!store.stripeAccountId) return fail("stripe");
    const product = productId ? await readListing(store, productId) : null;
    if (!canOfferWelcome(store, product ?? null)) return fail("product");
    // The same percent keeps its coupon only while the account connected now holds it with those terms (#4703).
    const same = store.welcomeOffer.percent === percent && store.welcomeOffer.coupon && (await couponStillFits(store, store.welcomeOffer.coupon, percent, 1));
    const coupon = same ? store.welcomeOffer.coupon : await makeSaveCoupon(store, percent, 1, "welcome");
    const result = await setWelcomeOffer(guarded.ref, { product: productId, percent, hours, coupon, remind, address });
    if (!result.ok) return fail(result.reason);
    return Response.json({ ok: true, welcomeOffer: result.store.welcomeOffer });
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("making the welcome offer coupon failed", error);
      return fail("stripe_refused", 502);
    }
    console.error("saving the welcome offer failed", error);
    return fail("server_error", 500);
  }
}
