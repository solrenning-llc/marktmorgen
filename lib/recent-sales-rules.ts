/**
 * The figures of a store's latest-purchases card (lib/recent-sales.ts), for
 * the studio and the store's pages alike. Browser-safe.
 */

/** How long a purchase is shown for. */
export const RECENT_DAYS = 7;
/** How many a visit is shown at most, each once. */
export const SHOWN = 3;

/** The most pages of a store's refunds a recompute of the feed reads (100 rows each); a list longer than that shows nothing. */
export const REFUND_PAGES = 2;
/** The most pages of a store's disputes a recompute reads. */
export const DISPUTE_PAGES = 1;
/** How long a feed that could not be checked is remembered as unchecked, so the next visits do not ask Stripe again. */
export const UNCHECKED_SECONDS = 60;
/** The ceiling of each Stripe read of a recompute, in milliseconds. */
export const RECENT_READ_MS = 5_000;

/** One purchase as a page shows it: never who bought it. */
export type RecentSale = { product: string; title: string; at: number; country: string };
