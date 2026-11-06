/**
 * The questions someone starting out asks about selling on their own Stripe
 * account (534 [FQ1], unit 8, added 2 November 2026), answered only by what
 * the code does today: the studio's "Where the money goes" card and its own
 * words, shown to the owner only, with what it says when connecting is not
 * switched on (app/studio/page.tsx); the connect route, which needs that role
 * and no plan (app/api/stripe/connect/route.ts); the account it opens, with a
 * full Stripe dashboard (lib/stripe-connect.ts); canSell, which needs Stripe to
 * say the account can take payments (lib/store-checkout.ts); and the shared answer to "Can I try … before
 * paying?" (lib/beginner-faq.ts). No number of accounts, sales or payouts.
 * Shown first in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio card's own words. */
export const STRIPE_CARD_WORDS = { title: "Where the money goes", country: "Which country is your bank account in?", connect: "Connect your Stripe account" } as const;

export function stripeBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = STRIPE_CARD_WORDS;
  return [
    {
      q: "What does “your own Stripe” mean here?",
      a: "When your store sells, the charge is made on a Stripe account in your own name, with your own login at stripe.com. The money goes there and Stripe pays it out to your bank; your sales never sit with us.",
    },
    {
      q: "How do I connect my Stripe account?",
      a: `In your studio, under “${w.title}”, choose “${w.country}” and press “${w.connect}”. Only the store's owner sees this. Pick the country your bank account is really in: Stripe fixes it when the account is opened. Stripe then asks for the details it needs to pay you. If the owner sees no button there, connecting is not switched on yet on our side, and the studio says so.`,
    },
    {
      q: "Can I connect my own Stripe before paying?",
      a: `Yes, once connecting is switched on on our side: connecting your Stripe account needs no plan. ${tryBeforePaying("Your store", "your products", onSale, trialDays).replace(/^Yes\. /, "")}`,
    },
    {
      q: "Does selling on my own Stripe work?",
      a: "We publish no number of accounts, sales or payouts, because we do not have a real, checked count to show. Your store takes no payment until Stripe says the account can take one, and every charge and payout of yours is in your own Stripe dashboard, as Stripe records it.",
    },
  ];
}
