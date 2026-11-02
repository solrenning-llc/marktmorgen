/**
 * The questions someone starting out asks about their numbers (534 [FQ1],
 * unit 23, added 2 November 2026), answered only by what the code does today:
 * the studio's "Your numbers" card and its own words
 * (components/stats-panel.tsx), shown to whoever may read the numbers
 * (lib/team-roles.ts, "stats"), visits not counted for the store's own people
 * (lib/visit.ts), and sales read from the store's own Stripe account only
 * once it or PayPal is connected (lib/stats.ts, readsSales). No plan is asked
 * to see them, but a store without one has fewer visits a month before its
 * pages rest (lib/traffic.ts). No figure, no result promised. Shown first in the page's own
 * "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { ROLE_NAMES } from "@/lib/team-roles";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const NUMBERS_WORDS = { jump: "Numbers", card: "Your numbers", ranges: ["7 days", "30 days", "90 days", "All time", "Any dates"], sales: "Sales", noStripe: "Once Stripe is connected", empty: "Nothing counted yet.", device: "Don't count this device" } as const;

export function insightsBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = NUMBERS_WORDS;
  return [
    {
      q: "Where do I see my numbers?",
      a: `In your studio, on the “${w.card}” card; “${w.jump}” at the top jumps to it. Choose ${w.ranges.slice(0, -1).map((r) => `“${r}”`).join(", ")} or “${w.ranges[w.ranges.length - 1]}” at its top. The owner, an ${ROLE_NAMES.admin} or an ${ROLE_NAMES.editor} sees them; ${ROLE_NAMES.support} does not. While visits cannot be read, the card and that link are not shown.`,
    },
    {
      q: "Why are my numbers empty?",
      a: `Until a first visit or checkout is counted, the card says “${w.empty}” On your store's address here, you and your team are left out of the count while signed in, and so is a device set to “${w.device}”; on a domain of your own, you are counted. Until your Stripe account or PayPal is connected, the “${w.sales}” tile says “${w.noStripe}”.`,
    },
    {
      q: "Can I try it before paying?",
      a: `${tryBeforePaying("Your numbers", "your store and see its numbers", onSale, trialDays)} Visits are one of those limits: once they are used, your store's pages rest and no more visits are counted until they open again.`,
    },
  ];
}
