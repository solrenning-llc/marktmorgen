/**
 * The questions someone starting out asks about the writing help (534 [FQ1],
 * unit 39, added 2 November 2026), answered only by what the code does today:
 * its buttons drawn inside the studio's editors only while the writing help is
 * on (AiOn, components/ai-assist.tsx), on for a paid-up Studio or Scale plan
 * where it is switched on (aiAvailableFor, lib/ai.ts: never in a trial, which
 * leaves out paid AI writing), and nothing kept until the creator saves. The
 * studio labels Studio "Pro". No figure. Shown first in the page's own
 * "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_TITLES } from "@/lib/plan";

/** The studio's own words for where the writing help is. */
export const AI_WRITING_WORDS = { draft: "Draft it with AI", panel: "Write the description with AI", write: "Write a draft", help: "How do I…?", studioPlan: "Pro" } as const;

export function aiWritingBeginnerQuestions(onSale = PLANS_ON_SALE): { q: string; a: string }[] {
  const w = AI_WRITING_WORDS;
  const plans = `${PLAN_TITLES.pro} or ${PLAN_TITLES.scale}`;
  return [
    {
      q: "Where do I find the writing help?",
      a: `In your studio, next to what it writes. On a paid-up ${plans} plan (your studio calls the ${PLAN_TITLES.pro} plan “${w.studioPlan}”), while the writing help is available for your store, editors show buttons such as “${w.draft}”, and panels such as “${w.panel}”, where you press “${w.write}”; and “${w.help}” is a box on your studio's home page. Otherwise none of these are shown.`,
    },
    {
      q: "Can I try the writing help before paying?",
      a: onSale
        ? `Not in the free trial: the trial does not include the writing help. It needs a ${plans} plan that is paid up.`
        : `Not yet. The writing help needs a paid-up ${plans} plan, and paid plans are not on sale yet.`,
    },
  ];
}
