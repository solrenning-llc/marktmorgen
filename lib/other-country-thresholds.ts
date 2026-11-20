import { TAX_THRESHOLD_RULES, assessTaxSalesThreshold, assessTaxThreshold, type TaxThresholdAssessment, type TaxThresholdRuleId } from "@/lib/tax-threshold";

/**
 * Art. 9a lock 3, the jurisdiction "other" of lib/deemed-supplier.ts (owner's order of 19 November 2026, ~13h25
 * Fortaleza, front 1; C5-20261119-1320-frentes): which threshold rule, if any, a country outside the EU, the UK and
 * the US has been reviewed under, and that country's assessment from its own evidence.
 *
 * Reviewed so far, each from the official page named in its rule (docs/tx-legal-source-review-2026-10-27.md):
 *   - Canada (CA): specified supplies to Canadian consumers, registration once CAD 30,000 is exceeded in 12 months
 *     (point 17), from Canada's own ledger;
 *   - Norway (NO): remote services to Norwegian consumers, registration once NOK 50,000 is reached in 12 months
 *     (point 15), from Norway's own ledger;
 *   - Taiwan (TW): electronic services to individuals in Taiwan, registration once NT$600,000 is reached in the
 *     previous or the current calendar year (Ministry of Finance decree of 07/04/2025; C5-20261120-2110-9a-other-u4),
 *     from Taiwan's own ledger;
 *   - Switzerland (CH): CHF 100,000 of WORLDWIDE turnover from supplies that are not excluded, then from the first
 *     supply in Switzerland (point 15). It is not a count of Swiss sales: its evidence is a worldwide snapshot in CHF,
 *     whose conversion and scope the caller's review covers (applicableScopeReviewed).
 *
 * Every other country is "unknown", which refuses: TX point 17 rejects reading one country's rule as everyone's
 * ("universalização não autorizada"). That includes Liechtenstein, whose place in Swiss VAT was not read here, and
 * every territory lib/jurisdiction-refusal-rules.ts counts as "other". A country is added only with its own rule,
 * source and day read, in lib/tax-threshold.ts and here.
 *
 * What this is not: no counter (the per-place counters are built once, by Claude 4, C5-20261119-1335-tx2), no
 * registration, no tax collected, no checkout wiring and no record in DEEMED_SUPPLIER_RECORDS. "below-threshold" is
 * never permission to sell: every other gate still applies. Pure: no IO. The evidence is captured once, by the
 * assessor, which is told the country's rule and refuses evidence that names another in that same capture (Codex X5
 * on #4890: a separate read of the rule here could see one rule, and the assessor's capture another).
 */
export type OtherCountryRule = Readonly<{ ruleId: TaxThresholdRuleId }>;

export const OTHER_COUNTRY_RULES: Readonly<Record<"CA" | "NO" | "CH" | "TW", OtherCountryRule>> = Object.freeze({
  CA: Object.freeze({ ruleId: "ca-specified-supplies" }),
  NO: Object.freeze({ ruleId: "no-remote-services" }),
  CH: Object.freeze({ ruleId: "ch-worldwide-turnover" }),
  TW: Object.freeze({ ruleId: "tw-cross-border-e-services" }),
});

const UNKNOWN: TaxThresholdAssessment = Object.freeze({ status: "unknown", projectedApplicableMinor: null }) as TaxThresholdAssessment;
const unknown = (): TaxThresholdAssessment => ({ ...UNKNOWN });

/** The rule a country was reviewed under; null for every country without one, or anything that is not a code. */
export function otherCountryRule(country: unknown): OtherCountryRule | null {
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) return null;
  return Object.hasOwn(OTHER_COUNTRY_RULES, country) ? OTHER_COUNTRY_RULES[country as keyof typeof OTHER_COUNTRY_RULES] : null;
}

/**
 * One country's assessment under its own rule, from evidence made for that very rule: a country's ledger
 * (assessTaxSalesThreshold) for a "country" rule, the worldwide snapshot (assessTaxThreshold) for a "worldwide" one.
 * Unknown when the country has no rule, or the evidence names another rule in the assessor's own capture; every
 * check of those two assessors applies in full.
 */
export function assessOtherCountry(country: unknown, evidence: unknown, now = Date.now()): TaxThresholdAssessment {
  const rule = otherCountryRule(country);
  if (!rule) return unknown();
  return TAX_THRESHOLD_RULES[rule.ruleId].scope === "worldwide"
    ? assessTaxThreshold(evidence, now, rule.ruleId)
    : assessTaxSalesThreshold(evidence, now, rule.ruleId);
}
