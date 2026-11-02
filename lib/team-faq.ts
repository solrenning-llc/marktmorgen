/**
 * The questions someone starting out asks about teams and stores (534 [FQ1],
 * unit 20, added 2 November 2026), answered only by what the code does
 * today: the studio's Team page and its own words (components/team-manager.tsx),
 * who may manage it (lib/team-roles.ts, "team" is the owner's alone), and the
 * shared answer to "Can I try it before paying?" (lib/beginner-faq.ts). No
 * number of teams, stores or sales. Shown first in the page's own "Questions"
 * block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { INVITE_DAYS, ROLE_NAMES } from "@/lib/team-roles";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const TEAM_WORDS = { tool: "Team", invite: "Invite someone", email: "Their email", role: "What they can do", send: "Send the invitation" } as const;

export function teamBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = TEAM_WORDS;
  return [
    {
      q: "What are teams and stores here?",
      a: `One account can run several stores, each with its own address, products, buyers and Stripe account. On each store, people you invite help as ${ROLE_NAMES.admin}, ${ROLE_NAMES.editor} or ${ROLE_NAMES.support}.`,
    },
    {
      q: "How do I invite someone?",
      a: `In your studio, open “${w.tool}”. Under “${w.invite}”, type their address under “${w.email}”, choose a role under “${w.role}”, and press “${w.send}”. We email them a link that works once, for ${INVITE_DAYS} days, with no password to make. If the studio says the email could not be sent, nothing was kept, and you can send it again later. Only the store's owner manages the team.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("A team", "a team", onSale, trialDays),
    },
    {
      q: "Do I have to share my login?",
      a: "No. Each person signs in with their own email, or a passkey of their own, and sees only what their role allows.",
    },
  ];
}
