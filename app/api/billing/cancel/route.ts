import type { NextRequest } from "next/server";
import { away, creatorFrom } from "@/lib/studio-route";
import {
  BillingError,
  isBillingConfigured,
  readSubscription,
  setCancelAtPeriodEnd,
} from "@/lib/billing";
import { setSubscription } from "@/lib/store";
import { limited } from "@/lib/request-guard";
import { dropPause, pauseView, undoPause } from "@/lib/plan-pause";
import { PLAN_BREAKS_ENABLED } from "@/lib/plan-pause-rules";

/**
 * Cancels the creator's subscription, or takes the cancellation back.
 *
 * No email to us and no conversation: the studio's button is the whole of it.
 * The subscription id is read from the creator's own store record, so a
 * request can only ever reach the subscription of whoever holds the session —
 * nothing in the form names which subscription to touch.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "billing");
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;

  if (!isBillingConfigured()) return away(origin, studio("billing=unavailable"));
  if (!store.subscriptionId) return away(origin, studio("billing=none"));

  let intent = "";
  try {
    const value = (await (await limited(request, 8_000)).formData()).get("intent");
    intent = typeof value === "string" ? value : "";
  } catch {
    intent = "";
  }
  if (intent !== "cancel" && intent !== "resume") {
    return away(origin, studio("billing=cancel-error"));
  }

  try {
    // "Keep my subscription" on a store with a break set takes the break back,
    // so it is not counted against the once a year (lib/plan-pause.ts).
    if (intent === "resume") {
      if (!PLAN_BREAKS_ENABLED) {
        const observation = await pauseView(store);
        if (observation.kind === "unknown") return away(origin, studio("billing=cancel-error"));
        if (observation.kind === "known") return away(origin, studio("billing=pause-unavailable"));
      }
      const done = PLAN_BREAKS_ENABLED ? await undoPause(store) : "none";
      if (done !== "none") return away(origin, studio(done === "kept" ? "billing=resumed" : "billing=ended"));
    }
    const state = await setCancelAtPeriodEnd(store.subscriptionId, intent === "cancel");
    // Leaving outright: a break that was set has nothing left to start again.
    if (intent === "cancel") await dropPause(store).catch((error) => console.error("dropping a break failed", error));
    if (state.state !== "active") {
      // Stripe has ended it; a store record not written (null) still holds the
      // plan, so the creator is not told it ended. A throw lands in the catch.
      const written = await setSubscription(ref, { active: false });
      return away(origin, studio(written ? "billing=ended" : "billing=cancel-error"));
    }
    return away(origin, studio(intent === "cancel" ? "billing=canceling" : "billing=resumed"));
  } catch (error) {
    // Stripe refuses to change a subscription that is already over. Ask what
    // it is doing before saying so, because a refusal for any other reason
    // must not be reported to the creator as "it has ended".
    if (error instanceof BillingError && (error.status === 400 || error.status === 404)) {
      const now = await readSubscription(store.subscriptionId);
      if (now.state === "inactive") {
        const written = await setSubscription(ref, { active: false }).catch((failure) => {
          console.error("recording the ended subscription failed", failure);
          return null;
        });
        return away(origin, studio(written ? "billing=ended" : "billing=cancel-error"));
      }
    }
    console.error("changing the cancellation failed", error);
    return away(origin, studio("billing=cancel-error"));
  }
}
