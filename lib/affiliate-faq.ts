/**
 * The questions someone starting out asks about affiliates (534 [FQ1], unit
 * 18, added 2 November 2026), answered only by what the code does today: the
 * studio's Affiliates page and its own words (app/studio/affiliates/page.tsx,
 * components/affiliate-studio.tsx), including what it says while the store
 * cannot sell (lib/store-checkout.ts canSell), and the shared answer to "Can
 * I try it before paying?" (lib/beginner-faq.ts). No number of affiliates,
 * clicks or sales. Shown first in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const AFFILIATE_WORDS = { tool: "Affiliates", program: "Your program", take: "Take affiliates", share: "Share of each sale", window: "A click counts for", save: "Save", recurring: "Memberships and payment plans" } as const;

export function affiliateBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = AFFILIATE_WORDS;
  return [
    {
      q: "What is an affiliate program here?",
      a: `People share their own link to your store, and a one-time purchase made through it within your window earns them the share you set, worked out from what the buyer paid before tax and taken back if you refund the sale. Memberships and payment plans earn only if you choose so under “${w.recurring}”. You choose who is in, or let buyers take a link without applying, and you pay them yourself.`,
    },
    {
      q: "How do I start one?",
      a: `In your studio, open “${w.tool}”. Under “${w.program}”, check “${w.take}”, check or change “${w.share}” and “${w.window}”, and press “${w.save}”. The store's owner and Admins see this page. ${onSale ? "Links start earning once your Stripe account is connected and your plan is running." : "Links start earning once your store can sell: your Stripe account connected and a paid plan running. Paid plans are not on sale yet."}`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("An affiliate program", "your affiliate program", onSale, trialDays),
    },
    {
      q: "How many people use affiliates here?",
      a: "We publish no count of how many people use affiliates on Marktmorgen, because we do not have a real, checked count to show. A creator can choose to show their own program's numbers in the affiliate directory, and your studio's Affiliates page lists who applied, who is in and what each is owed.",
    },
  ];
}
