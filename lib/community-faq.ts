/**
 * The questions someone starting out asks about the community (534 [FQ1],
 * unit 27, added 2 November 2026), answered only by what the code does today:
 * the studio's Community page and its own words
 * (components/community-studio.tsx), set up by whoever may change settings
 * and moderated by whoever may moderate the community
 * (app/api/store/community/manage/route.ts, lib/team-roles.ts), and buyers
 * let in by a product they hold, a sale needing the store's plan or its trial
 * (canSell). No figure. Shown first in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { ROLE_NAMES } from "@/lib/team-roles";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const COMMUNITY_WORDS = { tool: "Community", start: "Set it up", who: "Who gets in", saveWho: "Save who gets in", on: "Switch it on", address: "Its address" } as const;

export function communityBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = COMMUNITY_WORDS;
  return [
    {
      q: "How do I start my community?",
      a: `In your studio, the owner or an ${ROLE_NAMES.admin} opens “${w.tool}” and presses “${w.start}”: it starts switched off, so only the store's owner can open it. Further down, under “${w.who}”, check the products that open it and press “${w.saveWho}”; with no product yet, it asks you to add one first. Then, back at the top, press “${w.on}”.`,
    },
    {
      q: "How do my buyers find it?",
      a: `Once it is switched on, your store page shows the way in while the page is open to visitors. It also has an address of its own, under “${w.address}” in your studio, to send to your buyers.`,
    },
    {
      q: "Can I try it before paying?",
      a: `${tryBeforePaying("The community", "your community", onSale, trialDays)} Buyers come in by holding a product that opens it, and a sale or a free copy needs your store's plan${onSale ? " or its trial" : ""}.`,
    },
  ];
}
