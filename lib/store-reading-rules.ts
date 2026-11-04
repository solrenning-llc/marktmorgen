/**
 * The figures of a store's readings of its own numbers (lib/store-readings.ts),
 * with nothing that reads: so the help and the pages that say them can import
 * them without the database.
 */

/** Readings a store may take in a UTC day, every page and kind together. */
export const STORE_READINGS_PER_DAY = 8;
/**
 * Of them, the heavy ones: its sales (every PayPal sale and refund record read,
 * lib/read-ceilings.ts SALES_READ_SHAPE). The rest of the day's readings are
 * light. The most the first-payment refund the owner funds allows
 * (tests/plan-margin.test.ts, US$ 65; inbox C4-18, C4-33), held there: one more
 * a day would pass it.
 */
export const HEAVY_READINGS_PER_DAY = 3;
/**
 * A product update's searches for its buyers (lib/product-updates.ts) in a
 * UTC day, of their own: they never take the studio's heavy readings (inbox
 * C4-33 (4)). Each product's buyers are told at most once a week; a search
 * that finds none claims nothing, so it is counted here.
 */
export const UPDATE_SEARCHES_PER_DAY = 1;
/** How long a reading is shown as it is before it is read again. */
export const READING_FRESH_SECONDS = 600;

/** The rule in plain words, for the help (inbox C4-33 (5)). */
export const READINGS_RULE_WORDS = `Your numbers are read again when you open your studio, at most once every ${READING_FRESH_SECONDS / 60} minutes and up to ${STORE_READINGS_PER_DAY} times a day (UTC), ${HEAVY_READINGS_PER_DAY} of them with your sales. Between readings your studio shows the last one, with the time it was read, and “Update now” reads them again while the day has a reading left. Once a day's readings are used, your numbers update again at 00:00 UTC; your studio also says when that is on your own clock.`;

/** A product update's lookups in plain words, for the help. */
export const UPDATE_RULE_WORDS = `Your store can look up ${UPDATE_SEARCHES_PER_DAY === 1 ? "one product's buyers" : `${UPDATE_SEARCHES_PER_DAY} products' buyers`} a day, a lookup that finds none included; the next one is after 00:00 UTC.`;
