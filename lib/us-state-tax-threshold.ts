import { countTaxSales, type TaxSalesLedger } from "@/lib/tax-sales-counter";

/**
 * TX point 9 (472 [TX2]): per-state US income/franchise "doing business"
 * counters and the switch that turns treatment on before a state's limit.
 *
 * This is pure arithmetic over a supplied, complete ledger. It is not a nexus
 * opinion, a registration, a filing, a tax calculator or permission to sell,
 * and nothing in production calls it yet: PLANS_ON_SALE and every release gate
 * stay exactly as they are. No provider or storage IO.
 *
 * Every limit needs an official dated source read for the current year. Where
 * none was read, the value is null and the state can never be assessed as
 * below its limit: unknown refuses, it never becomes zero. Only a test that is
 * already met with known evidence can switch treatment on without the rest.
 */
export type UsStateCode =
  | "AL" | "AK" | "AZ" | "AR" | "CA" | "CO" | "CT" | "DE" | "DC" | "FL" | "GA" | "HI" | "ID"
  | "IL" | "IN" | "IA" | "KS" | "KY" | "LA" | "ME" | "MD" | "MA" | "MI" | "MN" | "MS" | "MO"
  | "MT" | "NE" | "NV" | "NH" | "NJ" | "NM" | "NY" | "NC" | "ND" | "OH" | "OK" | "OR" | "PA"
  | "RI" | "SC" | "SD" | "TN" | "TX" | "UT" | "VT" | "VA" | "WA" | "WV" | "WI" | "WY";
export type UsStateIncomeFranchiseRule = {
  state: UsStateCode;
  /** The interval the state measures sales over. Only the LLC's taxable year
   * when it is the calendar year is modelled; another year must be reviewed. */
  period: "calendar-year";
  /** USD cents a state's sales must EXCEED for the current year; null = no
   * official figure read for this year. */
  salesThresholdMinor: number | null;
  /** Share of total sales, in basis points, that state sales must EXCEED;
   * null = not read, or the state has none recorded. */
  relativeShareBps: number | null;
  /** Non-sales tests (domicile, property, payroll, ...) a reviewer must answer. */
  nonSalesTests: readonly string[] | null;
  /** Official page the figures above come from, as recorded in the repository. */
  source: string | null;
  checkedOn: string | null;
  /** What still has to be read before this state can ever be "below". */
  pending: string;
};

const NOT_READ = "No official state source has been identified and read for this state's income/franchise doing-business test; no figure is recorded.";
const unread = (state: UsStateCode): UsStateIncomeFranchiseRule => Object.freeze({
  state, period: "calendar-year", salesThresholdMinor: null, relativeShareBps: null,
  nonSalesTests: null, source: null, checkedOn: null, pending: NOT_READ,
});

/**
 * California: the FTB "Doing business in California" page, recorded in
 * docs/tx-legal-source-review-2026-10-27.md point 9 (page updated 7 Nov 2025),
 * lists alternative tests: organized or commercially domiciled in California,
 * or California sales, property or payroll above the lesser of an indexed
 * amount or 25% of the total. The table read ends at 2025, so the 2026 sales
 * amount is unknown and is not invented here. R&TC 23101 itself still has to
 * be read. The 25% relative test and the non-sales tests are kept.
 */
const CALIFORNIA: UsStateIncomeFranchiseRule = Object.freeze({
  state: "CA", period: "calendar-year", salesThresholdMinor: null, relativeShareBps: 2_500,
  nonSalesTests: Object.freeze([
    "organized-or-commercially-domiciled-in-state",
    "in-state-property-above-lesser-of-indexed-amount-or-25-percent",
    "in-state-payroll-above-lesser-of-indexed-amount-or-25-percent",
  ]),
  source: "https://www.ftb.ca.gov/file/business/doing-business-in-california.html",
  checkedOn: "2026-10-27",
  pending: "Read the FTB table row for the current taxable year (the recorded table ends at 2025) and the current text of R&TC 23101 (https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=23101).",
});

const STATES: readonly UsStateCode[] = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];
export const US_STATE_INCOME_FRANCHISE_RULES: Readonly<Record<UsStateCode, UsStateIncomeFranchiseRule>> =
  Object.freeze(Object.fromEntries(STATES.map(state => [state, state === "CA" ? CALIFORNIA : unread(state)])) as Record<UsStateCode, UsStateIncomeFranchiseRule>);

/** States that cannot be assessed as below their limit until a source is read. */
export const US_STATE_PENDING_SOURCES: readonly { state: UsStateCode; missing: readonly string[]; source: string | null; pending: string }[] =
  Object.freeze(STATES.map(state => US_STATE_INCOME_FRANCHISE_RULES[state]).map(rule => Object.freeze({
    state: rule.state,
    missing: Object.freeze([
      ...(rule.salesThresholdMinor === null ? ["sales-threshold"] : []),
      ...(rule.relativeShareBps === null ? ["relative-share"] : []),
      ...(rule.nonSalesTests === null ? ["non-sales-tests"] : []),
      ...(rule.source === null ? ["official-source"] : []),
    ]),
    source: rule.source, pending: rule.pending,
  })).filter(row => row.missing.length > 0));

/** Internal conservative room, not a legal figure: treatment switches on once
 * the projected count reaches 90% of a known limit, before it can be passed. */
export const US_STATE_SAFETY_MARGIN_BPS = 1_000;

export type UsStateThresholdEvidence = {
  state: UsStateCode;
  /** place { country: "US", state }, USD, the current calendar year to today. */
  stateLedger: TaxSalesLedger;
  /** place { country: "US", state: null }, same currency and interval. Used as
   * the denominator of a relative test: US-only total sales are at most total
   * sales everywhere, so the share is never understated. */
  usLedger: TaxSalesLedger;
  applicableScopeReviewed: boolean;
  /** A reviewer's answer for every non-sales test of the rule; null = unknown. */
  nonSalesFactors: "none" | "present" | null;
};
export type UsStateThresholdStatus = "unknown" | "invalid" | "below-threshold" | "approaching" | "treatment-required";
export type UsStateThresholdAssessment = {
  status: UsStateThresholdStatus;
  state: UsStateCode | null;
  projectedStateMinor: number | null;
  /** Why treatment is required or why the state cannot be assessed. */
  reasons: readonly string[];
};
const stop = (status: "unknown" | "invalid", state: UsStateCode | null = null, reasons: string[] = []): UsStateThresholdAssessment =>
  ({ status, state, projectedStateMinor: null, reasons });
const KEYS = ["state", "stateLedger", "usLedger", "applicableScopeReviewed", "nonSalesFactors"] as const;

function own(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).length !== KEYS.length) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of KEYS) {
    if (!Object.hasOwn(fields, key)) return null;
    const field = fields[key];
    if (!field || !field.enumerable || !Object.hasOwn(field, "value")) return null;
    out[key] = field.value;
  }
  return out;
}

/**
 * Exact assessment of one state's income/franchise doing-business tests from
 * complete ledgers. Reservations and proposed supplies count before the limit.
 * A met test with known evidence requires treatment even when other parts are
 * unknown; "below-threshold" needs every test known and below its margin.
 */
export function assessUsStateThreshold(value: unknown, now = Date.now()): UsStateThresholdAssessment {
  return assessWith(null, value, now);
}
/**
 * The same arithmetic against a candidate rule while its figures are being
 * reviewed (and for tests). Release code must use assessUsStateThreshold, which
 * reads only the recorded table; a candidate rule never changes that table.
 */
export function assessUsStateThresholdUnderCandidateRule(rule: UsStateIncomeFranchiseRule, value: unknown, now = Date.now()): UsStateThresholdAssessment {
  return assessWith(rule, value, now);
}
const limit = (value: unknown, maximum: number) => value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function assessWith(candidate: UsStateIncomeFranchiseRule | null, value: unknown, now: number): UsStateThresholdAssessment {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) return stop("invalid");
  try {
    const data = own(value);
    if (!data) return stop("unknown");
    if (typeof data.state !== "string" || !Object.hasOwn(US_STATE_INCOME_FRANCHISE_RULES, data.state)) return stop("unknown");
    const state = data.state as UsStateCode;
    const rule = candidate ?? US_STATE_INCOME_FRANCHISE_RULES[state];
    if (rule.state !== state || rule.period !== "calendar-year"
      || !limit(rule.salesThresholdMinor, Number.MAX_SAFE_INTEGER) || !limit(rule.relativeShareBps, 10_000)) return stop("unknown", state, ["rule"]);
    if (data.applicableScopeReviewed !== true) return stop("unknown", state, ["applicable-scope-not-reviewed"]);
    if (data.nonSalesFactors !== null && data.nonSalesFactors !== "none" && data.nonSalesFactors !== "present") return stop("unknown", state);
    const today = new Date(now).toISOString().slice(0, 10);
    const local = countTaxSales(data.stateLedger);
    if (local.status !== "known") return stop(local.status, state, ["state-ledger-" + local.status]);
    const national = countTaxSales(data.usLedger);
    if (national.status !== "known") return stop(national.status, state, ["us-ledger-" + national.status]);
    if (local.place.country !== "US" || local.place.state !== state
      || national.place.country !== "US" || national.place.state !== null) return stop("unknown", state, ["ledger-place"]);
    if (local.currency !== "USD" || national.currency !== "USD") return stop("unknown", state, ["ledger-currency"]);
    // Calendar year to today: an older or partial interval is not current evidence.
    const start = today.slice(0, 4) + "-01-01";
    if (local.periodStart !== start || local.periodEnd !== today
      || national.periodStart !== start || national.periodEnd !== today) return stop("unknown", state, ["ledger-period"]);
    const sum = (t: typeof local) => BigInt(t.settledApplicableMinor) + BigInt(t.reservedApplicableMinor) + BigInt(t.proposedApplicableMinor);
    const inState = sum(local), inUs = sum(national);
    if (inState > inUs) return stop("invalid", state, ["state-exceeds-us-total"]);
    const projectedStateMinor = Number(inState);
    const BPS = BigInt(10_000), room = BigInt(10_000 - US_STATE_SAFETY_MARGIN_BPS);

    const met: string[] = [], near: string[] = [], unknown: string[] = [];
    if (rule.source === null || rule.checkedOn === null || today < rule.checkedOn) unknown.push("official-source");
    if (rule.nonSalesTests === null) unknown.push("non-sales-tests");
    else if (data.nonSalesFactors === "present") met.push("non-sales-factor-present");
    else if (data.nonSalesFactors === null) unknown.push("non-sales-factors-not-reviewed");
    if (rule.salesThresholdMinor === null) unknown.push("sales-threshold");
    else {
      const limit = BigInt(rule.salesThresholdMinor);
      if (inState > limit) met.push("sales-threshold-exceeded");
      else if (inState * BPS >= limit * room) near.push("sales-threshold-within-margin");
    }
    if (rule.relativeShareBps === null) unknown.push("relative-share");
    else {
      const share = BigInt(rule.relativeShareBps);
      if (inState * BPS > share * inUs) met.push("relative-share-exceeded");
      else if (inState * BPS * BPS >= share * room * inUs && inState > BigInt(0)) near.push("relative-share-within-margin");
    }
    if (met.length) return { status: "treatment-required", state, projectedStateMinor, reasons: met };
    if (unknown.length) return { status: "unknown", state, projectedStateMinor, reasons: unknown };
    if (near.length) return { status: "approaching", state, projectedStateMinor, reasons: near };
    return { status: "below-threshold", state, projectedStateMinor, reasons: [] };
  } catch { return stop("unknown"); }
}

export type UsStateSaleDecision = "continue-untreated" | "treatment-on" | "refuse";
/**
 * Below the limit with its margin: the sale continues without this state's
 * treatment (every other gate still applies). Near or over it: only with the
 * state's treatment built and on; otherwise refuse before the limit is passed.
 * Unknown or invalid evidence always refuses.
 */
export function usStateSaleDecision(assessment: UsStateThresholdAssessment, treatmentReady: unknown): UsStateSaleDecision {
  if (assessment.status === "below-threshold") return "continue-untreated";
  if (assessment.status === "approaching" || assessment.status === "treatment-required") return treatmentReady === true ? "treatment-on" : "refuse";
  return "refuse";
}
