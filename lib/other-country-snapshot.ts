import { OTHER_COUNTRY_RULES, otherCountryRule } from "@/lib/other-country-thresholds";
import { TAX_THRESHOLD_RULES, assessTaxThreshold, type TaxThresholdAssessment, type TaxThresholdRuleId, type TaxThresholdSnapshot } from "@/lib/tax-threshold";

/**
 * Art. 9a lock 3, jurisdiction "other", unit 2 (owner's order of 19 November 2026, front 1; coordinator's answer
 * C5-20261119-1625-9a-other): the threshold snapshot of one country, built from what the per-place counter of
 * C5-20261119-1335-tx2 reports for it (`placeTotals`: settled and reserved, in the sales' own currency) and the sale
 * being proposed, and that country's assessment from it (assessPlaceCountedCountry). The counter gives totals, not a
 * ledger of entries, so the snapshot goes to assessTaxThreshold bound to the country's own rule (expectedRuleId), not
 * to assessOtherCountry's ledger path.
 *
 * Two facts no counter can give are taken only from reviewed, dated records in this file:
 *   - the exchange rate (condition 2): sales are converted into the threshold's currency at a reviewed CEILING rate,
 *     the one that reaches the threshold sooner, valid only between the day it was read and its `validThrough`, and
 *     rounded up. No reviewed rate for the pair and the day: "unknown", which refuses. A rate is never guessed;
 *   - the scope (TX points 15 and 17): that the counted sales are the applicable supplies to that country's consumers
 *     over the rule's whole rolling window. Without that review the snapshot says so (both flags false), and the
 *     assessment is "unknown".
 * Both lists are empty: until a reviewed record is added, every country assesses as "unknown", which refuses.
 *
 * Switzerland is always "unknown" here: its rule counts the WORLDWIDE turnover (all products, all countries), which no
 * single place's totals can show. Its snapshot needs a worldwide source that is not built.
 *
 * What this is not: no counter, no reservation, no checkout wiring, no record in DEEMED_SUPPLIER_RECORDS. Pure: no
 * IO; reads its inputs' own data once.
 */

/** Months each country rule counts back from today (point 17: "any 12 months"; point 15: "in 12 months"). */
export const OTHER_COUNTRY_WINDOW_MONTHS: Readonly<Record<"ca-specified-supplies" | "no-remote-services", number>> = Object.freeze({
  "ca-specified-supplies": 12,
  "no-remote-services": 12,
});

/** Minor-unit digits of the only currencies converted here; any other currency is unknown. */
const EXPONENT: Readonly<Record<string, number>> = Object.freeze({ USD: 2, CAD: 2, NOK: 2, CHF: 2 });

/** One reviewed ceiling rate: 1 unit of `from` is at most `numerator / denominator` units of `to`. */
export type FxCeiling = Readonly<{
  from: string;
  to: "CAD" | "NOK" | "CHF";
  numerator: number;
  denominator: number;
  /** The official page the ceiling was set from, and the UTC days it holds. */
  source: string;
  checkedOn: string;
  validThrough: string;
}>;

/** One reviewed scope: the counter's place totals are the rule's applicable supplies over its whole window. */
export type ScopeReview = Readonly<{
  ruleId: TaxThresholdRuleId;
  evidence: string;
  reviewedOn: string;
}>;

export type OtherCountryReviews = Readonly<{ fx: readonly FxCeiling[]; scopes: readonly ScopeReview[] }>;

/** Empty on purpose: a record is added only with its source and the day it was read (condition 2). */
export const REVIEWED_FX_CEILINGS: readonly FxCeiling[] = Object.freeze([]);
/** Empty on purpose: no country's scope has been reviewed. */
export const REVIEWED_COUNTRY_SCOPES: readonly ScopeReview[] = Object.freeze([]);

export type OtherCountrySnapshot = TaxThresholdSnapshot | Readonly<{ status: "unknown" | "invalid" }>;
const UNKNOWN = Object.freeze({ status: "unknown" as const });
const INVALID = Object.freeze({ status: "invalid" as const });

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const money = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/** A plain object's own data fields, read once; null for anything else (an accessor is never run). */
function own(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    if (Reflect.ownKeys(value).length !== keys.length) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    const data: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!field || !field.enumerable || !Object.hasOwn(field, "value")) return null;
      data[key] = field.value;
    }
    return data;
  } catch {
    return null;
  }
}

/** The first UTC millisecond of the day `months` calendar months before `now`'s day: the window `placeTotals` reads. */
export function otherCountryWindowStart(ruleId: "ca-specified-supplies" | "no-remote-services", now: number): number {
  const at = new Date(now);
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - OTHER_COUNTRY_WINDOW_MONTHS[ruleId], at.getUTCDate());
  // One day more than the window, so a day is never missed at a month's end (the dearer count).
  return day - 24 * 60 * 60 * 1000;
}

/** `amountMinor` of `from` in `to`, rounded up, at the one reviewed ceiling valid today; null when there is none. */
function convert(amountMinor: number, from: string, to: "CAD" | "NOK" | "CHF", day: string, fx: readonly FxCeiling[]): number | null {
  if (!Object.hasOwn(EXPONENT, from) || !Object.hasOwn(EXPONENT, to)) return null;
  if (from === to) return amountMinor;
  const valid = fx.filter((rate) => rate.from === from && rate.to === to && DAY.test(rate.checkedOn) && DAY.test(rate.validThrough)
    && rate.checkedOn <= day && day <= rate.validThrough && Number.isSafeInteger(rate.numerator) && rate.numerator > 0
    && Number.isSafeInteger(rate.denominator) && rate.denominator > 0 && /^https:\/\//.test(rate.source));
  // Two reviewed ceilings for the same day: the dearer one (more of `to` for each unit).
  if (!valid.length) return null;
  const rate = valid.reduce((a, b) => (BigInt(a.numerator) * BigInt(b.denominator) >= BigInt(b.numerator) * BigInt(a.denominator) ? a : b));
  // minor(to) = minor(from) × numerator / denominator × 10^(digits(to) − digits(from)), rounded up.
  const shift = EXPONENT[to] - EXPONENT[from];
  const top = BigInt(amountMinor) * BigInt(rate.numerator) * BigInt(10) ** BigInt(Math.max(0, shift));
  const bottom = BigInt(rate.denominator) * BigInt(10) ** BigInt(Math.max(0, -shift));
  const minor = (top + bottom - BigInt(1)) / bottom;
  return minor > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(minor);
}

/**
 * The snapshot of `country` from its place totals (`placeTotals(place, otherCountryWindowStart(...))`: null when the
 * counter could not say) and the proposed sale, under the given reviews. Production uses otherCountrySnapshot, which
 * takes only the reviewed records of this file; this form exists so the arithmetic can be tested with synthetic ones.
 */
export function otherCountrySnapshotUnder(
  reviews: OtherCountryReviews,
  country: unknown,
  totals: unknown,
  proposed: unknown,
  now: number,
): OtherCountrySnapshot {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) return INVALID;
  const rule = otherCountryRule(country);
  if (!rule) return UNKNOWN;
  const ruleId = rule.ruleId;
  // A worldwide rule (Switzerland) is not one place's count.
  if (TAX_THRESHOLD_RULES[ruleId].scope !== "country") return UNKNOWN;
  const counted = totals === null ? null : own(totals, ["currency", "settledMinor", "reservedMinor"]);
  if (!counted) return UNKNOWN;
  const sale = own(proposed, ["currency", "amountMinor"]);
  if (!sale) return UNKNOWN;
  if (!money(counted.settledMinor) || !money(counted.reservedMinor) || !money(sale.amountMinor)) return INVALID;
  if (typeof counted.currency !== "string" || counted.currency !== sale.currency) return UNKNOWN;
  const day = today(now);
  const to = TAX_THRESHOLD_RULES[ruleId].currency;
  const amounts = [counted.settledMinor, counted.reservedMinor, sale.amountMinor].map((amount) => convert(amount as number, counted.currency as string, to, day, reviews.fx));
  if (amounts.some((amount) => amount === null)) return UNKNOWN;
  const reviewed = reviews.scopes.some((scope) => scope.ruleId === ruleId && typeof scope.reviewedOn === "string" && DAY.test(scope.reviewedOn) && scope.reviewedOn <= day && typeof scope.evidence === "string" && scope.evidence.length > 0);
  return {
    ruleId,
    currency: to,
    recordedOn: day,
    completeRollingCoverage: reviewed,
    applicableScopeReviewed: reviewed,
    settledApplicableMinor: amounts[0],
    reservedApplicableMinor: amounts[1],
    proposedApplicableMinor: amounts[2],
  };
}

/** The snapshot under this file's reviewed records only: "unknown" for every country while they are empty. */
export function otherCountrySnapshot(country: unknown, totals: unknown, proposed: unknown, now = Date.now()): OtherCountrySnapshot {
  return otherCountrySnapshotUnder({ fx: REVIEWED_FX_CEILINGS, scopes: REVIEWED_COUNTRY_SCOPES }, country, totals, proposed, now);
}

/**
 * One place-counted country's assessment (Canada, Norway): its snapshot under this file's reviewed records, assessed
 * under that country's own rule. "unknown" for every country while those records are empty, and always for
 * Switzerland and every country without a rule. "below-threshold" is never permission to sell by itself.
 */
export function assessPlaceCountedCountry(country: unknown, totals: unknown, proposed: unknown, now = Date.now()): TaxThresholdAssessment {
  return assessSnapshot(country, otherCountrySnapshot(country, totals, proposed, now), now);
}

/** A snapshot assessed under `country`'s own rule; "unknown" for a country without one. */
export function assessSnapshot(country: unknown, snapshot: OtherCountrySnapshot, now: number): TaxThresholdAssessment {
  const rule = otherCountryRule(country);
  if (!rule || TAX_THRESHOLD_RULES[rule.ruleId].scope !== "country") return { status: "unknown", projectedApplicableMinor: null };
  return assessTaxThreshold(snapshot, now, rule.ruleId);
}

/** The countries whose rule counts one place, the ones a place counter can feed. */
export const PLACE_COUNTED_COUNTRIES = Object.freeze(
  (Object.keys(OTHER_COUNTRY_RULES) as (keyof typeof OTHER_COUNTRY_RULES)[]).filter((code) => TAX_THRESHOLD_RULES[OTHER_COUNTRY_RULES[code].ruleId].scope === "country"),
);
