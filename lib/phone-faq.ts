/**
 * The questions someone starting out asks about phone notifications (534
 * [FQ1], unit 19, added 2 November 2026), answered only by what the code does
 * today: the studio's Phone notifications page and its panel's own words
 * (app/studio/phone/page.tsx, components/phone-alerts-panel.tsx), including
 * what it says when notifications are not set up on the deployment, the most
 * devices (lib/phone-alerts-rules.ts, MAX_DEVICES), and the shared answer to "Can I
 * try it before paying?" (lib/beginner-faq.ts). No number of devices or sales
 * beyond the code's own. Shown first in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_DEVICES } from "@/lib/phone-alerts-rules";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words. */
export const PHONE_WORDS = { tool: "Phone notifications", choose: "Tell this device about", on: "Turn on notifications", test: "Send a test" } as const;

export function phoneBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = PHONE_WORDS;
  return [
    {
      q: "What are phone notifications here?",
      a: `Your studio can notify your phone, tablet or computer the moment something happens, such as a sale, a booking, a report in your community, an affiliate application, a live event about to start or a comment under a lesson. You can use up to ${MAX_DEVICES} devices of your own, and choose for each one what it tells you. Each person on your team hears only what their role may see.`,
    },
    {
      q: "How do I turn on phone notifications?",
      a: `In your studio, open “${w.tool}”. On iPhone or iPad, first add the studio to your home screen from Safari's Share button, then open it from there and go back to “${w.tool}”. Choose what you want under “${w.choose}”, press “${w.on}”, then “${w.test}”. If the page says notifications are not set up yet, they cannot be turned on for now.`,
    },
    {
      q: "Can I try phone notifications before paying?",
      a: `${tryBeforePaying("Phone notifications", "phone notifications on your devices", onSale, trialDays)} That holds once notifications are set up on our side.`,
    },
    {
      q: "Is it an app from the App Store or Google Play?",
      a: "No. Notifications come from your browser, through the studio. Only on iPhone and iPad does the studio need to be on the home screen, on iOS 16.4 or later.",
    },
  ];
}
