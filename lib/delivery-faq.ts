/**
 * The questions someone starting out asks about instant delivery (534 [FQ1],
 * unit 6, added 2 November 2026), answered only by what the code does today:
 * the product editor's own buttons and labels for a file or a link
 * (components/product-editor.tsx), the largest file (lib/product-file.ts),
 * the store's "Get it again" (lib/buyer-words/en.ts), the upload policy and
 * the shared answer to "Can I try it before paying?" (lib/beginner-faq.ts).
 * No number of downloads or sales. Shown first in the delivery page's own
 * "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { maxFileLabel } from "@/lib/product-file";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";
import { en } from "@/lib/buyer-words/en";

/** The product editor's own words for what a product hands over. */
export const DELIVERY_EDITOR_WORDS = { file: "Choose the file", link: "Use a link instead", where: "Where the buyer should be sent", save: "Save the link" } as const;

export function deliveryBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  // Said where the upload is named, so nobody presses it first and is refused: from the policy, never typed.
  const filesWait = AUTOMATIC_UPLOAD_CAPS.setup.opens === 0 && AUTOMATIC_UPLOAD_CAPS.trial.opens === 0 ? "; files can be uploaded once a paid plan starts" : "";
  return [
    {
      q: "What is instant delivery here?",
      a: `Once Stripe confirms the payment, a file or link you sell is on the buyer's screen: a download tied to their order, or the link you set. A pre-order is handed over the day the product goes on sale. If they lose it later, “${en.getAgain}” on your store emails the address they paid with a link to what it bought here.`,
    },
    {
      q: "How do I start one?",
      a: `In your studio, where a product, or one of its price options, says “Nothing on this yet”, press “${DELIVERY_EDITOR_WORDS.link}”, type “${DELIVERY_EDITOR_WORDS.where}” and press “${DELIVERY_EDITOR_WORDS.save}”. Or press “${DELIVERY_EDITOR_WORDS.file}” for a file of up to ${maxFileLabel()}${filesWait}.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("A product that hands over a link", "a product that hands over a link", onSale, trialDays),
    },
    {
      q: "Does instant delivery work?",
      a: "We publish no number of downloads or sales, because we do not have a real, checked count to show. What we can say is what the download refuses: a paid file is never handed over before Stripe says its order is paid, and a sale you refunded in full stops downloading.",
    },
  ];
}
