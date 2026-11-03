/**
 * The questions someone starting out asks about PDF stamping (534 [FQ1],
 * unit 14, added 2 November 2026), answered only by what the code does today:
 * the product's stamping box, which shows only once the product has a PDF
 * (components/pdf-stamp-toggle.tsx), the largest PDF stamped
 * (lib/product-file.ts, MAX_STAMP_BYTES), the upload policy
 * (lib/upload-budget-policy.ts), the stamp line itself (lib/pdf-stamp-line.ts),
 * and the shared answer to "Can I try PDF stamping before paying?" (lib/beginner-faq.ts),
 * said of a product rather than of stamping, since stamping needs an uploaded
 * PDF. No number of copies or sales. Shown first in the page's own "Questions"
 * block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_STAMP_BYTES, readableSize } from "@/lib/product-file";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The stamping box's own words. */
export const STAMP_WORDS = { box: "Mark each buyer's PDF or EPUB with their email" } as const;

export function stampBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const waits = AUTOMATIC_UPLOAD_CAPS.setup.opens === 0 && AUTOMATIC_UPLOAD_CAPS.trial.opens === 0;
  return [
    {
      q: "What is PDF stamping here?",
      a: "When it is on, each page of the PDF a buyer downloads after paying carries one small line along the bottom with their email, the date of the order and the order, for personal use, so a copy that turns up somewhere else says whose it was. An EPUB on the same product gets the same line written inside the book, where reading apps do not show it but every copy carries it.",
    },
    {
      q: "How do I switch on PDF stamping?",
      a: `In your studio, on a product that hands over a PDF, itself or in a price option, check “${STAMP_WORDS.box}”. The box shows once the product has a PDF${waits ? ", and a PDF can be uploaded once a paid plan starts" : ""}. PDFs up to ${readableSize(MAX_STAMP_BYTES)} are stamped; a bigger one, or one locked with a password or damaged, is handed over as you uploaded it, and your studio tells you. A free download is handed over as you uploaded it.`,
    },
    {
      q: "Can I try PDF stamping before paying?",
      a: waits
        ? `Not before a plan is paid: stamping works only on a PDF uploaded to the product, and a PDF can be uploaded once a paid plan starts.${onSale ? "" : " Paid plans are not on sale yet."}`
        : `${tryBeforePaying("A product", "a product", onSale, trialDays)} Stamping itself works only on a PDF uploaded to the product.`,
    },
    {
      q: "Does stamping stop people sharing?",
      a: "No. It discourages sharing: a copy that turns up somewhere else says whose it was. It does not stop anyone from sharing the file, and someone determined can remove the line.",
    },
  ];
}
