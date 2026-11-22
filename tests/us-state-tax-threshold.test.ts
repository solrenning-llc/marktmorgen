import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaxSalesEntry, TaxSalesLedger } from "@/lib/tax-sales-counter";
import {
  assessUsStateThreshold, assessUsStateThresholdUnderCandidateRule, usStateSaleDecision,
  US_STATE_INCOME_FRANCHISE_RULES, US_STATE_PENDING_SOURCES, US_STATE_SAFETY_MARGIN_BPS,
  type UsStateIncomeFranchiseRule, type UsStateThresholdEvidence,
} from "@/lib/us-state-tax-threshold";
import { PLANS_ON_SALE } from "@/lib/opening";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const entry = (id: string, state: string | null, amountMinor: number, change: Partial<TaxSalesEntry> = {}): TaxSalesEntry => ({
  id, country: "US", state, currency: "USD", supplyOn: "2026-06-01",
  position: "settled", amountMinor, applicable: true, ...change,
});
const ledger = (state: string | null, entries: TaxSalesEntry[]): TaxSalesLedger => ({
  place: { country: "US", state }, currency: "USD",
  periodStart: "2026-01-01", periodEnd: "2026-11-13",
  coverageFrom: "2026-01-01", coverageThrough: "2026-11-13", complete: true, entries,
});
const evidence = (state: "CA" | "NY", entries: TaxSalesEntry[], change: Partial<UsStateThresholdEvidence> = {}): UsStateThresholdEvidence => ({
  state, stateLedger: ledger(state, entries), usLedger: ledger(null, entries),
  applicableScopeReviewed: true, nonSalesFactors: "none", ...change,
});
// A candidate rule under review: figures are synthetic, never a recorded limit.
const candidate = (change: Partial<UsStateIncomeFranchiseRule> = {}): UsStateIncomeFranchiseRule => ({
  ...US_STATE_INCOME_FRANCHISE_RULES.CA, salesThresholdMinor: 1_000_000, ...change,
});

test("every state and DC has a rule, and none can be assessed below its limit without a read source", () => {
  assert.equal(Object.keys(US_STATE_INCOME_FRANCHISE_RULES).length, 51);
  for (const rule of Object.values(US_STATE_INCOME_FRANCHISE_RULES)) {
    assert.ok(Object.isFrozen(rule));
    // No current-year sales figure was read for any state (California's table ends at 2025).
    assert.equal(rule.salesThresholdMinor, null, rule.state);
    const small = evidence("CA", [entry("one", "CA", 1)], { state: rule.state as "CA" });
    small.stateLedger = ledger(rule.state, [entry("one", rule.state, 1)]);
    small.usLedger = ledger(null, [entry("one", rule.state, 1), entry("other", "ZZ", 10_000_000)]);
    const result = assessUsStateThreshold(small, NOW);
    assert.equal(result.status, "unknown", rule.state);
    assert.equal(usStateSaleDecision(result, true), "refuse", rule.state);
  }
  assert.equal(US_STATE_PENDING_SOURCES.length, 51);
  const ca = US_STATE_PENDING_SOURCES.find(row => row.state === "CA");
  assert.deepEqual(ca?.missing, ["sales-threshold"]);
  assert.match(ca?.pending ?? "", /leginfo\.legislature\.ca\.gov/);
  assert.ok(US_STATE_PENDING_SOURCES.filter(row => row.state !== "CA").every(row => row.source === null && row.missing.includes("official-source")));
});

test("California's recorded 25% relative test switches treatment on even while the sales amount is unknown", () => {
  // 30 of 100 US cents are Californian: 30% exceeds 25%.
  const value = evidence("CA", [entry("ca", "CA", 30), entry("ny", "NY", 70)]);
  const result = assessUsStateThreshold(value, NOW);
  assert.deepEqual(result, { status: "treatment-required", state: "CA", projectedStateMinor: 30, reasons: ["relative-share-exceeded"] });
  assert.equal(usStateSaleDecision(result, true), "treatment-on");
  assert.equal(usStateSaleDecision(result, false), "refuse");
  assert.equal(usStateSaleDecision(result, "yes"), "refuse");
  // At exactly 25% the relative test is not exceeded, and the unknown amount keeps it unknown.
  const equal = assessUsStateThreshold(evidence("CA", [entry("ca", "CA", 25), entry("ny", "NY", 75)]), NOW);
  assert.equal(equal.status, "unknown");
  assert.ok(equal.reasons.includes("sales-threshold"));
});

test("reservations and proposed supplies count, and a present non-sales factor requires treatment", () => {
  const proposed = evidence("CA", [entry("ca", "CA", 20), entry("p", "CA", 6, { position: "proposed" }), entry("r", "NY", 4, { position: "reserved" }), entry("ny", "NY", 70)]);
  const result = assessUsStateThreshold(proposed, NOW);
  assert.equal(result.status, "treatment-required");
  assert.equal(result.projectedStateMinor, 26);
  const factor = assessUsStateThreshold(evidence("CA", [entry("ca", "CA", 1), entry("ny", "NY", 99)], { nonSalesFactors: "present" }), NOW);
  assert.deepEqual(factor.reasons, ["non-sales-factor-present"]);
  assert.equal(factor.status, "treatment-required");
});

test("with every figure known, the safety margin switches treatment on before the limit is passed", () => {
  const rule = candidate({ relativeShareBps: 10_000 });
  const at = (cents: number) => assessUsStateThresholdUnderCandidateRule(rule, evidence("CA", [entry("ca", "CA", cents), entry("ny", "NY", 5_000_000)]), NOW);
  const margin = 1_000_000 * (10_000 - US_STATE_SAFETY_MARGIN_BPS) / 10_000;
  assert.equal(at(margin - 1).status, "below-threshold");
  assert.equal(usStateSaleDecision(at(margin - 1), false), "continue-untreated");
  assert.equal(at(margin).status, "approaching");
  assert.equal(usStateSaleDecision(at(margin), false), "refuse");
  assert.equal(usStateSaleDecision(at(margin), true), "treatment-on");
  assert.equal(at(1_000_000).status, "approaching");
  assert.equal(at(1_000_001).status, "treatment-required");
  // Relative share margin: 22.5% of the US total with a 25% test.
  const share = candidate({ salesThresholdMinor: Number.MAX_SAFE_INTEGER, relativeShareBps: 2_500 });
  const of = (ca: number) => assessUsStateThresholdUnderCandidateRule(share, evidence("CA", [entry("ca", "CA", ca), entry("ny", "NY", 1_000 - ca)]), NOW);
  assert.equal(of(224).status, "below-threshold");
  assert.equal(of(225).status, "approaching");
  assert.equal(of(250).status, "approaching");
  assert.equal(of(251).status, "treatment-required");
});

test("unreviewed scope or factors, wrong place, currency or period, and malformed evidence never pass", () => {
  const rule = candidate({ relativeShareBps: 10_000 });
  const base = evidence("CA", [entry("ca", "CA", 1), entry("ny", "NY", 1)]);
  assert.equal(assessUsStateThresholdUnderCandidateRule(rule, base, NOW).status, "below-threshold");
  const cases: unknown[] = [
    { ...base, applicableScopeReviewed: false },
    { ...base, nonSalesFactors: null },
    { ...base, nonSalesFactors: "maybe" },
    { ...base, state: "PR" },
    { ...base, state: "__proto__" },
    { ...base, stateLedger: ledger("NY", [entry("ny", "NY", 1)]) },
    { ...base, usLedger: ledger("CA", [entry("ca", "CA", 1)]) },
    { ...base, stateLedger: { ...ledger("CA", []), periodStart: "2025-11-14" } },
    { ...base, usLedger: { ...ledger(null, []), periodEnd: "2026-11-12", coverageThrough: "2026-11-12" } },
    { ...base, stateLedger: { ...ledger("CA", []), complete: false } },
    { ...base, stateLedger: ledger("CA", [entry("x", "CA", 1, { applicable: null })]) },
    { ...base, stateLedger: ledger("CA", [entry("x", null, 1)]) },
    { ...base, stateLedger: { ...ledger("CA", [entry("x", "CA", 1, { currency: "CAD" })]), currency: "CAD" } },
    { ...base, extra: true },
    null, [], "CA",
  ];
  for (const value of cases) {
    const result = assessUsStateThresholdUnderCandidateRule(rule, value, NOW);
    assert.equal(result.status, "unknown", JSON.stringify(value)?.slice(0, 120));
    assert.equal(usStateSaleDecision(result, true), "refuse");
  }
  const missing = { ...base } as Partial<UsStateThresholdEvidence>;
  delete missing.nonSalesFactors;
  assert.equal(assessUsStateThresholdUnderCandidateRule(rule, missing, NOW).status, "unknown");
  const getter = { ...base };
  Object.defineProperty(getter, "applicableScopeReviewed", { get: () => true, enumerable: true });
  assert.equal(assessUsStateThresholdUnderCandidateRule(rule, getter, NOW).status, "unknown");
  // A state total above the US total is contradictory, never a smaller share.
  const contradictory = { ...base, stateLedger: ledger("CA", [entry("ca", "CA", 5)]), usLedger: ledger(null, [entry("ca2", "CA", 1)]) };
  assert.equal(assessUsStateThresholdUnderCandidateRule(rule, contradictory, NOW).status, "invalid");
  for (const clock of [-1, NaN, Infinity, 253_402_300_800_000]) assert.equal(assessUsStateThreshold(base, clock).status, "invalid");
  // A candidate rule for another state, a non-integer figure or an over-100% share is refused.
  for (const bad of [candidate({ state: "NY" }), candidate({ salesThresholdMinor: 1.5 }), candidate({ relativeShareBps: 10_001 }), candidate({ salesThresholdMinor: -1 })]) {
    assert.equal(assessUsStateThresholdUnderCandidateRule(bad, base, NOW).status, "unknown");
  }
  // A source checked after today is not current evidence.
  assert.equal(assessUsStateThresholdUnderCandidateRule(candidate({ checkedOn: "2026-11-14", relativeShareBps: 10_000 }), base, NOW).status, "unknown");
});

test("nothing opens: the counters are not wired to sales and the plans stay off sale", () => {
  assert.equal(PLANS_ON_SALE, false);
});
