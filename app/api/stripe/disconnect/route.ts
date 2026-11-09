import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { away, creatorFrom } from "@/lib/studio-route";
import { clearStripeAccount } from "@/lib/store";

/**
 * Forgets the connection on this side.
 *
 * Deliberately only this side. The Stripe account belongs to the creator, and
 * closing it or removing Marktmorgen from it is theirs to do, in their own Stripe
 * dashboard. Pretending otherwise would be claiming a power over their money
 * that this product should not have.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "payments");
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;

  try {
    const result = await clearStripeAccount(ref);
    if (!result) return away(origin, studio("stripe=nostore"));
    if ("full" in result) return away(origin, studio("stripe=kept"));
    if (store.stripeAccountId) after(() => noticeCreator(store, { kind: "stripe-disconnected" }));
    return away(origin, studio("stripe=forgotten"));
  } catch (error) {
    console.error("stripe disconnect failed", error);
    return away(origin, studio("stripe=error"));
  }
}
