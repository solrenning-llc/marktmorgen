/**
 * The questions someone starting out asks about reviews (534 [FQ1], unit 24,
 * added 2 November 2026), answered only by what the code does today: the
 * studio's Reviews page and its own words (app/studio/reviews/page.tsx,
 * components/review-studio.tsx), a review only for an order the store's own
 * Stripe account says was paid (lib/reviews.ts), and a store taking payments
 * only once it has a plan or is inside its trial (canSell,
 * lib/store-checkout.ts), which waits on PLANS_ON_SALE; the live demo store
 * takes none (takesReviews, lib/house-store.ts). No figure, no number
 * of reviews or sales promised. Shown first in the page's own "Questions"
 * block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_TITLES } from "@/lib/plan";

/** The studio's own words. */
export const REVIEWS_WORDS = { tool: "Reviews", all: "Every review", reply: "Reply", edit: "Edit your reply", post: "Post the reply", ask: "Asking for reviews", askBox: "Email buyers once to ask for a review", save: "Save" } as const;

export function reviewsBeginnerQuestions(onSale = PLANS_ON_SALE): { q: string; a: string }[] {
  const w = REVIEWS_WORDS;
  return [
    {
      q: "How do I get my first reviews?",
      a: `Only a buyer can write one: a review needs a paid order, so none can arrive before your first sale, and a sale does not bring one by itself. Nothing has to be switched on for a buyer to write one. To also email each buyer to ask, open “${w.ask}” on the studio's ${w.tool} page, check “${w.askBox}”, pick the days and press “${w.save}”; it needs your email set up on ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale}.`,
    },
    {
      q: "Where do I see and answer reviews?",
      a: `In your studio, open “${w.tool}”; “${w.all}” lists them all. Under a review, press “${w.reply}” (or “${w.edit}”), write your answer and press “${w.post}”: it goes under the review wherever the review shows.`,
    },
    {
      q: "Can I get reviews before I pay for a plan?",
      a: onSale
        ? "Yes, once your store can take payments, its trial included: your Stripe account connected and your plan or its trial running. A buyer who pays then can review what they bought."
        : `Not yet: your studio's “${w.tool}” page is there with no card, but a review needs a paid order, and while paid plans are not on sale, a new store cannot take payments. The live demo store takes no reviews, because its purchases cost nothing.`,
    },
  ];
}
