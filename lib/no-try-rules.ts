/**
 * When a plan whose renewal is unpaid, and on which Stripe has no try
 * scheduled, has ended (plan-lifecycle pre-reviews, M-a and G-1).
 *
 * A null `next_payment_attempt` is not, by itself, Stripe having stopped:
 * 3DS waiting on the customer and Billing automations can leave it null too
 * (docs/stripe-charge-recovery-study-2026-11-06.md, gap 4; docs.stripe.com
 * could not be read again on 9 November 2026). So nothing ends on day 0: the
 * plan ends NO_TRY_WAIT_DAYS after its renewal was first unpaid, Stripe's
 * longest retry window (Smart Retries: up to two months; a custom schedule
 * has at most three retries) with a day to spare. By then every try Stripe
 * could have scheduled for an invoice that was unpaid that day is over.
 *
 * The clock is the store's: the day it first recorded the renewal unpaid
 * (lib/store.ts renewalUnpaidSince, kept while it stays unpaid, so the
 * renewals Stripe goes on making each period do not reset it), or the latest
 * invoice's own clock when that is earlier (its date; for one paid by link,
 * its due date). Pure: no IO.
 */
export const NO_TRY_WAIT_DAYS = 63;
const WINDOW_SECONDS = NO_TRY_WAIT_DAYS * 86_400;

/**
 * The day the 63 days count from, in seconds: the earlier of the day the
 * renewal was first recorded unpaid and the latest invoice's own clock, each
 * when known (> 0). 0 when neither is.
 */
export function noTryStart(unpaidSince: number, noTryFrom: number): number {
  const known = [unpaidSince, noTryFrom].filter((at) => Number.isSafeInteger(at) && at > 0);
  return known.length ? Math.min(...known) : 0;
}

/** The day such a plan ends if its renewal is still unpaid, in seconds; 0 when its clock is not known. */
export function noTryEndsAt(unpaidSince: number, noTryFrom: number): number {
  const start = noTryStart(unpaidSince, noTryFrom);
  return start ? start + WINDOW_SECONDS : 0;
}

/**
 * Whether a plan Stripe reads as running, with its renewal unpaid and no try
 * scheduled (`noTryFrom` given: the latest invoice's own clock, 0 when it has
 * none), has ended for the store that keeps it. A store that already ended
 * this subscription stays ended while Stripe still says so: only a payment
 * (or a try scheduled again) brings it back. `noTryFrom` undefined: a try is
 * scheduled, or the renewal is paid, and nothing ends here.
 */
export function noTryEnded(
  store: { subscriptionActive: boolean; subscriptionId: string | null; planEndedAt: string; renewalUnpaidSince?: number },
  subscriptionId: string | null,
  noTryFrom: number | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (noTryFrom === undefined) return false;
  const same = Boolean(subscriptionId) && store.subscriptionId === subscriptionId;
  if (same && !store.subscriptionActive && Boolean(store.planEndedAt)) return true;
  const unpaidSince = same && store.subscriptionActive ? store.renewalUnpaidSince ?? 0 : 0;
  // Not recorded unpaid yet: it is from now, as the store is about to record it.
  const start = noTryStart(unpaidSince || nowSeconds, noTryFrom);
  return nowSeconds - start >= WINDOW_SECONDS;
}
