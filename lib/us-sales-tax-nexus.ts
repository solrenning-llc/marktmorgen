/**
 * 9 [C-US] unit 2: whether a US state's sales tax must be collected on the sales Marktmorgen facilitates there, from
 * complete sales ledgers and the per-state rules read on each state's official page (lib/us-sales-tax-rules.ts).
 *
 * One counter, not two: it counts with main's countTaxSales (lib/tax-sales-counter.ts), as TX point 9's
 * doing-business counters do (lib/us-state-tax-threshold.ts, Claude 2), and returns that module's statuses, margin and
 * sale decision. Pure arithmetic over supplied evidence: no storage, no provider, no registration. Nothing in
 * production calls it yet, and PLANS_ON_SALE and every release gate stay as they are.
 *
 * Fail closed, in this order:
 *   - a state the table does not hold, a facilitator duty or a threshold not confirmed on an official page, a scope
 *     not reviewed, or a ledger that is not complete, in USD, for that state, over the exact window: unknown, which
 *     refuses the sale;
 *   - a state with no state sales tax (Delaware, Montana, Oregon, as read): no duty;
 *   - otherwise the state's threshold, as read, against THREE windows: the current calendar year to today, the whole
 *     previous calendar year and the trailing twelve months to today. The states word their period differently
 *     (current or previous year, previous twelve months, four quarters), and the table keeps their words, not a
 *     machine reading. A threshold crossed in ANY window requires treatment, which covers each reading.
 *   - Dollars count as met at the figure itself (">=" even where a state says "exceeds"), transactions at the count
 *     itself; an "and" rule needs both; a facilitator's own threshold is the one the table holds (Oklahoma,
 *     Connecticut). Treatment switches on at US_STATE_SAFETY_MARGIN_BPS before a limit, as for the doing-business tests.
 *
 * What counts as a sale and as a transaction is the caller's: each applicable ledger entry is one transaction in the
 * state, and its amount is what the state's rule counts (gross, retail or taxable, as `counts` says for that state).
 * `applicableScopeReviewed` is the caller's statement that this was reviewed; without it nothing passes. The
 * previous-year ledger holds settled supplies only, because countTaxSales refuses a pending supply outside a ledger's
 * period.
 */
import { countTaxSales, type TaxSalesLedger } from "@/lib/tax-sales-counter";
import { usSalesTaxRule } from "@/lib/us-sales-tax-rules";
import { US_STATE_SAFETY_MARGIN_BPS, type UsStateSaleDecision, type UsStateThresholdStatus, usStateSaleDecision } from "@/lib/us-state-tax-threshold";

export type UsSalesTaxNexusEvidence = {
  state: string;
  /** Place { country: "US", state }, USD, 1 January of this year to today. */
  currentYear: TaxSalesLedger;
  /** Place { country: "US", state }, USD, the whole previous calendar year; settled supplies only. */
  previousYear: TaxSalesLedger;
  /** Place { country: "US", state }, USD, the day after the same date a year ago, to today. */
  trailingTwelveMonths: TaxSalesLedger;
  /** The caller reviewed that each applicable entry is what this state's threshold counts. */
  applicableScopeReviewed: boolean;
};

export type UsSalesTaxNexusAssessment = {
  status: UsStateThresholdStatus | "no-state-sales-tax";
  state: string | null;
  /** The highest window's amount, in cents, and its transaction count; null when not assessed. */
  peakMinor: number | null;
  peakTransactions: number | null;
  reasons: readonly string[];
};

const KEYS = ["state", "currentYear", "previousYear", "trailingTwelveMonths", "applicableScopeReviewed"] as const;
const stop = (status: "unknown" | "invalid", state: string | null, reasons: string[]): UsSalesTaxNexusAssessment =>
  ({ status, state, peakMinor: null, peakTransactions: null, reasons });

/** Plain own data fields only, exactly these keys; no accessors or inherited fields. */
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

/** The three windows, as UTC dates, for `now`. */
export function usSalesTaxWindows(now: number): Record<"currentYear" | "previousYear" | "trailingTwelveMonths", { start: string; end: string }> {
  const today = new Date(now).toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  // The same date a year ago, kept inside its month (29 February goes to the 28th), then the day after: the longer
  // window of the two readings, never the shorter.
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  const yearAgo = new Date(Date.UTC(year - 1, month - 1, Math.min(Number(today.slice(8, 10)), lastDay) + 1));
  return {
    currentYear: { start: `${year}-01-01`, end: today },
    previousYear: { start: `${year - 1}-01-01`, end: `${year - 1}-12-31` },
    trailingTwelveMonths: { start: yearAgo.toISOString().slice(0, 10), end: today },
  };
}

export function assessUsSalesTaxNexus(value: unknown, now = Date.now()): UsSalesTaxNexusAssessment {
  if (!Number.isSafeInteger(now) || now < Date.UTC(1971, 0, 1) || now > 253_402_300_799_999) return stop("invalid", null, ["now"]);
  try {
    const data = own(value);
    if (!data || typeof data.state !== "string") return stop("unknown", null, ["evidence"]);
    const state = data.state;
    const rule = usSalesTaxRule(state);
    if (!rule) return stop("unknown", state, ["state-not-in-table"]);
    const threshold = rule.threshold;
    if (threshold.known && threshold.value === "no-state-sales-tax") {
      return { status: "no-state-sales-tax", state, peakMinor: null, peakTransactions: null, reasons: ["no-state-sales-tax"] };
    }
    if (!rule.marketplaceFacilitator.known || rule.marketplaceFacilitator.value !== true) return stop("unknown", state, ["facilitator-duty"]);
    if (!threshold.known || threshold.value === "no-state-sales-tax") return stop("unknown", state, ["threshold"]);
    if (data.applicableScopeReviewed !== true) return stop("unknown", state, ["applicable-scope-not-reviewed"]);
    const { salesUsd, transactions, joiner } = threshold.value;
    if (!Number.isSafeInteger(salesUsd) || salesUsd <= 0) return stop("unknown", state, ["threshold"]);
    if (transactions !== null && (!Number.isSafeInteger(transactions) || transactions <= 0 || (joiner !== "and" && joiner !== "or"))) {
      return stop("unknown", state, ["threshold"]);
    }

    const windows = usSalesTaxWindows(now);
    const counted: { name: string; minor: bigint; count: number }[] = [];
    for (const name of ["currentYear", "previousYear", "trailingTwelveMonths"] as const) {
      const total = countTaxSales(data[name]);
      if (total.status !== "known") return stop(total.status, state, [`${name}-${total.status}`]);
      if (total.place.country !== "US" || total.place.state !== state) return stop("unknown", state, [`${name}-place`]);
      if (total.currency !== "USD") return stop("unknown", state, [`${name}-currency`]);
      if (total.periodStart !== windows[name].start || total.periodEnd !== windows[name].end) return stop("unknown", state, [`${name}-period`]);
      const minor = BigInt(total.settledApplicableMinor) + BigInt(total.reservedApplicableMinor) + BigInt(total.proposedApplicableMinor);
      counted.push({ name, minor, count: total.applicableEntries });
    }

    const BPS = BigInt(10_000);
    const room = BigInt(10_000 - US_STATE_SAFETY_MARGIN_BPS);
    const dollars = BigInt(salesUsd) * BigInt(100);
    const met: string[] = [];
    const near: string[] = [];
    for (const window of counted) {
      const dollarsMet = window.minor >= dollars;
      const dollarsNear = window.minor * BPS >= dollars * room;
      const countMet = transactions !== null && window.count >= transactions;
      const countNear = transactions !== null && BigInt(window.count) * BPS >= BigInt(transactions) * room;
      const isMet = transactions === null ? dollarsMet : joiner === "and" ? dollarsMet && countMet : dollarsMet || countMet;
      // Near is protective on purpose: either test near switches treatment on early, "and" rules included.
      const isNear = dollarsNear || countNear;
      if (isMet) met.push(`${window.name}-threshold-met`);
      else if (isNear) near.push(`${window.name}-within-margin`);
    }
    const peak = counted.reduce((a, b) => (b.minor > a.minor ? b : a));
    const peakMinor = peak.minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(peak.minor) : null;
    const peakTransactions = Math.max(...counted.map((window) => window.count));
    if (met.length) return { status: "treatment-required", state, peakMinor, peakTransactions, reasons: met };
    if (near.length) return { status: "approaching", state, peakMinor, peakTransactions, reasons: near };
    return { status: "below-threshold", state, peakMinor, peakTransactions, reasons: [] };
  } catch {
    return stop("unknown", null, ["evidence"]);
  }
}

/**
 * The sale decision, as for the doing-business tests (usStateSaleDecision): below the threshold with its margin, the
 * sale goes on without this state's collection; near or over it, only with the state's collection built and on;
 * unknown or invalid refuses. A state with no state sales tax adds no duty here (every other gate still applies).
 */
export function usSalesTaxSaleDecision(assessment: UsSalesTaxNexusAssessment, collectionReady: unknown): UsStateSaleDecision {
  if (assessment.status === "no-state-sales-tax") return "continue-untreated";
  return usStateSaleDecision({ status: assessment.status, state: null, projectedStateMinor: null, reasons: assessment.reasons }, collectionReady);
}
