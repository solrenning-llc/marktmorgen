import assert from "node:assert/strict";
import test from "node:test";
import { assessMinimumCustomerBase, type CustomerBaseReview } from "@/lib/customer-base-rules";
import { commercialMarginReady, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, BASE_PLAN_REVENUE_CEILINGS, type CommercialMarginReview } from "@/lib/commercial-margin";
import { canonicalFinancialSnapshot, contractFundingConfiguration } from "@/lib/contract-funding-rules";
import { contractFixture } from "./contract-funding-fixture";
import { txCustomerFixture } from "./customer-tax-review-fixture";
import { fundedCustomerWithAi, planPaymentDisputeFixture, zeroExposureFixture } from "./margin-test-fixtures";

const fixed = (): CustomerBaseReview => ({
  monthlyFixedCostsCeilingCents: 10_000, monthlyFixedTaxesCeilingCents: 0,
  allFixedCostsBounded: true, allFixedTaxesReviewed: true,
  fixedCostsEvidence: "TEST ONLY", fixedTaxEvidence: "TEST ONLY", reviewedPayingCustomers: 2,
});
const units = () => [{ months: 1 as const, scenario: txCustomerFixture() }];
const unknown = { status: "unknown", minimumCustomers: null, reviewedBaseSufficient: false };
const calculated = { status: "calculated", minimumCustomers: 2, reviewedBaseSufficient: true };

test("minimum-base assessment never drops an extra known or unknown fixed cost", () => {
  let reads = 0;
  for (const key of ["unreviewedSupplier", Symbol("unreviewed supplier")]) {
    for (const enumerable of [true, false]) {
      for (const value of [null, 100_000]) {
        const review = fixed();
        Object.defineProperty(review, key, { enumerable, value });
        assert.deepEqual(assessMinimumCustomerBase(units(), review), unknown);
      }
      const review = fixed();
      Object.defineProperty(review, key, { enumerable, get() { reads++; return 100_000; } });
      assert.deepEqual(assessMinimumCustomerBase(units(), review), unknown);
    }
  }
  assert.equal(reads, 0);
});
test("fixed-cost evidence remains complete when serialized", () => {
  for (const key of Object.keys(fixed())) {
    const review = fixed();
    Object.defineProperty(review, key, { enumerable: false });
    assert.deepEqual(assessMinimumCustomerBase(units(), review), unknown, key);
  }
});
test("minimum-base assessment refuses derived and uninspectable fixed evidence", () => {
  let reads = 0;
  const prototype = Object.create(null);
  Object.defineProperty(prototype, "unreviewedSupplier", { get() { reads++; return null; } });
  const derived = Object.assign(Object.create(prototype), fixed());
  const hiddenPrototype = new Proxy(fixed(), { getPrototypeOf() { throw new Error("unknown prototype"); } });
  const hiddenKeys = new Proxy(fixed(), { ownKeys() { throw new Error("unknown fields"); } });
  for (const review of [derived, hiddenPrototype, hiddenKeys]) {
    assert.deepEqual(assessMinimumCustomerBase(units(), review), unknown);
  }
  assert.equal(reads, 0);
});
test("complete plain, frozen and null-prototype fixed reviews preserve the minimum", () => {
  for (const review of [fixed(), Object.freeze(fixed()), Object.assign(Object.create(null), fixed())]) {
    assert.deepEqual(assessMinimumCustomerBase(units(), review), calculated);
  }
  assert.equal(assessMinimumCustomerBase(units(), { ...fixed(), reviewedPayingCustomers: 1 }).reviewedBaseSufficient, false);
  assert.equal(assessMinimumCustomerBase(units(), { ...fixed(), monthlyFixedCostsCeilingCents: null }).minimumCustomers, null);
});
test("fixed review fields are captured once without getters or ordinary property reads", () => {
  const counts = new Map<PropertyKey, number>();
  let reads = 0;
  const review = new Proxy(fixed(), {
    get() { reads++; throw new Error("ordinary read"); },
    getOwnPropertyDescriptor(target, key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.deepEqual(assessMinimumCustomerBase(units(), review), calculated);
  assert.equal(reads, 0);
  for (const key of Object.keys(fixed())) assert.equal(counts.get(key), 1, key);
  for (const key of Object.keys(fixed())) {
    const accessor = fixed();
    Object.defineProperty(accessor, key, { enumerable: true, get() { reads++; return 0; } });
    assert.deepEqual(assessMinimumCustomerBase(units(), accessor), unknown);
  }
  assert.equal(reads, 0);
});

function commercial(): CommercialMarginReview {
  return {
    companyBase: { ...fixed(), monthlyFixedCostsCeilingCents: 0, reviewedPayingCustomers: 1 },
    planPaymentDisputes: planPaymentDisputeFixture(), fundedExposure: zeroExposureFixture(),
    priceAndRightsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,
    taxEvidence: "TEST ONLY", costAndLimitEvidence: "TEST ONLY",
    allocatedFixedCostsVerified: true, prepaidUsageEnforced: true,
    scenarios: Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key => {
      const gross = BASE_PLAN_REVENUE_CEILINGS[key] ?? 10_000;
      return [key, fundedCustomerWithAi(gross, Math.floor(gross * .7), 12, key)];
    })),
  };
}
test("the real commercial assessor refuses extra fixed costs before adding exposure", () => {
  const review = commercial();
  assert.equal(commercialMarginReady(review), true);
  Object.assign(review.companyBase!, { unreviewedSupplier: null });
  assert.equal(commercialMarginReady(review), false);
});
test("the real funding configuration refuses a bound review with an extra fixed cost", () => {
  const { policy, context, review, now } = contractFixture();
  assert.ok(contractFundingConfiguration(policy, context, now));
  Object.assign(review.companyBase!, { unreviewedSupplier: 100_000 });
  policy.financialSnapshot = canonicalFinancialSnapshot(review)!;
  assert.equal(contractFundingConfiguration(policy, context, now), null);
});
