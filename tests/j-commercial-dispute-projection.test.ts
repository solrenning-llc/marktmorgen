import assert from "node:assert/strict";
import test from "node:test";
import { BASE_PLAN_REVENUE_CEILINGS, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, commercialMarginReady, type CommercialMarginReview } from "@/lib/commercial-margin";
import { canonicalFinancialSnapshot } from "@/lib/contract-funding-rules";
import { fundedCustomerWithAi, planPaymentDisputeFixture, zeroExposureFixture, zeroFixedCompanyFixture } from "./margin-test-fixtures";

// The paired runner uses the repository's existing hypothetical-policy aliases.
// No productive flag, policy, review, price or other source is modified.
const review = (): CommercialMarginReview => ({
  companyBase: { ...zeroFixedCompanyFixture, reviewedPayingCustomers: 100 },
  planPaymentDisputes: planPaymentDisputeFixture(),
  priceAndRightsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,
  taxEvidence: "TEST ONLY: not actual tax evidence",
  costAndLimitEvidence: "TEST ONLY: not actual funding",
  allocatedFixedCostsVerified: true,
  fundedExposure: zeroExposureFixture(),
  prepaidUsageEnforced: true,
  scenarios: Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key => {
    const gross = BASE_PLAN_REVENUE_CEILINGS[key] ?? 10000;
    return [key, fundedCustomerWithAi(gross, Math.floor(gross * .65), 12, key)];
  })),
});

test("plain hypothetical evidence remains assessable, while actual absent review stays closed", () => {
  assert.equal(commercialMarginReady(review()), true);
  assert.equal(commercialMarginReady(), false);
});
test("an explicitly present extra liability cannot pass", () => {
  const value = review();
  Object.assign(value.planPaymentDisputes!, { unreviewedPlan: null });
  assert.equal(commercialMarginReady(value), false);
});
for (const boundary of ["outer", "row"] as const) test(`original ${boundary} Proxy liability cannot disappear before commercial assessment`, () => {
  const value = review();
  const originalSnapshot = canonicalFinancialSnapshot(value);
  assert.equal(commercialMarginReady(value), true, "positive control uses the same actual entry point");
  if (boundary === "outer") {
    value.planPaymentDisputes = new Proxy({ ...value.planPaymentDisputes, unreviewedPlan: null }, {
      ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "unreviewedPlan"),
    });
  } else {
    value.planPaymentDisputes!.creator_year = new Proxy({ ...value.planPaymentDisputes!.creator_year!, additionalFeesCents: null }, {
      ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "additionalFeesCents"),
    });
  }
  assert.equal(canonicalFinancialSnapshot(value), originalSnapshot, "projection hides the unknown liability");
  assert.equal(commercialMarginReady(value), false, "the original unknown liability must prevent approval");
});
