import { serviceRefusalCode, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { away, creatorFrom } from "@/lib/studio-route";
import { clientAddress } from "@/lib/request-guard";
import { contactStoreLive } from "@/lib/inbox";
import { markOnboarding, onboardingUrl, paypalSalesConfigured } from "@/lib/paypal-sales";

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
    // A store whose erasure has begun, or that is gone, asks PayPal nothing: read in one step, without writing
    // (lib/inbox.ts contactStoreLive, the fence's rule: its erasing mark absent, its id key still its own).
    if ((await contactStoreLive(store)) !== true) return away(origin, studio("paypal=error#paypal"));
    const url = await onboardingUrl(store, `${origin}/api/store/paypal/onboarded${pin}`);
    if (!url) return away(origin, studio("paypal=error#paypal"));
    // The way back is taken only after a connect started here (lib/paypal-sales.ts, markOnboarding). The mark is
    // written once PayPal answered, and only while the store is still live, in the same step as that check
    // (lib/live-fence.ts): a store whose erasure began while PayPal answered gets no mark and no page (Codex
    // L-20261120-0310), and a connect that failed leaves an earlier attempt, still open in another tab, as it was.
    if (!(await markOnboarding(store))) return away(origin, studio("paypal=error#paypal"));
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("starting PayPal onboarding failed", error);
    return away(origin, studio("paypal=error#paypal"));
  }
}
