/**
 * How many of a store's API requests a reading takes when it reads more than
 * one request's worth (lib/api-read.ts, lib/mcp-tools.ts).
 *
 * A request is one of the store's monthly figure, priced at a light request:
 * the key, the store and the answer (tests/plan-cost-registry.ts, UNIT_COST.api).
 * A page of products, of the list or of the members reads a page and fits it.
 * A course's students, the affiliates and the bookings read more: a course's
 * page reads each student's progress, the affiliates read the whole program
 * and pages of the creator's Stripe account, the bookings read up to five
 * pages of it and every booking's move. Each of those takes, before it reads,
 * the further requests the work below adds up to, and is refused, with
 * nothing read, when they are not left.
 *
 * One further request pays for at most one of these, in any mix that adds up
 * to one: API_UNIT_COMMANDS database commands, API_UNIT_BYTES bytes read from
 * the database, API_UNIT_SENT_BYTES bytes sent to the caller, API_UNIT_STRIPE_PAGES
 * pages of a Stripe list waited on, API_UNIT_ROUND_TRIPS trips to the database
 * waited on one after another. tests/plan-cost-registry.test.ts holds each
 * figure under a request's price and every reading's units above its cost at
 * every size. Pure: no reads here.
 */
import { MAX_LESSONS } from "@/lib/course";

/** Database commands one further API request pays for. */
export const API_UNIT_COMMANDS = 20;
/** Bytes read from the database one further API request pays for. */
export const API_UNIT_BYTES = 1_000_000;
/** Bytes sent on to the caller one further API request pays for. */
export const API_UNIT_SENT_BYTES = 500_000;
/** Pages of a list at the creator's Stripe account, waited on, one further API request pays for. */
export const API_UNIT_STRIPE_PAGES = 3;
/** Trips to the database waited on one after another that one further API request pays for. */
export const API_UNIT_ROUND_TRIPS = 20;
/** Commands taking the further requests costs (lib/store-allowance.ts, takeAllowance): its count kept, and a store that pays nothing's place. */
export const MORE_TAKE_COMMANDS = 4;

/** What a reading does beyond the request's own key, store and answer. */
export type ReadWork = { commands: number; bytes: number; sent: number; stripePages: number; roundTrips: number };

const NONE: ReadWork = { commands: 0, bytes: 0, sent: 0, stripePages: 0, roundTrips: 0 };

const share = (w: ReadWork) =>
  w.commands / API_UNIT_COMMANDS + w.bytes / API_UNIT_BYTES + w.sent / API_UNIT_SENT_BYTES + w.stripePages / API_UNIT_STRIPE_PAGES + w.roundTrips / API_UNIT_ROUND_TRIPS;

/**
 * The further API requests a reading takes, beyond the request itself: none
 * when it does nothing more, else enough for its work and for taking them.
 * A size that is not a finite count of zero or more is never priced low:
 * it is refused by the caller before this (Infinity here).
 */
export function apiReadUnits(work: Partial<ReadWork>): number {
  const w = { ...NONE, ...work };
  if (Object.values(w).some((n) => !Number.isFinite(n) || n < 0)) return Number.POSITIVE_INFINITY;
  if (share(w) === 0) return 0;
  return Math.ceil(share({ ...w, commands: w.commands + MORE_TAKE_COMMANDS }) - 1e-9);
}

// ---------------------------------------------------------------- students

/** A student's row as a course keeps it: the hashed address it is filed under and the address, when they began and last came back. */
export const STUDENT_ROW_BYTES = 512;
/**
 * What a student marked done, read whole: a lesson id is 32 characters, with
 * room for each, for every lesson a course can hold and as many again for
 * lessons marked and later taken out of it (a review ceiling).
 */
export const DONE_SET_BYTES = 2 * MAX_LESSONS * 40;
/** The course's blocked students are read in one command up to this many; past it, one per student on the page. */
export const BLOCKED_READ_MAX = 200;
/** A blocked student's hashed address, with room. */
export const BLOCKED_ENTRY_BYTES = 64;
/** One student as the API sends it. */
export const STUDENT_SENT_BYTES = 512;

/**
 * What reading the progress of one page of a course's students does, once the
 * page itself is read (lib/learn.ts, studentPage): each student's lessons
 * done, whether each is blocked, the rows and what is sent on.
 */
export function studentsPageWork(rows: number, blocked: number): ReadWork {
  if (rows <= 0) return { ...NONE };
  const whole = blocked <= BLOCKED_READ_MAX;
  return {
    commands: rows + (blocked <= 0 ? 0 : whole ? 1 : rows),
    bytes: rows * (STUDENT_ROW_BYTES + DONE_SET_BYTES) + (blocked <= 0 ? 0 : whole ? blocked * BLOCKED_ENTRY_BYTES : rows * 8),
    sent: rows * STUDENT_SENT_BYTES,
    stripePages: 0,
    roundTrips: 1,
  };
}

// ---------------------------------------------------------------- affiliates

/** How big the affiliate program is, counted before it is read (lib/affiliates.ts, bookSizes). */
export type BookSizes = {
  /** Whether readBook reads anything at all: a store with numbers, and a database. */
  kept: boolean;
  /** Entries in the seven records it reads whole: affiliates, clicks, sales, payouts, partners' shares, paid clicks, leads. */
  entries: number;
  /** Affiliates, each a row sent. */
  people: number;
  /** Leads, of which the open bookings' moves are read. */
  leads: number;
  /** PayPal refunds the store keeps, each read one after another. */
  paypalRefunds: number;
  /** Whether the creator's Stripe account is connected, so its invoices, refunds and disputes are read. */
  stripe: boolean;
  /** Products in the store, of which those sold as memberships through a link are read. */
  products: number;
};

/** The largest entry of any of the program's records: an affiliate's (an address, a note of MAX_NOTE_LENGTH in any script, the rest), with room. */
export const AFFILIATE_ENTRY_BYTES = 2_048;
/** One affiliate as the API sends it. */
export const AFFILIATE_SENT_BYTES = 512;
/** PayPal refunds readBook reads at the most (lib/paypal-sales.ts, readPayPalRefundsWithCoverage). */
export const BOOK_PAYPAL_REFUNDS = 500;
/** A PayPal sale's record, read for its refund: the order, the payment, the buyer, what the visit carried. */
export const PAYPAL_PAID_BYTES = 4_096;
/** Open bookings whose moves readBook reads at the most. */
export const BOOK_MOVES = 200;
/** A booking's move. */
export const MOVE_BYTES = 128;
/** Invoices readBook reads at the most, so products named by them at the most (lib/affiliates.ts, INVOICE_PAGES of a hundred). */
export const BOOK_INVOICES = 1_000;
/** A product's listing, read for its title. */
export const LISTING_BYTES = 16_384;

/** What one reading of the affiliate program does (lib/affiliates.ts, readBook), counted from its sizes and the Stripe pages it may wait on. */
export function bookWork(s: BookSizes, stripePages: number): ReadWork {
  if (!s.kept) return { ...NONE };
  const any = s.entries > 0;
  const paypal = any ? Math.min(s.paypalRefunds, BOOK_PAYPAL_REFUNDS) : 0;
  const moves = Math.min(s.leads, BOOK_MOVES);
  const stripe = s.stripe && s.people > 0;
  const products = stripe ? Math.min(s.products, BOOK_INVOICES) : 0;
  return {
    // Counting it (seven counts and the PayPal refunds'), reading the seven records, then each read below.
    commands: 8 + 7 + (any ? 1 + paypal : 0) + moves + products,
    bytes: s.entries * AFFILIATE_ENTRY_BYTES + paypal * PAYPAL_PAID_BYTES + moves * MOVE_BYTES + products * LISTING_BYTES,
    sent: s.people * AFFILIATE_SENT_BYTES,
    // Invoices while it has affiliates; refunds and disputes while it has anything credited.
    stripePages: s.stripe && any ? stripePages : 0,
    roundTrips: 2 + (any ? 1 + paypal : 0) + (moves ? 1 : 0) + (products ? 1 : 0),
  };
}

// ---------------------------------------------------------------- bookings

/** Pages of a hundred checkouts the bookings read at the most (lib/calls.ts, MAX_PAGES), so bookings at the most. */
export const BOOKING_PAGES = 5;
export const BOOKINGS_READ = BOOKING_PAGES * 100;
/** One booking as the API sends it: its buyer, its times and up to three answers to the creator's questions. */
export const BOOKING_SENT_BYTES = 2_048;

/**
 * What one reading of the bookings does (lib/calls.ts, paidCalls) at the
 * most: every page of checkouts, each booking's move read, and every booking
 * sent. How many there are is known only once Stripe has answered, so it is
 * taken whole, before; a store without Stripe connected reads nothing.
 */
export function bookingsWork(stripe: boolean): ReadWork {
  if (!stripe) return { ...NONE };
  return {
    commands: BOOKINGS_READ,
    bytes: BOOKINGS_READ * MOVE_BYTES,
    sent: BOOKINGS_READ * BOOKING_SENT_BYTES,
    stripePages: BOOKING_PAGES,
    roundTrips: 1,
  };
}
