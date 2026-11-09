/**
 * What a booking page's open times cost in the store's own requests, taken
 * before they are read (traffic audit, 9 November 2026; owner's rule MR: a
 * ceiling before every spend). Until then the page
 * (app/[handle]/book/[product]/page.tsx) asked the creator's Stripe account
 * for every load, and for every made-up `?move=`, without counting a single
 * request, so a robot could make it ask without any ceiling, and use up the
 * creator's Stripe rate limit their checkout needs.
 *
 * The page is one request (lib/traffic.ts, isResting, before the call is
 * read). Its times (lib/calls.ts, slotsForProduct and slotsForMove, both
 * reading readBusy) are bookTimesUnits more, taken with takePublicRequest
 * before they are read: past the window, the resting page, and Stripe is not
 * asked. Each request is priced as a later page (tests/traffic-cost.ts,
 * laterPageCost); tests/plan-cost-registry.test.ts holds the units above
 * what the reading costs at its worst (bookTimesRead in
 * tests/plan-cost-registry.ts) for every size of store.
 */
import { MAX_PRODUCTS } from "@/lib/catalog-rules";

/**
 * The creator's Stripe account read for one reading of the times, at the
 * most: lib/calls.ts readCallSessions reads `MAX_PAGES` (5, the same as
 * lib/read-ceilings.ts CALENDAR_STRIPE_PAGES) pages of completed checkouts
 * and asks about DISPUTE_READS_PER_READING (5) disputed charges.
 * tests/plan-cost-registry.test.ts fails when either moves.
 */
export const BOOK_STRIPE_READS = 5 + 5;

/**
 * The requests a reading of the times takes with its first
 * BOOK_LISTINGS_IN_BASE call listings: the creator's Stripe account
 * (BOOK_STRIPE_READS), the creator's own calendars (read beside Stripe, not
 * after it), the diary of holds and bookings with their moves, and the
 * bookings caught up after the page is sent (tests/plan-cost-registry.ts,
 * bookTimesRead).
 */
export const BOOK_TIMES_BASE_UNITS = 8;

/** Call listings the base already pays for. */
export const BOOK_LISTINGS_IN_BASE = 20;

/** Further call listings read (one GET each, lib/catalog.ts readListings) per request. */
export const BOOK_LISTINGS_PER_UNIT = 24;

/**
 * The requests one reading of a booking page's times takes, before it
 * reads, for a store with `callListings` call products (lib/catalog.ts,
 * idsOfKind(store, "call"), read from the store record with no command).
 */
export function bookTimesUnits(callListings: number): number {
  // A count that is not a whole number is not known: priced at the most a store can list.
  const listings = Number.isSafeInteger(callListings) && callListings >= 0 ? callListings : MAX_PRODUCTS;
  return BOOK_TIMES_BASE_UNITS + Math.ceil(Math.max(0, listings - BOOK_LISTINGS_IN_BASE) / BOOK_LISTINGS_PER_UNIT);
}

/** A checkout session's id, as Stripe makes it (lib/store-checkout.ts, readOrder, reads nothing else). */
export const BOOKING_SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/**
 * The store's diary of holds and bookings, one field per checkout session
 * (lib/calls.ts, busyKey: not exported there, and the file is in open pull
 * requests; tests/book-admission-buyer.test.ts fails when it moves).
 */
export const bookingDiaryKey = (callsId: string) => `nl:call:busy:${callsId}`;
