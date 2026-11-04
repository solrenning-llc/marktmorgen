import { countTaxSales, type TaxSalesLedger } from "@/lib/tax-sales-counter";

/**
 * TX3 arithmetic for two separately researched thresholds, not a registration,
 * nexus decision, rolling counter, tax calculator or permission to sell.
 * Sources/scopes: docs/tx-legal-source-review-2026-10-27.md, points15/17.
 * Production integration must classify applicable supplies, aggregate the
 * correct sellers, prove complete rolling coverage and reserve atomically.
 * Unknown evidence never becomes a zero total. No provider or storage IO.
 */
export const TAX_THRESHOLD_RULES = Object.freeze({
  "ca-specified-supplies": Object.freeze({
    currency: "CAD", thresholdMinor: 3_000_000, comparison: "gt",
    source: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/find-out-need-register/cross-border-threshold-amounts.html",
    checkedOn: "2026-10-27",
  }),
  "no-remote-services": Object.freeze({
    currency: "NOK", thresholdMinor: 5_000_000, comparison: "gte",
    source: "https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register/",
    checkedOn: "2026-10-27",
  }),
} as const);
export type TaxThresholdRuleId = keyof typeof TAX_THRESHOLD_RULES;
export type TaxThresholdSnapshot = {
  ruleId: TaxThresholdRuleId;
  currency: "CAD" | "NOK";
  /** Same UTC day as the assessment; stale counters are not current evidence. */
  recordedOn: string;
  /** Includes every applicable supply over the legally reviewed 12-month scope.
   * This flag does not authenticate source data or compute the period itself. */
  completeRollingCoverage: boolean;
  applicableScopeReviewed: boolean;
  settledApplicableMinor: number | null;
  /** Distinct, outstanding reservations; must be maintained atomically by integration. */
  reservedApplicableMinor: number | null;
  proposedApplicableMinor: number | null;
};
export type TaxThresholdAssessment = {
  status: "unknown" | "invalid" | "below-threshold" | "treatment-required";
  projectedApplicableMinor: number | null;
};
const stop = (status: "unknown" | "invalid"): TaxThresholdAssessment =>
  ({ status, projectedApplicableMinor: null });
const KEYS = [
  "ruleId", "currency", "recordedOn", "completeRollingCoverage", "applicableScopeReviewed",
  "settledApplicableMinor", "reservedApplicableMinor", "proposedApplicableMinor",
] as const;
const money = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Exact minor-unit boundary assessment. Below-threshold is not sales approval:
 * other nexus tests, tax rules, filings, costs and all release gates still apply.
 * Reaching a boundary requires implemented treatment before completing the sale;
 * this helper never claims a registration exists or submits one.
 */
export function assessTaxThreshold(value: unknown, now = Date.now()): TaxThresholdAssessment {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) return stop("invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) return stop("unknown");
  let data: Record<string, unknown>;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== KEYS.length) return stop("unknown");
    data = Object.create(null);
    for (const key of KEYS) {
      if (!Object.hasOwn(descriptors, key)) return stop("unknown");
      const field = descriptors[key];
      if (!field || !Object.hasOwn(field, "value")) return stop("unknown");
      data[key] = field.value;
    }
  } catch { return stop("unknown"); }
  if (typeof data.ruleId !== "string" || !Object.hasOwn(TAX_THRESHOLD_RULES, data.ruleId)) return stop("unknown");
  const rule = TAX_THRESHOLD_RULES[data.ruleId as TaxThresholdRuleId];
  const today = new Date(now).toISOString().slice(0, 10);
  if (today < rule.checkedOn || data.recordedOn !== today || data.currency !== rule.currency
    || data.completeRollingCoverage !== true || data.applicableScopeReviewed !== true) return stop("unknown");
  const amounts = [data.settledApplicableMinor, data.reservedApplicableMinor, data.proposedApplicableMinor];
  if (amounts.some(amount => amount === null || amount === undefined)) return stop("unknown");
  if (!amounts.every(money)) return stop("invalid");
  const total = amounts.reduce<bigint>((sum, amount) => sum + BigInt(amount as number), BigInt(0));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return stop("invalid");
  const threshold = BigInt(rule.thresholdMinor);
  const required = rule.comparison === "gte" ? total >= threshold : total > threshold;
  return { status: required ? "treatment-required" : "below-threshold", projectedApplicableMinor: Number(total) };
}


export type TaxSalesThresholdEvidence = {
  ruleId: TaxThresholdRuleId;
  ledger: TaxSalesLedger;
  /** A reviewer must establish the legally applicable rolling interval,
   * forecasts, seller aggregation and supply classification; syntax is not proof. */
  completeRollingCoverage: boolean;
  applicableScopeReviewed: boolean;
};
/** Derive threshold amounts from the complete supplied ledger instead of
 * accepting caller-provided totals. This is still an assessment of evidence,
 * never a nexus decision, registration or permission to complete a sale. */
export function assessTaxSalesThreshold(value: unknown, now = Date.now()): TaxThresholdAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return stop("unknown");
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return stop("unknown");
    const keys = ["ruleId", "ledger", "completeRollingCoverage", "applicableScopeReviewed"] as const;
    if (Reflect.ownKeys(value).length !== keys.length) return stop("unknown");
    const fields = Object.getOwnPropertyDescriptors(value);
    const evidence: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (!Object.hasOwn(fields, key)) return stop("unknown");
      const field = fields[key];
      if (!field || !Object.hasOwn(field, "value")) return stop("unknown");
      evidence[key] = field.value;
    }
    if (typeof evidence.ruleId !== "string" || !Object.hasOwn(TAX_THRESHOLD_RULES, evidence.ruleId)
      || evidence.completeRollingCoverage !== true || evidence.applicableScopeReviewed !== true) return stop("unknown");
    const totals = countTaxSales(evidence.ledger);
    if (totals.status !== "known") return stop(totals.status);
    const country = evidence.ruleId === "ca-specified-supplies" ? "CA" : "NO";
    // Neither national threshold may be assessed from a single-state subset.
    if (totals.place.country !== country || totals.place.state !== null) return stop("unknown");
    return assessTaxThreshold({
      ruleId: evidence.ruleId, currency: totals.currency, recordedOn: totals.periodEnd,
      completeRollingCoverage: true, applicableScopeReviewed: true,
      settledApplicableMinor: totals.settledApplicableMinor,
      reservedApplicableMinor: totals.reservedApplicableMinor,
      proposedApplicableMinor: totals.proposedApplicableMinor,
    }, now);
  } catch { return stop("unknown"); }
}
