/**
 * The questions someone starting out asks about bundles (534 [FQ1], unit 11,
 * added 2 November 2026), answered only by what the code does today: the
 * studio's Bundles page and the bundle editor's own words
 * (app/studio/bundles/page.tsx, components/bundle-editor.tsx), how many go
 * in and which (lib/bundle-rules.ts: MIN_BUNDLE_ITEMS, MAX_BUNDLE_ITEMS,
 * canBeInBundle, whyNotInBundle), the saving line (worthWords), and the
 * shared answer to "Can I try it before paying?" (lib/beginner-faq.ts). No
 * number of sales. Shown first in the bundles page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_BUNDLE_ITEMS, MIN_BUNDLE_ITEMS } from "@/lib/bundle-rules";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's and the editor's own words. */
export const BUNDLE_WORDS = { page: "Bundles", start: "New bundle", name: "Name", find: "Add your products", pick: "Add", add: "Add the bundle" } as const;

export function bundleBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = BUNDLE_WORDS;
  return [
    {
      q: "What is a bundle here?",
      a: `A bundle is ${MIN_BUNDLE_ITEMS} to ${MAX_BUNDLE_ITEMS} of your products sold as one product, at one price you set. The buyer gets each product in it as if they had bought it on its own. You can also have each buyer choose a number of them that you set, and they get only those.`,
    },
    {
      q: "How do I start one?",
      a: `In your studio, open “${w.page}” and press “${w.start}”. Fill in “${w.name}” and the price, search for your products under “${w.find}”, press “${w.pick}” beside at least ${MIN_BUNDLE_ITEMS} of them, and press “${w.add}”. What can go in: your one-off products with one set price (not pay what you want, not another bundle) that hand over a file, a link or a course with lessons, and that have no limited number for sale. Drafts can go in too.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("A bundle", "a bundle of your products", onSale, trialDays),
    },
    {
      q: "Do bundles sell more?",
      a: "We publish no number of sales, because we do not have a real, checked count to show. The line saying what the products cost on their own, like “$60 of products for $49”, appears only when they really cost more than the bundle; when buyers choose, it counts only the ones they chose.",
    },
  ];
}
