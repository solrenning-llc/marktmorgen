/**
 * The questions someone starting out asks about moving to Marktmorgen (534
 * [FQ1], unit 36, added 2 November 2026), answered only by what the code does
 * today: the studio's "Moving from another platform" page and its own words
 * (app/studio/import/page.tsx, components/import-tool.tsx), for whoever may
 * import (lib/team-roles.ts, "import"); a list, products and past buyers
 * brought in with no plan, and members only once the store can take payments
 * (lib/imports.ts, startProblem: members need canSell). No figure. Shown first
 * in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const SWITCHING_WORDS = { tool: "Moving from another platform", tabs: ["Your email list", "Your products", "Your past buyers", "Your members"], file: "Choose a CSV file", columns: "Which column is which", rows: "The first rows, as they will be read", agreed: "These people agreed to receive my emails.", stopped: "I will stop these memberships renewing where they are now, before their renewal dates.", go: "Import" } as const;

export function switchingBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = SWITCHING_WORDS;
  return [
    {
      q: "Where do I start my move to Marktmorgen?",
      a: `In your studio, open “${w.tool}” and pick what to bring in: ${w.tabs.slice(0, -1).map((t) => `“${t}”`).join(", ")} or “${w.tabs[w.tabs.length - 1]}”. Press “${w.file}”, check what each column holds under “${w.columns}”, and look over “${w.rows}”. For a list, check “${w.agreed}”; for members, check “${w.stopped}” Then press “${w.go} …”.`,
    },
    {
      q: "Can I move my store to Marktmorgen before paying?",
      a: `${tryBeforePaying("A move", "your list, products and past buyers", onSale, trialDays)} Your members come over only while your store can take payments and send email, because each one is emailed their own link and keeps their membership by paying here.`,
    },
  ];
}
