/**
 * What the plans' refund policy gives back, and never more than was paid.
 * 232 [CA1] unit 6; the button that uses it is 305 [SY1].
 *
 * The policy is app/refunds/page.tsx, sections 2, 3 and 5:
 *   - the first payment on an account, refunded in full when asked within
 *     REFUND_DAYS of it ("guarantee");
 *   - a yearly payment, at any time, less the months that have started at the
 *     plan's monthly price and less Stripe's card fee on that payment, which
 *     Stripe does not give back ("unstarted_months"); a first yearly payment
 *     asked about within REFUND_DAYS takes the guarantee instead;
 *   - nothing else: a monthly renewal, a switch charge, any later charge.
 *
 * Pure: it reads the charge as Stripe reports it and answers how many cents a
 * refund may be, why there is none, or that it cannot tell yet. It calls
 * nothing. Rules the rest of the code relies on:
 *   - the amount is what the charge captured (Stripe's
 *     `charge.amount_captured` on a `succeeded` charge), already net of
 *     coupons and discounts; the list price is never used for the guarantee;
 *     a charge that did not succeed gives nothing back;
 *   - only an invoice paid wholly by this one charge is decided: when a
 *     customer balance (credit) paid part of it, the policy's "what you
 *     paid" is not this charge alone, so the answer is "unknown";
 *   - only the subscription's own charges (Stripe `billing_reason`
 *     `subscription_create` or `subscription_cycle`) get the yearly months;
 *     a switch charge (`subscription_update`) on a monthly plan gets nothing,
 *     section 5, and on a yearly plan is "unknown" (it may be the yearly
 *     payment itself), unless it is the first charge on the account asked about
 *     inside the window, which section 2 covers whatever it was for;
 *   - what was already refunded (`charge.amount_refunded`) is taken off, so
 *     the total ever given back for one charge never passes what the policy
 *     gives, nor what the charge took. Two callers that read the same
 *     `amount_refunded` at once would each get the same answer, so the
 *     refund write (305 [SY1]) must carry a Stripe idempotency key and a lock;
 *   - Stripe's fee is kept only when it is in the charge's currency (the
 *     balance transaction's currency is the account's settlement currency,
 *     which may differ); otherwise "unknown";
 *   - a dispute (Stripe's dispute `status`): open, or a status this code does
 *     not know, means no refund now (the bank may return it); `lost` and
 *     `prevented` for the whole charge mean the money went back that way
 *     already, and for part of it "unknown" (the rest is not decided here); `won` and
 *     `warning_closed` let the policy apply again (statuses read on
 *     docs.stripe.com/api/disputes/object, 31/10/2026);
 *   - tax shown on top comes back with the part refunded, in proportion,
 *     rounded down; for the guarantee the whole payment, tax included;
 *   - anything that is not a whole, non-negative number of cents, or a
 *     currency the monthly price is not in, is "unknown", never a guess and
 *     never zero dressed up as "nothing is owed".
 */
import { REFUND_DAYS } from "@/lib/plan";

const DAY_SECONDS = 86_400;

export type PlanRefundCharge = {
  /** Stripe's lowercase three-letter code. */
  currency: string;
  /** Whether Stripe reports the charge `succeeded`. */
  succeeded: boolean;
  /** What the charge captured, in the smallest unit: `charge.amount_captured`. */
  amountCents: number;
  /** The total of the invoice this charge paid (`invoice.total`); equal to amountCents unless a balance paid part. */
  invoiceTotalCents: number;
  /** Stripe's `invoice.billing_reason` for that invoice. */
  billingReason: string;
  /** What has been refunded from it already: `charge.amount_refunded`. */
  refundedCents: number;
  /** Tax on the invoice this charge paid, included in amountCents. */
  taxCents: number;
  /** Stripe's fee on the charge (its balance transaction), or null if not read. */
  feeCents: number | null;
  /** The balance transaction's currency, which the fee is in. */
  feeCurrency: string | null;
  /** When it was paid, in seconds. */
  paidAtSeconds: number;
  /** The status of a dispute on it, or null when there is none. */
  disputeStatus: string | null;
  /** The dispute's amount (`dispute.amount`), or null when there is none. */
  disputedCents: number | null;
};

export type PlanRefundInput = {
  cycle: "month" | "year";
  /** Whether this is the first charge on the account (decided by the caller). */
  firstPayment: boolean;
  /** Start of the billing period this charge paid for, in seconds. */
  periodStartSeconds: number;
  /** The plan's monthly price when this yearly payment was made, same currency; null if not known. */
  monthlyCents: number | null;
  /** The currency of monthlyCents; "usd" when absent, as every plan price is. */
  monthlyCurrency?: string;
  nowSeconds: number;
  charge: PlanRefundCharge;
};

export type PlanRefund =
  | { kind: "guarantee"; cents: number }
  | { kind: "unstarted_months"; cents: number; monthsKept: number }
  | { kind: "none"; reason: "not_paid" | "nothing_paid" | "dispute_open" | "dispute_returned" | "already_refunded" | "outside_window" | "renewal" | "switch_charge" | "months_used" | "fee_kept" }
  | { kind: "unknown"; reason: "unreadable" | "split_payment" | "switch_yearly" | "dispute_partial" | "billing_reason" | "fee_unread" | "monthly_price_unknown" | "currency" };

const RETURNED = new Set(["lost", "prevented"]);
const SETTLED = new Set(["won", "warning_closed"]);
const OWN_CHARGE = new Set(["subscription_create", "subscription_cycle"]);
const SWITCH_CHARGE = new Set(["subscription_update"]);

function cents(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * A date some whole months after `startSeconds`, the way Stripe moves a
 * billing anchor: the same day and time, or the month's last day when it has
 * no such day (an anchor on the 31st bills on Feb 28). UTC throughout.
 */
export function addMonthsLikeStripe(startSeconds: number, months: number): number {
  const d = new Date(startSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), last);
  return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

/** How many of a yearly period's twelve months have started by `nowSeconds` (0 to 12). */
export function monthsStarted(periodStartSeconds: number, nowSeconds: number): number {
  let n = 0;
  for (let k = 0; k < 12; k += 1) {
    if (addMonthsLikeStripe(periodStartSeconds, k) <= nowSeconds) n += 1;
    else break;
  }
  return n;
}

export function planRefund(input: PlanRefundInput): PlanRefund {
  const c = input.charge;
  if (!cents(c.amountCents) || !cents(c.refundedCents) || !cents(c.taxCents) || !cents(c.invoiceTotalCents) || c.taxCents > c.invoiceTotalCents) return { kind: "unknown", reason: "unreadable" };
  if (c.feeCents !== null && !cents(c.feeCents)) return { kind: "unknown", reason: "unreadable" };
  if (c.disputedCents !== null && !cents(c.disputedCents)) return { kind: "unknown", reason: "unreadable" };
  if (typeof c.billingReason !== "string" || typeof c.succeeded !== "boolean") return { kind: "unknown", reason: "unreadable" };
  if (!Number.isFinite(c.paidAtSeconds) || !Number.isFinite(input.nowSeconds) || !Number.isFinite(input.periodStartSeconds)) return { kind: "unknown", reason: "unreadable" };

  if (!c.succeeded) return { kind: "none", reason: "not_paid" };
  if (c.invoiceTotalCents !== c.amountCents) return { kind: "unknown", reason: "split_payment" };
  if (c.amountCents === 0) return { kind: "none", reason: "nothing_paid" };

  if (c.disputeStatus !== null) {
    if (RETURNED.has(c.disputeStatus)) {
      if (c.disputedCents !== null && c.disputedCents < c.amountCents) return { kind: "unknown", reason: "dispute_partial" };
      return { kind: "none", reason: "dispute_returned" };
    }
    if (!SETTLED.has(c.disputeStatus)) return { kind: "none", reason: "dispute_open" };
  }

  const left = c.amountCents - c.refundedCents;
  if (left <= 0) return { kind: "none", reason: "already_refunded" };

  const inWindow = input.nowSeconds <= c.paidAtSeconds + REFUND_DAYS * DAY_SECONDS;
  if (input.firstPayment && inWindow) return { kind: "guarantee", cents: left };

  if (SWITCH_CHARGE.has(c.billingReason)) {
    // A switch onto (or within) a yearly plan may itself be the yearly
    // payment, whose unstarted months section 5 says are always refunded;
    // telling that apart from a proration-only charge needs the invoice's
    // lines, so it is not decided here.
    return input.cycle === "year" ? { kind: "unknown", reason: "switch_yearly" } : { kind: "none", reason: "switch_charge" };
  }
  if (!OWN_CHARGE.has(c.billingReason)) return { kind: "unknown", reason: "billing_reason" };
  if (input.cycle !== "year") return { kind: "none", reason: input.firstPayment ? "outside_window" : "renewal" };

  if (input.monthlyCents === null) return { kind: "unknown", reason: "monthly_price_unknown" };
  if (!cents(input.monthlyCents)) return { kind: "unknown", reason: "unreadable" };
  if (c.currency !== (input.monthlyCurrency ?? "usd")) return { kind: "unknown", reason: "currency" };
  if (c.feeCents === null) return { kind: "unknown", reason: "fee_unread" };
  if (c.feeCurrency !== c.currency) return { kind: "unknown", reason: "currency" };

  const kept = monthsStarted(input.periodStartSeconds, input.nowSeconds);
  const preTaxPaid = c.amountCents - c.taxCents;
  const keptCents = Math.min(preTaxPaid, kept * input.monthlyCents);
  const preTaxBack = preTaxPaid - keptCents;
  const taxBack = preTaxPaid > 0 ? Math.floor((c.taxCents * preTaxBack) / preTaxPaid) : 0;
  if (preTaxBack <= 0) return { kind: "none", reason: "months_used" };
  const policy = preTaxBack + taxBack - c.feeCents;
  if (policy <= 0) return { kind: "none", reason: "fee_kept" };
  const now = Math.min(policy - c.refundedCents, left);
  if (now <= 0) return { kind: "none", reason: "already_refunded" };
  return { kind: "unstarted_months", cents: now, monthsKept: kept };
}
