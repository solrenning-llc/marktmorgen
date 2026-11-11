/**
 * One charge on our own Stripe account, as read, turned into what the
 * refund and dispute reserve counts (306 [SY2] unit 2a). Pure: the reading of
 * the charges from Stripe is the next unit, and nothing calls this yet.
 *
 * The reserve (lib/refund-reserve-rules.ts) must never be smaller than what
 * may have to go back, so where the exact answer needs a reading this unit
 * does not make, it takes the larger one:
 *
 *   - inside REFUND_DAYS of its payment, a plan charge is counted as the
 *     guarantee gives it: the whole payment less what was refunded
 *     (app/refunds/page.tsx, section 2; the guarantee covers the first
 *     payment and every plan payment of the 30 days after it, owner,
 *     31/10/2026 15h41). Whether it really is within 30 days of the person's
 *     first payment is a reading across customers, addresses and cards
 *     (lib/plan-refund.ts) made per store when the refund is asked, not here.
 *     planRefund decides the guarantee before anything else and gives the
 *     whole payment left, which no other answer of the policy passes, so the
 *     count is never under what is owed;
 *   - after those days, the policy's own answer (lib/plan-refund-rules.ts,
 *     `planRefund`, firstPayment false): a yearly payment's months not
 *     started, nothing for a monthly renewal or a switch charge;
 *   - the Store assistant's payments are not refunded (section 5a), so
 *     "not-refunded" counts no refund; its dispute part is still kept by the
 *     reserve rule. "Except where applicable consumer law requires it" is not
 *     priced here: no such refund has a known amount;
 *   - a refund already made but `pending` or `requires_action` is still
 *     needed in the balance (support.stripe.com/questions/understanding-
 *     refund-statuses, read 31/10/2026); `succeeded`, `failed` and `canceled`
 *     are not; any other status, or a list not read whole, is unknown;
 *   - a failed charge took nothing and is left out (null); a pending one, or
 *     a status this code does not know, is unknown, never zero.
 * An unknown charge makes the whole reserve unknown (refundReserve), so no
 * payout and no sale is made on it.
 */
import { REFUND_DAYS } from "@/lib/plan";
import { type PlanRefund, type PlanRefundCharge, planRefund } from "@/lib/plan-refund-rules";
import type { ReserveCharge } from "@/lib/refund-reserve-rules";

const DAY_SECONDS = 86_400;

/** One charge on our account, with the invoice and refunds it was read with. */
export type ReserveRead = {
  /** "plan": a plan's subscription (sections 2, 3 and 5); "not-refunded": the Store assistant (section 5a). */
  kind: "plan" | "not-refunded";
  /** Stripe's charge `status`. */
  status: string;
  /** The plan's billing interval, from the invoice's subscription line; null when not read. */
  cycle: "month" | "year" | null;
  /** For a yearly plan, its monthly price when paid (lib/plan-refund.ts, monthlyForYearly); null when not known. */
  monthlyCents: number | null;
  monthlyCurrency?: string;
  /** The period this charge paid for (the subscription line's `period`), in seconds. */
  periodStartSeconds: number;
  periodEndSeconds: number;
  /** The charge's refunds (`charge.refunds`), each with its status and amount; null when not read whole. */
  refunds: readonly { status: string; amount: number }[] | null;
  charge: PlanRefundCharge;
};

const KEPT_REFUND = new Set(["pending", "requires_action"]);
const DONE_REFUND = new Set(["succeeded", "failed", "canceled"]);
const UNKNOWN: PlanRefund = { kind: "unknown", reason: "unreadable" };

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** What the reserve counts for one charge, or null for a charge that took nothing. */
export function reserveChargeOf(read: ReserveRead, nowSeconds: number): ReserveCharge | null {
  const c = read.charge;
  if (read.status === "failed") return null;
  const base = {
    currency: c.currency,
    chargedCents: c.amountCents,
    paidAtSeconds: c.paidAtSeconds,
    periodEndSeconds: read.periodEndSeconds,
  };

  let pendingRefundCents = 0;
  let readable = read.status === "succeeded" && c.succeeded === true && read.refunds !== null;
  for (const refund of read.refunds ?? []) {
    if (!refund || !whole(refund.amount) || (!KEPT_REFUND.has(refund.status) && !DONE_REFUND.has(refund.status))) readable = false;
    else if (KEPT_REFUND.has(refund.status)) pendingRefundCents += refund.amount;
  }
  if (!whole(read.periodStartSeconds) || !whole(read.periodEndSeconds) || read.periodEndSeconds < read.periodStartSeconds) readable = false;
  if (!readable) return { ...base, refund: UNKNOWN, pendingRefundCents: whole(pendingRefundCents) ? pendingRefundCents : 0 };

  let refund: PlanRefund;
  if (read.kind === "not-refunded") refund = { kind: "none", reason: "renewal" };
  else if (read.cycle !== "month" && read.cycle !== "year") refund = UNKNOWN;
  else {
    const inWindow = nowSeconds <= c.paidAtSeconds + REFUND_DAYS * DAY_SECONDS;
    refund = planRefund({
      cycle: read.cycle,
      // Inside the window, counted as the guarantee: never less than any answer the policy gives (see above).
      firstPayment: inWindow,
      periodStartSeconds: read.periodStartSeconds,
      monthlyCents: read.monthlyCents,
      monthlyCurrency: read.monthlyCurrency,
      nowSeconds,
      charge: c,
    });
  }
  return { ...base, refund, pendingRefundCents };
}
