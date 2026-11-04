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
