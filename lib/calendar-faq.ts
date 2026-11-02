/**
 * The questions someone starting out asks about calendar sync (534 [FQ1],
 * unit 15, added 2 November 2026), answered only by what the code does today:
 * the studio's "Your calendars" card, shown once the store has a call product
 * (components/calendar-editor.tsx, app/studio/page.tsx), its limits and how
 * long a reading is kept (lib/calendar-limits.ts), and
 * the shared answer to "Can I try it before paying?" (lib/beginner-faq.ts).
 * No number of calendars or bookings beyond the code's own limits. Shown
 * first in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { CACHE_SECONDS, LOOKAHEAD_DAYS, MAX_FEEDS, STALE_SECONDS } from "@/lib/calendar-limits";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio card's own words. */
export const CALENDAR_WORDS = { card: "Your calendars", field: "Private calendar address (iCal or .ics link)", add: "Add calendar", where: "Where to find the address" } as const;

export function calendarBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = CALENDAR_WORDS;
  return [
    {
      q: "What is calendar sync here?",
      a: `Up to ${MAX_FEEDS} calendars with a private iCal (.ics) address, such as Google, Outlook or iCloud: the times you are busy there, up to ${LOOKAHEAD_DAYS} days ahead, stop being offered in your calls with weekly hours, group calls included. Only the busy times are kept, never a title or a guest.`,
    },
    {
      q: "How do I connect a calendar?",
      a: `In your studio, once your store has a call (a draft counts), find “${w.card}”; the store's owner and Admins see it. Paste the calendar's private address under “${w.field}” and press “${w.add}”. “${w.where}” says where Google Calendar, Outlook and Apple Calendar keep it. There is no account to connect and no password. Once ${MAX_FEEDS} are added, remove one to add another.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("Calendar sync", "a call and the calendars your store reads", onSale, trialDays),
    },
    {
      q: "Does it stop double bookings?",
      a: `It hides the times you are busy for in your calls with weekly hours. A calendar is read again at most every ${CACHE_SECONDS / 60} minutes, so a new busy time usually takes up to that long to close a slot; if the calendar stops answering, its last good reading stands for up to ${STALE_SECONDS / 3600} hours and your studio says what went wrong. On a team call, each host's own calendar counts, set under “Your calendar”.`,
    },
  ];
}
