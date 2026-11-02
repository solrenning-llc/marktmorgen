/**
 * The questions someone starting out asks about Outreach (534 [FQ1], unit 35,
 * added 2 November 2026), answered only by what the code does today: the
 * studio's Outreach page and its own words (components/outreach-studio.tsx),
 * written with the writing help only a paid-up Studio or Scale plan has
 * (aiAvailableFor, lib/ai.ts: not in a trial, which leaves out paid AI
 * writing), the sender's name and postal address saved first, and nothing
 * ever sent from here. The studio labels Studio "Pro". No figure. Shown first
 * in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_TITLES } from "@/lib/plan";
import { ROLE_NAMES } from "@/lib/team-roles";

/** The studio's own words. */
export const OUTREACH_WORDS = { tool: "Outreach", who: "Who is writing", name: "Your name", address: "Your postal address", save: "Save", write: "Write to a business", goal: "What you are looking for", site: "Their website", country: "The country the business is in", notHere: "not from here", find: "Find where they ask to be written", addresses: "Addresses printed on their own website", draft: "Write the email", pitches: "Your pitches", gmail: "Open it in Gmail", mailApp: "Open it in my mail app", copy: "Copy it", studioPlan: "Pro" } as const;

export function outreachBeginnerQuestions(onSale = PLANS_ON_SALE): { q: string; a: string }[] {
  const w = OUTREACH_WORDS;
  const plans = `${PLAN_TITLES.pro} or ${PLAN_TITLES.scale}`;
  return [
    {
      q: "How do I write my first pitch?",
      a: `On a paid-up ${plans} plan (your studio calls the ${PLAN_TITLES.pro} plan “${w.studioPlan}”), while the writing help is available for your store, the owner, an ${ROLE_NAMES.admin} or an ${ROLE_NAMES.editor} opens “${w.tool}” in the studio. Under “${w.who}”, fill in “${w.name}” and “${w.address}” and press “${w.save}”. Under “${w.write}”, pick one of the options under “${w.goal}”, type “${w.site}”, and pick “${w.country}” from those not marked “${w.notHere}”. Say what you would offer, and press “${w.find}”. Under “${w.addresses}”, choose one you can select and press “${w.draft}”. The draft appears under “${w.pitches}”, where you can read and change it. Then press “${w.gmail}”, “${w.mailApp}” or “${w.copy}”: you send it yourself, from your own mailbox.`,
    },
    {
      q: "Can I try it before paying?",
      a: onSale
        ? `Not in the free trial: the trial leaves out paid AI writing, and each pitch is written with it. It needs a ${plans} plan that is paid up.`
        : `Not yet. Each pitch is written with the writing help of the ${plans} plan, and paid plans are not on sale yet. To see a store working, open the live demo store from the link at the end of this page: a made-up store, marked as a demo.`,
    },
  ];
}
