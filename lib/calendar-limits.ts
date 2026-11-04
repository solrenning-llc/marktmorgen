/**
 * The calendar-sync figures a page may show without loading
 * lib/calendar-sync.ts (which reaches Redis and the network): the studio's
 * editor and the public feature page's card read the same ones the server
 * keeps to. Browser-safe.
 */

/** Calendars one store may read. */
export const MAX_FEEDS = 3;
/** How far ahead busy times are read: past the longest booking horizon. */
export const LOOKAHEAD_DAYS = 120;
/** How long a reading is used before the calendar is asked again. */
export const CACHE_SECONDS = 600;
/** How long the last good reading stands in for a calendar that stopped answering. */
export const STALE_SECONDS = 6 * 3600;
/**
 * More makings of the private feed's file a UTC day, one for each booking
 * made, moved or let go that day (lib/call-records.ts, the store's credits),
 * up to this many: so a day's bookings show at the calendar app's next check.
 * The studio's editor says it (components/calendar-editor.tsx).
 */
export const CALENDAR_CREDITS_PER_DAY = 5;
/**
 * Answers one store's feed gets in an hour: four, two calendar apps (a phone
 * and a computer) each asking every thirty minutes, the file's own
 * REFRESH-INTERVAL. A third app asks more than this and is told to come back.
 */
export const CALENDAR_POLLS_PER_HOUR = 4;
/**
 * Answers refused past the pace in an hour before the address stops (inbox
 * C4-33, light a): the most the first-payment refund the owner funds allows
 * (tests/plan-margin.test.ts, US$ 65), priced in the feed's line. Two apps
 * asking every fifteen minutes never reach it; one asking every five minutes
 * (Apple Calendar's shortest) does, and the studio's editor says so. Past it
 * the address is let go, as "Make a new address" does, and the studio shows a
 * new one with why; what still asks the old one is an unknown address,
 * answered from its token's one read like any other.
 */
export const CALENDAR_REFUSED_PER_HOUR = 7;
