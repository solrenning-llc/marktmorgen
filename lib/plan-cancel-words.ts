/**
 * What canceling a plan leads to, said before the creator presses "Yes,
 * cancel it" and again once it is set to stop (763 [STN10] unit 1).
 *
 * A plan that ends closes its store (lib/plan-closing-rules.ts, closesStore),
 * and the confirmation used to say only that the store keeps taking payments
 * until the end date. These lines are built from the same figures the
 * closing job runs on (lib/plan-closing.ts) and say no more than its own
 * notice to the creator says (closingLetter): nothing here is a promise the
 * job does not keep. In particular they never say members are not charged
 * again, which the notice says only once every membership's payments are
 * known to be paused.
 *
 * Imported by pages only; no server module, no read, no cost.
 */
import { BUYER_NOTICE_DAYS } from "@/lib/closing-buyers-rules";
import { CLOSING_DAYS, ERASE_WITHIN_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";

/** The heading over the lines, one string so a search of the page finds it whole. */
export const AFTER_CANCEL_TITLE = "What happens next";

/**
 * The lines, in the order they happen. `endsOn` is the day the period
 * already paid for (or the trial) ends, in words, when it is known.
 */
export function afterCancelWords(endsOn: string | null, trialing: boolean): string[] {
  const end = endsOn ? `On ${endsOn}` : trialing ? "When the trial ends" : "When the period you paid for ends";
  return [
    `${end}, your plan ends and your checkout stops taking payments. Your members keep their access until your store closes.`,
    `At least ${CLOSING_DAYS} days after that, your store closes. We email you ${WARN_MONTH_DAYS} days and ${WARN_WEEK_DAYS} days before that day. We email the people who bought from you at least ${BUYER_NOTICE_DAYS} days before it, up to a limit your plan sets.`,
    `On the day it closes, every membership and payment plan you sold through it ends, and its files are removed. Within ${ERASE_WITHIN_DAYS} days, everything else it keeps with us is deleted: its page, products, courses, community, contacts, forms and your buyers' access to what they bought.`,
    "Your sales, refunds and payouts stay on your own Stripe account. Your account and sign-in stay.",
    "Start a plan again before that day, and your store stays exactly as it is.",
  ];
}
