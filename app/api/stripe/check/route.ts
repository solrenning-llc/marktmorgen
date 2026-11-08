import type { NextRequest } from "next/server";
import { away, creatorFrom } from "@/lib/studio-route";
import { isConnectConfigured, readAccount } from "@/lib/stripe-connect";
import { setStripeAccount } from "@/lib/store";

/** Asks Stripe again, on the creator's word, and writes down what it says. */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "payments");
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;

  if (!isConnectConfigured()) return away(origin, studio("stripe=unavailable"));
  if (!store.stripeAccountId) return away(origin, studio("stripe=notstarted"));

  try {
    const state = await readAccount(store.stripeAccountId);
    // Said only once the record took it (CX-123 rule 24): that record opens the store's checkout.
    const saved = await setStripeAccount(ref, store.stripeAccountId, state.chargesEnabled);
    if (!saved.ok) return away(origin, studio("stripe=error"));
    return away(origin, studio(`stripe=${state.chargesEnabled ? "ready" : "pending"}`));
  } catch (error) {
    console.error("stripe check failed", error);
    return away(origin, studio("stripe=error"));
  }
}
