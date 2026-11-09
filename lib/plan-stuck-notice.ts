/**
 * Telling a creator, once, that a payment plan's end could not be saved
 * (the review of claude5/plans-stuck-entries, M2, 9 November 2026).
 *
 * The daily plans job (lib/plans.ts, settlePlans) gives every payment plan
 * its end at Stripe, on the creator's own account. When that account refuses
 * us for PLAN_GIVE_UP_DAYS (access revoked, the account closed), the job keeps
 * trying once a week, and the creator, who alone can let us back in, is told
 * once by this email: what could not be done, what it means for the buyer,
 * and what puts it right. Nothing about the buyer is in it.
 *
 * It is the store's own email, as the one about a checkout Stripe would not
 * open is (lib/checkout-trouble.ts): taken from the store's email figure
 * before it is sent, at most once per plan (the caller keeps the plan's
 * "told" mark, and lets it go when this answers "unsent").
 */
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { storeForId } from "@/lib/store";
import { readListing } from "@/lib/catalog";

export type StuckPlan = { sid: string; product: string; account: string; days: number };

/** The words of the email, for one store and one product (null: the product is no longer in the store). */
export function stuckPlanWords(storeName: string, product: string | null, account: string, days: number): { subject: string; text: string } {
  const what = product ? `"${product}"` : "one of your products";
  return {
    subject: `${storeName}: a payment plan's end could not be saved`.slice(0, 180),
    text: [
      `A buyer is paying for ${what} on a payment plan. When a plan starts, we tell Stripe when it ends, so the buyer is never charged after their last payment.`,
      "",
      `For ${days} days, the Stripe account ${account} has refused our access, so we could not tell Stripe when this plan ends. Until we can, Stripe may keep charging the buyer after their last payment.`,
      "",
      "What to do:",
      `- Reconnect this Stripe account to your store in your studio: ${SITE_URL}/studio#stripe`,
      "- We keep trying once a week. As soon as the account lets us in, we save the plan's end. You do not need to do anything else.",
      "- If you no longer use this Stripe account, open it in your Stripe dashboard and set the buyer's subscription to cancel after their last payment.",
      "",
      "We send this email once for this plan.",
    ].join("\n"),
  };
}

/**
 * Emails the store's owner about one stuck plan. "told" when sent; "unsent"
 * when it could not be sent now (no sender, the store's email figure spent,
 * the provider down), so the caller tries again at the plan's next try;
 * "nobody" when there is no store to tell (no store named, or the store is
 * gone), which is final.
 */
export async function tellPlanStuck(plan: StuckPlan): Promise<"told" | "unsent" | "nobody"> {
  if (!plan.sid) return "nobody";
  const store = await storeForId(plan.sid);
  if (!store) return "nobody";
  if (!isSenderConfigured()) return "unsent";
  const listing = plan.product ? await readListing(store, plan.product).catch(() => null) : null;
  const words = stuckPlanWords(store.name, listing?.title ?? null, plan.account, plan.days);
  const sent = await sendEmail({ meter: { by: "store", store, kind: "email" }, from: NIMBUS_FROM, to: store.email, subject: words.subject, text: words.text }).catch(() => false);
  return sent ? "told" : "unsent";
}
