/**
 * What the public pages say about team hosts' two-way Google Calendar sync,
 * read from the same switch the studio and the routes use (hostSyncOn in
 * lib/meet-providers.ts: Google's keys and GOOGLE_CALENDAR_SYNC_SCOPES).
 * Nothing here waits on Google: its two scopes were added on 17 Oct 2026
 * (docs/team-scheduling.md), so the deployment's own variable decides, and
 * each sentence has one true version for each state.
 */
import { hostSyncOn } from "@/lib/meet-providers";

/** Booking calls: what is written into Google Calendar. */
export function googleWritesLimit(on: boolean = hostSyncOn()): string {
  const written = on
    ? "only calls set to Google Meet, and team calls whose host connected their own Google Calendar, are written into Google Calendar"
    : "only calls set to Google Meet are written into Google Calendar";
  return `Your calendars are read for busy times, and ${written}. Other bookings reach your calendar as a feed you subscribe to, and a new busy time can take about ten minutes to close a slot.`;
}

/** Booking calls: the line on team hosts' sync, said only while it is off. */
export function teamSyncLimit(on: boolean = hostSyncOn()): string | null {
  return on
    ? null
    : "Two-way Google Calendar sync for team hosts is built and not switched on yet; until it is, hosts add their calendar's private iCal address, which is read the same way but writes nothing.";
}

/** Calendar: how a team host sets their own calendar. */
export function teamHostCalendarLimit(on: boolean = hostSyncOn()): string {
  return on
    ? "Hosts of team calls set their own calendar under Your calendar: a private iCal address, or their own Google Calendar for two-way sync (busy times read from the calendars they pick, bookings written to the one they choose)."
    : "Hosts of team calls set their own calendar under Your calendar as a private iCal address; two-way sync with their own Google Calendar is built and not switched on yet.";
}

/** Calendar: where busy times are read from. */
export function busyReadLimit(on: boolean = hostSyncOn()): string {
  return on
    ? "Apart from a team host's own Google Calendar, busy times are read only through a private iCal address, not through a Google or Microsoft connection. A calendar that cannot give one cannot be read."
    : "Busy times are read only through a private iCal address, not through a Google or Microsoft connection. A calendar that cannot give one cannot be read.";
}

/** Help: what a team host can set under "Your calendar". */
export function teamHostCalendarChoice(on: boolean = hostSyncOn()): string {
  return on
    ? "a private iCal address, or their own Google Calendar for two-way sync (busy times read from the calendars they pick, each booking written with a Meet link to the one they choose, moved and deleted with it)"
    : "a private iCal address (two-way sync with their own Google Calendar is built and not switched on yet)";
}

/** Help: the start of "what it does not do": what is written as an event. */
export function nothingWrittenApartFrom(on: boolean = hostSyncOn()): string {
  return on
    ? "apart from calls set to Google Meet, and team calls whose host connected their own Google Calendar, nothing is written into your calendar as an event"
    : "apart from calls set to Google Meet, nothing is written into your calendar as an event";
}

/** Mission: the line of "not built" on writing every booking as an event. */
export function calendarEventsMissionLine(on: boolean = hostSyncOn()): string {
  const written = on
    ? "only calls set to Google Meet, and team calls whose host connected their own Google Calendar, are written there"
    : "only calls set to Google Meet are written there";
  return `Writing every booking into your calendar as an event: ${written}, other bookings come as a feed you subscribe to, and calendars are read for busy times`;
}
