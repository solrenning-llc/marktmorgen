/**
 * The questions someone starting out asks about webhooks (534 [FQ1], unit 16,
 * added 2 November 2026), answered only by what the code does today: the
 * studio's "Webhooks and Zapier" card and its own words
 * (components/webhook-editor.tsx), the most addresses (lib/webhook-limits.ts),
 * the deliveries a month covers, none without a plan
 * (lib/store-allowance-rules.ts, NON_PAYING_ALLOWANCES), and the shared answer
 * to "Can I try webhooks before paying?" (lib/beginner-faq.ts). No number of
 * deliveries or sales beyond the code's own. Shown first in the page's own
 * "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";
import { NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio card's own words. */
export const WEBHOOK_WORDS = { card: "Webhooks and Zapier", field: "Endpoint address (https)", events: "Send these events", add: "Add endpoint", test: "Send test" } as const;

export function webhookBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = WEBHOOK_WORDS;
  const noneWithoutPlan = NON_PAYING_ALLOWANCES.none.webhook === 0 && NON_PAYING_ALLOWANCES.ended.webhook === 0;
  const trialSends = NON_PAYING_ALLOWANCES.trial.webhook > 0;
  return [
    {
      q: "What are webhooks here?",
      a: `An address in another tool, such as a Zapier Catch Hook, a Make scenario or your own server, that your store tells when something you pick happens: a sale, a refund, a membership starting or ending, a lead, an email-list sign-up, a booking or a sequence step. Each message is JSON, a format other tools read, signed so they can tell it came from us. Most are sent at once; sales, memberships and refunds, read from your Stripe account, within about five minutes. Up to ${MAX_ENDPOINTS} addresses per store.`,
    },
    {
      q: "How do I add a webhook?",
      a: `In your studio, under “${w.card}”, type the address under “${w.field}”, choose the events under “${w.events}” (all are checked to start), and press “${w.add}”. Its signing secret is shown to you once. Once your store has a plan or its trial, press “${w.test}” to see what the address answers. While a plan payment is unpaid or disputed, no test is sent.`,
    },
    {
      q: "Can I try webhooks before paying?",
      a: `${tryBeforePaying("A webhook", "a webhook address and its events", onSale, trialDays)}${onSale && trialSends ? " During the trial, messages are sent within the trial's own smaller number of deliveries." : ""}${noneWithoutPlan ? " Without a plan, nothing is sent, not even a test: a store with no plan, or whose plan ended, has no webhook deliveries to use, and a test counts as one." : ""}`,
    },
    {
      q: "Do webhooks work with Zapier?",
      a: "Yes, through Zapier's own Webhooks by Zapier trigger, Catch Hook; check that your Zapier plan includes it. There is no Marktmorgen app in Zapier's directory. Paste the Catch Hook's address as an endpoint and pick its events; Zapier does not need the signing secret.",
    },
  ];
}
