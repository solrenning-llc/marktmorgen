import type { NextRequest } from "next/server";
import { away, creatorFrom } from "@/lib/studio-route";
import { isBillingConfigured, readStartedSubscription } from "@/lib/billing";
import { setSubscription } from "@/lib/store";
import { dropPause } from "@/lib/plan-pause";
import { inClosingDay } from "@/lib/closing-holds";
import { refuseSession } from "@/lib/closing-plan-guard";

/**
 * Where Stripe sends a creator who has finished, or looked like they finished.
 *
 * The session id in the URL is a claim made by a browser, so nothing is
 * believed until Stripe is asked what that session actually created and
 * whether it belongs to this store. Coming back through this door proves the
 * door was walked through, nothing more.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "billing", { checkOrigin: false });
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;

  if (!isBillingConfigured()) return away(origin, studio("billing=unavailable"));

  const sessionId = request.nextUrl.searchParams.get("session_id") ?? undefined;

  try {
    // Its closing day has begun (queue item 307 [EC1]): a plan finished now
    // would be paid for and never given, so it is ended and its payment
    // returned in full, never written down (lib/closing-plan-guard.ts).
    if (store.planEndedAt && (await inClosingDay(ref))) {
      const refused = await refuseSession(store, sessionId);
      return away(origin, studio(refused === "no" ? "billing=closing" : `billing=closing-${refused}`));
    }
    const started = await readStartedSubscription(store, sessionId);
    if (!started) return away(origin, studio("billing=unfinished"));

    const saved = await setSubscription(ref, {
      customerId: started.customerId,
      subscriptionId: started.subscriptionId,
      active: started.active,
      tier: started.tier,
      cycle: started.cycle,
      trialEnds: started.trialEnds,
      shared: started.shared,
      period: started.period,
    });
    if (!saved) return away(origin, studio("billing=error"));
    // Started again by hand during a break: there is nothing left for the
    // break to start (lib/plan-pause.ts).
    if (started.active) await dropPause(saved).catch((error) => console.error("dropping a break failed", error));

    return away(origin, studio(`billing=${started.active ? "on" : "pending"}`));
  } catch (error) {
    // Stripe did not answer just now. The payment, if there was one, is not
    // lost: it is found by the store's address, when the creator presses
    // start again and by the daily job (lib/billing-sync.ts). So the creator
    // is told that, rather than that nothing was charged.
    console.error("billing return failed", error);
    return away(origin, studio("billing=unconfirmed"));
  }
}
