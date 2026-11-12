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
      const listed: unknown = await onAccount("GET", account, `/checkout/sessions?${query}`);
      // A missing list or continuation flag cannot prove that nothing is
      // retained by payment. Reject the whole copy, including earlier rows.
      if (!listed || typeof listed !== "object" || Array.isArray(listed)) return null;
      const page = listed as Record<string, unknown>;
      if (page.object !== "list" || page.has_more !== false || !Array.isArray(page.data) || page.data.length > 100) return null;
      for (let i = 0; i < page.data.length; i++) {
        if (!Object.hasOwn(page.data, i)) return null;
        const value: unknown = page.data[i];
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const session = value as Record<string, unknown>;
        const id = session.id;
        if (typeof id !== "string" || !SESSION.test(id) ||
            !["open", "complete", "expired"].includes(session.status as string) ||
            !["paid", "unpaid", "no_payment_required"].includes(session.payment_status as string) ||
            (session.payment_intent !== undefined && session.payment_intent !== null && typeof session.payment_intent !== "string")) return null;
        // Stripe can explicitly return null metadata for an untagged checkout.
        // Missing or malformed metadata cannot identify which store owns it.
        const metadata: unknown = session.metadata === null ? {} : session.metadata;
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
            Object.values(metadata).some(item => typeof item !== "string")) return null;
        const meta = metadata as Record<string, string>;
        if (!handles.has(meta.store ?? "") || !isSettled(session)) continue;
        out.set(id, { id, meta, payment: typeof session.payment_intent === "string" ? session.payment_intent : "" });
      }
    }
  } catch (error) {
    console.error("reading a person's checkouts for their copy failed", error);
    return null;
  }
  return [...out.values()];
}
