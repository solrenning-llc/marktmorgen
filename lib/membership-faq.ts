/**
 * The questions someone starting out asks about memberships (534 [FQ1],
 * unit 3, added 2 November 2026), answered only by what the code does today:
 * the product editor's own field (components/product-editor.tsx, "How often
 * it charges"), the intervals (lib/product-recurring.ts), the Membership
 * numbers page (app/studio/memberships/page.tsx), and the shared answer to
 * "Can I try it before paying?" (lib/beginner-faq.ts). No number of members
 * or sales, no time promise. Shown first in the memberships page's own
 * "Questions" block (components/topic-page.tsx).
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The product editor's own words for how a product charges. */
export const MEMBERSHIP_EDITOR_WORDS = { field: "How often it charges", once: "Once — a single sale", add: "Add it", save: "Save" } as const;
/** The Membership numbers page's own headings (app/studio/memberships/page.tsx). */
export const MEMBERSHIP_NUMBERS = { page: "Membership numbers", tiles: ["Monthly recurring revenue", "Paying members", "Churn, last 30 days", "Trials that became paying"] } as const;

export function membershipBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const [mrr, paying, churn, trials] = MEMBERSHIP_NUMBERS.tiles;
  return [
    {
      q: "What is a membership here?",
      a: "A product that charges again every day, week, month or year on your own Stripe account, and stays open while the membership runs. It can deliver a file, a link, a course or a private podcast, and can open your community. The member cancels on their own from “Manage or cancel” under the membership, ending on Stripe's own page, without writing to you.",
    },
    {
      q: "How do I start one?",
      a: `In your studio, on a paid product, choose how often it charges under “${MEMBERSHIP_EDITOR_WORDS.field}” instead of “${MEMBERSHIP_EDITOR_WORDS.once}”, then press “${MEMBERSHIP_EDITOR_WORDS.add}”, or “${MEMBERSHIP_EDITOR_WORDS.save}” on a product you already have. Calls, bundles and products you ship are sold once.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("A membership", "a product as a membership", onSale, trialDays),
    },
    {
      q: "Do memberships work?",
      a: `We publish no number of members or sales, because we do not have a real, checked count to show. Once your Stripe account is connected and can be read, your own ${MEMBERSHIP_NUMBERS.page} page shows yours: “${mrr}”, “${paying}”, “${churn}” and “${trials}”.`,
    },
  ];
}
