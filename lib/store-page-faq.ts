/**
 * The questions someone starting out asks about the store page (534 [FQ1],
 * unit 5, added 2 November 2026), answered only by what the code does today:
 * the feature page's button (components/topic-page.tsx), the sign-in form's
 * button (components/signin-form.tsx), the emailed link's confirmation
 * (app/signin/confirm/page.tsx), the store form's
 * fields and button (components/handle-form.tsx), the live demo linked at the
 * end of every feature page (components/topic-page.tsx), and the shared
 * answer to "Can I try it before paying?" (lib/beginner-faq.ts). No number of
 * stores, visits or sales. Shown first in the store page's own "Questions"
 * block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The feature page's and the sign-in form's buttons, the emailed link's confirmation, and the store form's own labels and button. */
export const START_WORDS = { start: "Start your store", email: "Email me a link", confirm: "Log me in", address: "Your address", name: "Store name", line: "One line about it", create: "Create my store" } as const;

export function storeBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  return [
    {
      q: "What is a store page here?",
      a: "Your own page at marktmorgen.com/@yourname, with an address you choose: your store's name, a line about it, your photo if you add one, your links and the products you list. It is made to be read on a phone.",
    },
    {
      q: "How do I start one?",
      a: `Press “${START_WORDS.start}”, type your email and press “${START_WORDS.email}”. Open the link we email you and press “${START_WORDS.confirm}”, then fill in “${START_WORDS.address}”, “${START_WORDS.name}” and, if you like, “${START_WORDS.line}”, and press “${START_WORDS.create}”. No password is needed.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("A store page", "your page", onSale, trialDays),
    },
    {
      q: "Do store pages work?",
      a: "We publish no number of stores, visits or sales, because we do not have a real, checked count to show. The live demo store linked at the end of this page is made up, so nothing on it is a figure about real creators.",
    },
  ];
}
