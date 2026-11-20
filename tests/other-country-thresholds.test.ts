/**
 * Art. 9a lock 3, jurisdiction "other" (owner's order of 19/11/2026, ~13h25, front 1, C5-20261119-1320-frentes):
 * Canada, Norway and Switzerland each by its own reviewed rule, and every other country refused, never guessed.
 * What fails here:
 *   - a country without a reviewed rule (Liechtenstein, Australia, the US, a territory, a code never assigned) is
 *     assessed as anything but "unknown";
 *   - one country's evidence is read for another (Norwegian sales for Canada, a Swiss figure for Norway);
 *   - Switzerland is assessed from a single-country ledger instead of the worldwide turnover its rule names, or its
 *     CHF 100,000 boundary is not reached at exactly 100,000;
 *   - an accessor on the evidence is executed, or a rule's table can be changed at run time;
 *   - anything here records a treatment or opens a sale.
 * Synthetic only: no provider, no storage, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { OTHER_COUNTRY_RULES, assessOtherCountry, otherCountryRule } from "@/lib/other-country-thresholds";
import { TAX_THRESHOLD_RULES, assessTaxSalesThreshold, assessTaxThreshold } from "@/lib/tax-threshold";
import { DEEMED_SUPPLIER_RECORDS, deemedSupplierReady } from "@/lib/deemed-supplier";
import { PLANS_ON_SALE } from "@/lib/opening";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = "2026-11-19";
const UNKNOWN = { status: "unknown", projectedApplicableMinor: null };

const ledgerEvidence = (ruleId: "ca-specified-supplies" | "no-remote-services", country: string, currency: string, amountMinor: number) => ({
  ruleId,
  completeRollingCoverage: true,
  applicableScopeReviewed: true,
  ledger: {
    place: { country, state: null }, currency,
    periodStart: "2025-11-20", periodEnd: DAY, coverageFrom: "2025-11-20", coverageThrough: DAY, complete: true,
    entries: [{ id: "one", country, state: null, currency, supplyOn: DAY, position: "settled", amountMinor, applicable: true }],
  },
});
const swiss = (worldwideMinor: number, proposedMinor = 0) => ({
  ruleId: "ch-worldwide-turnover", currency: "CHF", recordedOn: DAY,
  completeRollingCoverage: true, applicableScopeReviewed: true,
  settledApplicableMinor: worldwideMinor, reservedApplicableMinor: 0, proposedApplicableMinor: proposedMinor,
});

test("Canada and Norway are assessed from their own country's ledger, at their own boundaries", () => {
  assert.equal(assessOtherCountry("CA", ledgerEvidence("ca-specified-supplies", "CA", "CAD", 3_000_000), NOW).status, "below-threshold");
  assert.equal(assessOtherCountry("CA", ledgerEvidence("ca-specified-supplies", "CA", "CAD", 3_000_001), NOW).status, "treatment-required");
  assert.equal(assessOtherCountry("NO", ledgerEvidence("no-remote-services", "NO", "NOK", 4_999_999), NOW).status, "below-threshold");
  assert.equal(assessOtherCountry("NO", ledgerEvidence("no-remote-services", "NO", "NOK", 5_000_000), NOW).status, "treatment-required");
});

test("Switzerland is reached at CHF 100,000 of worldwide turnover, counting what is proposed", () => {
  assert.deepEqual(assessOtherCountry("CH", swiss(9_999_999), NOW), { status: "below-threshold", projectedApplicableMinor: 9_999_999 });
  assert.deepEqual(assessOtherCountry("CH", swiss(10_000_000), NOW), { status: "treatment-required", projectedApplicableMinor: 10_000_000 });
  assert.deepEqual(assessOtherCountry("CH", swiss(9_999_999, 1), NOW), { status: "treatment-required", projectedApplicableMinor: 10_000_000 });
  assert.equal(TAX_THRESHOLD_RULES["ch-worldwide-turnover"].scope, "worldwide");
});

test("Switzerland's worldwide rule is never assessed from one country's ledger", () => {
  const ledger = ledgerEvidence("no-remote-services", "CH", "CHF", 1);
  assert.deepEqual(assessTaxSalesThreshold({ ...ledger, ruleId: "ch-worldwide-turnover" }, NOW), UNKNOWN);
  assert.deepEqual(assessOtherCountry("CH", { ...ledger, ruleId: "ch-worldwide-turnover" }, NOW), UNKNOWN);
});

test("one country's evidence is never read for another", () => {
  assert.deepEqual(assessOtherCountry("CA", ledgerEvidence("no-remote-services", "NO", "NOK", 1), NOW), UNKNOWN);
  assert.deepEqual(assessOtherCountry("NO", ledgerEvidence("ca-specified-supplies", "CA", "CAD", 1), NOW), UNKNOWN);
  assert.deepEqual(assessOtherCountry("NO", swiss(1), NOW), UNKNOWN);
  assert.deepEqual(assessOtherCountry("CH", ledgerEvidence("ca-specified-supplies", "CA", "CAD", 1), NOW), UNKNOWN);
  // The rule id says Canada, the ledger says Norway: the ledger's own place check refuses it.
  assert.deepEqual(assessOtherCountry("CA", ledgerEvidence("ca-specified-supplies", "NO", "CAD", 1), NOW), UNKNOWN);
});

test("a country without a reviewed rule is unknown, which refuses, whatever its evidence", () => {
  for (const country of ["LI", "AU", "IN", "JP", "BR", "US", "GB", "DE", "XK", "PR", "GI", "ca", "C", "CAN", "", null, undefined, 1, "__proto__", "constructor", "toString"]) {
    assert.equal(otherCountryRule(country), null, String(country));
    assert.deepEqual(assessOtherCountry(country, swiss(0), NOW), UNKNOWN, String(country));
    assert.deepEqual(assessOtherCountry(country, ledgerEvidence("ca-specified-supplies", "CA", "CAD", 0), NOW), UNKNOWN, String(country));
  }
  assert.deepEqual(Object.keys(OTHER_COUNTRY_RULES).sort(), ["CA", "CH", "NO", "TW"]);
});

test("the evidence's rule is read from own data once, and an accessor is never executed", () => {
  let reads = 0;
  const value = swiss(0);
  const accessor = { ...value };
  Object.defineProperty(accessor, "ruleId", { enumerable: true, get() { reads += 1; return "ch-worldwide-turnover"; } });
  assert.deepEqual(assessOtherCountry("CH", accessor, NOW), UNKNOWN);
  assert.deepEqual(assessOtherCountry("CH", Object.create(value), NOW), UNKNOWN);
  assert.equal(reads, 0);
  for (const bad of [null, undefined, [], "CH", 1]) assert.deepEqual(assessOtherCountry("CH", bad, NOW), UNKNOWN);
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.deepEqual(assessOtherCountry("CH", proxy, NOW), UNKNOWN);
});

test("the Swiss snapshot goes through the same checks as every threshold snapshot", () => {
  for (const change of [
    { completeRollingCoverage: false }, { applicableScopeReviewed: false }, { currency: "USD" },
    { recordedOn: "2026-11-18" }, { settledApplicableMinor: null },
  ]) assert.equal(assessOtherCountry("CH", { ...swiss(0), ...change }, NOW).status, "unknown");
  assert.equal(assessOtherCountry("CH", { ...swiss(0), proposedApplicableMinor: -1 }, NOW).status, "invalid");
  assert.deepEqual(assessTaxThreshold(swiss(10_000_000), NOW), assessOtherCountry("CH", swiss(10_000_000), NOW));
});

test("the rules cannot be changed at run time, and each names its official source and the day it was read", () => {
  assert.ok(Object.isFrozen(OTHER_COUNTRY_RULES));
  for (const [country, rule] of Object.entries(OTHER_COUNTRY_RULES)) {
    assert.ok(Object.isFrozen(rule), country);
    const threshold = TAX_THRESHOLD_RULES[rule.ruleId];
    assert.ok(Object.isFrozen(threshold), country);
    assert.match(threshold.source, /^https:\/\/(www\.canada\.ca|www\.skatteetaten\.no|www\.estv\.admin\.ch|law-out\.mof\.gov\.tw)\//, country);
    assert.match(threshold.checkedOn, /^\d{4}-\d{2}-\d{2}$/, country);
  }
  // Reflect.set answers false on a frozen object in strict and sloppy code alike (Codex X5's LOW on #4890).
  assert.equal(Reflect.set(OTHER_COUNTRY_RULES, "LI", { ruleId: "ch-worldwide-turnover" }), false);
  assert.equal(Object.hasOwn(OTHER_COUNTRY_RULES, "LI"), false);
  assert.equal(otherCountryRule("LI"), null);
});

test("nothing here records a treatment or opens a sale", () => {
  assert.deepEqual(DEEMED_SUPPLIER_RECORDS, []);
  assert.equal(deemedSupplierReady(), false);
  assert.equal(PLANS_ON_SALE, false);
});
