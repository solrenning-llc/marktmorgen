import { serviceRefusalCode, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { away, creatorFrom } from "@/lib/studio-route";
import { clientAddress } from "@/lib/request-guard";
import { PayPalStoreGoneError, markOnboarding, onboardingUrl, paypalSalesConfigured } from "@/lib/paypal-sales";

/**
 * Sends the creator into PayPal's own onboarding to connect their PayPal
 * Business account for selling (lib/paypal-sales.ts). PayPal asks them to
 * sign in, or open an account, and to grant Marktmorgen the right to take
 * payments into it and refund them. Nothing here sees their password.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "payments");
  if (creator instanceof Response) return creator;
  const { store, origin, studio } = creator;
  if (!paypalSalesConfigured()) return away(origin, studio("paypal=unavailable#paypal"));
  if (!store.statsId) return away(origin, studio("paypal=error#paypal"));
  const refused = await withinServiceWhy("paypal-sell-connect", `${clientAddress(request)}|${store.handle}`, 10, 3600, store);
  if (refused) return away(origin, studio(`paypal=${serviceRefusalCode(refused, "slow")}#paypal`));
  try {
    const pin = store.sid ? `?store=${encodeURIComponent(store.sid)}` : "";
    const url = await onboardingUrl(store, `${origin}/api/store/paypal/onboarded${pin}`);
    if (!url) return away(origin, studio("paypal=error#paypal"));
    // The way back is taken only after a connect started here (lib/paypal-sales.ts, markOnboarding), and only while
    // the store is live: a store erasing meanwhile gets no mark and is not sent to PayPal.
    await markOnboarding(store);
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (error) {
    if (!(error instanceof PayPalStoreGoneError)) console.error("starting PayPal onboarding failed", error);
    return away(origin, studio("paypal=error#paypal"));
  }
}
