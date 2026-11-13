/**
 * TX points 10 and 11 (472 [TX2]): per-state US sales tax economic nexus, for Marktmorgen's own plans (point 10) and
 * for the stores' sales it facilitates (point 11). Pure arithmetic over supplied ledgers; synthetic only.
 *
 * No state figure has been read from an official source yet, so the recorded table must never let a state be "below":
 * every state is unknown and every sale refuses. The arithmetic itself is held against candidate rules.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TaxSalesLedger } from "@/lib/tax-sales-counter";
import {
  assessUsSalesTaxNexus, assessUsSalesTaxNexusUnderCandidateRule, US_SALES_TAX_NEXUS_RULES, US_SALES_TAX_PENDING_SOURCES,
  usSalesTaxSaleDecision, type UsSalesTaxNexusRule,
} from "@/lib/us-sales-tax-nexus";

const now = Date.parse("2026-11-13T15:00:00Z");
type Line = { amount: number; position?: "settled" | "reserved" | "proposed"; on?: string };
let serial = 0;
const ledger = (state: string, periodStart: string, periodEnd: string, lines: Line[] = []): TaxSalesLedger => ({
  place: { country: "US", state }, currency: "USD", periodStart, periodEnd, coverageFrom: periodStart, coverageThrough: periodEnd, complete: true,
  entries: lines.map((line) => ({
    id: `synthetic-${++serial}`, country: "US", state, currency: "USD", supplyOn: line.on ?? periodEnd,
    position: line.position ?? "settled", amountMinor: line.amount, applicable: true,
  })),
});
const windows = (state: string, lines: { previous?: Line[]; current?: Line[]; trailing?: Line[] } = {}) => ({
  previousYear: ledger(state, "2025-01-01", "2025-12-31", lines.previous),
  currentYear: ledger(state, "2026-01-01", "2026-11-13", lines.current),
  trailing12Months: ledger(state, "2025-11-14", "2026-11-13", lines.trailing),
});
const evidence = (over: Record<string, unknown> = {}) => ({
  state: "TX", scope: "plans", countedAs: "gross", own: windows("TX"), facilitated: windows("TX"), applicableScopeReviewed: true, ...over,
});
const rule = (over: Partial<UsSalesTaxNexusRule> = {}): UsSalesTaxNexusRule => ({
  state: "TX", hasStateSalesTax: true, salesThresholdMinor: 10_000_000, comparator: "exceeds", transactionThreshold: "none",
  combine: null, period: "previous-or-current-calendar-year", counts: "gross", saasTaxable: "taxable", marketplaceFacilitator: true,
  source: "https://example.invalid/official-state-source", checkedOn: "2026-11-13", pending: "", ...over,
});
const many = (count: number, amount = 1): Line[] => Array.from({ length: count }, () => ({ amount }));

test("the recorded table has every state and DC, and none can be below its limit: no figure was read", () => {
  assert.equal(Object.keys(US_SALES_TAX_NEXUS_RULES).length, 51);
  for (const [state, recorded] of Object.entries(US_SALES_TAX_NEXUS_RULES)) {
    assert.equal(recorded.state, state);
    assert.equal(recorded.salesThresholdMinor, null, state);
    const answer = assessUsSalesTaxNexus(evidence({ state, own: windows(state), facilitated: windows(state) }), now);
    assert.equal(answer.status, "unknown", state);
    assert.equal(usSalesTaxSaleDecision(answer, true), "refuse", state);
  }
  assert.equal(US_SALES_TAX_PENDING_SOURCES.length, 51);
});

test("below a known limit with its margin the sale continues untreated; within 10% it is approaching; over it, treatment", () => {
  const r = rule();
  const below = assessUsSalesTaxNexusUnderCandidateRule(r, evidence({ own: windows("TX", { current: [{ amount: 8_000_000 }] }) }), now);
  assert.equal(below.status, "below-threshold");
  assert.equal(usSalesTaxSaleDecision(below, false), "continue-untreated");
  const near = assessUsSalesTaxNexusUnderCandidateRule(r, evidence({ own: windows("TX", { current: [{ amount: 9_000_000 }] }) }), now);
  assert.equal(near.status, "approaching");
  assert.equal(usSalesTaxSaleDecision(near, false), "refuse");
  assert.equal(usSalesTaxSaleDecision(near, true), "treatment-on");
  const over = assessUsSalesTaxNexusUnderCandidateRule(r, evidence({ own: windows("TX", { previous: [{ amount: 10_000_001 }] }) }), now);
  assert.equal(over.status, "treatment-required");
  assert.equal(usSalesTaxSaleDecision(over, false), "refuse");
});

test("the comparator decides the exact limit: exceeds versus at least", () => {
  const atLimit = evidence({ own: windows("TX", { current: [{ amount: 10_000_000 }] }) });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ comparator: "exceeds" }), atLimit, now).status, "approaching");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ comparator: "at-least" }), atLimit, now).status, "treatment-required");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ comparator: null }), atLimit, now).status, "treatment-required", "unknown comparator meets at the limit");
});

test("reservations and proposed sales count before the limit", () => {
  const lines = [{ amount: 6_000_000 }, { amount: 3_000_000, position: "reserved" as const }, { amount: 1_000_001, position: "proposed" as const }];
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule(), evidence({ own: windows("TX", { current: lines }) }), now).status, "treatment-required");
});

test("the period decides which windows count", () => {
  const trailingOnly = evidence({ own: windows("TX", { trailing: [{ amount: 10_000_001 }] }) });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule(), trailingOnly, now).status, "below-threshold");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ period: "rolling-12-months" }), trailingOnly, now).status, "treatment-required");
  const previousOnly = evidence({ own: windows("TX", { previous: [{ amount: 10_000_001 }] }) });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ period: "rolling-12-months" }), previousOnly, now).status, "below-threshold");
  // An unknown period: a limit passed in any window turns treatment on; otherwise unknown, never below.
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ period: null }), previousOnly, now).status, "treatment-required");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ period: null }), evidence(), now).status, "unknown");
});

test("the transaction test: 'or' meets on either, 'and' needs both", () => {
  const count = evidence({ own: windows("TX", { current: many(201) }) });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: 200, combine: "or" }), count, now).status, "treatment-required");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: 200, combine: "and" }), count, now).status, "approaching",
    "the count passed but the amount is far: 'and' is not met, yet one test passed, so it never reads as below");
  const both = evidence({ own: windows("TX", { current: [...many(200), { amount: 10_000_000 }] }) });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: 200, combine: "and" }), both, now).status, "treatment-required");
  const few = evidence({ own: windows("TX", { current: many(10) }) });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: 200, combine: "or" }), few, now).status, "below-threshold");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: 200, combine: "or" }), evidence({ own: windows("TX", { current: many(181) }) }), now).status, "approaching");
  // A transaction test whose figure or combination is unknown never lets a state be below.
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: null, combine: "or" }), few, now).status, "unknown");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: 200, combine: null }), few, now).status, "unknown");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: null, combine: "or" }), count, now).status, "unknown");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ transactionThreshold: null, combine: "or" }), evidence({ own: windows("TX", { current: [{ amount: 10_000_001 }] }) }), now).status, "treatment-required");
});

test("point 11: the stores' sales count toward Marktmorgen's limit where a marketplace facilitator law applies", () => {
  const facilitated = evidence({ own: windows("TX", { current: [{ amount: 5_000_000 }] }), facilitated: windows("TX", { current: [{ amount: 5_000_001 }] }) });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ marketplaceFacilitator: true }), facilitated, now).status, "treatment-required");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ marketplaceFacilitator: false }), facilitated, now).status, "below-threshold");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ marketplaceFacilitator: null }), facilitated, now).status, "treatment-required",
    "an unknown law: the higher count passing turns treatment on");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ marketplaceFacilitator: null }), evidence(), now).status, "unknown");
  // The stores' own sales, where no facilitator law makes Marktmorgen their seller, are not Marktmorgen's to treat.
  const stores = evidence({ scope: "store-sales", facilitated: windows("TX", { current: [{ amount: 20_000_000 }] }) });
  const none = assessUsSalesTaxNexusUnderCandidateRule(rule({ marketplaceFacilitator: false }), stores, now);
  assert.equal(none.status, "not-facilitator");
  assert.equal(usSalesTaxSaleDecision(none, false), "continue-untreated");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ marketplaceFacilitator: true }), stores, now).status, "treatment-required");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ marketplaceFacilitator: null }), { ...stores, facilitated: windows("TX") }, now).status, "unknown");
});

test("point 10: a plan that is exempt there never lets a sale pass untreated once the limit is reached", () => {
  const over = evidence({ own: windows("TX", { current: [{ amount: 10_000_001 }] }) });
  const answer = assessUsSalesTaxNexusUnderCandidateRule(rule({ saasTaxable: "exempt" }), over, now);
  assert.equal(answer.status, "treatment-required");
  assert.equal(answer.saasTaxable, "exempt");
  assert.equal(usSalesTaxSaleDecision(answer, false), "refuse");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ saasTaxable: null }), evidence(), now).status, "below-threshold",
    "taxability is the treatment's question, not the limit's: an unknown one is carried, not used to pass or fail the count");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ saasTaxable: null }), evidence(), now).saasTaxable, null);
});

test("a state with no sales tax, by an official source, has nothing to treat; an unread one is unknown", () => {
  const none = assessUsSalesTaxNexusUnderCandidateRule(rule({ hasStateSalesTax: false, salesThresholdMinor: null }), evidence(), now);
  assert.equal(none.status, "no-sales-tax");
  assert.equal(usSalesTaxSaleDecision(none, false), "continue-untreated");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ hasStateSalesTax: false, source: null }), evidence(), now).status, "unknown");
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ hasStateSalesTax: null }), evidence(), now).status, "unknown");
});

test("evidence that is incomplete, mismatched or malformed is unknown or invalid, never below", () => {
  const r = rule();
  const cases: [string, unknown][] = [
    ["scope not reviewed", evidence({ applicableScopeReviewed: false })],
    ["counted as another basis", evidence({ countedAs: "taxable" })],
    ["unknown scope", evidence({ scope: "everything" })],
    ["another state's ledger", evidence({ own: windows("CA") })],
    ["a whole-country ledger", evidence({ own: { ...windows("TX"), currentYear: { ...ledger("TX", "2026-01-01", "2026-11-13"), place: { country: "US", state: null } } } })],
    ["an old current year", evidence({ own: { ...windows("TX"), currentYear: ledger("TX", "2026-01-01", "2026-11-12") } })],
    ["a short previous year", evidence({ own: { ...windows("TX"), previousYear: ledger("TX", "2025-02-01", "2025-12-31") } })],
    ["a short trailing window", evidence({ own: { ...windows("TX"), trailing12Months: ledger("TX", "2025-12-01", "2026-11-13") } })],
    ["incomplete coverage", evidence({ own: { ...windows("TX"), currentYear: { ...ledger("TX", "2026-01-01", "2026-11-13"), complete: false } } })],
    ["another currency", evidence({ own: { ...windows("TX"), currentYear: { ...ledger("TX", "2026-01-01", "2026-11-13"), currency: "EUR" } } })],
    ["a missing window", evidence({ own: { previousYear: windows("TX").previousYear, currentYear: windows("TX").currentYear } })],
    ["an extra field", { ...evidence(), extra: 1 }],
    ["not an object", "TX"],
    ["an unknown state", evidence({ state: "PR" })],
  ];
  for (const [name, value] of cases) {
    const answer = assessUsSalesTaxNexusUnderCandidateRule(r, value, now);
    assert.ok(answer.status === "unknown" || answer.status === "invalid", `${name}: ${answer.status}`);
    assert.equal(usSalesTaxSaleDecision(answer, true), "refuse", name);
  }
  const getter = evidence();
  Object.defineProperty(getter, "applicableScopeReviewed", { get: () => true, enumerable: true });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(r, getter, now).status, "unknown", "a getter is never run");
});

test("a rule with a source read after today, or a malformed figure, is unknown", () => {
  for (const bad of [rule({ checkedOn: "2026-11-14" }), rule({ source: null }), rule({ salesThresholdMinor: -1 }), rule({ salesThresholdMinor: 1.5 }),
    rule({ transactionThreshold: -3, combine: "or" }), rule({ state: "CA" })]) {
    assert.equal(assessUsSalesTaxNexusUnderCandidateRule(bad, evidence(), now).status, "unknown", JSON.stringify(bad));
  }
});

test("the trailing window ends today and starts the day after the same date a year back, February 29 included", () => {
  const leap = Date.parse("2028-02-29T12:00:00Z");
  const e = evidence({
    own: {
      previousYear: ledger("TX", "2027-01-01", "2027-12-31"), currentYear: ledger("TX", "2028-01-01", "2028-02-29"), trailing12Months: ledger("TX", "2027-03-01", "2028-02-29"),
    },
    facilitated: {
      previousYear: ledger("TX", "2027-01-01", "2027-12-31"), currentYear: ledger("TX", "2028-01-01", "2028-02-29"), trailing12Months: ledger("TX", "2027-03-01", "2028-02-29"),
    },
  });
  assert.equal(assessUsSalesTaxNexusUnderCandidateRule(rule({ checkedOn: "2028-01-01" }), e, leap).status, "below-threshold");
});
