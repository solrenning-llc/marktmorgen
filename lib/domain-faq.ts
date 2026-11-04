/**
 * The questions someone starting out asks about a store on its own domain
 * (534 [FQ1], unit 22, added 2 November 2026), answered only by what the
 * code does today: the studio's "Your own domain" card and its own words
 * (app/studio/page.tsx, components/domain-editor.tsx), shown only where
 * domains are switched on (isDomainsConfigured, lib/domains.ts) and to whoever
 * may change the store's settings (lib/team-roles.ts), and usable only on an
 * active Studio or Scale plan, its trial included (canUseDomain, hasPro). The
 * studio still labels Studio "Pro", so the answers give both names. No figure but the
 * code's own.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_TITLES, TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { ROLE_NAMES } from "@/lib/team-roles";

/** The studio's own words. */
export const DOMAIN_WORDS = { card: "Your own domain", field: "Your domain", add: "Add the domain", studioPlan: "Pro" } as const;

export function domainBeginnerQuestions(on: boolean, onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = DOMAIN_WORDS;
  const plans = `${PLAN_TITLES.pro} or ${PLAN_TITLES.scale}`;
  const demo = "To see a store working, open the live demo store from the link at the end of this page: a made-up store, marked as a demo.";
  return [
    {
      q: "What is a domain, and do I need one?",
      a: "A domain is a web address you buy from a company that sells them, like yourname.com. You do not need one: your store already has its own address on marktmorgen.com, the one you picked for it.",
    },
    {
      q: "How do I add my domain?",
      a: on
        ? `Your own domain is part of the ${PLAN_TITLES.pro} and ${PLAN_TITLES.scale} plans; inside your studio, where you run your store, ${PLAN_TITLES.pro} is labeled “${w.studioPlan}”. On one of them, the owner or an ${ROLE_NAMES.admin} types it under “${w.field}” in the “${w.card}” card and presses “${w.add}”, then adds the records the card shows in the domain's DNS settings, where it was bought. The domain is held for your store for three days while you do this.`
        : "Not for now: there is nowhere to add one until domains are switched on here.",
    },
    {
      q: "Can I put my store on my own domain before paying?",
      a: !on
        ? `Not yet: there is nothing to try until domains are switched on here. ${demo}`
        : onSale
          ? `${tryBeforePaying(`Your own domain, on ${plans},`, "", true, trialDays)} On a trial of the ${PLAN_TITLES.creator} plan, the domain card only offers the upgrade.`
          : `Not yet. Your own domain needs the ${plans} plan, and paid plans are not on sale yet. ${demo}`,
    },
  ];
}
