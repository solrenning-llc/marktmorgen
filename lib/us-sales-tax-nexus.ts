import { countTaxSales, type TaxSalesLedger, type TaxSalesTotals } from "@/lib/tax-sales-counter";

/**
 * TX points 10 and 11 (472 [TX2]): per-state US sales tax economic nexus, and the switch that turns a state's treatment
 * on before its limit.
 *
 *   - point 10, scope "plans": Marktmorgen's own subscriptions. Where a marketplace facilitator law applies, the stores'
 *     sales Marktmorgen facilitates count toward its limit too.
 *   - point 11, scope "store-sales": the stores' sales. Marktmorgen is their seller for sales tax only where a
 *     marketplace facilitator law makes it so, and then the limit counts its own sales and the facilitated ones together.
 *
 * Pure arithmetic over supplied, complete ledgers (lib/tax-sales-counter.ts), one ledger entry per transaction. It is not a
 * nexus opinion, a registration, a filing, a tax calculator or permission to sell, and nothing in production calls it yet:
 * PLANS_ON_SALE and every release gate stay as they are. No provider or storage IO.
 *
 * Every figure needs an official dated source read for the current year. Where none was read it is null and the state can
 * never be assessed as below its limit: unknown refuses, it never becomes zero. Only a limit already passed with known
 * evidence can switch treatment on without the rest. Whether a plan is taxable in the state (point 10) is carried for the
 * treatment to use; it never lets a sale pass untreated once the limit is reached, since a state may require registration
 * even when what is sold there is exempt.
 */
export type UsStateCode =
  | "AL" | "AK" | "AZ" | "AR" | "CA" | "CO" | "CT" | "DE" | "DC" | "FL" | "GA" | "HI" | "ID"
  | "IL" | "IN" | "IA" | "KS" | "KY" | "LA" | "ME" | "MD" | "MA" | "MI" | "MN" | "MS" | "MO"
  | "MT" | "NE" | "NV" | "NH" | "NJ" | "NM" | "NY" | "NC" | "ND" | "OH" | "OK" | "OR" | "PA"
  | "RI" | "SC" | "SD" | "TN" | "TX" | "UT" | "VT" | "VA" | "WA" | "WV" | "WI" | "WY";
export type UsSalesTaxPeriod = "previous-or-current-calendar-year" | "rolling-12-months";
export type UsSalesTaxNexusRule = {
  state: UsStateCode;
  /** false only when an official source shows no sales tax a remote seller must collect at any level; null = not read. */
  hasStateSalesTax: boolean | null;
  /** USD cents of sales the limit is measured against; null = no official figure read for this year. */
  salesThresholdMinor: number | null;
  /** "exceeds": strictly more; "at-least": the limit itself meets it. null = not read (then the limit itself meets it). */
  comparator: "exceeds" | "at-least" | null;
  /** Separate transactions; "none" = the state has no transaction test (by its source); null = not read. */
  transactionThreshold: number | "none" | null;
  /** How the amount and transaction tests combine; ignored when there is no transaction test; null = not read. */
  combine: "or" | "and" | null;
  period: UsSalesTaxPeriod | null;
  /** What the amount counts: gross, taxable or retail sales. The ledgers must be counted the same way. */
  counts: "gross" | "taxable" | "retail" | null;
  /** Point 10: whether a software subscription such as a plan is taxed there. Carried only. */
  saasTaxable: "taxable" | "exempt" | "partial" | null;
  /** Point 11: whether a marketplace facilitator law makes Marktmorgen the seller of facilitated sales. */
  marketplaceFacilitator: boolean | null;
  source: string | null;
  checkedOn: string | null;
  /** What still has to be read before this state can ever be "below". */
  pending: string;
};

const NOT_READ = "No official state source has been identified and read for this state's remote seller and marketplace facilitator thresholds, its measuring period, its count basis or the taxability of software subscriptions; no figure is recorded.";
const STATES: readonly UsStateCode[] = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];
const unread = (state: UsStateCode): UsSalesTaxNexusRule => Object.freeze({
  state, hasStateSalesTax: null, salesThresholdMinor: null, comparator: null, transactionThreshold: null, combine: null,
  period: null, counts: null, saasTaxable: null, marketplaceFacilitator: null, source: null, checkedOn: null, pending: NOT_READ,
});
export const US_SALES_TAX_NEXUS_RULES: Readonly<Record<UsStateCode, UsSalesTaxNexusRule>> =
  Object.freeze(Object.fromEntries(STATES.map((state) => [state, unread(state)])) as Record<UsStateCode, UsSalesTaxNexusRule>);

/** States that cannot be assessed as below their limit until a source is read, and what each is missing. */
export const US_SALES_TAX_PENDING_SOURCES: readonly { state: UsStateCode; missing: readonly string[]; pending: string }[] =
  Object.freeze(STATES.map((state) => US_SALES_TAX_NEXUS_RULES[state]).map((rule) => Object.freeze({
    state: rule.state,
    missing: Object.freeze(([
      ["has-sales-tax", rule.hasStateSalesTax], ["sales-threshold", rule.salesThresholdMinor], ["comparator", rule.comparator],
      ["transaction-threshold", rule.transactionThreshold], ["period", rule.period], ["counts", rule.counts],
      ["saas-taxable", rule.saasTaxable], ["marketplace-facilitator", rule.marketplaceFacilitator], ["official-source", rule.source],
    ] as const).filter(([, value]) => value === null).map(([name]) => name)),
    pending: rule.pending,
  })).filter((row) => row.missing.length > 0));

/** Internal conservative room, not a legal figure: treatment switches on at 90% of a known limit, before it is passed. */
export const US_SALES_TAX_SAFETY_MARGIN_BPS = 1_000;

export type UsSalesTaxWindows = { previousYear: TaxSalesLedger; currentYear: TaxSalesLedger; trailing12Months: TaxSalesLedger };
export type UsSalesTaxNexusEvidence = {
  state: UsStateCode;
  scope: "plans" | "store-sales";
  /** The basis the ledgers' "applicable" entries were counted on; must equal the rule's. */
  countedAs: "gross" | "taxable" | "retail";
  /** Marktmorgen's own sales in the state (plans and add-ons). */
  own: UsSalesTaxWindows;
  /** The stores' sales in the state that Marktmorgen's checkout facilitates. */
  facilitated: UsSalesTaxWindows;
  applicableScopeReviewed: boolean;
};
export type UsSalesTaxNexusStatus =
  | "unknown" | "invalid" | "below-threshold" | "approaching" | "treatment-required" | "no-sales-tax" | "not-facilitator";
export type UsSalesTaxNexusAssessment = {
  status: UsSalesTaxNexusStatus;
  state: UsStateCode | null;
  /** The highest projected amount counted toward the limit over the windows used. */
  projectedMinor: number | null;
  saasTaxable: UsSalesTaxNexusRule["saasTaxable"];
  reasons: readonly string[];
};
const stop = (status: "unknown" | "invalid", state: UsStateCode | null = null, reasons: string[] = []): UsSalesTaxNexusAssessment =>
  ({ status, state, projectedMinor: null, saasTaxable: null, reasons });

/** Own data fields only: no getters run, no inherited fields, no extra keys. */
function own(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!field || !field.enumerable || !Object.hasOwn(field, "value")) return null;
    out[key] = field.value;
  }
  return out;
}
const EVIDENCE_KEYS = ["state", "scope", "countedAs", "own", "facilitated", "applicableScopeReviewed"] as const;
const WINDOW_KEYS = ["previousYear", "currentYear", "trailing12Months"] as const;
type WindowName = (typeof WINDOW_KEYS)[number];

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The day after the same date one year back (clamped to the month's end), so the window holds exactly 12 months. */
function trailingStart(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return iso(Date.UTC(y - 1, m - 1, Math.min(d, lastDay)) + 86_400_000);
}

const figure = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function ruleProblem(rule: UsSalesTaxNexusRule, state: UsStateCode): boolean {
  return !rule || rule.state !== state
    || ![true, false, null].includes(rule.hasStateSalesTax as boolean | null)
    || !(rule.salesThresholdMinor === null || figure(rule.salesThresholdMinor))
    || !(rule.transactionThreshold === null || rule.transactionThreshold === "none" || figure(rule.transactionThreshold))
    || ![null, "exceeds", "at-least"].includes(rule.comparator)
    || ![null, "or", "and"].includes(rule.combine)
    || ![null, "previous-or-current-calendar-year", "rolling-12-months"].includes(rule.period)
    || ![null, "gross", "taxable", "retail"].includes(rule.counts)
    || ![null, "taxable", "exempt", "partial"].includes(rule.saasTaxable)
    || ![true, false, null].includes(rule.marketplaceFacilitator as boolean | null);
}

type Test = "met" | "near" | "below" | "unknown";
const BPS = BigInt(10_000);
const ROOM = BigInt(10_000 - US_SALES_TAX_SAFETY_MARGIN_BPS);
function against(value: bigint, limit: number | null, strict: boolean): Test {
  if (limit === null) return "unknown";
  const l = BigInt(limit);
  if (strict ? value > l : value >= l) return "met";
  return value * BPS >= l * ROOM ? "near" : "below";
}
/** "or": either test meets it; "and": both must. A passed test under "and" still never reads as below. */
function combined(amount: Test, count: Test | null, combine: "or" | "and" | null): Test {
  if (count === null) return amount;
  if (combine === "or" || combine === null) {
    if (amount === "met" || count === "met") return "met";
    if (combine === null || amount === "unknown" || count === "unknown") return "unknown";
    return amount === "near" || count === "near" ? "near" : "below";
  }
  if (amount === "met" && count === "met") return "met";
  if (amount === "unknown" || count === "unknown") return "unknown";
  return amount !== "below" || count !== "below" ? "near" : "below";
}
const worst = (tests: Test[]): Test =>
  tests.includes("met") ? "met" : tests.includes("unknown") ? "unknown" : tests.includes("near") ? "near" : "below";

/**
 * Exact assessment of one state's sales tax limit from complete ledgers. Reservations and proposed sales count before
 * the limit. "below-threshold" needs every figure known and below its margin in every window the period uses.
 */
export function assessUsSalesTaxNexus(value: unknown, now = Date.now()): UsSalesTaxNexusAssessment {
  return assessWith(null, value, now);
}
/**
 * The same arithmetic against a candidate rule while its figures are being reviewed (and for tests). Release code must
 * use assessUsSalesTaxNexus, which reads only the recorded table; a candidate rule never changes that table.
 */
export function assessUsSalesTaxNexusUnderCandidateRule(rule: UsSalesTaxNexusRule, value: unknown, now = Date.now()): UsSalesTaxNexusAssessment {
  return assessWith(rule, value, now);
}

function assessWith(candidate: UsSalesTaxNexusRule | null, value: unknown, now: number): UsSalesTaxNexusAssessment {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) return stop("invalid");
  try {
    const data = own(value, EVIDENCE_KEYS);
    if (!data) return stop("unknown");
    if (typeof data.state !== "string" || !Object.hasOwn(US_SALES_TAX_NEXUS_RULES, data.state)) return stop("unknown");
    const state = data.state as UsStateCode;
    const rule = candidate ?? US_SALES_TAX_NEXUS_RULES[state];
    if (ruleProblem(rule, state)) return stop("unknown", state, ["rule"]);
    if (data.applicableScopeReviewed !== true) return stop("unknown", state, ["applicable-scope-not-reviewed"]);
    if (data.scope !== "plans" && data.scope !== "store-sales") return stop("unknown", state, ["scope"]);
    if (data.countedAs !== "gross" && data.countedAs !== "taxable" && data.countedAs !== "retail") return stop("unknown", state, ["counted-as"]);

    const today = iso(now);
    const year = Number(today.slice(0, 4));
    const intervals: Record<WindowName, [string, string]> = {
      previousYear: [`${year - 1}-01-01`, `${year - 1}-12-31`],
      currentYear: [`${year}-01-01`, today],
      trailing12Months: [trailingStart(today), today],
    };
    type Side = { problem: string; invalid?: boolean } | { totals: Record<WindowName, TaxSalesTotals> };
    const read = (side: unknown, name: string): Side => {
      const windows = own(side, WINDOW_KEYS);
      if (!windows) return { problem: `${name}-windows` };
      const totals = {} as Record<WindowName, TaxSalesTotals>;
      for (const key of WINDOW_KEYS) {
        const count = countTaxSales(windows[key]);
        if (count.status !== "known") return { problem: `${name}-${key}-${count.status}`, invalid: count.status === "invalid" };
        const [start, end] = intervals[key];
        if (count.place.country !== "US" || count.place.state !== state) return { problem: `${name}-${key}-place` };
        if (count.currency !== "USD") return { problem: `${name}-${key}-currency` };
        if (count.periodStart !== start || count.periodEnd !== end) return { problem: `${name}-${key}-period` };
        totals[key] = count;
      }
      return { totals };
    };
    const ownSide = read(data.own, "own");
    if ("problem" in ownSide) return stop(ownSide.invalid ? "invalid" : "unknown", state, [ownSide.problem]);
    const facilitatedSide = read(data.facilitated, "facilitated");
    if ("problem" in facilitatedSide) return stop(facilitatedSide.invalid ? "invalid" : "unknown", state, [facilitatedSide.problem]);

    const sourced = rule.source !== null && rule.checkedOn !== null && /^\d{4}-\d{2}-\d{2}$/.test(rule.checkedOn) && rule.checkedOn <= today;
    const carried = { saasTaxable: rule.saasTaxable };
    if (rule.hasStateSalesTax === false && sourced) return { status: "no-sales-tax", state, projectedMinor: null, ...carried, reasons: [] };
    if (data.scope === "store-sales" && rule.marketplaceFacilitator === false && sourced) {
      return { status: "not-facilitator", state, projectedMinor: null, ...carried, reasons: [] };
    }
    const unknown: string[] = [];
    if (!sourced) unknown.push("official-source");
    if (rule.hasStateSalesTax === null) unknown.push("has-sales-tax");
    if (rule.counts === null) unknown.push("counts");
    else if (rule.counts !== data.countedAs) return stop("unknown", state, ["counted-as-another-basis"]);
    if (rule.marketplaceFacilitator === null) unknown.push("marketplace-facilitator");

    // The facilitated sales count toward Marktmorgen's limit under a facilitator law; when the law is unknown they
    // are counted, so a passed limit is never missed (the result is then unknown, unless that higher count passed it).
    const withFacilitated = rule.marketplaceFacilitator !== false;
    const strict = rule.comparator === "exceeds";
    if (rule.comparator === null) unknown.push("comparator");
    const counted = rule.transactionThreshold === "none" ? null : rule.transactionThreshold;
    if (rule.transactionThreshold === null) unknown.push("transaction-threshold");
    if (rule.transactionThreshold !== "none" && rule.combine === null) unknown.push("combine");

    const used: WindowName[] = rule.period === "rolling-12-months" ? ["trailing12Months"]
      : rule.period === "previous-or-current-calendar-year" ? ["previousYear", "currentYear"] : [...WINDOW_KEYS];
    if (rule.period === null) unknown.push("period");

    let projected = BigInt(0);
    const tests: Test[] = [];
    for (const key of used) {
      const sides = withFacilitated ? [ownSide.totals[key], facilitatedSide.totals[key]] : [ownSide.totals[key]];
      const amount = sides.reduce((sum, t) => sum + BigInt(t.settledApplicableMinor) + BigInt(t.reservedApplicableMinor) + BigInt(t.proposedApplicableMinor), BigInt(0));
      const transactions = BigInt(sides.reduce((sum, t) => sum + t.applicableEntries, 0));
      if (amount > projected) projected = amount;
      const amountTest = against(amount, rule.salesThresholdMinor, strict);
      const countTest = rule.transactionThreshold === "none" ? null : rule.transactionThreshold === null ? "unknown" : against(transactions, counted as number, strict);
      tests.push(combined(amountTest, countTest, rule.transactionThreshold === "none" ? null : rule.combine));
    }
    if (projected > BigInt(Number.MAX_SAFE_INTEGER)) return stop("invalid", state, ["overflow"]);
    const projectedMinor = Number(projected);
    const result = worst(tests);
    if (result === "met") return { status: "treatment-required", state, projectedMinor, ...carried, reasons: ["threshold-reached"] };
    if (result === "unknown" || unknown.length) {
      return { status: "unknown", state, projectedMinor, ...carried, reasons: unknown.length ? unknown : ["sales-threshold"] };
    }
    if (result === "near") return { status: "approaching", state, projectedMinor, ...carried, reasons: ["within-margin"] };
    return { status: "below-threshold", state, projectedMinor, ...carried, reasons: [] };
  } catch {
    return stop("unknown");
  }
}

export type UsSalesTaxSaleDecision = "continue-untreated" | "treatment-on" | "refuse";
/**
 * Below the limit with its margin, a state with no sales tax, or a store sale where no facilitator law makes Marktmorgen
 * the seller: the sale continues without this state's treatment (every other gate still applies). Near or over the limit:
 * only with the state's treatment built and on, otherwise refused before the limit is passed. Unknown or invalid
 * evidence always refuses.
 */
export function usSalesTaxSaleDecision(assessment: UsSalesTaxNexusAssessment, treatmentReady: unknown): UsSalesTaxSaleDecision {
  const status = assessment?.status;
  if (status === "below-threshold" || status === "no-sales-tax" || status === "not-facilitator") return "continue-untreated";
  if (status === "approaching" || status === "treatment-required") return treatmentReady === true ? "treatment-on" : "refuse";
  return "refuse";
}
