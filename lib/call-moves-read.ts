/**
 * What reading many bookings' moves costs (lib/call-records.ts, readMoves).
 *
 * The moves are read MOVES_PER_MGET keys at one MGET, every MGET of a reading
 * in one trip to the database: a few commands, not one a booking. Each key is
 * sent, and each move found comes back. Whoever pays for such a reading (the
 * orders page's meter, lib/buyer-orders-rules.ts; the API's bookings and
 * affiliates, lib/api-read-rules.ts) counts it from here, and
 * tests/plan-cost-registry.test.ts holds MOVES_PER_MGET to readMoves' own.
 * Pure: no reads here.
 */

/** Moves read at one MGET at the most. */
export const MOVES_PER_MGET = 100;
/** A booking's move as kept: { s, e, n }, with room. */
export const MOVE_BYTES = 128;
/**
 * A move's key as sent: movedKey's prefix (lib/call-records.ts) and the checkout session's id, which
 * Stripe keeps under 255 characters, with room.
 */
export const MOVE_KEY_BYTES = 320;

/** The MGETs reading the moves of this many bookings takes; a count that is not a number is never priced low. */
export function moveReads(bookings: number): number {
  if (Number.isNaN(bookings) || bookings === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return bookings > 0 ? Math.ceil(bookings / MOVES_PER_MGET) : 0;
}
