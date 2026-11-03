/**
 * How a recurring series of one call is charged (637 [GL5], unit 5b; added
 * 3 November 2026): the rules, browser-safe. Saving the buyer's card on the
 * creator's Stripe account, making each charge and each refund are the next
 * units (lib/call-series-rules.ts has the dates and toCancel).
 *
 *   - Each session is charged on its own, at the length's own price, on the
 *     card the buyer saves on the creator's own Stripe account when booking
 *     the series: the first when booking, each other one at the deadline
 *     before it, or SERIES_CHARGE_HOURS before it when there is none. The
 *     deadline is the cancellation deadline promised when booking, one of
 *     SERIES_DEADLINES (the creator's cancellation deadline of 520 [LB1],
 *     unit 7a, pull request #1762, once it is merged; until then there is
 *     none), always shorter than the cadence, so two sessions are never
 *     charged at once after the first.
 *   - Whether a session was charged is read from its charge's own record,
 *     never from the time it was due: the unit that charges reads the
 *     session again under a lock right before charging, and never charges
 *     one canceled (toStop); a series that ends early stops every session
 *     not yet charged.
 *   - A charge that fails (a card refused, or the bank asking the buyer to
 *     confirm): the buyer is emailed a link to pay with the card in hand
 *     until PAY_BY_HOURS before the session; unpaid by then, the session is
 *     canceled, its time freed, and nothing is charged (failedCharge).
 *   - A session charged and not yet held when the series ends: the creator
 *     ending it refunds it in full; the buyer ending it is refunded in full
 *     when they end it before the deadline (which is when it is charged, so
 *     such a session was usually never charged), and not after it; with no
 *     deadline promised, a session already charged is not refunded by
 *     itself. The first session, booked inside the deadline, is never
 *     refundable by the buyer, and the words say so.
 *   - Not with a deposit, a discount code or a package: their figures are one
 *     booking's. Each session's price is the length chosen (lib/call-lengths.ts).
 *   - The words a buyer agrees to before booking (seriesChargeWords) say the
 *     card is saved and charged later without them, each amount and when,
 *     the total, what happens when a charge fails and how canceling works.
 *     Before they are shown, the booking unit checks against Stripe's and the
 *     card networks' official, dated rules what an agreement to future
 *     charges on a saved card must say, and adds it.
 */

export const SERIES_CHARGE_HOURS = 24;
/** The deadlines a series may be charged at: the creator's cancellation deadlines, all shorter than a week. */
export const SERIES_DEADLINES = [2, 12, 24, 48, 72] as const;
/** A failed charge may be paid by the buyer until this long before the session. */
export const PAY_BY_HOURS = 2;
const HOUR = 3_600_000;

export type SeriesCharge = { index: number; at: number; cents: number };

const deadlineOf = (hours: unknown): number | null => ((SERIES_DEADLINES as readonly unknown[]).includes(hours) ? (hours as number) : null);

/**
 * When each session is due to be charged, and how much: the first now, each
 * other one at the deadline before it. Null when the amount is not a whole
 * positive number of the currency's smallest unit at or above `least` (the
 * currency's smallest charge, lib/money.ts), or the deadline is not one of
 * SERIES_DEADLINES.
 */
export function seriesCharges(starts: readonly number[], cents: number, bookedAt: number, least: number, deadlineHours?: number): SeriesCharge[] | null {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents < least) return null;
  if (deadlineHours !== undefined && deadlineOf(deadlineHours) === null) return null;
  const lead = (deadlineHours ?? SERIES_CHARGE_HOURS) * HOUR;
  return starts.map((start, index) => ({ index, at: index === 0 ? bookedAt : Math.max(bookedAt, start - lead), cents }));
}

/** The sessions that must never be charged: every one canceled and not yet charged (its record says so). */
export function toStop(canceled: readonly number[], charged: ReadonlySet<number>): number[] {
  return canceled.filter((index) => !charged.has(index));
}

/** What a failed charge comes to: paid with the card in hand until PAY_BY_HOURS before the session, or the session canceled and its time freed. */
export function failedCharge(start: number, now: number): "pay_by_link" | "cancel" {
  return now < start - PAY_BY_HOURS * HOUR ? "pay_by_link" : "cancel";
}

/**
 * What is refunded when a series ends at `endedAt`: each session charged
 * (by its record, with what it was charged) and not yet started. `by` says
 * who ended it; `deadlineHours` is the deadline promised when booking, or
 * none.
 */
export function refundsOnEnd(
  charged: readonly SeriesCharge[],
  starts: readonly number[],
  endedAt: number,
  by: "creator" | "buyer",
  deadlineHours?: number,
): SeriesCharge[] {
  const deadline = deadlineOf(deadlineHours);
  return charged.filter((c) => {
    if (starts[c.index] <= endedAt) return false;
    if (by === "creator") return true;
    // Before the deadline, in full; at or after it, not; the same instant counts as late, as a charge at the deadline is made.
    return deadline !== null && endedAt < starts[c.index] - deadline * HOUR;
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

/**
 * What the buyer agrees to before booking, in US English (the store's
 * language comes with the booking page's words): `price` and `total` already
 * written in the store's currency, `dates` each session's day and time.
 */
export function seriesChargeWords(input: { count: number; price: string; total: string; dates: string[]; store: string; deadlineHours?: number }): string {
  const deadline = deadlineOf(input.deadlineHours);
  const when = deadline ? `${deadline} hours before it starts` : `${SERIES_CHARGE_HOURS} hours before it starts`;
  return [
    `You book ${input.count} sessions for ${input.total} in all: ${input.dates.join("; ")}.`,
    `Your card is saved with ${input.store}'s payment account and charged ${input.price} for each session, without you there: the first now, and each other one ${when}.`,
    `If a charge does not go through, we email you a link to pay it yourself until ${PAY_BY_HOURS} hours before that session. If it is not paid by then, that session is canceled and you are not charged for it.`,
    deadline
      ? `Cancel a session before it is charged and you never pay for it. Once charged, it is not refunded. The first session is charged now and is not refunded.`
      : `Cancel a session before it is charged and you never pay for it. Once charged, a session is not refunded by itself; ask ${input.store}.`,
  ].join(" ");
}
