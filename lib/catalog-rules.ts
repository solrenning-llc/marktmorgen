/** Shared pure rules. No server operations or private configuration. */

export const MAX_PRODUCTS = 2_000;

export const MAX_TITLE_LENGTH = 80;

export const MAX_SUMMARY_LENGTH = 300;

/**
 * A store's product records read at one MGET at the most (lib/catalog.ts, getMany; calendar-feed room, option B,
 * 10 November 2026): a calendar feed's making reads every call listing, up to MAX_PRODUCTS, and was one GET a key
 * until then. Upstash bills an MGET as one command whatever its keys; the bytes it moves are priced where the reading
 * is (lib/read-ceilings.ts).
 */
export const LISTINGS_PER_MGET = 100;

/** The commands one read of this many product records sends (getMany); a count that is not a number is never priced low. */
export function listingReads(keys: number): number {
  if (Number.isNaN(keys) || keys === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return keys > 0 ? Math.ceil(keys / LISTINGS_PER_MGET) : 0;
}
