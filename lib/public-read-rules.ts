/**
 * What two public reads cost in the store's own requests, taken before they
 * read anything (4 November 2026): an affiliate's own page and the store's
 * map for search engines. Both read in proportion to the store (every
 * affiliate's sales, the whole catalog and blog), and until then neither
 * counted a single request, so a store's crawlers or its affiliates could
 * make it read without any ceiling.
 *
 * Each is sized first with cheap counts (field counts, a set's size, a
 * stored value's length, the store record it already has), then charged as
 * that many requests of the plan's window (lib/traffic.ts, takePublicRequest),
 * each priced as a later page (tests/traffic-cost.ts, laterPageCost); what
 * the counts allow it to read is bounded by them. Refused, nothing more is
 * read. The figures are held against what the reads cost in
 * tests/plan-cost-registry.test.ts.
 *
 * An affiliate program's book (lib/affiliates.ts, readBook) is worked out
 * for every affiliate at once and kept a day
 * (lib/affiliate-book-snapshot.ts): the load that finds it out of date pays
 * for working it out (affiliatePageUnits), every other load pays for
 * reading its own part (affiliateLoadUnits).
 */

const MAX_UNITS = 1_000_000;
const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0);

/**
 * Working out the book, beside what scales: its fixed commands (the book
 * counted, its seven hashes, the PayPal refunds' set, two reads of
 * listings, the parts written back and the lock), the request itself held
 * while it works, and its counting.
 */
export const AFFILIATE_PAGE_UNITS = 4;
/** Each page of the creator's Stripe account read for the book, its body up to a megabyte worked through: one request each. */
export const AFFILIATE_STRIPE_PAGES_PER_UNIT = 1;
/**
 * Fields of the program's records (affiliates, clicks, sales, payouts, shares, paid clicks, leads), read in one go, per
 * request. 125 since the book asks about each PayPal payment's partial refund too (BOOK_KEPT_REFUND_BYTES 384, two
 * names an entry in each question; audit R13, MEDIUM 2): at 150 a program of 868 to about 1,500 fields cost more than
 * its requests; at 125 none does, from no field to 60,000 (scanned one by one) and past it (tests/plan-cost-registry.test.ts).
 */
export const AFFILIATE_FIELDS_PER_UNIT = 125;
/** Records read one command each (PayPal refunds, moved bookings), per request. */
export const AFFILIATE_ROWS_PER_UNIT = 16;
/** Listings read (products with their own rate, a partner's products, products named by invoices), per request. */
export const PUBLIC_LISTINGS_PER_UNIT = 32;
/** The most PayPal refunds and moved bookings the book reads one by one (lib/paypal-sales.ts, lib/affiliates.ts readBook). */
export const AFFILIATE_ROW_CAP = 500 + 200;

export type AffiliatePageSize = {
  /** Every field of the program's hashes the book reads whole. */
  fields: number;
  /** Records it reads one command each. */
  rows: number;
  /** Listings it reads. */
  listings: number;
  /** Pages of the creator's Stripe account it may read. */
  stripePages: number;
};

/** The listings-only part: what a visitor who sees no book adds to the page's own request. */
export function listingUnits(listings: number): number {
  return Math.min(MAX_UNITS, whole(listings / PUBLIC_LISTINGS_PER_UNIT));
}

/** The requests working out a program's book takes, all at once, before it is read. */
export function affiliatePageUnits(size: AffiliatePageSize): number {
  const units = AFFILIATE_PAGE_UNITS
    + whole(size.stripePages / AFFILIATE_STRIPE_PAGES_PER_UNIT)
    + whole(size.fields / AFFILIATE_FIELDS_PER_UNIT + Math.min(size.rows, AFFILIATE_ROW_CAP) / AFFILIATE_ROWS_PER_UNIT + size.listings / PUBLIC_LISTINGS_PER_UNIT);
  return Math.min(MAX_UNITS, units);
}

/** An affiliate's own part of the kept book, per request (one at the least, with the commands that find and read it). */
export const AFFILIATE_LOAD_BYTES_PER_UNIT = 65_536;
/** Codes given to affiliates (lib/affiliate-codes.ts), read whole on a load, per request. */
export const AFFILIATE_CODE_FIELDS_PER_UNIT = 150;

export type AffiliateLoadSize = {
  /** The length of the affiliate's own part of the kept book. */
  sliceBytes: number;
  /** Listings the page reads. */
  listings: number;
  /** Null when the page does not read the store's codes; else how many are given to affiliates. */
  codes: number | null;
};

/**
 * The requests one load of an affiliate's own page takes, before it reads:
 * the page itself (one), its own part of the kept book with its listings and
 * the codes' owners (one at the least), and, where it shows the affiliate's
 * codes, one call to the creator's Stripe account (one). Two for a typical
 * load of a store without codes, whatever the program's size.
 */
export function affiliateLoadUnits(size: AffiliateLoadSize): number {
  const parts = size.sliceBytes / AFFILIATE_LOAD_BYTES_PER_UNIT
    + size.listings / PUBLIC_LISTINGS_PER_UNIT
    + (size.codes ?? 0) / AFFILIATE_CODE_FIELDS_PER_UNIT;
  return Math.min(MAX_UNITS, 1 + (size.codes === null ? 0 : 1) + Math.max(1, whole(parts)));
}

/** The store's map for search engines: its own request, the store's counts and the answer itself. */
export const SITEMAP_BASE_UNITS = 1;
/** Pages of the blog's published posts (lib/store-blog.ts, POSTS_PER_PAGE each) read for the map, per request. */
export const SITEMAP_POST_PAGES_PER_UNIT = 5;
/** Lines of the map whose listing the store record already carries (nothing read), per request. */
export const SITEMAP_LINES_PER_UNIT = 1_000;

export type SitemapSize = {
  /** The visible products whose listing is read (not carried by the store record). */
  listings: number;
  /** The visible products the store record carries: a line of the map each, nothing read. */
  carried: number;
  /** Pages of published posts read. */
  postPages: number;
};

/** The requests one drawing of the map takes, before anything of it is read. */
export function sitemapUnits(size: SitemapSize): number {
  return Math.min(MAX_UNITS, SITEMAP_BASE_UNITS + whole(size.listings / PUBLIC_LISTINGS_PER_UNIT + size.carried / SITEMAP_LINES_PER_UNIT + size.postPages / SITEMAP_POST_PAGES_PER_UNIT));
}

/**
 * What a store's card in the buyer's library takes of that store's buyer
 * requests before it reads what waits on them there (app/library,
 * lib/buyer-waiting.ts waitingFor; Codex J on #1969): the person's two sets
 * and their records (four commands, at most MAX_PER_PERSON records of each
 * kind) and the text of each agreement listed (WAITING_SHOWN). Held against
 * that read at its largest in tests/plan-cost-registry.test.ts (libraryWaitingRead).
 */
export const LIBRARY_WAITING_UNITS = 4;
