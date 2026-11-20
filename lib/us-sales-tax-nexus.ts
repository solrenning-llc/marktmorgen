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
 *   - otherwise the state's threshold, as read, against EVERY period a state may name: the current calendar year to
 *     today, the whole previous calendar year, the trailing twelve months to today, and the twelve months ending at
 *     each of the last twelve month ends. That last set holds each state's "twelve months ending at a quarter's end",
 *     whatever its quarters are (Connecticut's September 30, New York's four sales tax quarters, Missouri's
 *     quarter-end tests; Claude 3's MEDIUM on #4961). The table keeps the states' words, not a machine reading, so a
 *     threshold crossed in ANY of these windows requires treatment, which covers each reading; treatment can switch on
 *     early, never late.
 *   - Dollars count as met at the figure itself (">=" even where a state says "exceeds"), transactions at the count
 *     itself; an "and" rule needs both; a facilitator's own threshold is the one the table holds (Oklahoma,
 *     Connecticut). Treatment switches on at US_STATE_SAFETY_MARGIN_BPS before a limit, as for the doing-business tests.
 *
 * What counts as a sale and as a transaction is the caller's: each applicable ledger entry is one transaction in the
 * state, and its amount is what the state's rule counts (gross, retail or taxable, as `counts` says for that state).
 * `applicableScopeReviewed` is the caller's statement that this was reviewed; without it nothing passes. One ledger
 * covers every window (usSalesTaxLookback): a pending supply (reserved or proposed) counts only in the windows that end
 * today and that it falls in, so one from December still pending in January is counted in the trailing twelve months
 * and does not make the current year unknown; one dated before the trailing twelve months refuses (counted nowhere).
 */
import { countTaxSales, type TaxSalesLedger } from "@/lib/tax-sales-counter";
import { usSalesTaxRule } from "@/lib/us-sales-tax-rules";
import { US_STATE_SAFETY_MARGIN_BPS, type UsStateSaleDecision, type UsStateThresholdStatus, usStateSaleDecision } from "@/lib/us-state-tax-threshold";

export type UsSalesTaxNexusEvidence = {
  state: string;
  /** Place { country: "US", state }, USD, exactly usSalesTaxLookback(now): every window below is read from it. */
  ledger: TaxSalesLedger;
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

const KEYS = ["state", "ledger", "applicableScopeReviewed"] as const;
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

const iso = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);

export type UsSalesTaxWindow = { name: string; start: string; end: string };

/**
 * Every window a state's period may be, as UTC dates, for `now`: the current year to today, the previous year, the
 * trailing twelve months to today, and the twelve months ending at each of the last twelve month ends.
 */
export function usSalesTaxWindows(now: number): UsSalesTaxWindow[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  // The same date a year ago, kept inside its month (29 February goes to the 28th), then the day after: the longer
  // window of the two readings, never the shorter.
  const lastDay = new Date(Date.UTC(year - 1, m0 + 1, 0)).getUTCDate();
  const windows: UsSalesTaxWindow[] = [
    { name: "current-year", start: `${year}-01-01`, end: today },
    { name: "previous-year", start: `${year - 1}-01-01`, end: `${year - 1}-12-31` },
    { name: "trailing-twelve-months", start: iso(year - 1, m0, Math.min(Number(today.slice(8, 10)), lastDay) + 1), end: today },
  ];
  for (let back = 1; back <= 12; back += 1) {
    // Day 0 of a month is the last day of the month before it.
    const end = iso(year, m0 - back + 1, 0);
    windows.push({ name: `twelve-months-to-${end}`, start: iso(year, m0 - back - 11, 1), end });
  }
  return windows;
}

/** The one ledger interval that holds every window: from the earliest start to today. */
export function usSalesTaxLookback(now: number): { start: string; end: string } {
  const windows = usSalesTaxWindows(now);
  return { start: windows.map((w) => w.start).sort()[0], end: windows[0].end };
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

    const lookback = usSalesTaxLookback(now);
    const whole = countTaxSales(data.ledger);
    if (whole.status !== "known") return stop(whole.status, state, [`ledger-${whole.status}`]);
    if (whole.place.country !== "US" || whole.place.state !== state) return stop("unknown", state, ["ledger-place"]);
    if (whole.currency !== "USD") return stop("unknown", state, ["ledger-currency"]);
    if (whole.periodStart !== lookback.start || whole.periodEnd !== lookback.end) return stop("unknown", state, ["ledger-period"]);
    // Read once, as plain data, after countTaxSales has checked every field: each window is counted from this copy.
    const ledger = structuredClone(data.ledger) as TaxSalesLedger;
    const windows = usSalesTaxWindows(now);
    // A pending supply (reserved or proposed) is counted in the trailing twelve months, which end today. One dated
    // before that window would be counted nowhere: unknown, never zero.
    const trailing = windows.find((window) => window.name === "trailing-twelve-months");
    if (!trailing || trailing.end !== lookback.end) return stop("unknown", state, ["trailing-window"]);
    if (ledger.entries.some((entry) => entry.position !== "settled" && entry.supplyOn < trailing.start)) {
      return stop("unknown", state, ["pending-before-trailing-twelve-months"]);
    }
    const counted: { name: string; minor: bigint; count: number }[] = [];
    for (const window of windows) {
      // A pending supply belongs to the windows that end today and that it falls in (a December supply still pending
      // on 2 January is in the trailing twelve months, not in the current year); a window that ended before has
      // settled supplies only (Claude 2's MEDIUM on #4961).
      const entries = ledger.entries.filter((entry) => entry.position === "settled" || (window.end === lookback.end && entry.supplyOn >= window.start));
      const total = countTaxSales({ ...ledger, periodStart: window.start, periodEnd: window.end, entries });
      if (total.status !== "known") return stop(total.status, state, [`${window.name}-${total.status}`]);
      const minor = BigInt(total.settledApplicableMinor) + BigInt(total.reservedApplicableMinor) + BigInt(total.proposedApplicableMinor);
      counted.push({ name: window.name, minor, count: total.applicableEntries });
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
