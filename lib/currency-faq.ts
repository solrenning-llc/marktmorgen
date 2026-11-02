/**
 * The questions someone starting out asks about currencies and ways to pay
 * (534 [FQ1], unit 25, added 2 November 2026), answered only by what the code
 * does today: every store starting in DEFAULT_CURRENCY (lib/money.ts,
 * lib/store.ts), the studio's currency field and its own words
 * (components/payments-panel.tsx), shown to whoever may change settings
 * (lib/team-roles.ts), and every buyer checkout asking Stripe not to convert
 * (inTheCurrencyShown, lib/instant-pay.ts); a payment request keeps the
 * currency it was sent in (lib/payment-requests.ts). No
 * figure but the code's own. Shown first in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { DEFAULT_CURRENCY, currencyLabel } from "@/lib/money";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const CURRENCY_WORDS = { field: "Your store's currency", save: "Save", off: "not on your Stripe account", more: "Turn more on in Stripe" } as const;

export function currencyBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = CURRENCY_WORDS;
  return [
    {
      q: "How do I choose my store's currency?",
      a: `A new store starts with “${currencyLabel(DEFAULT_CURRENCY)}” chosen. In your studio, pick another under “${w.field}” and press “${w.save}”; if your products have prices, you are asked to confirm first. When Stripe tells us which currencies your connected account can charge in, every currency on the list it cannot charge in, other than the one your store uses now, is marked “${w.off}”.`,
    },
    {
      q: "Can my buyers pay in their own currency?",
      a: "No. Our checkout asks Stripe not to convert your prices into the buyer's currency, so buyers pay in your store's currency. A payment request sent before you changed the currency is still paid in the one it was sent in.",
    },
    {
      q: "How do I add Apple Pay or Klarna?",
      a: `Where Stripe offers them for your country, you switch them on in your own Stripe account, not here. After you connect it, the “${w.more}” button in your studio takes you there.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("Your currency", "your store's currency", onSale, trialDays),
    },
  ];
}
