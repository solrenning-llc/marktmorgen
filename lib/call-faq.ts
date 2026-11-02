/**
 * The questions someone starting out asks about paid calls (534 [FQ1], unit
 * 4, added 2 November 2026), answered only by what the code does today: the
 * call editor's own buttons and the products it takes
 * (components/call-editor.tsx), a group call's seats (lib/call-setup.ts,
 * MAX_SEATS), the studio's Upcoming calls (app/studio/page.tsx), and the
 * shared answer to "Can I try it before paying?" (lib/beginner-faq.ts). No
 * number of calls or bookings, no time promise. Shown first in the calls
 * page's own "Questions" block (components/topic-page.tsx).
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_SEATS } from "@/lib/call-setup";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The call editor's own words for starting a call and saving it. */
export const CALL_EDITOR_WORDS = {
  weekly: "Sell this as a paid call with a calendar",
  weeklySave: "Sell it as a call",
  live: "Sell seats in live sessions on set dates",
  liveSave: "Sell seats in these sessions",
} as const;
/** Where the studio lists what was booked (app/studio/page.tsx). */
export const UPCOMING_CALLS = "Upcoming calls";

export function callBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  return [
    {
      q: "What is a paid call here?",
      a: `A time with you that the buyer picks and pays for as they book it, on your own Stripe account, or books later from a package of sessions they already paid for: one person at a time, a group of up to ${MAX_SEATS} at each time, or seats in live sessions on dates you set. The buyer gets an email with a calendar file. You get one too, or the host does on a team call you do not host. If the call is already in that person's Google Calendar, their email has no file. The call itself happens on the meeting service you choose, or by a link you send yourself; nothing is streamed or recorded here.`,
    },
    {
      q: "How do I start one?",
      a: `In your studio, open a paid product with one set price that does not deliver a file or a link, and press “${CALL_EDITOR_WORDS.weekly}”. Set how long a call lasts, your time zone and your hours, then press “${CALL_EDITOR_WORDS.weeklySave}”. For seats on dates you set, press “${CALL_EDITOR_WORDS.live}” instead, then “${CALL_EDITOR_WORDS.liveSave}”. Something free, a membership, a course, a podcast, a bundle, something you ship, a product with several prices and one where the buyer names the price cannot be a call.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("A call", "a call, with its hours or its dates,", onSale, trialDays),
    },
    {
      q: "Do paid calls work?",
      a: `${onSale ? "" : "Paid plans are not on sale yet, so no call can be booked now. "}We publish no number of calls or bookings, because we do not have a real, checked count to show. Once your Stripe account is connected and your store can take payments, your studio lists the calls still to come that it reads from your Stripe account, under “${UPCOMING_CALLS}”. The buyer gets a reminder a day before and an hour before, and you get one for each time, listing everyone booked, each sent only when it falls at least an hour after the booking or its move.`,
    },
  ];
}
