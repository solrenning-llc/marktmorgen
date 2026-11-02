/**
 * The questions someone starting out asks about moving from ClickFunnels
 * (534 [FQ1], unit 37, added 2 November 2026), answered only by what the code
 * does today: the "Move from ClickFunnels" part of the studio's moving page
 * and its own words (app/studio/import/page.tsx, components/import-tool.tsx,
 * components/clickfunnels-funnel.tsx), a dry run that saves nothing before
 * each import, nothing asking for a plan to start (lib/imports.ts,
 * startProblem; app/api/store/import/funnel), and the one email to past
 * buyers only for a store whose plan or trial runs. No figure. Shown first in
 * the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const CLICKFUNNELS_WORDS = { tool: "Moving from another platform", part: "Move from ClickFunnels", first: "1. Products", last: "4. Funnel pages", file: "Choose a CSV file", columns: "Which column is which", check: "Check the file first (nothing is saved)", go: "Import", pages: "Choose your saved pages", role: "What this page was", checkFunnel: "Check the funnel first (nothing is saved)", goFunnel: "Import the funnel" } as const;

export function clickFunnelsBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = CLICKFUNNELS_WORDS;
  return [
    {
      q: "Where do I start?",
      a: `In your studio, open “${w.tool}” and press “${w.part}”, then open its steps, from “${w.first}” to “${w.last}”. For each file, press “${w.file}”, see that “${w.columns}” is right, and check the boxes you want (for contacts, that the ones marked Subscribed agreed; for past buyers, the email) before you press “${w.check}”. Once the check has gone through every row, the “${w.go}” button with your number of rows appears; changing a column or a box after that means checking again. Each check counts in your dry runs, and each import has to finish, or be canceled, before the next one starts. For the funnel, press “${w.pages}”, set “${w.role}” for each one and, where it asks, the product, then press “${w.checkFunnel}”; “${w.goFunnel}” appears once the check lists nothing to fix.`,
    },
    {
      q: "Can I try it before paying?",
      a: `${tryBeforePaying("A move from ClickFunnels", "your products, contacts, past buyers and funnel pages", onSale, trialDays)} You can choose the one email to past buyers only while your store's plan${onSale ? " (or its trial)" : ""} is active and paid up and our email sending is switched on; without it, your past buyers still come in, just not emailed.`,
    },
  ];
}
