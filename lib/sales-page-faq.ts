/**
 * The questions someone starting out asks about sales pages (534 [FQ1], unit
 * 9, added 2 November 2026), answered only by what the code does today: the
 * studio's Sales pages list (app/studio/pages/page.tsx), the editor's own
 * words for starting and saving a page (components/page-editor.tsx), the
 * most blocks (lib/sales-page.ts, MAX_BLOCKS), the page coach and what it
 * counts (components/page-coach.tsx), and the shared answer to "Can I try …
 * before paying?" (lib/beginner-faq.ts). No number of pages, visits or sales.
 * Shown first in the sales pages page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_BLOCKS } from "@/lib/sales-page";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's and the editor's own words. */
export const SALES_PAGE_WORDS = { list: "Sales pages", start: "Start the page", fromDescription: "Start from the description", template: "Or start from a template", useTemplate: "Use this template", save: "Save the page" } as const;

export function salesPageBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = SALES_PAGE_WORDS;
  return [
    {
      q: "What is a sales page here?",
      a: `A product's own page, built from up to ${MAX_BLOCKS} blocks you stack in your store's look: a headline, what the buyer gets, questions, buttons and more. Once your Stripe account is connected and your plan is running, the trial included, its buttons lead to the checkout; for something free, the page can ask for an email once your plan is running.${onSale ? "" : " Paid plans are not on sale yet, so today no page takes a payment or an email."}`,
    },
    {
      q: "How do I start a sales page?",
      a: `In your studio, open “${w.list}” (add a product first if you have none) and pick the product. On a product with no page yet, under “${w.start}”, press “${w.fromDescription}”, pick one under “${w.template}” and press “${w.useTemplate}”, or add blocks one by one. Then press “${w.save}”.`,
    },
    {
      q: "Can I try sales pages before paying?",
      a: tryBeforePaying("A sales page", "a product's sales page", onSale, trialDays),
    },
    {
      q: "Do sales pages work?",
      a: "We publish no number of pages, visits or sales, because we do not have a real, checked count to show. Once a page has blocks, its coach in the editor scores it out of 100 and, once the page has been opened and your numbers can be read, shows how often it was opened in the last 30 days and how many checkouts of the product were started, or sign-ups for something free.",
    },
  ];
}
