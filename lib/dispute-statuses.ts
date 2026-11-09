/**
 * Stripe's dispute statuses, read in one place (rule 30; the siblings of
 * #3318, which reads the same three as "lost" in lib/plan-dispute-rules.ts).
 * Pure: imports nothing, so every reader can share one table; today the
 * doors in lib/refunds.ts read it.
 *
 * Every status Stripe gives a dispute: the inquiry stages (warning_*), the
 * chargeback stages (needs_response, under_review) and the closed ones
 * (won, lost, prevented, and the legacy charge_refunded). Statuses read in
 * stripe-node's generated types: v22.6.0 (2026-08-26.dahlia)
 * src/resources/Disputes.ts and v12.18.0 (2022-11-15) types/Disputes.d.ts,
 * with its CHANGELOG (13.0.0 removed `charge_refunded`, 19.0.0 added
 * `prevented`). The reads that use this send no Stripe-Version, or one the
 * creator's account may predate, so the legacy status can still arrive.
 *
 * A status not among them is unknown (CX-123 rule 24): never read as "not
 * returned" and never passed over; the reader throws or stops incomplete.
 *
 * Junctions to come: once #3318 is merged, its private MONEY_RETURNED in
 * lib/plan-dispute-rules.ts can read DISPUTE_RETURNED from here; once #3321
 * is merged, lib/share-settle.ts can read DISPUTE_STATUSES and
 * disputeReturned. lib/retained-revenue.ts DISPUTE_TAKES stays its own set:
 * charge_refunded is left out there, its refund already being counted.
 */

/** Every status Stripe gives a dispute. */
export const DISPUTE_STATUSES: ReadonlySet<string> = new Set([
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "won",
  "lost",
  "prevented",
  "charge_refunded",
]);

/**
 * The closed statuses where the money went back to the buyer: `lost` (the
 * bank took it back), `prevented` (given back before a chargeback, as
 * lib/plan-refund-rules.ts RETURNED and lib/checkup-rules.ts CLOSED read it)
 * and the legacy `charge_refunded` (the charge was refunded while disputed).
 * `won` and `warning_closed` gave nothing back; the open stages have not
 * decided yet.
 */
export const DISPUTE_RETURNED: ReadonlySet<string> = new Set(["lost", "prevented", "charge_refunded"]);

/** Whether `status` is one Stripe gives a dispute. */
export function disputeStatusKnown(status: unknown): status is string {
  return typeof status === "string" && DISPUTE_STATUSES.has(status);
}

/** Whether a dispute in `status` gave the money back to the buyer. */
export function disputeReturned(status: unknown): boolean {
  return typeof status === "string" && DISPUTE_RETURNED.has(status);
}
