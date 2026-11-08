/**
 * How a reminder whose send failed for a reason that may pass is tried again:
 * the buyer's own ask (lib/checkout-ask.ts), the Store assistant's checkout
 * reminder (lib/assistant-reminder.ts) and the welcome offer reminder
 * (lib/welcome-offer-send.ts). Each is taken off its queue before anything
 * is sent, so two runs never send the same one; a send that then failed (an
 * error on the way, the email service saying no for a moment) is put back,
 * a few times at the most, and only while it is still worth sending. A
 * decision (another store now, too late, already paid, no consent) is never
 * put back. The email itself stays once only: every retry carries the same
 * name (its idempotency key and its sent mark), so it is never a second one.
 */

/** Times one reminder is put back after a failed send, at the most. */
export const REMINDER_RETRIES = 3;

/** How long the next try waits after the given number of tries again: five minutes, then ten, then twenty. */
export const reminderRetryAfter = (tries: number): number => 300 * 2 ** tries;

/**
 * The tries again a queue member says it has had: none when it says nothing
 * (one written before tries were counted, or never tried again); the count
 * when it is one this code writes; and every try used when it is anything
 * else, so a member of no known shape is never tried again.
 */
export function retriesOf(raw: unknown): number {
  if (raw === undefined) return 0;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= REMINDER_RETRIES ? raw : REMINDER_RETRIES;
}
