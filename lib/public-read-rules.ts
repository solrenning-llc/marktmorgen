/**
 * What two public reads cost in the store's own requests, taken before they
 * read anything (4 November 2026): an affiliate's own page and the store's
 * map for search engines. Both read in proportion to the store (every
 * affiliate's sales, the whole catalog and blog), and until then neither
 * counted a single request, so a store's crawlers or its affiliates could
 * make it read without any ceiling.
 *
 * Each is sized first with cheap counts (field counts, a set's size, the
 * store record it already has), then charged as that many requests of the
 * plan's window (lib/traffic.ts, takePublicRequest), each priced as a later
 * page (tests/traffic-cost.ts, laterPageCost); what the counts allow it to
 * read is bounded by them. Refused, nothing more is read. The figures are
 * held against what the reads cost in tests/plan-cost-registry.test.ts.
 */

const MAX_UNITS = 1_000_000;
const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0);

/**
 * An affiliate's own page, beside the reads that scale: its few fixed
 * commands, the creator's Stripe account read for the book (invoices,
 * refunds and disputes, at their page caps in lib/affiliates.ts, and the
 * discount codes) waited on one after another, and the page itself.
 */
export const AFFILIATE_PAGE_UNITS = 10;
/** Fields of the program's records (affiliates, clicks, sales, payouts, shares, paid clicks, leads), read in one go, per request. */
export const AFFILIATE_FIELDS_PER_UNIT = 150;
/** Records read one command each (PayPal refunds, moved bookings), per request. */
export const AFFILIATE_ROWS_PER_UNIT = 16;
/** Listings read for the page (products with their own rate, a partner's products), per request. */
export const PUBLIC_LISTINGS_PER_UNIT = 32;
/** The most PayPal refunds and moved bookings the book reads one by one (lib/paypal-sales.ts, lib/affiliates.ts readBook). */
export const AFFILIATE_ROW_CAP = 500 + 200;

export type AffiliatePageSize = {
  /** Every field of the program's hashes the book reads whole. */
  fields: number;
  /** Records it reads one command each. */
  rows: number;
  /** Listings the page reads. */
  listings: number;
};

/** The listings-only part: what a visitor who is not signed in adds to the page's own request. */
export function listingUnits(listings: number): number {
  return Math.min(MAX_UNITS, whole(listings / PUBLIC_LISTINGS_PER_UNIT));
}

/** The requests a signed-in affiliate's page takes, all at once, before the book is read. */
export function affiliatePageUnits(size: AffiliatePageSize): number {
  const units = AFFILIATE_PAGE_UNITS
    + whole(size.fields / AFFILIATE_FIELDS_PER_UNIT)
    + whole(Math.min(size.rows, AFFILIATE_ROW_CAP) / AFFILIATE_ROWS_PER_UNIT)
    + listingUnits(size.listings);
  return Math.min(MAX_UNITS, units);
}

/** The store's map for search engines: its own request, the store's counts and the answer itself. */
export const SITEMAP_BASE_UNITS = 1;
/** Pages of the blog's published posts (lib/store-blog.ts, POSTS_PER_PAGE each) read for the map, per request. */
export const SITEMAP_POST_PAGES_PER_UNIT = 5;

export type SitemapSize = {
  /** The visible products, each a line of the map; those the store record does not carry are read. */
  listings: number;
  /** Pages of published posts read. */
  postPages: number;
};

/** The requests one drawing of the map takes, before anything of it is read. */
export function sitemapUnits(size: SitemapSize): number {
  return Math.min(MAX_UNITS, SITEMAP_BASE_UNITS + whole(size.listings / PUBLIC_LISTINGS_PER_UNIT + size.postPages / SITEMAP_POST_PAGES_PER_UNIT));
}
