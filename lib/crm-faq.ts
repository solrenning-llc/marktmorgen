/**
 * The questions someone starting out asks about people, deals and pipelines
 * (534 [FQ1], unit 38, added 2 November 2026), answered only by what the code
 * does today: the studio's "Deals and fields" page and its own words
 * (components/deals-board.tsx), for whoever may read orders
 * (lib/team-roles.ts, "orders"; app/api/store/crm), and one pipeline without
 * a paid plan (pipelineLimit, lib/crm-rules.ts). No figure. The page's own
 * "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { ROLE_NAMES } from "@/lib/team-roles";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const CRM_WORDS = { tool: "Deals and fields", newDeal: "New deal", what: "What it is", saveDeal: "Save deal", unloaded: "Your deals could not be loaded", reload: "Reload deals", fields: "Your fields", firstField: "Add your first field", addField: "Add a field", kind: "Kind", saveFields: "Save fields", buyers: "Buyers" } as const;

export function crmBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = CRM_WORDS;
  return [
    {
      q: "How do I record my first deal?",
      a: `In your studio, the owner, or a teammate with the ${ROLE_NAMES.admin} or ${ROLE_NAMES.support} role, opens “${w.tool}” and presses “${w.newDeal}”. Fill in “${w.what}” (the only box you must fill), add anything else you know, and press “${w.saveDeal}”. Later, choose its new stage in the box on its card. If the page says “${w.unloaded}”, press “${w.reload}”; nothing saved was changed.`,
    },
    {
      q: "How do I keep a detail about each person?",
      a: `On the same page, under “${w.fields}”, press “${w.firstField}”, then “${w.addField}”. Type its name, pick its “${w.kind}”, and press “${w.saveFields}”. To fill one in for someone, open “${w.buyers}”, find them by their email, and save it under “${w.fields}” on their page.`,
    },
    {
      q: "Can I try it before paying?",
      a: `${tryBeforePaying("People and deals", "your fields, deals and a pipeline", onSale, trialDays)} Without a plan, you cannot add a pipeline to the one every store starts with; a plan${onSale ? " or its trial" : ""} has room for more.`,
    },
  ];
}
