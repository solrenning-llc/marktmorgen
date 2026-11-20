/**
 * TX point 9: a US state's income, franchise or gross-receipts tax is assessed before its nexus threshold,
 * from a snapshot of that state's sales. This is arithmetic over reviewed evidence. It is not a registration,
 * a filing, a tax amount, a nexus opinion or a permission to sell. No storage, provider or network access.
 *
 * Sources: Codex V's reports of 19 November 2026 on the `codex-relatorios` branch
 * (V-20261119-1344 California, -1346 Delaware, -1349 Texas, -1351 Washington, -1353 Florida and New York,
 * -1355 Illinois). Only Texas and Washington have a receipts test that the sources state as a figure.
 * Every other state answers `unknown`, which refuses: California's 2026 index was not found, and Florida,
 * Illinois and New York first need the entity's classification reviewed. Delaware is a fixed annual tax
 * (lib/llc-fixed-costs.ts), not a threshold. Unknown evidence never becomes a zero total or a zero tax.
 */

/** Below-threshold only below 90% of the threshold: refunds, reservations in flight and timing move the count. */
export const STATE_BUSINESS_TAX_SAFETY_BPS = 9_000;

export type StateBusinessTaxFact = "physicalPresence" | "organizedOrDomiciledInState" | "useTaxPermit";

type ReceiptsNexusRule = {
  readonly kind: "receipts-nexus";
  readonly tax: string;
  readonly currency: "USD";
  readonly thresholdMinor: number;
  readonly comparison: "gt" | "gte";
  /** The window the threshold is measured over; the caller attests it with `periodReviewed`. */
  readonly window: "accounting-period" | "current-or-prior-calendar-year";
  /** Each non-sales test the source lists. It must read exactly false for `below-threshold`. */
  readonly facts: readonly StateBusinessTaxFact[];
  readonly sources: readonly string[];
  readonly readOn: string;
  /** From this day on, the reading is too old to trust: the state answers `unknown` until it is read again. */
  readonly reviewBy: string;
};
type NotAssessableRule = {
  readonly kind: "not-assessable";
  readonly tax: string;
  readonly reason: string;
  readonly sources: readonly string[];
  readonly readOn: string;
};
export type StateBusinessTaxRule = ReceiptsNexusRule | NotAssessableRule;

const freezeRule = <T extends StateBusinessTaxRule>(rule: T): T =>
  Object.freeze({ ...rule, sources: Object.freeze([...rule.sources]), ...("facts" in rule ? { facts: Object.freeze([...rule.facts]) } : {}) }) as T;

export const STATE_BUSINESS_TAX_RULES = Object.freeze({
  CA: freezeRule({
    kind: "not-assessable",
    tax: "California LLC annual tax and LLC fee (doing business, R&TC §23101)",
    reason: "The FTB table stops at tax year 2025 (USD 757,070 of California sales); no 2026 index was found, and the 2025 "
      + "figure is not carried forward. Doing business is also met by property, payroll, 25% of the total, organization or "
      + "commercial domicile, which a sales count alone cannot rule out.",
    sources: [
      "https://www.ftb.ca.gov/file/business/doing-business-in-california.html",
      "https://www.ftb.ca.gov/forms/2025/2025-568-booklet.html",
      "https://www.ftb.ca.gov/forms/2026/2026-3522.pdf",
    ],
    readOn: "2026-11-19",
  }),
  FL: freezeRule({
    kind: "not-assessable",
    tax: "Florida corporate income tax (chapter 220)",
    reason: "Whether it applies depends first on the LLC's classification (Fla. Stat. §605.1103), not on a sales threshold. "
      + "The USD 100,000 figure belongs to remote sales tax, not to income tax.",
    sources: [
      "https://www.flsenate.gov/Laws/Statutes/2026/605.1103",
      "https://floridarevenue.com/taxes/taxesfees/Pages/corporate.aspx",
    ],
    readOn: "2026-11-19",
  }),
  IL: freezeRule({
    kind: "not-assessable",
    tax: "Illinois income and replacement tax",
    reason: "The Department of Revenue taxes an LLC by its federal classification and Illinois-source income; no numeric "
      + "receipts threshold was found that could be applied without reviewing the entity and the source of income.",
    sources: [
      "https://tax.illinois.gov/questionsandanswers/answer.604.html",
      "https://tax.illinois.gov/questionsandanswers/answer.74.html",
    ],
    readOn: "2026-11-19",
  }),
  NY: freezeRule({
    kind: "not-assessable",
    tax: "New York franchise tax and LLC filing fee",
    reason: "The Article 9-A receipts threshold (USD 1,283,000 for years beginning in 2024 through 2026) applies to "
      + "corporations, not by itself to a disregarded single-member LLC; the USD 25 filing fee follows New York-source income.",
    sources: [
      "https://www.tax.ny.gov/pit/efile/llc_llp.htm",
      "https://www.tax.ny.gov/bus/ct/article9a_deriving_receipts.htm",
      "https://www.nysenate.gov/legislation/laws/TAX/658",
    ],
    readOn: "2026-11-19",
  }),
  TX: freezeRule({
    kind: "receipts-nexus",
    tax: "Texas franchise tax (economic nexus)",
    currency: "USD",
    // USD 500,000 or more of Texas gross receipts; nexus starts on the first day of the federal accounting period
    // in which it is reached. Whether tax is due (the USD 2.65 M no-tax-due threshold) is a separate question.
    // The figure was read in the Franchise Tax section of the remote-sellers page, not in its Use Tax section
    // (a different USD 500,000 test). The rule itself, 34 TAC §3.586 (STAR 202601004R), did not open as readable
    // text in Codex V's report, so it is not listed as a source read. When the nexus ends was not read either, so a
    // closed prior period that reached the threshold carries nexus here: a cautious reading of an unread rule, not a finding.
    thresholdMinor: 50_000_000,
    comparison: "gte",
    window: "accounting-period",
    facts: ["physicalPresence", "useTaxPermit"],
    sources: [
      "https://comptroller.texas.gov/taxes/sales/remote-sellers.php",
      "https://comptroller.texas.gov/taxes/sales/marketplace-providers-sellers.php",
      "https://comptroller.texas.gov/taxes/franchise/index.php",
    ],
    readOn: "2026-11-19",
    reviewBy: "2027-11-19",
  }),
  WA: freezeRule({
    kind: "receipts-nexus",
    tax: "Washington business and occupation tax (substantial nexus, RCW 82.04.067)",
    currency: "USD",
    // More than USD 100,000 of cumulative Washington gross receipts in the current or the prior calendar year.
    // A marketplace facilitator counts its sellers' sales through the platform toward the threshold.
    thresholdMinor: 10_000_000,
    comparison: "gt",
    window: "current-or-prior-calendar-year",
    facts: ["physicalPresence", "organizedOrDomiciledInState"],
    sources: [
      "https://app.leg.wa.gov/RCW/default.aspx?cite=82.04.067",
      "https://app.leg.wa.gov/RCW/default.aspx?cite=82.04.220",
    ],
    readOn: "2026-11-19",
    reviewBy: "2027-11-19",
  }),
} as const);

export type StateBusinessTaxSnapshot = {
  /** Two-letter US state code, upper case. */
  state: string;
  /** The calendar year being assessed; the reading must be from that year, on the day of the assessment. */
  year: number;
  recordedOn: string;
  currency: "USD";
  /** Every gross receipt attributable to the state over the rule's window is in the totals below. */
  completeCoverage: boolean;
  /** A reviewer established that the totals' window is the rule's window (accounting period or calendar year). */
  periodReviewed: boolean;
  /** The totals include the marketplace sellers' sales through the platform (never an undercount). */
  includesMarketplaceSellers: boolean;
  settledMinor: number | null;
  reservedMinor: number | null;
  proposedMinor: number | null;
  /** The closed prior period's total (the prior calendar year, or Texas's prior accounting period). */
  priorYearMinor: number | null;
  facts: Record<StateBusinessTaxFact, boolean | null>;
};
export type StateBusinessTaxAssessment = {
  status: "unknown" | "invalid" | "below-threshold" | "treatment-required";
  projectedMinor: number | null;
};

const KEYS = [
  "state", "year", "recordedOn", "currency", "completeCoverage", "periodReviewed", "includesMarketplaceSellers",
  "settledMinor", "reservedMinor", "proposedMinor", "priorYearMinor", "facts",
] as const;
const FACT_KEYS = ["physicalPresence", "organizedOrDomiciledInState", "useTaxPermit"] as const;
const stop = (status: "unknown" | "invalid"): StateBusinessTaxAssessment => ({ status, projectedMinor: null });
const money = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The exact own, enumerable data fields of a plain object, or null when anything else is there. */
function exactFields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  // String-only enumeration would silently ignore extra symbol fields.
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) return null;
    const field = descriptors[key];
    if (!field || !field.enumerable || !Object.hasOwn(field, "value")) return null;
    data[key] = field.value;
  }
  return data;
}

/**
 * Exact minor-unit assessment of one state's snapshot. `below-threshold` is never permission to sell or proof
 * of no tax: filings, other taxes, costs and every release gate still apply. `treatment-required` means the
 * state's treatment must be built and reviewed before the sale completes; this helper never claims it exists.
 */
export function assessStateBusinessTax(value: unknown, now = Date.now()): StateBusinessTaxAssessment {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) return stop("invalid");
  let data: Record<string, unknown> | null;
  let facts: Record<string, unknown> | null;
  try {
    data = exactFields(value, KEYS);
    if (!data) return stop("unknown");
    facts = exactFields(data.facts, FACT_KEYS);
    if (!facts) return stop("unknown");
  } catch { return stop("unknown"); }
  if (typeof data.state !== "string" || !/^[A-Z]{2}$/.test(data.state) || !Object.hasOwn(STATE_BUSINESS_TAX_RULES, data.state)) return stop("unknown");
  const rule: StateBusinessTaxRule = STATE_BUSINESS_TAX_RULES[data.state as keyof typeof STATE_BUSINESS_TAX_RULES];
  if (rule.kind !== "receipts-nexus") return stop("unknown");
  const today = new Date(now).toISOString().slice(0, 10);
  if (today < rule.readOn || today >= rule.reviewBy || data.recordedOn !== today || data.year !== Number(today.slice(0, 4))
    || data.currency !== rule.currency || data.completeCoverage !== true || data.periodReviewed !== true
    || data.includesMarketplaceSellers !== true) return stop("unknown");
  for (const key of FACT_KEYS) if (facts[key] !== true && facts[key] !== false && facts[key] !== null) return stop("unknown");

  const amounts = [data.settledMinor, data.reservedMinor, data.proposedMinor];
  if (amounts.some(amount => amount === null || amount === undefined)) return stop("unknown");
  if (!amounts.every(money)) return stop("invalid");
  const total = amounts.reduce<bigint>((sum, amount) => sum + BigInt(amount as number), BigInt(0));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return stop("invalid");
  const projected = Number(total);
  const threshold = BigInt(rule.thresholdMinor);

  // Both rules read the closed prior period: Washington by statute, Texas because when its nexus ends was not read.
  if (data.priorYearMinor === null || data.priorYearMinor === undefined) return stop("unknown");
  if (!money(data.priorYearMinor)) return stop("invalid");
  const prior = BigInt(data.priorYearMinor);
  const reached = (amount: bigint) => rule.comparison === "gte" ? amount >= threshold : amount > threshold;

  // A non-sales test that is met needs treatment at any amount; one that is not known refuses.
  const listed = rule.facts.map(fact => facts[fact]);
  if (listed.some(fact => fact === true)) return { status: "treatment-required", projectedMinor: projected };
  // The closed prior period is compared at the threshold itself.
  if (reached(prior)) return { status: "treatment-required", projectedMinor: projected };
  if (listed.some(fact => fact === null)) return stop("unknown");
  // The current year must stay below the safety share of the threshold, so treatment comes before the threshold.
  const below = total * BigInt(10_000) < threshold * BigInt(STATE_BUSINESS_TAX_SAFETY_BPS);
  return { status: below ? "below-threshold" : "treatment-required", projectedMinor: projected };
}
