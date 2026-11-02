/**
 * The questions someone starting out asks about price options (534 [FQ1],
 * unit 10, added 2 November 2026), answered only by what the code does today:
 * the product editor's own words for adding prices and where it is not shown
 * (components/product-editor.tsx, OptionsBlock), the most options
 * (lib/product-option.ts, MAX_OPTIONS) and when they compare (comparable),
 * the list above six (components/store-product.tsx), what an option hands over
 * on a course, a podcast or something shipped, the checkout reading the price from
 * what was saved (app/api/store/checkout/route.ts), and the shared answer to
 * "Can I try price options before paying?" (lib/beginner-faq.ts). No number of sales.
 * Shown first in the price options page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_OPTIONS } from "@/lib/product-option";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The product editor's own words. */
export const OPTION_WORDS = { first: "Sell it at several prices", what: "What this one is", add: "Add this price", next: "Add another price" } as const;

export function optionsBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = OPTION_WORDS;
  return [
    {
      q: "What are price options here?",
      a: `Up to ${MAX_OPTIONS} prices on one product, and the buyer picks one. Write what each one includes and they stand side by side to compare; more than six become a list to pick from. Each hands over its own file or link; on a course or podcast every price opens it, and on a product you ship each is a size or a version.`,
    },
    {
      q: "How do I add price options?",
      a: `In your studio, on a product with a price, press “${w.first}”. Fill in “${w.what}” and its price, and press “${w.add}”. For the next one, press “${w.next}”. There are no price options on something free, a call, a bundle, a course or podcast sold as a membership, or a product where the buyer names the price.`,
    },
    {
      q: "Can I try price options before paying?",
      a: tryBeforePaying("Price options", "a product's price options", onSale, trialDays),
    },
    {
      q: "Do price options sell more?",
      a: "We publish no number of sales, because we do not have a real, checked count to show. What we can say is how a sale is charged: what is charged is read from the option you saved, never from the page.",
    },
  ];
}
