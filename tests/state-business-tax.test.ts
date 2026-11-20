/** TX point 9: state income, franchise and gross-receipts nexus before each threshold. Synthetic data only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assessStateBusinessTax, STATE_BUSINESS_TAX_RULES, STATE_BUSINESS_TAX_SAFETY_BPS, type StateBusinessTaxSnapshot,
} from "@/lib/state-business-tax";
import { PLANS_ON_SALE } from "@/lib/opening";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const facts = (): StateBusinessTaxSnapshot["facts"] => ({ physicalPresence: false, organizedOrDomiciledInState: false, useTaxPermit: false });
const row = (state: string, settled: number, priorYear: number | null = 0): StateBusinessTaxSnapshot => ({
  state, year: 2026, recordedOn: "2026-11-19", currency: "USD",
  completeCoverage: true, periodReviewed: true, includesMarketplaceSellers: true,
  settledMinor: settled, reservedMinor: 0, proposedMinor: 0, priorYearMinor: priorYear, facts: facts(),
});
const status = (value: unknown, now = NOW) => assessStateBusinessTax(value, now).status;

test("Texas: the economic nexus at USD 500,000 or more is treated before 90% of it", () => {
  assert.equal(STATE_BUSINESS_TAX_SAFETY_BPS, 9_000);
  assert.equal(status(row("TX", 44_999_999)), "below-threshold");
  assert.equal(status(row("TX", 45_000_000)), "treatment-required");
  assert.equal(status(row("TX", 49_999_999)), "treatment-required");
  assert.equal(status(row("TX", 50_000_000)), "treatment-required");
  assert.deepEqual(assessStateBusinessTax(row("TX", 1_000), NOW), { status: "below-threshold", projectedMinor: 1_000 });
});

test("Texas: a closed prior period that reached the threshold carries nexus until 34 TAC §3.586 is read", () => {
  // Codex V could not read when the nexus ends, so a reached prior period refuses to read as no nexus.
  assert.equal(status(row("TX", 0, 50_000_000)), "treatment-required");
  assert.equal(status(row("TX", 0, 49_999_999)), "below-threshold");
  assert.equal(status(row("TX", 0, null)), "unknown");
  assert.equal(status({ ...row("TX", 0), priorYearMinor: -1 }), "invalid");
});

test("an old reading refuses: each rule answers only until its review date", () => {
  for (const state of ["TX", "WA"] as const) {
    const rule = STATE_BUSINESS_TAX_RULES[state];
    assert.equal(rule.reviewBy, "2027-11-19", state);
    const at = (day: string) => ({ ...row(state, 0), year: Number(day.slice(0, 4)), recordedOn: day });
    assert.equal(status(at("2027-11-18"), Date.parse("2027-11-18T12:00:00Z")), "below-threshold", state);
    assert.equal(status(at("2027-11-19"), Date.parse("2027-11-19T12:00:00Z")), "unknown", state);
  }
});

test("Washington: above USD 100,000 in the current or the prior calendar year, equality does not trigger", () => {
  assert.equal(status(row("WA", 8_999_999)), "below-threshold");
  assert.equal(status(row("WA", 9_000_000)), "treatment-required");
  // The prior year is closed: it is compared at the threshold itself, where equality is not "more than".
  assert.equal(status(row("WA", 0, 10_000_000)), "below-threshold");
  assert.equal(status(row("WA", 0, 10_000_001)), "treatment-required");
  assert.equal(status(row("WA", 0, null)), "unknown");
  // A Washington count without the marketplace sellers' sales undercounts the facilitator's nexus.
  assert.equal(status({ ...row("WA", 0), includesMarketplaceSellers: false }), "unknown");
});

test("reservations and the proposed sale count before the threshold is crossed", () => {
  const value = row("TX", 44_999_998);
  value.reservedMinor = 1;
  assert.equal(status(value), "below-threshold");
  value.proposedMinor = 1;
  assert.deepEqual(assessStateBusinessTax(value, NOW), { status: "treatment-required", projectedMinor: 45_000_000 });
});

test("a non-sales test is never assumed false: unknown refuses, true needs treatment at any amount", () => {
  for (const [state, fact] of [["TX", "physicalPresence"], ["TX", "useTaxPermit"], ["WA", "physicalPresence"], ["WA", "organizedOrDomiciledInState"]] as const) {
    const unknown = row(state, 0);
    unknown.facts = { ...facts(), [fact]: null };
    assert.equal(status(unknown), "unknown", `${state} ${fact} null`);
    const present = row(state, 0);
    present.facts = { ...facts(), [fact]: true };
    assert.equal(status(present), "treatment-required", `${state} ${fact} true`);
  }
  // A fact the state's rule does not list must still read as a boolean or null.
  const odd = row("TX", 0);
  (odd.facts as Record<string, unknown>).organizedOrDomiciledInState = "no";
  assert.equal(status(odd), "unknown");
});

test("California, Florida, Illinois, New York, Delaware and every unreviewed state answer unknown", () => {
  for (const state of ["CA", "FL", "IL", "NY", "DE", "OR", "ZZ", "__proto__", "toString", "tx"]) {
    assert.equal(status(row(state, 0)), "unknown", state);
  }
  // California's 2026 index was not found: the 2025 figure is never carried forward.
  assert.equal(STATE_BUSINESS_TAX_RULES.CA.kind, "not-assessable");
  assert.match(STATE_BUSINESS_TAX_RULES.CA.reason, /2026/);
  for (const state of ["FL", "IL", "NY"] as const) assert.equal(STATE_BUSINESS_TAX_RULES[state].kind, "not-assessable");
});

test("coverage, period review, currency, year and the same-day reading fail closed", () => {
  const value = row("TX", 0);
  for (const change of [
    { completeCoverage: false }, { periodReviewed: false }, { currency: "usd" }, { currency: "CAD" },
    { year: 2025 }, { year: 2027 }, { recordedOn: "2026-11-18" }, { recordedOn: "2026-11-20" },
    { settledMinor: null }, { reservedMinor: null }, { proposedMinor: null },
  ]) assert.equal(status({ ...value, ...change }), "unknown", JSON.stringify(change));
  // A reading before the rules were read from their sources is not current evidence.
  assert.equal(status({ ...value, year: 2026, recordedOn: "2026-11-18" }, Date.parse("2026-11-18T12:00:00Z")), "unknown");
  assert.equal(status(value, Number.NaN), "invalid");
});

test("amounts are exact safe integers in minor units", () => {
  for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity]) {
    assert.equal(status({ ...row("TX", 0), settledMinor: bad }), "invalid", String(bad));
  }
  assert.equal(status({ ...row("TX", 0), settledMinor: "1" }), "invalid");
  const huge = row("TX", Number.MAX_SAFE_INTEGER);
  huge.reservedMinor = 1;
  assert.equal(status(huge), "invalid");
  assert.equal(status({ ...row("WA", 0), priorYearMinor: -1 }), "invalid");
});

test("only the exact reviewed fields are read: extra, missing, symbol, accessor and inherited fields refuse", () => {
  assert.equal(status(null), "unknown");
  assert.equal(status([]), "unknown");
  assert.equal(status({ ...row("TX", 0), extra: 1 }), "unknown");
  const missing = { ...row("TX", 0) } as Partial<StateBusinessTaxSnapshot>;
  delete missing.priorYearMinor;
  assert.equal(status(missing), "unknown");
  assert.equal(status({ ...row("TX", 0), [Symbol("x")]: 1 }), "unknown");
  const getter = row("TX", 0) as Record<string, unknown>;
  Object.defineProperty(getter, "settledMinor", { get: () => 0, enumerable: true });
  assert.equal(status(getter), "unknown");
  assert.equal(status(Object.assign(Object.create({ inherited: true }), row("TX", 0))), "unknown");
  assert.equal(status({ ...row("TX", 0), facts: { ...facts(), extra: false } }), "unknown");
  const thrower = new Proxy({}, { ownKeys() { throw new Error("hostile"); } });
  assert.equal(status(thrower), "unknown");
});

test("the rules carry their dated official sources and are frozen", () => {
  assert.ok(Object.isFrozen(STATE_BUSINESS_TAX_RULES));
  const tx = STATE_BUSINESS_TAX_RULES.TX;
  const wa = STATE_BUSINESS_TAX_RULES.WA;
  assert.deepEqual([tx.kind, tx.thresholdMinor, tx.comparison, tx.window], ["receipts-nexus", 50_000_000, "gte", "accounting-period"]);
  assert.deepEqual([wa.kind, wa.thresholdMinor, wa.comparison, wa.window], ["receipts-nexus", 10_000_000, "gt", "current-or-prior-calendar-year"]);
  assert.deepEqual([...tx.facts].sort(), ["physicalPresence", "useTaxPermit"]);
  assert.deepEqual([...wa.facts].sort(), ["organizedOrDomiciledInState", "physicalPresence"]);
  for (const [state, rule] of Object.entries(STATE_BUSINESS_TAX_RULES)) {
    assert.ok(Object.isFrozen(rule), state);
    assert.equal(rule.readOn, "2026-11-19", state);
    assert.ok(rule.sources.length > 0, state);
    for (const source of rule.sources) assert.match(source, /^https:\/\/([a-z0-9-]+\.)*(texas\.gov|wa\.gov|ca\.gov|flsenate\.gov|floridarevenue\.com|illinois\.gov|ny\.gov|nysenate\.gov)\//, `${state} ${source}`);
  }
});

test("the assessor is pure, wires nothing, and nothing opens", () => {
  const source = readFileSync("lib/state-business-tax.ts", "utf8");
  assert.doesNotMatch(source, /from "@\/lib\/(redis|stripe|opening|customer-tax-review|checkout)/);
  assert.doesNotMatch(source, /\bfetch\(|process\.env/);
  assert.equal(PLANS_ON_SALE, false);
});
