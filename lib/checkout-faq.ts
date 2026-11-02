/**
 * The questions someone starting out asks about the checkout tools (534
 * [FQ1], unit 7, added 2 November 2026), answered only by what the code does
 * today: the discount editor's own words, and that it alone waits until the
 * store can sell (components/discount-editor.tsx, shown with lib/store-checkout.ts
 * canSell, which a trial passes), while pay what you want, the checkout extras
 * (a payment plan, a product added at checkout, a limited quantity) and
 * questions at checkout are set on a product with no such wait; and the shared
 * answer to "Can I try it before paying?" (lib/beginner-faq.ts). No number of
 * sales or earnings. Shown first in the checkout page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The discount editor's own words. */
export const DISCOUNT_WORDS = { title: "Discount codes", open: "Make a code", code: "The code", off: "What it takes off", percent: "A percentage", amount: "An amount", make: "Make the code" } as const;
/** What a creator sets on a product before the store can sell. */
const ON_A_PRODUCT = "pay what you want, a payment plan, a product added at checkout, questions at checkout and a limited quantity";

export function checkoutBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const d = DISCOUNT_WORDS;
  return [
    {
      q: "What are the checkout tools here?",
      a: "Tools for the moment a buyer pays. The main ones: discount codes, a product added at checkout, one-click offers after paying, payment plans, pay what you want, questions at checkout, limited quantities and sales tax. Discount codes are kept on your own Stripe account.",
    },
    {
      q: "How do I start one?",
      a: `Start with a discount code. In your studio, under “${d.title}”, press “${d.open}”. Type “${d.code}”, choose under “${d.off}” “${d.percent}” or “${d.amount}”, type how much, and press “${d.make}”. It opens once your Stripe account is connected and your plan is running, the trial included.${onSale ? "" : " Paid plans are not on sale yet, so it opens for no one today."}`,
    },
    {
      q: "Can I try it before paying?",
      a: `${tryBeforePaying(`${ON_A_PRODUCT[0].toUpperCase()}${ON_A_PRODUCT.slice(1)}`, `${ON_A_PRODUCT} on a product`, onSale, trialDays)} Discount codes open once your Stripe account is connected and your plan is running.`,
    },
    {
      q: "Do the checkout tools bring more sales?",
      a: "We publish no number of sales or extra earnings, because we do not have a real, checked count to show. Beside each code, your studio shows how many times it was used, as Stripe counts it on your own account.",
    },
  ];
}
