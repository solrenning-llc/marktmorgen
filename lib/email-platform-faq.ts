/**
 * The questions someone starting out asks about connecting an email platform
 * (534 [FQ1], unit 26, added 2 November 2026), answered only by what the
 * code does today: the studio's Email platforms page and its own words
 * (components/email-sync-editor.tsx), shown to whoever may change settings
 * (lib/team-roles.ts), connectable only where keys can be sealed and kept
 * (syncView, lib/email-sync.ts), and people sent only once they sign up or
 * pay, both of which need the store's plan or its trial (isPaidUp, in
 * lib/free.ts, lib/store-join.ts and canSell); until a plan is paid, its
 * calls to the platform are limited (withinService, "integration"). No figure. Shown first in the page's own
 * "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { ROLE_NAMES } from "@/lib/team-roles";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const EMAIL_PLATFORM_WORDS = { tool: "Email platforms", platform: "Platform", connect: "Connect", target: "Add people to this", who: "Who is sent", save: "Save", test: "Test connection", log: "Last sends" } as const;

export function emailPlatformBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = EMAIL_PLATFORM_WORDS;
  return [
    {
      q: "How do I connect my email tool?",
      a: `The owner or an ${ROLE_NAMES.admin} does it. In your studio, open “${w.tool}”, pick one under “${w.platform}”, paste its API key and press “${w.connect}”; under the key's box, the studio says where that platform keeps it. We can connect only when all destinations fit on one page. If the account needs more pages, use an account with fewer destinations; an existing connection stays unchanged. Once it is connected, choose under “${w.target} …” and “${w.who}”, then press “${w.save}”. If the page says keys cannot be stored safely yet, no platform can be connected for now.`,
    },
    {
      q: "How do I know it works?",
      a: `Once connected, press “${w.test}”: it checks your key and the place you picked with the platform, and tells you whether both work or that it could not check just now. Under “${w.log}”, each person handed to the platform shows as sent, still sending or failed, and anyone who did not agree to emails shows as not sent.`,
    },
    {
      q: "Can I connect my email tool before paying?",
      a: `${tryBeforePaying("The connection", "the connection", onSale, trialDays)} Calls to your platform are one of those limits: once they are used, the studio says so and when they open again. Nobody is sent until someone signs up for something free or buys, and your store can take a sign-up or open a checkout only on a plan${onSale ? " or its trial" : ""}.`,
    },
  ];
}
