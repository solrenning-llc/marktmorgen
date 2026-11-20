/**
 * Codex X5's MEDIUM on #4890 (X5-20261119-1410): the country's rule and the evidence's rule must be checked on ONE
 * capture of the evidence. Before, assessOtherCountry read the evidence's `ruleId` once to match the country, then
 * handed the same object to the assessor, which captured its fields again and chose its rule from that second read.
 * Evidence whose descriptor changes between reads (a Proxy the validators accept) could pass Switzerland's check and
 * then be assessed under Canada's rule, or Canada's and then Norway's. What fails here:
 *   - such evidence is assessed as anything but "unknown";
 *   - the evidence's `ruleId` is read more than once for one assessment;
 *   - ordinary evidence stops being assessed at its own boundary.
 * Synthetic only: no provider, no storage, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessOtherCountry } from "@/lib/other-country-thresholds";
import { assessTaxSalesThreshold, assessTaxThreshold } from "@/lib/tax-threshold";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = "2026-11-19";
const UNKNOWN = { status: "unknown", projectedApplicableMinor: null };

const snapshot = (ruleId: string, currency: string, settled: number) => ({
  ruleId, currency, recordedOn: DAY, completeRollingCoverage: true, applicableScopeReviewed: true,
  settledApplicableMinor: settled, reservedApplicableMinor: 0, proposedApplicableMinor: 0,
});
const ledger = (ruleId: string, country: string, currency: string, amountMinor: number) => ({
  ruleId,
  completeRollingCoverage: true,
  applicableScopeReviewed: true,
  ledger: {
    place: { country, state: null }, currency,
    periodStart: "2025-11-20", periodEnd: DAY, coverageFrom: "2025-11-20", coverageThrough: DAY, complete: true,
    entries: [{ id: "one", country, state: null, currency, supplyOn: DAY, position: "settled", amountMinor, applicable: true }],
  },
});

/**
 * The evidence as a Proxy over its plain data: each read of `ruleId`'s descriptor answers the next id in `ids` (the
 * last one repeats), and `reads()` says how many times it was read. Every other field is the plain data's own.
 */
function shifting(data: Record<string, unknown>, ids: string[]): { evidence: object; reads: () => number } {
  let count = 0;
  const evidence = new Proxy({ ...data }, {
    getOwnPropertyDescriptor(target, key) {
      if (key !== "ruleId") return Reflect.getOwnPropertyDescriptor(target, key);
      const value = ids[Math.min(count, ids.length - 1)];
      count += 1;
      return { value, writable: true, enumerable: true, configurable: true };
    },
  });
  return { evidence, reads: () => count };
}

test("a Swiss rule on the first read and a Canadian snapshot on the second is unknown", () => {
  const { evidence } = shifting(snapshot("ca-specified-supplies", "CAD", 1), ["ch-worldwide-turnover", "ca-specified-supplies"]);
  assert.deepEqual(assessOtherCountry("CH", evidence, NOW), UNKNOWN);
});

test("a Canadian rule on the first read and a Norwegian ledger on the second is unknown", () => {
  const { evidence } = shifting(ledger("no-remote-services", "NO", "NOK", 1), ["ca-specified-supplies", "no-remote-services"]);
  assert.deepEqual(assessOtherCountry("CA", evidence, NOW), UNKNOWN);
});

test("the evidence's rule is read exactly once for one assessment", () => {
  const swiss = shifting(snapshot("ch-worldwide-turnover", "CHF", 1), ["ch-worldwide-turnover"]);
  assert.equal(assessOtherCountry("CH", swiss.evidence, NOW).status, "below-threshold");
  assert.equal(swiss.reads(), 1);
  const canada = shifting(ledger("ca-specified-supplies", "CA", "CAD", 1), ["ca-specified-supplies"]);
  assert.equal(assessOtherCountry("CA", canada.evidence, NOW).status, "below-threshold");
  assert.equal(canada.reads(), 1);
});

test("the expected rule binds each assessor to its own single capture, and ordinary evidence keeps its boundary", () => {
  assert.deepEqual(assessTaxThreshold(snapshot("ca-specified-supplies", "CAD", 1), NOW, "ch-worldwide-turnover"), UNKNOWN);
  assert.deepEqual(assessTaxSalesThreshold(ledger("no-remote-services", "NO", "NOK", 1), NOW, "ca-specified-supplies"), UNKNOWN);
  assert.deepEqual(assessOtherCountry("CH", snapshot("ch-worldwide-turnover", "CHF", 9_999_999), NOW), { status: "below-threshold", projectedApplicableMinor: 9_999_999 });
  assert.deepEqual(assessOtherCountry("CH", snapshot("ch-worldwide-turnover", "CHF", 10_000_000), NOW), { status: "treatment-required", projectedApplicableMinor: 10_000_000 });
  assert.equal(assessOtherCountry("CA", ledger("ca-specified-supplies", "CA", "CAD", 3_000_001), NOW).status, "treatment-required");
  // Two-argument callers are unchanged.
  assert.equal(assessTaxThreshold(snapshot("ch-worldwide-turnover", "CHF", 1), NOW).status, "below-threshold");
});
