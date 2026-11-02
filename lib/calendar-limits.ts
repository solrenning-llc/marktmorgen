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
