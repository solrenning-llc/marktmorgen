import { PUBLISHED_PLAN_PRICES, type Tier, type Cycle } from "@/lib/plan";

/** A lost payment is a funded liability, never a forecast fee or free allowance. */
export const PLAN_PAYMENT_DISPUTE_KEYS = [
  "creator_month", "creator_year", "pro_month", "pro_year", "scale_month", "scale_year",
] as const;
export type PlanPaymentDisputeKey = typeof PLAN_PAYMENT_DISPUTE_KEYS[number];
export const PLAN_PAYMENT_DISPUTE_COST_RULES = {
  schema: 1, currency: "USD-cents",
  principal: "maximum-total-paid-per-contract-including-all-payments",
  fees: "maximum-total-lost-dispute-fees-over-reviewed-liability-tail",
  unknown: "deny-not-zero", annual: "full-loss-not-divided-by-twelve",
  taxRecovery: "no-credit", reservation: "replace-existing-principal-not-add-it-twice",
  feeAccounting: "included-once-in-refundAndDisputeFees",
  maxInteger: 1_000_000_000_000,
  plans: PLAN_PAYMENT_DISPUTE_KEYS,
} as const;
export type PlanPaymentDisputeCost = {
  maximumPaidPrincipalCents: number | null;
  maximumTotalFeesCents: number | null;
  allContractPaymentsBounded: boolean;
  liabilityTailReviewed: boolean;
  evidence: string;
};
export type PlanPaymentDisputeReview = Partial<Record<PlanPaymentDisputeKey, PlanPaymentDisputeCost | null>>;
export type ReviewedPlanPaymentDisputeCosts = Record<PlanPaymentDisputeKey, {
  principalCents: number; feesCents: number; lostPaymentWorstCaseCents: number;
}>;
/** A complete review cannot omit unknown liabilities by selecting only known
 * fields. Copy exact enumerable own data without inherited setters or getters. */
function ownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Reflect.ownKeys(value).length !== keys.length) return null;
    const record: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch { return null; }
}
const cents = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  value <= PLAN_PAYMENT_DISPUTE_COST_RULES.maxInteger;

/** Read once, without executing a review. No provider/bank/tax fact is supplied here.
 * Fees of zero require an explicit reviewed value and evidence, never a default.
 * The loss is the whole contract's principal plus fees, including for a yearly plan.
 */
export function assessPlanPaymentDisputeCosts(value: unknown): ReviewedPlanPaymentDisputeCosts | null {
  const review = ownRecord(value, PLAN_PAYMENT_DISPUTE_KEYS);
  if (!review) return null;
  const result = Object.create(null) as ReviewedPlanPaymentDisputeCosts;
  for (const key of PLAN_PAYMENT_DISPUTE_KEYS) {
    const row = ownRecord(review[key], ["maximumPaidPrincipalCents", "maximumTotalFeesCents", "allContractPaymentsBounded", "liabilityTailReviewed", "evidence"]);
    if (!row) return null;
    const principal = row.maximumPaidPrincipalCents;
    const fees = row.maximumTotalFeesCents;
    const evidence = row.evidence;
    const [tier, cycle] = key.split("_") as [Tier, Cycle];
    if (!cents(principal) || principal < PUBLISHED_PLAN_PRICES[tier][cycle] || !cents(fees) ||
        row.allContractPaymentsBounded !== true || row.liabilityTailReviewed !== true ||
        typeof evidence !== "string" || !evidence.trim() || evidence.length > 1_000) return null;
    const loss = BigInt(principal) + BigInt(fees);
    if (loss > BigInt(PLAN_PAYMENT_DISPUTE_COST_RULES.maxInteger)) return null;
    result[key] = { principalCents: principal, feesCents: fees, lostPaymentWorstCaseCents: Number(loss) };
  }
  return result;
}
