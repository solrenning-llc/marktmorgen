/**
 * How a recurring series of one call is charged (637 [GL5], unit 5b; added
 * 3 November 2026): the rules, browser-safe. Saving the buyer's card on the
 * creator's Stripe account, making each charge and each refund are the next
 * units (lib/call-series-rules.ts has the dates).
 *
 *   - Each session is charged on its own, at the length's own price, on the
 *     card the buyer saved on the creator's own Stripe account when booking
 *     the series: the first when booking, each other one at the creator's
 *     cancellation deadline before it (lib/call-setup.ts, cancelHours), or
 *     SERIES_CHARGE_HOURS before it when there is none. Never earlier than
 *     the booking, never two sessions at once, never a session that was
 *     cancelled before its charge: a series that ends early (toCancel) stops
 *     every charge still to come.
 *   - A session already charged and not yet held when the series ends: the
 *     creator cancelling refunds it in full; the buyer cancelling is refunded
 *     as a single booking is, by the deadline promised when booking (before
 *     it, in full; past it, not), and with no deadline it is not refunded
 *     by itself, as for a single booking. Charging at the deadline means a
 *     buyer who cancels before it was never charged.
 *   - Not with a deposit, a discount code or a package: their figures are one
 *     booking's. Each session's price is the length chosen (lib/call-lengths.ts).
 */

export const SERIES_CHARGE_HOURS = 24;
const HOUR = 3_600_000;

export type SeriesCharge = { index: number; at: number; cents: number };

/** When each session is charged, and how much: the first now, each other one at the deadline before it. */
export function seriesCharges(starts: readonly number[], cents: number, bookedAt: number, cancelHours?: number): SeriesCharge[] {
  const lead = (cancelHours && cancelHours > 0 ? cancelHours : SERIES_CHARGE_HOURS) * HOUR;
  return starts.map((start, index) => ({ index, at: index === 0 ? bookedAt : Math.max(bookedAt, start - lead), cents }));
}

/** The charges never made once a series ends at `endedAt`: every one still to come. */
export function chargesStopped(charges: readonly SeriesCharge[], endedAt: number): number[] {
  return charges.filter((c) => c.at > endedAt).map((c) => c.index);
}

/**
 * What is refunded when a series ends at `endedAt`, by session: those already
 * charged and not yet started. `by` says who ended it; `promise` is the
 * deadline promised when booking (lib/call-setup.ts, readCancelPromise), or
 * null when none was.
 */
export function refundsOnEnd(
  charges: readonly SeriesCharge[],
  starts: readonly number[],
  endedAt: number,
  by: "creator" | "buyer",
  promise: { hours: number } | null,
): SeriesCharge[] {
  return charges.filter((c) => {
    if (c.at > endedAt || starts[c.index] <= endedAt) return false;
    if (by === "creator") return true;
    return promise ? endedAt <= starts[c.index] - promise.hours * HOUR : false;
  });
}

export type BillingProblem = "deposit" | "code" | "package";

/** Whether a series may be charged this way, or why not. */
export function seriesBillingProblem(input: { deposit: boolean; code: boolean; fromPackage: boolean }): BillingProblem | null {
  if (input.deposit) return "deposit";
  if (input.code) return "code";
  if (input.fromPackage) return "package";
  return null;
}

/** What the buyer is told before booking, in US English (the store's language comes with the booking page's words). */
export function seriesChargeWords(count: number, price: string, store: string, cancelHours?: number): string {
  const when = cancelHours && cancelHours > 0 ? `${cancelHours} hours before it, ${store}'s cancellation deadline` : `${SERIES_CHARGE_HOURS} hours before it`;
  const rest = count - 1 === 1 ? `${price} for the other session ${when}` : `${price} for each of the other ${count - 1} sessions ${when}`;
  return `You pay ${price} for the first session now, and ${rest}. Cancel before a session is charged and you never pay for it.`;
}
