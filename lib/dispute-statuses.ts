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
 *     itself moved, with #3321's rule (Claude 6, disputeMoneyGone): returned
 *     only when its balance transactions withdrew more than they reinstated;
 *     nothing withdrawn, or all reinstated, is not returned; a list or an
 *     amount not in Stripe's shape is unknown. The card case type is not
 *     read: it decides nothing the money does not, and the money is there at
 *     every API version;
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
 * Junctions to come: disputeMoneyGone below is a copy, same name and same
 * body, of the one in lib/retained-revenue.ts on #3321 (@31890b10c4). Once
 * #3321 is merged, the copy goes and this module imports it from there (a
 * pure module too, so this one still runs nothing). #3318's MONEY_RETURNED in
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

/**
 * Whether a dispute's own balance transactions took money from the creator
 * and did not put it back. Stripe's `prevented` is either a `resolution`,
 * "resolved (refunded) before it could become a chargeback", or a `block`,
 * stopped by the card network while the merchant keeps the money (API
 * reference, Dispute payment_method_details.card.case_type; changelog basil
 * 2025-08-27). case_type does not exist at the versions read here, so the
 * money is read instead: `balance_transactions` is "zero, one, or two balance
 * transactions that show funds withdrawn and reinstated to your Stripe
 * account as a result of this dispute", and a negative `amount` is funds sent
 * to another party (stripe-node v12.18.0 types/Disputes.d.ts, v22.6.0
 * src/resources/Disputes.ts and BalanceTransactions.ts). `amount`, not `net`:
 * the fee on a withdrawal is Stripe's dispute fee, not money given back.
 *
 * True when more was withdrawn than reinstated; false when nothing was
 * withdrawn or all of it was reinstated; null when the list or any amount is
 * not in that shape (CX-123 rule 24), never read as either. A Refund's money
 * is the Refund's own balance transaction, never one of these, so a
 * resolution that also made a Refund is counted once, by the refund reading.
 *
 * Copied, same name and same body, from lib/retained-revenue.ts on #3321
 * (Claude 6, @31890b10c4); at the junction this copy goes and the import
 * comes from there.
 */
export function disputeMoneyGone(dispute: unknown): boolean | null {
  if (!dispute || typeof dispute !== "object" || Array.isArray(dispute)) return null;
  const moves = (dispute as { balance_transactions?: unknown }).balance_transactions;
  if (!Array.isArray(moves) || moves.length > 2) return null;
  let total = 0;
  for (const move of moves) {
    if (!move || typeof move !== "object" || Array.isArray(move)) return null;
    const { object, amount } = move as { object?: unknown; amount?: unknown };
    if (object !== "balance_transaction" || typeof amount !== "number" || !Number.isSafeInteger(amount)) return null;
    total += amount;
  }
  // A dispute that put back more than it took is not a shape Stripe documents.
  if (total > 0) return null;
  return total < 0;
}

/** Where this dispute's money went, read from its status and, when prevented, the money it moved (the header says why). */
export function disputeMoney(dispute: unknown): DisputeMoney {
  if (!record(dispute)) return "unknown";
  const { status } = dispute;
  if (!disputeStatusKnown(status)) return "unknown";
  if (DISPUTE_RETURNED.has(status)) return "returned";
  if (status !== "prevented") return "not_returned";
  const gone = disputeMoneyGone(dispute);
  if (gone === null) return "unknown";
  return gone ? "returned" : "not_returned";
}

/**
 * The fields disputeMoney() reads, copied off a dispute, so that a row built
 * from it (lib/refunds.ts lostDisputesSince) reads the same as the dispute:
 * its status and, when disputeMoneyGone can read them, its balance
 * transactions' object and amount.
 */
export function disputeMoneyFields(dispute: Record<string, unknown>): Record<string, unknown> {
  if (disputeMoneyGone(dispute) === null) return { status: dispute.status };
  const moves = dispute.balance_transactions as { amount: number }[];
  return { status: dispute.status, balance_transactions: moves.map((move) => ({ object: "balance_transaction", amount: move.amount })) };
}
