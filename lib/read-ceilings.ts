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
 *   studio totals      app/studio/totals/page.tsx and the studio's home: a
 *                      page still costs STUDIO_PAGE_UNITS of the studio's
 *                      requests, as the Terms say; each store's visits, sales
 *                      and memberships come from its kept readings, read
 *                      again only from its own daily budget
 *                      (lib/store-readings.ts; owner, 4 November 2026, C4-18).
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
import { DAY_FIELDS_MAX, KEPT_DAYS, LIFE_WRITE_MAX, STATS_DAYS } from "@/lib/stats";
import { CALENDAR_FILE_MAX_BYTES, CALENDAR_REFUSED_PER_HOUR } from "@/lib/calendar-sync";
import { READING_COPY_MAX_BYTES } from "@/lib/store-readings";
import { MAX_PAID_BYTES, PAYPAL_REFUNDS_READ } from "@/lib/paypal-sales";

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
/** The file at its largest, a ceiling the feed holds before it keeps or sends one (lib/calendar-sync.ts, CALENDAR_FILE_MAX_BYTES). */
export const CALENDAR_FILE_BYTES = CALENDAR_FILE_MAX_BYTES;

/**
 * Every answer: the token and its settings (2 GET), the sliding hour's pace
 * (ZADD, ZREMRANGEBYSCORE, ZCARD, EXPIRE and, when refused, ZREM: 5), the
 * copy, the store's handle, the changed mark and the day's credits (one
 * MGET), and, for a store whose handle was let go, its copy deleted (DEL): 9;
 * the copy sent. An answer refused for the pace stops after the pace: 7
 * commands and no copy (CALENDAR_REFUSED_SHAPE).
 */
export const CALENDAR_POLL_SHAPE: ReadShape = {
  seconds: 1,
  cpu: 0.1,
  commands: 2 + 5 + 1 + 1,
  dbBytes: 2 * 4_096 + CALENDAR_FILE_BYTES + 2 * 256,
  outBytes: CALENDAR_FILE_BYTES,
  stripePages: 0,
};
/**
 * The file made again, besides its poll: the day's credits used and the
 * day's own makings (SET NX, INCRBY, EXPIRE NX and, when refused, DECRBY: 4
 * each, 8); the store (its handle and its record: 2 GET) and its settings
 * written again when it was renamed (lib/calendar-sync.ts, ensureFeedToken:
 * GET and SET, 2); its Stripe pages; every call listing (one GET each, up to
 * MAX_PRODUCTS, the catalog's head aside); each booking's moves
 * (lib/call-records.ts, readMoves: one GET a booking); four reads of each
 * booking's room and, for a video room not made yet, its making (SET NX and
 * GET: lib/call-rooms.ts, roomsFor); the copy kept (lib/calendar-sync.ts,
 * KEEP_COPY: the EVAL and the EXISTS and SET it runs, billed one by one: 3);
 * and the store kept in the list whose refunds are read (ZSCORE and ZADD: 2,
 * inbox C4-33).
 */
/** Commands one booking adds to a making: its moves (GET), its room's four reads and its room's making (SET NX and GET). */
export const CALENDAR_BUILD_PER_BOOKING = 1 + 4 + 2;
/** Commands of a making for a store of `listings` call listings and `calls` bookings (tests/read-ceilings.test.ts measures it). */
export function calendarBuildCommands(listings: number, calls: number): number {
  return 8 + 2 + 2 + listings + CALENDAR_BUILD_PER_BOOKING * calls + 3 + 2;
}
export const CALENDAR_BUILD_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: calendarBuildCommands(MAX_PRODUCTS, CALENDAR_CALLS),
  dbBytes: MAX_STORE_BYTES + MAX_PRODUCTS * LISTING_READ_BYTES + CALENDAR_CALLS * 1_024 + 4 * CALENDAR_CALLS * 1_024 + 2 * CALENDAR_CALLS * 512 + CALENDAR_FILE_BYTES,
  outBytes: 0,
  stripePages: CALENDAR_STRIPE_PAGES,
};

/**
 * An answer refused for the sliding hour's pace: the token and its settings
 * (2 GET), the pace (ZADD, ZREMRANGEBYSCORE, ZCARD, EXPIRE: 4) and, refused,
 * its mark taken back and the refusal counted (ZREM, INCR, EXPIRE: 3): 9
 * commands, nothing read or sent besides.
 */
export const CALENDAR_REFUSED_SHAPE: ReadShape = { seconds: 0.2, cpu: 0.01, commands: 2 + 4 + 3, dbBytes: 2 * 4_096, outBytes: 64, stripePages: 0 };
/**
 * Refused answers priced in the feed's line, an hour: every one the address
 * may get before it stops (lib/calendar-sync.ts, CALENDAR_REFUSED_PER_HOUR;
 * inbox C4-33, light a), and the stop itself (GET, DEL, DEL, SET) at one
 * more. Past it the address is let go and what still asks it is an unknown
 * address, answered from the token's one read.
 */
export const CALENDAR_REFUSED_PRICED_PER_HOUR = CALENDAR_REFUSED_PER_HOUR + 1;

/** A PayPal sale's record, at the most, as lib/paypal-sales.ts weighs it (MAX_PAID_BYTES). */
const PAYPAL_SALE_BYTES = MAX_PAID_BYTES;

// ---- The studio's totals of every store -------------------------------------

/** A field of a day's counts or of the all-time record, at the most: its name (up to 96 bytes) and its count. */
const STATS_FIELD_BYTES = 128;
/** The PayPal sales readSales reads (lib/stats.ts, readPaidSales(store, since, 20)) and the refunds (lib/paypal-sales.ts, up to 500). */
const TOTALS_PAYPAL_SALES = 20 * 100;
const TOTALS_PAYPAL_REFUNDS = PAYPAL_REFUNDS_READ;
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
 *                             and refunds (ZRANGEBYSCORE and one MGET of up
 *                             to PAYPAL_REFUNDS_READ: 2; counted here as one a
 *                             refund, above what it is);
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

/**
 * One of a store's readings of the day (lib/store-readings.ts), the dearest
 * kind: its visits (readStats and readLife), its sales (readSales) or its
 * memberships, as TOTALS_STORE_SHAPE counts each; with the copy kept looked
 * at first (GET), the day's count (SET NX, INCRBY, EXPIRE NX: 3, and for a
 * heavy one its own SET NX and INCRBY: 5) and the reading kept (SET: at most
 * READING_COPY_MAX_BYTES). A refused count's DECRBY is in
 * KEPT_READINGS_SHAPE, where nothing is read. Priced, every reading of every
 * day, in the store-readings line (tests/plan-cost-registry.ts).
 */
/** The commands a reading takes beside what it reads (above): GET, the count, SET. */
export const READING_COUNT_COMMANDS = { light: 1 + 3 + 1, heavy: 1 + 5 + 1 } as const;
export const STATS_READ_SHAPE: ReadShape = {
  seconds: 1, cpu: 0.5, commands: (3 * STATS_DAYS + 6) + 4 + READING_COUNT_COMMANDS.light, outBytes: 0, stripePages: 0,
  dbBytes: STATS_DAYS * DAY_FIELDS_MAX * STATS_FIELD_BYTES + STATS_DAYS * 64 + STATS_DAYS * 2 * 32 + LIFE_WRITE_MAX * STATS_FIELD_BYTES + READING_COPY_MAX_BYTES,
};
export const SALES_READ_SHAPE: ReadShape = {
  seconds: 2, cpu: 1, commands: 2 + (1 + TOTALS_PAYPAL_REFUNDS) + READING_COUNT_COMMANDS.heavy, outBytes: 0, stripePages: 2 * 20 + 10 + 5 + 3,
  dbBytes: TOTALS_PAYPAL_SALES * (PAYPAL_SALE_BYTES + 64) + TOTALS_PAYPAL_REFUNDS * (PAYPAL_SALE_BYTES + 64) + READING_COPY_MAX_BYTES,
};
export const MEMBERS_READ_SHAPE: ReadShape = {
  seconds: 2, cpu: 0.5, commands: 2 + READING_COUNT_COMMANDS.light, outBytes: 0, stripePages: 2 * 20,
  dbBytes: 2 * 65_536 + READING_COPY_MAX_BYTES,
};
export const STORE_READING_SHAPES: readonly ReadShape[] = [STATS_READ_SHAPE, SALES_READ_SHAPE, MEMBERS_READ_SHAPE];
/**
 * What a page that shows the numbers takes when it reads nothing (the studio's
 * home, a store's line in the totals): up to three kept readings (GET each);
 * for each, when it is no longer fresh and the day's count refuses it, that
 * count and its DECRBY (a light one 3 + 1, a heavy one 5 + 2: two light, one
 * heavy); and the day's two counts, to offer "Update now" only while one is
 * left (lib/store-readings.ts, readingsLeft).
 */
export const KEPT_READINGS_SHAPE: ReadShape = { seconds: 0, cpu: 0.05, commands: 3 + 2 * (3 + 1) + (5 + 2) + 2, dbBytes: 3 * READING_COPY_MAX_BYTES + 2 * 32, outBytes: 0, stripePages: 0 };

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
