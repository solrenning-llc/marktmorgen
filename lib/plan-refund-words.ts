/**
 * What the plan refund's review page and confirmation email say (305 [SY1]
 * unit 2b2): pure, so the words are tested against the code they describe.
 *
 * Every sentence matches what the code does: the refund comes from the
 * reading of lib/plan-refund.ts and is made by lib/plan-refund-flow.ts, which
 * ends the plan the same day; what happens to the store afterward is the
 * closing of lib/plan-closing-rules.ts, as the Help says
 * (lib/help-content.ts, "What happens when my plan ends?": the closing day
 * stops the renewals the creator sold on their own Stripe account, so the
 * page never says that account is not touched). No reason is asked: the
 * policy says "No reason is required".
 */
import { formatMoney } from "@/lib/money";
import { CLOSING_DAYS, ENDED_STORE_EXPORTS, ERASE_WITHIN_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { REFUND_DAYS } from "@/lib/plan";
import type { PlanRefundReading } from "@/lib/plan-refund";

export const SUPPORT_ADDRESS = "support@marktmorgen.com";

export const moneyOf = (cents: number, currency: string): string => formatMoney(cents, currency.toUpperCase());

/** What happens to the store once the refund is made, in the order it happens. */
export function refundEffects(o: { assistant: boolean }): string[] {
  return [
    "Your plan ends today. Your checkout stops taking payments today, and the other paid features of your plan stop with it.",
    `Your store stays as it is for ${CLOSING_DAYS} days: its page, products, files, courses, community, contacts and orders, and your buyers go on reaching what they bought. Then it closes.`,
    `We email you when your plan ends, ${WARN_MONTH_DAYS} days before your store closes and ${WARN_WEEK_DAYS} days before it, each time with the date. Starting a plan again before then keeps your store.`,
    "When it closes, its files are removed, and the renewals of the memberships and payment plans you sold through it are stopped at Stripe, each at the end of the period already paid.",
    `Within ${ERASE_WITHIN_DAYS} days of closing, usually the same day, everything else it keeps with us is deleted, your buyers' access to what they bought from it included. Every sale, refund and payout stays on your own Stripe account.`,
    `Before then, you can download your whole store as one file from the notice at the top of your studio, ${ENDED_STORE_EXPORTS === 1 ? "once" : `up to ${ENDED_STORE_EXPORTS} times`}.`,
    ...(o.assistant ? ["Your Store assistant add-on stops at the end of the month you already paid for, and nothing more is charged for it."] : []),
  ];
}

type Refusal = Exclude<PlanRefundReading["refund"]["kind"], "guarantee" | "unstarted_months">;

/** Why there is no refund to make, in plain words, and what to do instead. Never a button that would fail. */
export function refusalWords(reading: { refund: { kind: Refusal; reason: string } }): { title: string; body: string } {
  const r = reading.refund.reason;
  if (reading.refund.kind === "unknown") {
    return {
      title: "We cannot work out your refund here",
      body: r === "customer_credit"
        ? `Your account has a credit from an earlier change of plan, so the refund needs a person to work it out. Email ${SUPPORT_ADDRESS} and we will reply.`
        : r === "stripe_unread"
          ? `We could not reach our payment provider just now. Try again in a few minutes, or email ${SUPPORT_ADDRESS}.`
          : `Something about this payment needs a person to check it. Email ${SUPPORT_ADDRESS} and we will work out your refund.`,
    };
  }
  const why: Record<string, string> = {
    no_plan_payment: "You have not been charged for a plan yet, so there is nothing to refund. To stop a trial, cancel the subscription in your studio.",
    not_paid: "Your last plan payment did not go through, so there is nothing to refund.",
    nothing_paid: "Your last plan payment was nothing, so there is nothing to refund.",
    dispute_open: "This payment is in a dispute with your bank. The dispute decides what comes back to you, so we cannot refund it as well.",
    dispute_returned: "Your bank already returned this payment to you through a dispute.",
    already_refunded: "This payment has already been refunded.",
    guarantee_used: "The money-back guarantee is given once per person, and it was used before.",
    outside_window: `The money-back guarantee is for requests made within ${REFUND_DAYS} days of your first payment, and that time has passed.`,
    // True in every case that reaches it: a renewal or switch after the guarantee's days, one whose first payment
    // was not under the guarantee (it was used before, by this person for any store), or one paid on its own.
    renewal: `The money-back guarantee covers a monthly renewal only together with a first payment it covers, within ${REFUND_DAYS} days of that payment, and once per person. This renewal is not covered. You can cancel your subscription in your studio, and it stops at the end of the month you paid for.`,
    switch_charge: `The money-back guarantee covers a charge for switching plans only together with a first payment it covers, within ${REFUND_DAYS} days of that payment, and once per person. This charge is not covered. You can cancel your subscription in your studio, and it stops at the end of the period you paid for.`,
    months_used: "Every month of your yearly plan has started, so there are no months left to refund.",
    fee_kept: "What is left of your yearly payment is not more than the card fee we keep, so there is nothing to refund.",
  };
  return {
    title: "There is no refund to make",
    body: `${why[r] ?? "This payment cannot be refunded under our refund policy."} If you think this is wrong, email ${SUPPORT_ADDRESS}.`,
  };
}

/** The confirmation email, once the money is on its way and the plan has ended. */
export function planRefundLetter(o: { store: string; cents: number; currency: string; pending: boolean; assistant: boolean }): { subject: string; text: string } {
  const store = o.store || "your store";
  const lines = [
    `We refunded ${moneyOf(o.cents, o.currency)} for your Marktmorgen plan for ${store}, to the card or account you paid with.`,
    o.pending ? "Your bank is still processing it, and it may take a few days to show." : "Your bank may take a few days to show it.",
    "",
    ...refundEffects({ assistant: o.assistant }),
    "",
    "If you have a question, reply to this email.",
    "",
    "Marktmorgen",
  ];
  return { subject: `${store}: your plan payment was refunded`, text: lines.join("\n") };
}

/**
 * When a refund the creator asked for was not made after all (the daily job found none, or could not tell for
 * GIVE_UP_DAYS): nothing was refunded, the stop set for it was taken back, the plan goes on; how to ask again.
 */
export function planRefundNotMadeLetter(o: { store: string; undecided: boolean }): { subject: string; text: string } {
  const store = o.store || "your store";
  const lines = [
    o.undecided
      ? `We could not confirm the refund you asked for on your Marktmorgen plan for ${store}, so we did not end your plan.`
      : `The refund you asked for on your Marktmorgen plan for ${store} was not made: our payment provider did not take it.`,
    "",
    "Nothing was refunded and your plan goes on as before. It renews as usual unless you cancel it in your studio.",
    `To ask again, open your studio and choose "Refund my payment" under "What you pay us", or email ${SUPPORT_ADDRESS}.`,
    "",
    "Marktmorgen",
  ];
  return { subject: `${store}: your refund was not made`, text: lines.join("\n") };
}

/** When only part of a refund went through and the rest could not be made in GIVE_UP_DAYS: the plan stops at its period's end, support settles the rest. */
export function planRefundPartLetter(o: { store: string }): { subject: string; text: string } {
  const store = o.store || "your store";
  return {
    subject: `${store}: part of your refund was not made`,
    text: [
      `Only part of the refund you asked for on your Marktmorgen plan for ${store} went through; our payment provider did not take the rest.`,
      "",
      "Your plan is set to stop at the end of the period you paid for, and nothing more will be charged for it.",
      `Reply to this email or write to ${SUPPORT_ADDRESS}, and we will settle the rest of your refund.`,
      "",
      "Marktmorgen",
    ].join("\n"),
  };
}

/** Days the daily job keeps checking a refund it cannot decide (lib/plan-refund-flow.ts GIVE_UP_DAYS), said on the page. */
const CHECK_DAYS = 7;
export const REFUND_CHECK_DAYS = CHECK_DAYS;

const DECIDED_LATER = `We check it again every day and email you once it is decided, at most ${CHECK_DAYS} days from now: either the refund and the end of your plan, or that nothing was refunded and your plan goes on.`;

/**
 * What the review page says about the refund route's answer (app/api/billing/refund) or a refund still being
 * settled, in plain words. A title says "Nothing was refunded" only where the code knows no refund was made.
 */
export const REFUND_DONE: Record<string, { tone: "success" | "warn"; title: string; body: string }> = {
  refunded: { tone: "success", title: "Your payment was refunded", body: "Your plan has ended. We sent you an email with the amount and what happens next. Your bank may take a few days to show the refund." },
  ending: { tone: "success", title: "Your refund is on its way", body: "Our payment provider is still processing it. We end your plan once it goes through and email you then. If it does not go through, nothing is refunded, your plan goes on, and we email you to say so." },
  busy: { tone: "warn", title: "Your refund is already being handled", body: `An earlier request for it has not finished yet, so there is nothing to confirm here now. ${DECIDED_LATER}` },
  review: { tone: "warn", title: "This confirmation was not used", body: "It was used already, or a newer copy of this page was opened. Check the amount below and confirm again if you still want the refund." },
  changed: { tone: "warn", title: "The amount changed", body: "The amount our refund policy gives changed since you opened this page, so nothing was refunded. The new amount is below; confirm again if you still want it." },
  later: { tone: "warn", title: "Nothing was refunded", body: `You asked many times today. Try again tomorrow, or email ${SUPPORT_ADDRESS}.` },
  error: { tone: "warn", title: "Nothing was refunded", body: `We could not reach our payment provider, and your plan was not changed. Try again in a few minutes. If it happens again, email ${SUPPORT_ADDRESS}.` },
  unsure: { tone: "warn", title: "We could not confirm your refund yet", body: `We did not hear back from our payment provider, so we do not know yet whether the refund went through. ${DECIDED_LATER} Please do not ask again before then. Questions: ${SUPPORT_ADDRESS}.` },
  "error-stop": { tone: "warn", title: "We could not confirm your refund yet", body: `We did not hear back from our payment provider, so we do not know yet whether the refund went through. Until it is decided, your plan is set to stop at the end of the period you paid for; if no refund was made, we take that back. ${DECIDED_LATER} Questions: ${SUPPORT_ADDRESS}.` },
  partial: { tone: "warn", title: "Part of your refund went through", body: `Part of your refund is on its way to the card or account you paid with, and the rest could not be made just now. Your plan is set to stop at the end of the period you paid for, so it does not renew. Email ${SUPPORT_ADDRESS} and we will finish your refund.` },
  none: { tone: "warn", title: "Nothing was refunded", body: "The reason is below." },
  owner: { tone: "warn", title: "Only the store's owner can ask for this refund", body: "Ask the owner of this store to open this page." },
};
