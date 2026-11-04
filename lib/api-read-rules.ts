/**
 * How many of a store's API requests a reading takes when it reads more than
 * one request's worth (lib/api-read.ts, lib/mcp-tools.ts).
 *
 * A request is one of the store's monthly figure, priced at a light request:
 * the key, the store and the answer (tests/plan-cost-registry.ts, UNIT_COST.api),
 * and nothing more. Every reading past the door takes, on top, the further
 * requests its work below adds up to, and is refused with 429 when they are
 * not left: a page of products (its listings), of the list or of the members
 * (its rows, counted as they came back, before they are sent), a course's
 * students (each one's progress), the affiliates (the whole program and pages
 * of the creator's Stripe account), the bookings (up to five pages of it and
 * every booking's move), the numbers (ninety days of counts and up to
 * NUMBERS_STRIPE_PAGES pages of sales, renewals, refunds and disputes), the
 * memberships, the emails and what they sold, the recent events and the
 * discount codes. Whatever can be counted first (the program, the PayPal
 * sales and refunds, the listings a page needs, the emails' records) is
 * counted first; what cannot is taken at its most. A store's own record, the
 * key and the answer's envelope are the door's.
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
import { DAY_FIELDS_MAX, LIFE_WRITE_MAX, STATS_DAYS } from "@/lib/stats";
import { LOG_SIZE, RECENT_MESSAGES_MAX } from "@/lib/webhooks";
import { MAX_CODES } from "@/lib/discount";
import { MAX_FLOWS } from "@/lib/flow-limits";

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
/** And when they do not fit: the one command that gives them back (DECRBY). */
export const MORE_GIVE_BACK_COMMANDS = 1;
/** Trips to the database taking them waits on: a store that pays nothing's place, the count, and the giving back. */
export const MORE_TAKE_ROUND_TRIPS = 3;

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
  // Never rounded down: a share a hair over a whole number takes one more.
  return Math.ceil(share(withTaking(w)));
}

/** The work with what taking the further requests itself costs, at its most (refused, so given back). */
export function withTaking(w: ReadWork): ReadWork {
  return { ...w, commands: w.commands + MORE_TAKE_COMMANDS + MORE_GIVE_BACK_COMMANDS, roundTrips: w.roundTrips + MORE_TAKE_ROUND_TRIPS };
}

// ---------------------------------------------------------------- students

/** A student's row as a course keeps it: the hashed address it is filed under and the address, when they began and last came back. */
// A 254-character address in a three-byte script is 762 bytes, with its hashed key and its two times.
export const STUDENT_ROW_BYTES = 1_024;
/**
 * What a student marked done, read whole: a lesson id is 32 characters, with
 * room for each, for every lesson a course can hold and as many again for
 * lessons marked and later taken out of it (a review ceiling).
 */
// Known gap: the set is not pruned when a lesson is deleted, so a course whose lessons change a lot can pass
// this and its bytes are charged short; the real bound is the store's data room (lib/store-data.ts).
export const DONE_SET_BYTES = 2 * MAX_LESSONS * 40;
/** The course's blocked students are read in one command up to this many; past it, one per student on the page. */
export const BLOCKED_READ_MAX = 200;
/** A blocked student's hashed address, with room. */
export const BLOCKED_ENTRY_BYTES = 64;
/** One student as the API sends it. */
export const STUDENT_SENT_BYTES = 1_024;

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
// Measured at 3,336 bytes for the largest writable affiliate (a 200-character note of control characters
// escaped six bytes each, and a PayPal address not checked by setPayAddress); room above it.
export const AFFILIATE_ENTRY_BYTES = 4_096;
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

// ---------------------------------------------------------------- pages of products, the list and the members

/** One product as the API sends it: its title in any script, its link and the rest. */
export const PRODUCT_SENT_BYTES = 1_024;

/** What one page of products does: each listing the store's own record does not hold, read (lib/catalog.ts, listingsToRead), and every product sent. */
export function productsPageWork(listed: number, read: number): ReadWork {
  if (listed <= 0) return { ...NONE };
  return { commands: read, bytes: read * LISTING_BYTES, sent: listed * PRODUCT_SENT_BYTES, stripePages: 0, roundTrips: read ? 1 : 0 };
}

/**
 * What a page of a list read with HSCAN did, counted as it came back and
 * before it is sent: its commands, the bytes Redis answered with and the
 * bytes the answer holds. A page's rows cannot be counted before they are
 * read (COUNT is only a hint), so the scan is the door's, and nothing is sent
 * unless what it read is taken.
 */
export function scannedPageWork(commands: number, readBytes: number, sentBytes: number): ReadWork {
  return { commands, bytes: readBytes, sent: sentBytes, stripePages: 0, roundTrips: 1 };
}

// ---------------------------------------------------------------- numbers

/** A day's count field: a source, tag, country or device name with its number. */
export const STATS_FIELD_BYTES = 128;
/** An all-time field, as Marktmorgen Path prices it (tests/plan-cost-registry.ts, PATH_READ). */
export const LIFE_FIELD_BYTES = 96;
/** Pages the numbers' sales read at the most (lib/stats.ts, readSales): checkouts and charges side by side, renewals, refunds, disputes. */
export const SALES_PAGES = 20;
export const RENEWAL_PAGES = 10;
export const REFUND_READ_PAGES = 5;
export const DISPUTE_READ_PAGES = 3;
export const NUMBERS_STRIPE_PAGES = 2 * SALES_PAGES + RENEWAL_PAGES + REFUND_READ_PAGES + DISPUTE_READ_PAGES;
/** PayPal sales the numbers read at the most (readPaidSales, a hundred a page), and PayPal refunds (readPayPalRefundsWithCoverage). */
export const NUMBERS_PAYPAL_SALES = SALES_PAGES * 100;
/** The numbers as sent, with every row (?details=all): a review ceiling. */
export const NUMBERS_SENT_BYTES = 1_000_000;

/** What the numbers read can be sized by first. */
export type NumbersSizes = {
  /** Whether the store keeps numbers at all (an id for them, and a database). */
  kept: boolean;
  /** Whether it reads sales (lib/stats.ts, readsSales). */
  sales: boolean;
  stripe: boolean;
  /** PayPal sales and refunds it keeps, of which it reads up to its most. */
  paypalSales: number;
  paypalRefunds: number;
};

/**
 * What one reading of the numbers does (lib/stats-report.ts readNumbers,
 * lib/mcp-tools.ts readFullNumbers): ninety days of counts and the ninety
 * before, the all-time record (read, its gap kept, trimmed), and with sales
 * the PayPal sales and refunds counted first and every Stripe page at its
 * most. The all-time record's one filling from the days before it (once in a
 * store's life, under a lock) is not a reading's: it is not priced here.
 * The listings readFullNumbers names are taken apart, once counted.
 */
export function numbersWork(s: NumbersSizes): ReadWork {
  if (!s.kept) return { ...NONE };
  const paypalSales = s.sales ? Math.min(s.paypalSales, NUMBERS_PAYPAL_SALES) : 0;
  const paypalRefunds = s.sales ? Math.min(s.paypalRefunds, BOOK_PAYPAL_REFUNDS) : 0;
  return {
    commands: 3 * STATS_DAYS + 6 + 4 + (s.sales ? 2 + 1 + paypalRefunds : 0),
    bytes: STATS_DAYS * DAY_FIELDS_MAX * STATS_FIELD_BYTES + STATS_DAYS * 64 + LIFE_WRITE_MAX * LIFE_FIELD_BYTES + (paypalSales + paypalRefunds) * PAYPAL_PAID_BYTES,
    sent: NUMBERS_SENT_BYTES,
    stripePages: s.sales && s.stripe ? NUMBERS_STRIPE_PAGES : 0,
    roundTrips: 4 + (s.sales ? 2 + 1 + paypalRefunds : 0),
  };
}

/** The listings readFullNumbers reads for the products the numbers name, once it knows them. */
export function listingsWork(read: number): ReadWork {
  return read > 0 ? { commands: read, bytes: read * LISTING_BYTES, sent: 0, stripePages: 0, roundTrips: 1 } : { ...NONE };
}

// ---------------------------------------------------------------- memberships

/** Pages of subscriptions and of invoices the membership numbers read when not kept (lib/membership-numbers.ts, MAX_PAGES each). */
export const MEMBERSHIP_PAGES = 2 * 20;
/** The membership numbers as kept and as sent: by product, by channel, why members left, thirteen months: a review ceiling. */
export const MEMBERSHIP_NUMBERS_BYTES = 256_000;
/** The titles the memberships are named by: every product's id and title in any script (lib/catalog.ts, readTitles). */
export const TITLE_BYTES = 512;

/** What get_memberships does before Stripe: the kept numbers looked for, the titles read, the answer sent. */
export function membershipsWork(products: number): ReadWork {
  return { commands: 2, bytes: MEMBERSHIP_NUMBERS_BYTES + products * TITLE_BYTES, sent: MEMBERSHIP_NUMBERS_BYTES, stripePages: 0, roundTrips: 2 };
}
/** And when they are not kept: every page of subscriptions and invoices, and the numbers kept again. */
export const MEMBERSHIPS_COLD_WORK: ReadWork = { commands: 1, bytes: MEMBERSHIP_NUMBERS_BYTES, sent: 0, stripePages: MEMBERSHIP_PAGES, roundTrips: 1 };

// ---------------------------------------------------------------- emails

/** Broadcasts get_emails reads (lib/mcp-tools.ts, emailsTool), and what one sent is told back: its subject and numbers. */
export const EMAILS_BROADCASTS = 30;
export const EMAIL_SENT_BYTES = 1_024;
/** A sequence's counts, as the store's data registry prices them (20 KB a sequence). */
export const FLOW_STATS_BYTES = 20 * 1024;
/** Pages of sales what the emails sold reads when not kept (lib/mail-revenue.ts, PAGES): checkouts and charges side by side. */
export const MAIL_REVENUE_PAGES = 2 * 10;
/** What the emails sold, as kept: by campaign (a review ceiling). */
export const MAIL_REVENUE_BYTES = 64_000;

/**
 * What get_emails reads, sized first: its broadcasts and its sequences
 * measured by their bytes (one LRANGE and a STRLEN each), then the list's
 * counts, the records, each sequence's counts at the most and what they sold
 * as kept, and every one told back.
 */
export function emailsWork(s: { broadcasts: number; broadcastBytes: number; flowBytes: number }): ReadWork {
  return {
    commands: 2 + s.broadcasts + 3 + 1 + 1 + s.broadcasts + MAX_FLOWS + 1,
    bytes: s.broadcastBytes + s.flowBytes + MAX_FLOWS * FLOW_STATS_BYTES + MAIL_REVENUE_BYTES,
    sent: (s.broadcasts + MAX_FLOWS) * EMAIL_SENT_BYTES,
    stripePages: 0,
    roundTrips: 2 + 4,
  };
}
/** And when what they sold is not kept: every page of sales, the PayPal sales counted first, kept again. */
export function mailRevenueColdWork(paypalSales: number): ReadWork {
  const paypal = Math.min(paypalSales, 10 * 100);
  return { commands: 3, bytes: paypal * PAYPAL_PAID_BYTES + MAIL_REVENUE_BYTES, sent: 0, stripePages: MAIL_REVENUE_PAGES, roundTrips: 2 };
}

// ---------------------------------------------------------------- events and codes

/** A delivery as the store's data registry prices one (4 KB); the events read the newest LOG_SIZE and send RECENT_MESSAGES_MAX (lib/webhooks.ts). */
export const DELIVERY_BYTES = 4 * 1024;
export function eventsWork(): ReadWork {
  return { commands: 1 + LOG_SIZE, bytes: LOG_SIZE * (64 + DELIVERY_BYTES), sent: RECENT_MESSAGES_MAX * DELIVERY_BYTES, stripePages: 0, roundTrips: 2 };
}

/** A discount code as sent; the codes are one page of the creator's Stripe account (lib/discount.ts, MAX_CODES a page). */
export const CODE_SENT_BYTES = 1_024;
export function codesWork(): ReadWork {
  return { commands: 0, bytes: 0, sent: MAX_CODES * CODE_SENT_BYTES, stripePages: 1, roundTrips: 0 };
}
