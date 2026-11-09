/**
 * The figures of a store's latest-purchases card (lib/recent-sales.ts), for
 * the studio and the store's pages alike. Browser-safe.
 */

/** How long a purchase is shown for. */
export const RECENT_DAYS = 7;
/** How many a visit is shown at most, each once. */
export const SHOWN = 3;

/** How long a feed that could not be checked is remembered as unchecked, so the next visits do not ask Stripe again. */
export const UNCHECKED_SECONDS = 60;

/** One purchase as a page shows it: never who bought it. */
export type RecentSale = { product: string; title: string; at: number; country: string };
