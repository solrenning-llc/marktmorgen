/**
 * How a recurring series of one call is charged (637 [GL5], unit 5b; added
 * 3 November 2026): the rules, browser-safe. Saving the buyer's card on the
 * creator's Stripe account, making each charge and each refund are the next
 * units (lib/call-series-rules.ts has the dates and toCancel).
 *
 *   - Each session is charged on its own, at the length's own price, on the
 *     card the buyer saves on the creator's own Stripe account when booking
 *     the series: the first when booking, each other one at the deadline
 *     before it, or SERIES_CHARGE_HOURS before it when there is none, and
 *     never later than PAY_BY_HOURS + PAY_WINDOW_HOURS before it, so a
 *     charge that fails always leaves the buyer time to pay it by the link
 *     (chargeDueAt). The deadline is the cancellation deadline promised when
 *     booking, one of SERIES_DEADLINES (the creator's cancellation deadline
 *     of 520 [LB1], unit 7a: the same list as CANCEL_HOURS in
 *     lib/call-setup.ts, imported from there once this branch carries it),
 *     always shorter than the cadence, so two sessions are never charged at
 *     once after the first. A session moved within the rules is charged at
 *     its new start's due time, worked out again from it (chargeDueAt).
 *   - Each session's charge is made under its own key (chargeKey), and the
 *     link to pay a failed one confirms that same charge, so a retry and the
 *     link never charge a session twice.
 *   - Whether a session was charged is read from its charge's own record,
 *     never from the time it was due: the unit that charges reads the
 *     session again under a lock right before charging, and never charges
 *     one canceled (toStop); a series that ends early stops every session
 *     not yet charged.
 *   - A charge that fails (a card refused, or the bank asking the buyer to
 *     confirm): the buyer is emailed a link to pay with the card in hand
 *     until PAY_BY_HOURS before the session; unpaid by then, the session is
 *     canceled, its time freed, and nothing is charged (failedCharge).
 *   - A session charged and not yet held when the series ends, or when the
 *     buyer cancels that one session: the creator canceling refunds it in
 *     full; the buyer canceling is refunded in full when it is at least the
 *     deadline before the session, as 520 [LB1] promises for one booking
 *     ("at least 24 hours before": the instant itself counts), and not
 *     after; with no deadline promised, a session already charged is not
 *     refunded by itself. The first session follows the same rule; when it
 *     already starts inside the deadline at booking, no time is left to
 *     cancel it in, and the words say so, as LB1's cancelTooLate does.
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
/** The least time a buyer has to pay a failed charge by the link: a session is charged at least PAY_BY_HOURS + this before it. */
export const PAY_WINDOW_HOURS = 10;
const HOUR = 3_600_000;

/** How long before a session (after the first) it is charged: the deadline, or SERIES_CHARGE_HOURS without one, never less than PAY_BY_HOURS + PAY_WINDOW_HOURS. */
export function chargeLeadHours(deadlineHours?: number): number {
  return Math.max(deadlineHours ?? SERIES_CHARGE_HOURS, PAY_BY_HOURS + PAY_WINDOW_HOURS);
}

/** When a session is due to be charged: the first at booking, each other one chargeLeadHours before its start as it is now (a moved session's new start), never before the booking. */
export function chargeDueAt(index: number, start: number, bookedAt: number, deadlineHours?: number): number {
  return index === 0 ? bookedAt : Math.max(bookedAt, start - chargeLeadHours(deadlineHours) * HOUR);
}

/** The key one session's charge is made under on the creator's Stripe account (its idempotency key), the same for a retry and for the link to pay it. */
export function chargeKey(seriesId: string, index: number): string {
  return `series:${seriesId}:${index}`;
}

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
  return starts.map((start, index) => ({ index, at: chargeDueAt(index, start, bookedAt, deadlineHours), cents }));
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
    // At least the deadline before the session, in full, the instant itself included (520 [LB1]: "at least 24 hours before"); later, not.
    return deadline !== null && endedAt <= starts[c.index] - deadline * HOUR;
  });
}

/** Whether one session the buyer or the creator cancels on its own is refunded: the same rule as a series ending, for that session alone. */
export function sessionRefunded(charge: SeriesCharge, start: number, canceledAt: number, by: "creator" | "buyer", deadlineHours?: number): boolean {
  const starts: number[] = [];
  starts[charge.index] = start;
  return refundsOnEnd([charge], starts, canceledAt, by, deadlineHours).length === 1;
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
 * language comes with the booking page's words), worked out from the
 * charges themselves so the count, each amount and the total can never say
 * other than what will be charged: `charges` from seriesCharges, `starts`
 * each session's start, `dates` each session's day and time as said, and
 * `money` the store's currency formatter. Throws when they do not agree.
 */
export function seriesChargeWords(input: { charges: readonly SeriesCharge[]; starts: readonly number[]; dates: readonly string[]; money: (cents: number) => string; store: string; bookedAt: number; deadlineHours?: number }): string {
  const { charges, starts, dates, store } = input;
  if (!charges.length || charges.length !== dates.length || charges.length !== starts.length) throw new Error("series words: the charges, the starts and the dates do not agree");
  if (charges.some((c, i) => c.index !== i || c.cents !== charges[0].cents)) throw new Error("series words: every session is one charge at the same price, in order");
  const deadline = deadlineOf(input.deadlineHours);
  const lead = chargeLeadHours(deadline ?? undefined);
  const total = input.money(charges.reduce((sum, c) => sum + c.cents, 0));
  const price = input.money(charges[0].cents);
  // The first already starts inside the deadline when booked: no time is left to cancel it in (520 [LB1], cancelTooLate).
  const firstLate = deadline !== null && starts[0] - input.bookedAt < deadline * HOUR;
  return [
    `You book ${charges.length} sessions for ${total} in all: ${dates.join("; ")}.`,
    `Your card is saved with ${store}'s payment account and charged ${price} for each session, without you there: the first now, and each other one ${lead} hours before it starts.`,
    `If a charge does not go through, we email you a link to pay it yourself until ${PAY_BY_HOURS} hours before that session. If it is not paid by then, that session is canceled and you are not charged for it.`,
    deadline
      ? `Cancel a session at least ${deadline} hours before it starts and you pay nothing for it: one already charged${firstLate ? "" : ", the first included,"} is refunded. If you cancel later or miss it, it is not refunded.${firstLate ? ` The first session starts in less than ${deadline} hours, so it is not refunded.` : ""}`
      : `Cancel a session before it is charged and you never pay for it. Once charged, a session is not refunded by itself; ask ${store}.`,
    `If ${store} cancels, you get back what was charged for every session not held. This does not affect your rights under the law.`,
  ].join(" ");
}
