/**
 * The questions someone starting out asks about Discord access (534 [FQ1],
 * unit 17, added 2 November 2026), answered only by what the code does today:
 * the studio's Discord page, there only once the deployment has Discord's
 * keys and for the owner and Admins (app/studio/discord/page.tsx,
 * app/studio/page.tsx), its own words (components/discord-studio.tsx), the
 * code's limits and how often access is checked (lib/discord-rules.ts), and
 * the shared answer to "Can I try Discord access before paying?" (lib/beginner-faq.ts).
 * No number of servers, members or sales. Shown first in the page's own
 * "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { CHECK_HOURS, MAX_DISCORD_PRODUCTS, MAX_PRODUCT_ROLES } from "@/lib/discord-rules";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const DISCORD_WORDS = { tool: "Discord", connect: "Connect a Discord server", roles: "Which products give which roles", save: "Save", join: "Join the Discord", joined: "Who joined" } as const;

export function discordBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = DISCORD_WORDS;
  return [
    {
      q: "What is Discord access here?",
      a: `It opens your own Discord server to the people who buy from you: up to ${MAX_PRODUCT_ROLES} roles for each product, on up to ${MAX_DISCORD_PRODUCTS} products. A buyer presses “${w.join}” on their thank-you page or their orders and says yes on Discord's own page. They keep the roles while they hold what they bought; when a membership ends or a purchase is refunded in full, the roles are taken back at the next check, about every ${CHECK_HOURS} hours. While Stripe or Discord cannot be reached, or Discord will not let the bot remove a role, nothing is taken until it can be.`,
    },
    {
      q: "How do I connect my server?",
      a: `In your studio, open “${w.tool}” and press “${w.connect}”; Discord asks which of your servers to add our bot to, and you need to be allowed to manage it. Then, under “${w.roles}”, pick the roles for each product and press “${w.save}”. Only the store's owner and Admins see “${w.tool}” in the studio; if you are one of them and it is not there, it is not switched on yet on our side.`,
    },
    {
      q: "Can I try Discord access before paying?",
      a: `${tryBeforePaying("Discord access", "the connection to your server and the roles each product gives", onSale, trialDays)} Only the owner and Admins can, once Discord is switched on on our side.${onSale ? "" : " Paid plans are not on sale yet, so no buyer can join from a purchase now."}`,
    },
    {
      q: "How many people use Discord access?",
      a: `We publish no number of servers, members or sales, because we do not have a real, checked count to show. Under “${w.joined}”, your studio lists the newest people given roles by a purchase: their name on Discord, the address they bought with, their roles and the day they joined. Someone whose access ended leaves the list.`,
    },
  ];
}
