/**
 * How a reminder whose send failed for a reason that may pass is tried again:
 * the buyer's own ask (lib/checkout-ask.ts), the Store assistant's checkout
 * reminder (lib/assistant-reminder.ts) and the welcome offer reminder
 * (lib/welcome-offer-send.ts). Each is taken off its queue before anything
 * is sent, so two runs never send the same one; a try that then failed
 * before the email service was asked (a Redis or Stripe error on the way) is
 * put back, a few times at the most, and only while it is still worth
 * sending. A decision (another store now, too late, already paid, no
 * consent) is never put back. The email itself stays once only: every retry
 * carries the same name (its idempotency key and its sent mark), so it is
 * never a second one.
 *
 * Once the email service was asked, it is never tried again (Claude 2 on
 * #3214): sendEmail (lib/email.ts) answers only true or false, so a refusal
 * (a 4xx, an address it will never take, an uncertain SES answer) cannot be
 * told from a failure that may pass, and each ask takes the store's email
 * room again. Trying those again needs a reason from sendEmail. A throw from
 * inside it (an unknown allowance reply) still reads as a failure on the way
 * where the send is behind lib/checkout-recovery.ts's deliver, so the most
 * room such a reminder can take is REMINDER_RETRIES + 1 asks, never more.
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
