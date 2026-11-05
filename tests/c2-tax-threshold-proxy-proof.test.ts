import assert from "node:assert/strict";
import { test } from "node:test";
import { assessTaxThreshold, type TaxThresholdSnapshot } from "@/lib/tax-threshold";

const now = Date.parse("2026-11-05T12:00:00.000Z");
const snapshot = (settledApplicableMinor = 1): TaxThresholdSnapshot => ({
  ruleId: "ca-specified-supplies", currency: "CAD", recordedOn: "2026-11-05",
  completeRollingCoverage: true, applicableScopeReviewed: true,
  settledApplicableMinor, reservedApplicableMinor: 0, proposedApplicableMinor: 0,
});

test("ordinary, frozen and null-prototype snapshots keep the exact threshold comparison", () => {
  for (const value of [snapshot(), Object.freeze(snapshot()), Object.assign(Object.create(null), snapshot())]) {
    assert.deepEqual(assessTaxThreshold(value, now), { status: "below-threshold", projectedApplicableMinor: 1 });
  }
  assert.deepEqual(assessTaxThreshold(snapshot(3_000_001), now), {
    status: "treatment-required", projectedApplicableMinor: 3_000_001,
  });
});

test("a Proxy cannot replace an above-threshold own amount with a zero descriptor", () => {
  const original = snapshot(3_000_001);
  let reads = 0;
  const proxy = new Proxy(original, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === "settledApplicableMinor" && descriptor ? { ...descriptor, value: 0 } : descriptor;
    },
    get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
  });
  assert.equal(assessTaxThreshold(original, now).status, "treatment-required");
  const result = assessTaxThreshold(proxy, now);
  assert.equal(reads, 0);
  assert.deepEqual(result, { status: "unknown", projectedApplicableMinor: null });
});

test("a Proxy cannot erase an unreviewed threshold evidence field", () => {
  const original = { ...snapshot(), unreviewedJurisdiction: null };
  const proxy = new Proxy(original, {
    ownKeys(target) { return Reflect.ownKeys(target).filter(key => key !== "unreviewedJurisdiction"); },
  });
  assert.equal(assessTaxThreshold(original, now).status, "unknown");
  assert.deepEqual(assessTaxThreshold(proxy, now), { status: "unknown", projectedApplicableMinor: null });
});
