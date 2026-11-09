/**
 * Telling a creator, once, that a payment plan's end could not be saved
 * (the review of claude5/plans-stuck-entries, M2, 9 November 2026).
 *
 * The daily plans job (lib/plans.ts, settlePlans) gives every payment plan
 * its end at Stripe, on the creator's own account. When that account refuses
 * us for PLAN_GIVE_UP_DAYS (access revoked, the account closed), the job keeps
 * trying once a week, and the creator is told once by this email: what could
 * not be done, what it means for the buyer, what they can do in their own
 * Stripe dashboard, and what the job does by itself. It promises only what
 * is real: the studio cannot reconnect an account already connected (it can
 * only ask Stripe again or disconnect it), so the email never says to
 * reconnect (Claude 6 on #3367, VR 2). Nothing about the buyer is in it.
 *
 * tellPlanOwed is the same door for a payment taken after a plan's end that
 * could not be refunded for PLAN_OWED_TELL_DAYS (lib/plans.ts): the
 * creator's balance does not cover it, or Stripe refused the refund. It names
 * the invoices to refund, never the buyer.
 *
 * It is the store's own email, as the one about a checkout Stripe would not
 * open is (lib/checkout-trouble.ts): taken from the store's email figure
 * before it is sent, at most once per plan (the caller keeps the plan's
 * "told" mark, and lets it go when this answers "unsent").
 */
import { createHash } from "node:crypto";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { storeForId } from "@/lib/store";
import { readListing } from "@/lib/catalog";

export type StuckPlan = { sid: string; product: string; account: string; session: string; days: number };

/**
 * The idempotency key of a plan's notice: one per plan and kind, so an email Resend accepted whose answer was lost is
 * not sent again on the next try (the review of #3367 at 9489992283, Claude 6 LEVE 2).
 */
export const noticeKey = (kind: "plan-stuck" | "plan-owed", account: string, session: string): string =>
  `${kind}:${createHash("sha256").update(`${account}|${session}`).digest("hex").slice(0, 32)}`;

/**
 * The words of the email, for one store and one product (null: the product is no longer in the store). The plan is
 * named by the checkout that started it, which the creator can search for in their Stripe dashboard to reach the
 * buyer's subscription; never by anything about the buyer (Claude 6 A1 on #3367).
 */
export function stuckPlanWords(storeName: string, product: string | null, account: string, session: string, days: number): { subject: string; text: string } {
  const what = product ? `"${product}"` : "one of your products";
  return {
    subject: `${storeName}: a payment plan's end could not be saved`.slice(0, 180),
    text: [
      `A buyer is paying for ${what} on a payment plan. When a plan starts, we tell Stripe when it ends, so the buyer is never charged after their last payment.`,
      "",
      `For ${days} days, the Stripe account ${account} has refused our access, so we could not tell Stripe when this plan ends. Until we can, Stripe may keep charging the buyer after their last payment.`,
      "",
      `The plan started with this checkout: ${session}`,
      "",
      "What to do:",
      `- In your Stripe dashboard for the account ${account}, search for the checkout above, open the subscription it started and set it to cancel after the buyer's last payment. Then Stripe never charges past it.`,
      "",
      "What we do by ourselves:",
      "- We try again once a week. As soon as Stripe answers us for this account, we save the plan's end. If that end has already passed, we end the subscription at once and refund in full, from your Stripe balance, every payment Stripe took after it.",
      "",
      "We send this email once for this plan.",
    ].join("\n"),
  };
}

export type OwedPlan = { sid: string; product: string; account: string; session: string; days: number; invoices: string[] };

/** The words of the email about a payment after a plan's end still to refund (null product: no longer in the store). */
export function owedPlanWords(storeName: string, product: string | null, session: string, invoices: string[], days: number): { subject: string; text: string } {
  const what = product ? `"${product}"` : "one of your products";
  const one = invoices.length === 1;
  return {
    subject: `${storeName}: a payment to refund to a buyer is waiting`.slice(0, 180),
    text: [
      `A buyer paying for ${what} on a payment plan was charged after their last payment. The plan's end was promised to the buyer, so we end the subscription and refund such a payment in full, from your Stripe balance.`,
      "",
      `For ${days} days we could not refund ${one ? "it" : "them"}: your Stripe balance does not cover ${one ? "it" : "them"}, or Stripe refused the refund.`,
      "",
      `The plan started with this checkout: ${session}`,
      `${one ? "The payment" : "The payments"} to refund (Stripe invoice${one ? "" : "s"}):`,
      ...invoices.map((invoice) => `- ${invoice}`),
      "",
      "What to do:",
      `- Refund ${one ? "it" : "them"} yourself now: in your Stripe dashboard, search for ${one ? "the invoice" : "each invoice"} above and refund ${one ? "its payment" : "the payment"} in full.`,
      "- If Stripe says a payment can no longer be refunded (it is too old, or the buyer's card is closed), we cannot give it back from here either: contact the buyer and pay them back another way.",
      "",
      "What we do by ourselves:",
      "- We try again every day. When your balance covers it and Stripe accepts the refund, we refund it and email the buyer. A payment you refund yourself in Stripe is not refunded again.",
      "",
      "We send this email once for this plan.",
    ].join("\n"),
  };
}

/**
 * Emails the store's owner, once a plan, about a payment after the plan's end still to refund: "told", "unsent" or
 * "nobody", as tellPlanStuck answers.
 */
export async function tellPlanOwed(plan: OwedPlan): Promise<"told" | "unsent" | "nobody"> {
  if (!plan.sid) return "nobody";
  const store = await storeForId(plan.sid);
  if (!store) return "nobody";
  if (!isSenderConfigured()) return "unsent";
  const listing = plan.product ? await readListing(store, plan.product).catch(() => null) : null;
  const words = owedPlanWords(store.name, listing?.title ?? null, plan.session, plan.invoices, plan.days);
  const sent = await sendEmail({ meter: { by: "store", store, kind: "email" }, from: NIMBUS_FROM, to: store.email, subject: words.subject, text: words.text, idempotencyKey: noticeKey("plan-owed", plan.account, plan.session) }).catch(() => false);
  return sent ? "told" : "unsent";
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
  const words = stuckPlanWords(store.name, listing?.title ?? null, plan.account, plan.session, plan.days);
  const sent = await sendEmail({ meter: { by: "store", store, kind: "email" }, from: NIMBUS_FROM, to: store.email, subject: words.subject, text: words.text, idempotencyKey: noticeKey("plan-stuck", plan.account, plan.session) }).catch(() => false);
  return sent ? "told" : "unsent";
}
