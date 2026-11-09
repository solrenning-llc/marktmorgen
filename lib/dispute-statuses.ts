/**
 * Stripe's disputes, read in one place (rule 30; the siblings of #3318, which
 * reads which disputes gave the money back in lib/plan-dispute-rules.ts).
 * Pure: imports nothing, so every reader can share one table; today the
 * doors in lib/refunds.ts read it.
 *
 * Every status Stripe gives a dispute: the inquiry stages (warning_*), the
 * chargeback stages (needs_response, under_review), the appeal stages
 * (appeal_needs_response, appeal_under_review) and the closed ones (won,
 * lost, prevented, and the legacy charge_refunded). Read in stripe-node's
 * generated types: v23.1.0 (2026-10-28.endive) cjs/resources/Disputes.d.ts
 * (`Status`, `balance_transactions`, `PaymentMethodDetails.Card.CaseType`),
 * with its CHANGELOG (19.0.0 added `prevented`, 18.5.0 the case types
 * `block` and `resolution`, 23.1.0 the appeal stages, 13.0.0 removed
 * `charge_refunded`); and v12.18.0 (2022-11-15) types/Disputes.d.ts for
 * `charge_refunded` and `balance_transactions` ("zero, one, or two balance
 * transactions that show funds withdrawn and reinstated to your Stripe
 * account as a result of this dispute", in both versions). The reads that
 * use this send no Stripe-Version, so the creator's account version decides
 * what arrives, and the legacy status can still come.
 *
 * Where the money went (disputeMoney):
 *   - `lost`: the bank took the money back for the buyer;
 *   - `prevented`: Stripe gives it for two opposite outcomes (Claude 2's
 *     money review of #3323, comment 6732285842, quoting the API reference;
 *     docs.stripe.com could not be read from here): resolved "(refunded)
 *     before it could become a chargeback", or blocked by the card network,
 *     the creator keeping the money. So it is read by the money the dispute
 *     itself moved, as #3321 reads it (Claude 6): returned only when its
 *     balance transactions withdrew money from the creator's account and did
 *     not reinstate it; nothing moved, or all reinstated, is not returned;
 *     balance transactions missing or unreadable are unknown. The card case
 *     type is not read: it decides nothing the money does not, and the money
 *     is there at every API version;
 *   - `charge_refunded` (legacy): a dispute won on a charge that was refunded
 *     (changelog 2014-11-20, as the review quotes it). The money went back
 *     through the refund, which the refund doors read at the amount the
 *     charge itself gave back; the dispute gives nothing back of its own, so
 *     a partial refund is never made whole by it;
 *   - `won`, `warning_closed`: nothing went back; the open stages and the
 *     appeal stages: not decided yet, so nothing went back by the dispute.
 *
 * A status not among them, or anything that is not a dispute, is unknown
 * (CX-123 rule 24): never read as "not returned" and never passed over; the
 * reader throws or stops incomplete.
 *
 * Junctions to come: disputeNetWithdrawnCents is a stand-in for the helper
 * Claude 6 is writing in #3321 with the same rule; once that one is merged,
 * this one gives way to it. #3318's MONEY_RETURNED in
 * lib/plan-dispute-rules.ts and lib/plan-refund-rules.ts RETURNED (which
 * still reads every `prevented` as returned) can read disputeMoney from here,
 * given the dispute and not only its status. lib/retained-revenue.ts
 * DISPUTE_TAKES stays its own set: charge_refunded is left out there, its
 * refund already being counted.
 */

/** Every status Stripe gives a dispute. */
export const DISPUTE_STATUSES: ReadonlySet<string> = new Set([
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "appeal_needs_response",
  "appeal_under_review",
  "won",
  "lost",
  "prevented",
  "charge_refunded",
]);

/**
 * The appeal stages: a decision appealed and not settled again yet. The doors
 * read them as nothing given back by the dispute (disputeMoney); a reader of
 * money held (lib/stats.ts) cannot place them until DISPUTE_TAKES
 * (lib/retained-revenue.ts) does, so it reads them as not read, never as
 * nothing taken.
 */
export const DISPUTE_APPEAL_STAGES: ReadonlySet<string> = new Set(["appeal_needs_response", "appeal_under_review"]);

/** The statuses whose money always went back to the buyer: `lost`. A `prevented` one is read by its money. */
export const DISPUTE_RETURNED: ReadonlySet<string> = new Set(["lost"]);

/** Where a dispute's money went: back to the buyer, not back (kept, or not decided yet), or unknown. */
export type DisputeMoney = "returned" | "not_returned" | "unknown";

/** Whether `status` is one Stripe gives a dispute. */
export function disputeStatusKnown(status: unknown): status is string {
  return typeof status === "string" && DISPUTE_STATUSES.has(status);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A dispute's balance transactions, each with whole cents and a currency, all in one; null when any of it cannot be read. */
function moves(dispute: unknown): { amount: number; currency: string }[] | null {
  if (!record(dispute) || !Array.isArray(dispute.balance_transactions)) return null;
  const out: { amount: number; currency: string }[] = [];
  for (const move of dispute.balance_transactions as unknown[]) {
    if (!record(move) || !Number.isSafeInteger(move.amount) || typeof move.currency !== "string" || !move.currency) return null;
    if (out.length && out[0].currency !== move.currency) return null;
    out.push({ amount: move.amount as number, currency: move.currency });
  }
  return out;
}

/**
 * What this dispute took from the creator's account and kept, in cents: its
 * withdrawals less its reinstatements (0 when nothing moved or all came
 * back). Null when that cannot be read: no balance transactions, one that is
 * not whole cents or has no currency, two currencies, or more reinstated
 * than withdrawn. Never zero for unknown.
 */
export function disputeNetWithdrawnCents(dispute: unknown): number | null {
  const listed = moves(dispute);
  if (!listed) return null;
  const net = -listed.reduce((sum, move) => sum + move.amount, 0);
  return Number.isSafeInteger(net) && net >= 0 ? net : null;
}

/** Where this dispute's money went, read from its status and, when prevented, the money it moved (the header says why). */
export function disputeMoney(dispute: unknown): DisputeMoney {
  if (!record(dispute)) return "unknown";
  const { status } = dispute;
  if (!disputeStatusKnown(status)) return "unknown";
  if (DISPUTE_RETURNED.has(status)) return "returned";
  if (status !== "prevented") return "not_returned";
  const net = disputeNetWithdrawnCents(dispute);
  if (net === null) return "unknown";
  return net > 0 ? "returned" : "not_returned";
}

/**
 * The fields disputeMoney() reads, copied off a dispute, so that a row built
 * from it (lib/refunds.ts lostDisputesSince) reads the same as the dispute:
 * its status and, when they can be read, its balance transactions' amounts
 * and currency.
 */
export function disputeMoneyFields(dispute: Record<string, unknown>): Record<string, unknown> {
  const listed = moves(dispute);
  return listed === null ? { status: dispute.status } : { status: dispute.status, balance_transactions: listed.map((move) => ({ ...move })) };
}
