/**
 * The questions someone starting out asks on a page for one kind of creator
 * (534 [FQ1], unit 40, added 2 November 2026), answered only by what the code
 * does today: the sign-in page that starts a store from an emailed link
 * (app/signin/page.tsx), the studio's "Take your address" card, and the first
 * steps the studio lists for every store (app/studio/page.tsx, startSteps),
 * up to five steps to the first sale, from "Prepare your first offer" to
 * "Share your address" (lib/studio-start-rules.ts), shown to the owner. No figure. Shown in
 * each such page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The site's and the studio's own words. */
export const AUDIENCE_WORDS = { start: "Start your store", address: "Take your address", name: "Store name", create: "Create my store", list: "Getting your store ready", first: "Prepare your first offer", last: "Share your address" } as const;

export function audienceBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = AUDIENCE_WORDS;
  return [
    {
      q: "How do I start my own store?",
      a: `Choose “${w.start}” at the end of this page and type your email; the link we email you logs you in, with no password. If your email has no store yet, your studio shows “${w.address}”: type the address and, if you like, the “${w.name}”, then choose “${w.create}”. Then “${w.list}” lists your first steps in order, from “${w.first}” to “${w.last}”, with a check mark beside each one your store has done. If logging in is not switched on yet, the sign-in page says so and sends nothing.`,
    },
    {
      q: "Can I try my store before paying?",
      a: tryBeforePaying("Your store", "your store, its page and your first products", onSale, trialDays),
    },
  ];
}
