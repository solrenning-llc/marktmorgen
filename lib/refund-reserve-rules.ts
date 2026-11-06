/**
 * The money the platform's Stripe balance must keep for plan refunds and
 * disputes (306 [SY2] unit 1): the rule only. Nothing calls it yet; the
 * reading of the charges, the daily payout of what is above it and the lock
 * on new sales below it are the next units.
 *
 * Why: Stripe's automatic payouts send the whole available balance to the
 * bank, and a refund the balance cannot cover stays pending until Stripe
 * debits the bank or funds arrive (docs.stripe.com/payouts/minimum-balances-
 * for-automatic-payouts; support.stripe.com/questions/pending-refunds-due-
 * to-insufficient-stripe-balance). Keeping the reserve in the balance is what
 * lets 305 [SY1]'s refunds go through at once.
 *
 * The reserve, per currency, is the sum over the plan charges given:
 *   - what the published policy would give back if asked now, by the same
 *     rule the refund button uses (lib/plan-refund-rules.ts, `planRefund`):
 *     the first payment within REFUND_DAYS, the months not started of a
 *     yearly payment;
 *   - and a dispute part: the larger of (a) the dispute reserve of
 *     lib/receiving-costs.ts summed over each charge a cardholder can still
 *     dispute ((the amount charged + both dispute fees) x
 *     DISPUTE_RESERVE_BPS, rounded up) and (b) one whole dispute on the
 *     largest of those charges (its amount + both fees): the owner's
 *     decision of 31/10/2026 15h41, so a few charges still cover one real
 *     dispute. "Card networks typically allow
 *     cardholders to initiate disputes within 120 days of the original
 *     payment", and for a service paid ahead "the dispute window starts on
 *     the event date, not the payment date" (docs.stripe.com/disputes/how-
 *     disputes-work, "Dispute timing", read 31/10/2026): a charge counts
 *     until DISPUTE_DAYS after the later of its payment and the end of the
 *     period it paid for.
 *   - and every refund already made on the charge but still pending or
 *     waiting for an action: Stripe counts it in the charge's
 *     `amount_refunded` (so the policy's rule no longer owes it) although a
 *     pending refund "hasn't been initiated" and one pending for
 *     insufficient balance waits on the balance (support.stripe.com/
 *     questions/understanding-refund-statuses and /pending-refunds-due-to-
 *     insufficient-stripe-balance, read 31/10/2026): its money is still
 *     needed in the balance.
 * Whatever cannot be decided (a refund the rule calls unknown, an amount that
 * is not whole cents, a currency other than the dollar the dispute fees are
 * in) makes the whole reserve unknown: no payout is made on it and no sale
 * is opened on it, never a guess.
 */
import { DISPUTE_COUNTER_FEE_CENTS, DISPUTE_FEE_CENTS, DISPUTE_RESERVE_BPS } from "@/lib/receiving-costs";
import type { PlanRefund } from "@/lib/plan-refund-rules";

/** Days after the later of a charge's payment and its period's end during which it can be disputed. */
export const DISPUTE_DAYS = 120;
const DAY_SECONDS = 86_400;

/** One plan charge on the platform's account, with what the refund rule says of it now. */
export type ReserveCharge = {
  /** Stripe's lowercase code. */
  currency: string;
  /** What the charge captured, in cents (`charge.amount_captured`). */
  chargedCents: number;
  /** When it was paid, in seconds. */
  paidAtSeconds: number;
  /** The end of the period it paid for, in seconds. */
  periodEndSeconds: number;
  /** `planRefund` for this charge, now. */
  refund: PlanRefund;
  /** The charge's refunds Stripe reports `pending` or `requires_action`, in cents: made, not yet out of the balance. */
  pendingRefundCents: number;
};

export type ReserveTotal = { refundCents: number; pendingCents: number; disputeCents: number; totalCents: number };
export type Reserve =
  | { kind: "known"; byCurrency: Record<string, ReserveTotal> }
  | { kind: "unknown"; reason: "refund_unknown" | "unreadable" | "currency"; index: number };

const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** The dispute reserve of one charge, rounded up (never under the model of lib/receiving-costs.ts). */
export function disputeReserveCents(chargedCents: number): number {
  return Math.ceil(((chargedCents + DISPUTE_FEE_CENTS + DISPUTE_COUNTER_FEE_CENTS) * DISPUTE_RESERVE_BPS) / 10_000);
}

/** One whole dispute lost on a charge: its amount and both of Stripe's dispute fees (lib/receiving-costs.ts). */
export function fullDisputeCents(chargedCents: number): number {
  return chargedCents + DISPUTE_FEE_CENTS + DISPUTE_COUNTER_FEE_CENTS;
}

export function refundReserve(charges: readonly ReserveCharge[], nowSeconds: number): Reserve {
  const byCurrency: Record<string, ReserveTotal> = {};
  // The largest charge still disputable, per currency: one whole dispute on it is the floor of the dispute part.
  const largest: Record<string, number> = {};
  for (const [index, c] of charges.entries()) {
    if (!c || !whole(c.chargedCents) || !whole(c.paidAtSeconds) || !whole(c.periodEndSeconds) || !Number.isFinite(nowSeconds)) return { kind: "unknown", reason: "unreadable", index };
    if (c.currency !== "usd") return { kind: "unknown", reason: "currency", index };
    if (c.refund.kind === "unknown") return { kind: "unknown", reason: "refund_unknown", index };
    const owed = c.refund.kind === "guarantee" || c.refund.kind === "unstarted_months" ? c.refund.cents : 0;
    if (!whole(owed) || !whole(c.pendingRefundCents) || owed + c.pendingRefundCents > c.chargedCents) return { kind: "unknown", reason: "unreadable", index };
    // On the 120th day the window is still open.
    const disputable = nowSeconds <= Math.max(c.paidAtSeconds, c.periodEndSeconds) + DISPUTE_DAYS * DAY_SECONDS;
    const dispute = disputable ? disputeReserveCents(c.chargedCents) : 0;
    if (disputable) largest[c.currency] = Math.max(largest[c.currency] ?? 0, c.chargedCents);
    const total = (byCurrency[c.currency] ??= { refundCents: 0, pendingCents: 0, disputeCents: 0, totalCents: 0 });
    total.refundCents += owed;
    total.pendingCents += c.pendingRefundCents;
    total.disputeCents += dispute;
    total.totalCents += owed + c.pendingRefundCents + dispute;
  }
  // The owner's decision of 31/10/2026 15h41: the dispute part is the larger of the statistical sum and one whole
  // dispute on the largest charge still disputable, so a few charges still cover one real dispute.
  for (const [currency, total] of Object.entries(byCurrency)) {
    const floor = largest[currency] === undefined ? 0 : fullDisputeCents(largest[currency]);
    if (floor > total.disputeCents) {
      total.totalCents += floor - total.disputeCents;
      total.disputeCents = floor;
    }
  }
  return { kind: "known", byCurrency };
}

/**
 * What may be paid out to the bank from `availableCents` of a currency: only what is above the reserve. Null, never
 * a payout, when the reserve or the balance is not known.
 */
export function payoutAbove(availableCents: number | null, reserve: Reserve, currency: string): number | null {
  if (reserve.kind !== "known" || availableCents === null || !Number.isSafeInteger(availableCents)) return null;
  const kept = reserve.byCurrency[currency]?.totalCents ?? 0;
  return Math.max(0, availableCents - kept);
}

/** Whether new plans may be sold: the balance covers the reserve in every currency it holds. False when anything is unknown. */
export function reserveCovered(balanceCents: Record<string, number> | null, reserve: Reserve): boolean {
  if (reserve.kind !== "known" || !balanceCents) return false;
  return Object.entries(reserve.byCurrency).every(([currency, t]) => Number.isSafeInteger(balanceCents[currency]) && balanceCents[currency] >= t.totalCents);
}
