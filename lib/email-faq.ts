/**
 * The questions someone starting out asks about email to their list (534
 * [FQ1], unit 30, added 2 November 2026), answered only by what the code does
 * today: the studio's Email page and its own words (app/studio/email/page.tsx,
 * components/email-studio.tsx), email only on an active Studio or Scale plan,
 * its trial included (canWrite and monthlyAllowance, lib/mail.ts), the sender
 * name and postal address saved first, sent by whoever may send
 * (lib/team-roles.ts, "send"), and a check before anything goes out to the
 * list. Stopped on a Studio plan whose renewal is unpaid or whose payment is
 * disputed (canUse), so the answer says "paid up". The
 * studio still labels Studio "Pro". No figure but the code's own. Shown first
 * in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_TITLES, TRIAL_DAYS } from "@/lib/plan";
import { ROLE_NAMES } from "@/lib/team-roles";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const EMAIL_WORDS = { studioPlan: "Pro", tool: "Email", from: "Your emails are from", postal: "Postal address at the bottom of each email", save: "Save", compose: "New email", to: "Send to", send: "Send", draft: "Save as a draft", check: "Check before it goes out", yes: "Yes, send it to", when: "When", later: "At a time I choose", schedule: "Schedule", yesLater: "Yes, schedule it for" } as const;

export function emailBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = EMAIL_WORDS;
  const plans = `${PLAN_TITLES.pro} or ${PLAN_TITLES.scale}`;
  return [
    {
      q: "How do I send my first email?",
      a: `Email is part of the ${PLAN_TITLES.pro} and ${PLAN_TITLES.scale} plans; in your studio, the ${PLAN_TITLES.pro} plan is labeled “${w.studioPlan}”. While one of them is paid up, open “${w.tool}” in your studio. First, the owner or an ${ROLE_NAMES.admin} checks “${w.from}” (your store's name to start with), fills in “${w.postal}” and presses “${w.save}”. Then write it under “${w.compose}” and pick who gets it under “${w.to}”. The owner or an ${ROLE_NAMES.admin} presses “${w.send}”, which stays off while that group counts no one; an ${ROLE_NAMES.editor} presses “${w.draft}” for them. The studio then shows “${w.check}”, and nothing goes to your list until you press “${w.yes} …”. To send it later, choose “${w.later}” under “${w.when}”: the buttons say “${w.schedule}” and “${w.yesLater} …”.`,
    },
    {
      q: "Can I try it before paying?",
      a: onSale
        ? `${tryBeforePaying(`Email to your list, on ${plans},`, "", true, trialDays)} On a trial of the ${PLAN_TITLES.creator} plan, email is not included.`
        : `Not yet. Email to your list needs the ${plans} plan, and paid plans are not on sale yet. To see a store working, open the live demo store from the link at the end of this page: a made-up store, marked as a demo.`,
    },
  ];
}
