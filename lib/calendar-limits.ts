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
