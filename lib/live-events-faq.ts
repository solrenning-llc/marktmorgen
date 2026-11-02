/**
 * The questions someone starting out asks about live events (534 [FQ1],
 * unit 29, added 2 November 2026), answered only by what the code does today:
 * the events part of the studio's Community page and its own words
 * (components/community-events-studio.tsx), drawn only once the community is
 * set up (app/studio/community/page.tsx), scheduled by whoever may run
 * events (lib/team-roles.ts, "events"), and members let in by a product they
 * hold, a sale or a free copy needing the store's plan or its trial, or
 * brought over from another platform (lib/community-access.ts). No figure. Shown first in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { ROLE_NAMES } from "@/lib/team-roles";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const EVENT_WORDS = { tool: "Community", setUp: "Set it up", part: "Live events", schedule: "Schedule an event", title: "Title", when: "When", where: "Where", confirm: "Schedule it", announce: "Announce it in the feed" } as const;

export function liveEventsBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = EVENT_WORDS;
  return [
    {
      q: "How do I schedule my first event?",
      a: `Events live inside your community, so the owner or an ${ROLE_NAMES.admin} sets that up first: on the studio's “${w.tool}” page, press “${w.setUp}”. Then, under “${w.part}”, press “${w.schedule}”, type a “${w.title}”, check the date and time under “${w.when}” and the place under “${w.where}” (a private video room unless you pick another), and press “${w.confirm}”. Members see it once the community is switched on.`,
    },
    {
      q: "Is anyone told when I schedule one?",
      a: `Not by email. It shows in your community, and with “${w.announce}” checked, as a post there too. Only members who RSVP get reminders, and only if they asked for the community's emails.`,
    },
    {
      q: "Can I try it before paying?",
      a: `${tryBeforePaying("A live event", "a live event", onSale, trialDays)} Members come to an event through a product that opens your community: bought or claimed free, which needs your store's plan${onSale ? " or its trial" : ""}, or held by buyers you or an ${ROLE_NAMES.admin} bring over from another platform.`,
    },
  ];
}
