/**
 * The answer every feature page gives to "Can I try it before paying?"
 * (534 [FQ1]), in one place so the same question never gets two answers.
 * It follows PLANS_ON_SALE (lib/opening.ts), the trial's length (lib/plan.ts)
 * and what a store not paying for a plan may upload (lib/upload-budget-policy.ts);
 * `setUp` is what the page's feature lets a store set up with no plan, in
 * its own words. The live demo it points to is linked at the end of every
 * feature page (components/topic-page.tsx).
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";

/** What a store not paying for a plan cannot upload yet, read from the upload policy. */
export function uploadsWait(scope: "setup" | "trial"): string {
  return AUTOMATIC_UPLOAD_CAPS[scope].opens === 0 ? "Files and lesson videos can be uploaded once a paid plan starts." : "";
}

export function tryBeforePaying(thing: string, setUp: string, onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): string {
  return onSale
    ? `Yes. An eligible first store can start a ${trialDays}-day trial when it picks a plan: your card is taken when the trial starts and first charged when it ends, and canceling inside it means it is never charged. ${thing} can be set up during the trial, and the trial leaves out paid AI writing. ${uploadsWait("trial")}`.trim()
    : `Yes. Paid plans are not on sale yet, so there is nothing to pay for now, and you can set up ${setUp} in your own store's studio with no card. ${uploadsWait("setup")} To see a store working, open the live demo store from the link at the end of this page: a made-up store, marked as a demo.`.replace(/ {2,}/g, " ");
}
