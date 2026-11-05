/**
 * The questions someone starting out asks about license keys (534 [FQ1],
 * unit 12, added 2 November 2026), answered only by what the code does
 * today: the key editor's own words (components/licence-key-editor.tsx),
 * which products take keys (lib/key-setup.ts, canHaveKeys), where a buyer
 * sees the key (app/[handle]/thanks, app/[handle]/orders), the list of keys
 * given in the studio, and the shared answer to "Can I try … before
 * paying?" (lib/beginner-faq.ts). No number of keys or sales. Shown first in
 * the license keys page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The key editor's own words. */
export const KEY_WORDS = { start: "Give each buyer a unique license key", source: "Where each buyer's license key comes from", made: "Made here, one per sale", list: "From a list you upload", save: "Start giving keys", upload: "Upload a file of keys", paste: "Paste keys", given: "Keys given" } as const;

export function keyBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = KEY_WORDS;
  return [
    {
      q: "What is a license key here?",
      a: "A code each buyer gets that nobody else has, for software, plugins and anything that unlocks with one. The buyer sees it on the thank-you page, in their confirmation email and in their list of purchases, and your software can check it.",
    },
    {
      q: "How do I turn on license keys?",
      a: `In your studio, on a paid product sold once that you do not ship, press “${w.start}”. Under “${w.source}”, choose “${w.made}” or “${w.list}”, and press “${w.save}”. For a list, then press “${w.upload}” or “${w.paste}”; until there are some, the product shows as sold out. Memberships, calls, courses, shipped products and bundles do not take keys of their own; a bundle hands out the keys of the products in it.`,
    },
    {
      q: "Can I try license keys before paying?",
      a: tryBeforePaying("License keys", "license keys on a product", onSale, trialDays),
    },
    {
      q: "Do license keys work?",
      a: `${onSale ? "" : "Paid plans are not on sale yet, so no key has gone to a buyer yet. "}We publish no number of keys or sales, because we do not have a real, checked count to show. Your studio counts each product's keys given and revoked, and under “${w.given}” you can find one by key, email or order reference.`,
    },
  ];
}
