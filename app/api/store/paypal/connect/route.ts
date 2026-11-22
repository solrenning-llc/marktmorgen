import { serviceRefusalCode, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { away, creatorFrom } from "@/lib/studio-route";
import { clientAddress } from "@/lib/request-guard";
import { endOnboarding, markOnboarding, onboardingStill, onboardingUrl, paypalSalesConfigured } from "@/lib/paypal-sales";

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
  let attempt: string | null = null;
  try {
    const pin = store.sid ? `?store=${encodeURIComponent(store.sid)}` : "";
    // The way back is taken only after a connect started here (lib/paypal-sales.ts, markOnboarding). The mark is
    // written first, only while the store is live: a store being erased asks PayPal nothing (Codex L-20261120-0310).
    attempt = await markOnboarding(store);
    if (!attempt) return away(origin, studio("paypal=error#paypal"));
    const url = await onboardingUrl(store, `${origin}/api/store/paypal/onboarded${pin}`);
    // PayPal's page is handed over only while this attempt is still the store's: an erasure that began while PayPal
    // answered has deleted the mark with the store's other keys, and a newer connect or a disconnect has replaced it.
    if (!url || (await onboardingStill(store.statsId, attempt)) !== true) {
      await endOnboarding(store.statsId, attempt);
      return away(origin, studio("paypal=error#paypal"));
    }
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("starting PayPal onboarding failed", error);
    if (attempt) await endOnboarding(store.statsId, attempt).catch(() => undefined);
    return away(origin, studio("paypal=error#paypal"));
  }
}
