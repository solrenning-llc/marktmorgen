/**
 * The checkouts a person paid in one store, read from the creator's own
 * Stripe account, for the copy of their data (619 [SZ3], lib/person-copy.ts).
 * Some records are kept by the payment rather than by the person (a gift
 * bought, places bought for a group, a shipment, a booked call's meeting),
 * and this is how the copy finds them: the same read that tells what a buyer
 * owns (lib/next-offer.ts, ownedHere), by the address as they typed it and as
 * it is kept. Only reads; nothing is written on Stripe or here.
 *
 * Null when it cannot be read whole (more than a page for one address, or
 * Stripe did not answer): the copy then fails rather than leave a part out.
 */
import { normaliseEmail } from "@/lib/auth";
import { onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { type Store, saleHandles } from "@/lib/store";

export type PaidCheckout = { id: string; meta: Record<string, string>; payment: string };

const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

export async function paidCheckoutsOf(store: Store, email: string): Promise<PaidCheckout[] | null> {
  const account = store.stripeAccountId;
  if (!account || !email) return [];
  const handles = saleHandles(store);
  const out = new Map<string, PaidCheckout>();
  try {
    for (const variant of [...new Set([email.trim(), normaliseEmail(email)])]) {
      const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
      const listed = (await onAccount("GET", account, `/checkout/sessions?${query}`)) as { data?: unknown; has_more?: unknown };
      if (listed.has_more === true) return null;
      for (const session of Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : []) {
        const meta = (session.metadata ?? {}) as Record<string, string>;
        const id = typeof session.id === "string" ? session.id : "";
        if (!SESSION.test(id) || !handles.has(meta.store ?? "") || !isSettled(session)) continue;
        out.set(id, { id, meta, payment: typeof session.payment_intent === "string" ? session.payment_intent : "" });
      }
    }
  } catch (error) {
    console.error("reading a person's checkouts for their copy failed", error);
    return null;
  }
  return [...out.values()];
}
