/**
 * What three reads cost at the most, and what pays for each before it reads
 * anything (owner's rule MR, 27 October 2026: a ceiling before every spend;
 * an unknown cost is never zero). Found by the inventory of public and studio
 * reads without a ceiling (C4-4; the community search is Claude 3's, C4-6):
 *
 *   booking calendar   app/api/store/calendar/[token]/route.ts: the private
 *                      feed answers a calendar app from the last good copy of
 *                      the file; it is made again only when a booking changed
 *                      or the copy is CALENDAR_REFRESH_SECONDS old, at most
 *                      CALENDAR_BUILDS_PER_DAY times a store a day, and a
 *                      store's feed is answered CALENDAR_POLLS_PER_HOUR times
 *                      an hour (lib/calendar-sync.ts, bookedCalendarFeed): its
 *                      own cost line (tests/plan-cost-registry.ts,
 *                      calendar-feed), never the studio's requests, which an
 *                      app asking on its own must not spend.
 *   product update     lib/product-updates.ts, startUpdate: reading the
 *                      store's paid sales to find a product's buyers takes
 *                      UPDATE_READ_UNITS studio requests first.
 *   studio totals      app/studio/totals/page.tsx: each store's numbers
 *                      (its sales and memberships, read from Stripe) take
 *                      TOTALS_STORE_UNITS of that store's studio requests.
 *
 * Each worst case is a ReadShape: wall seconds held at 2 GB, CPU seconds,
 * database commands, bytes moved through the database, bytes sent on, and
 * pages of the creator's Stripe account waited on (each at
 * EXPORT_PAGE_SECONDS, as lib/store-export.ts prices them; Stripe bills no
 * API call). tests/read-ceilings.test.ts prices each shape with the
 * registry's own rates (tests/plan-cost-registry.ts, readShapeCost) and fails
 * when its units cost less than it. Commands are counted from the code, read
 * by read; sizes no code caps are review ceilings, said so where they are set.
 */
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_STORE_BYTES } from "@/lib/store";
import { MAX_UPDATE_RECIPIENTS } from "@/lib/product-updates-rules";
import { ALL_TIME_PAGES, DAY_FIELDS_MAX, KEPT_DAYS, LIFE_WRITE_MAX, STATS_DAYS } from "@/lib/stats";
import { CALENDAR_MAX_EVENTS } from "@/lib/calendar-sync";

export type ReadShape = {
  /** Wall seconds, held at 2 GB. */
  seconds: number;
  /** CPU seconds. */
  cpu: number;
  /** Database commands. */
  commands: number;
  /** Bytes moved through the database, both ways. */
  dbBytes: number;
  /** Bytes sent on to the browser or the calendar app. */
  outBytes: number;
  /** Pages of the creator's Stripe account waited on, one after another. */
  stripePages: number;
};

/** A listing read from the catalog, at the most: the review ceiling tests/plan-cost-registry.ts already reads one at (NEXT_OFFER_READ). */
export const LISTING_READ_BYTES = 16_384;

// ---- The booking calendar's private feed -----------------------------------

/**
 * Pages of the store's checkouts read to make the file: lib/calls.ts,
 * readCallSessions, `const MAX_PAGES = 5;` (not exported there, and the file
 * is another agent's: tests/read-ceilings.test.ts fails when it moves).
 */
export const CALENDAR_STRIPE_PAGES = 5;
/** Booked calls those pages can hold. */
export const CALENDAR_CALLS = CALENDAR_STRIPE_PAGES * 100;
/** The file at its largest (CALENDAR_MAX_EVENTS, lib/calendar-sync.ts): each event's lines, and each booking's name and address once. A review ceiling of 2 KB an event and 512 bytes a booking. */
export const CALENDAR_FILE_BYTES = CALENDAR_MAX_EVENTS * 2_048 + CALENDAR_CALLS * 512;

/** Every answer: the token and its settings (2 GET), the hour's pace (SET NX, INCRBY and, when refused, DECRBY: 3), the copy and the changed mark (MGET); the copy sent. */
export const CALENDAR_POLL_SHAPE: ReadShape = {
  seconds: 1,
  cpu: 0.1,
  commands: 2 + 3 + 1,
  dbBytes: 2 * 4_096 + CALENDAR_FILE_BYTES + 256,
  outBytes: CALENDAR_FILE_BYTES,
  stripePages: 0,
};
/**
 * The file made again, besides its poll: the day's budget (SET NX, INCRBY and,
 * when refused, DECRBY: 3); the store (its handle and its record: 2 GET); its
 * Stripe pages; every call listing (one GET each, up to MAX_PRODUCTS, the
 * catalog's head aside); each booking's moves (lib/call-records.ts, readMoves:
 * one GET a booking); four reads of each booking's room (lib/call-rooms.ts,
 * roomsFor); the copy kept (SET).
 */
export const CALENDAR_BUILD_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: 3 + 2 + MAX_PRODUCTS + CALENDAR_CALLS + 4 * CALENDAR_CALLS + 1,
  dbBytes: MAX_STORE_BYTES + MAX_PRODUCTS * LISTING_READ_BYTES + CALENDAR_CALLS * 1_024 + 4 * CALENDAR_CALLS * 1_024 + CALENDAR_FILE_BYTES,
  outBytes: 0,
  stripePages: CALENDAR_STRIPE_PAGES,
};

// ---- Telling a product's buyers it was updated ------------------------------

/** A PayPal sale's record, at the most: a review ceiling. */
const PAYPAL_SALE_BYTES = 2_048;
/**
 * Finding a product's buyers (lib/product-updates.ts, startUpdate): when it
 * may next go (GET); both of the store's Stripe lists, ALL_TIME_PAGES pages
 * each; the PayPal sales of as many pages (ZREVRANGEBYSCORE and MGET); and,
 * once a week a product, the claim (SET) and the send written: DEL, the
 * buyers 500 to an RPUSH, EXPIRE, the job, the latest and the queue (SET,
 * SET, SADD).
 */
export const UPDATE_READ_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: 1 + 2 + 1 + 1 + Math.ceil(MAX_UPDATE_RECIPIENTS / 500) + 1 + 3,
  dbBytes: ALL_TIME_PAGES * 100 * (PAYPAL_SALE_BYTES + 64) + MAX_UPDATE_RECIPIENTS * 320 + 8_192,
  outBytes: 0,
  stripePages: 2 * ALL_TIME_PAGES,
};
export const UPDATE_READ_UNITS = 16;

// ---- The studio's totals of every store -------------------------------------

/** A field of a day's counts or of the all-time record, at the most: its name (up to 96 bytes) and its count. */
const STATS_FIELD_BYTES = 128;
/** The PayPal sales readSales reads (lib/stats.ts, readPaidSales(store, since, 20)) and the refunds (lib/paypal-sales.ts, up to 500). */
const TOTALS_PAYPAL_SALES = 20 * 100;
const TOTALS_PAYPAL_REFUNDS = 500;
/**
 * One store's numbers for the totals, read by read:
 *
 *   lib/stats.ts, readStats   STATS_DAYS HGETALL of the days, STATS_DAYS
 *                             PFCOUNT, six PFCOUNT of the windows, STATS_DAYS
 *                             HMGET of the days before (3 x 90 + 6 = 276);
 *   readLife                  the all-time record (HGETALL), its gap noted
 *                             once (HSETNX), the smallest let go (HDEL and
 *                             HINCRBY): 4. Its one-time filling from the kept
 *                             days, once ever a store under a lock, is not
 *                             here: see LIFE_FILL_SHAPE;
 *   readSales                 the PayPal sales (ZREVRANGEBYSCORE and MGET: 2)
 *                             and refunds (ZRANGEBYSCORE and a GET each: 501);
 *                             from Stripe, the sales (two lists of twenty
 *                             pages), renewals (ten), refunds (five) and
 *                             disputes (three);
 *   lib/membership-numbers.ts the kept numbers (GET) and, when not kept, the
 *                             memberships and their invoices (twenty pages
 *                             each) and the numbers kept (SET): 2.
 */
export const TOTALS_STORE_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: (3 * STATS_DAYS + 6) + 4 + 2 + (1 + TOTALS_PAYPAL_REFUNDS) + 2,
  dbBytes:
    STATS_DAYS * DAY_FIELDS_MAX * STATS_FIELD_BYTES + STATS_DAYS * 64 + STATS_DAYS * 2 * 32
    + LIFE_WRITE_MAX * STATS_FIELD_BYTES
    + TOTALS_PAYPAL_SALES * (PAYPAL_SALE_BYTES + 64) + TOTALS_PAYPAL_REFUNDS * (PAYPAL_SALE_BYTES + 64)
    + 2 * 65_536,
  outBytes: 0,
  stripePages: 2 * 20 + 10 + 5 + 3 + 2 * 20,
};
export const TOTALS_STORE_UNITS = 46;

/**
 * Not one of these four reads, said so it is not taken for zero: the first
 * reading of a store's numbers ever (whichever page or job reads them first:
 * the studio's home page, the totals, the API, the weekly email) fills its
 * all-time record from its kept days, once, under a lock (lib/stats.ts,
 * readLife): the lock (SET), two reads of each of KEPT_DAYS days (HGETALL and
 * PFCOUNT), an HINCRBY for each field found (DAY_FIELDS_MAX a day at the
 * most), its marks and the record read again (5). A one-off of each store,
 * reported for its own line (C4-4); tests/read-ceilings.test.ts prints it.
 */
export const LIFE_FILL_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: 1 + 2 * KEPT_DAYS + KEPT_DAYS * DAY_FIELDS_MAX + 5,
  dbBytes: KEPT_DAYS * DAY_FIELDS_MAX * STATS_FIELD_BYTES * 2 + LIFE_WRITE_MAX * STATS_FIELD_BYTES,
  outBytes: 0,
  stripePages: 0,
};
