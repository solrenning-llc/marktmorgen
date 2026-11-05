import assert from "node:assert/strict";
import test from "node:test";
import { contractFixture } from "./contract-funding-fixture";
import {
  canonicalFinancialSnapshot,
  contractFundingConfiguration,
} from "@/lib/contract-funding-rules";
import { assessPlanPaymentDisputeCosts } from "@/lib/plan-payment-dispute-cost-rules";

for (const boundary of ["outer", "row"] as const) {
  test(`the funding boundary rejects an original ${boundary} dispute Proxy before projection`, () => {
    const fixture = contractFixture();
    assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));

    if (boundary === "outer") {
      fixture.review.planPaymentDisputes = new Proxy(
        { ...fixture.review.planPaymentDisputes, unreviewedPlan: null },
        {
          ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== "unreviewedPlan"),
        },
      );
    } else {
      fixture.review.planPaymentDisputes!.creator_year = new Proxy(
        {
          ...fixture.review.planPaymentDisputes!.creator_year!,
          additionalFeesCents: null,
        },
        {
          ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== "additionalFeesCents"),
        },
      );
    }

    assert.equal(assessPlanPaymentDisputeCosts(fixture.review.planPaymentDisputes), null);
    assert.equal(
      canonicalFinancialSnapshot(fixture.review),
      fixture.policy.financialSnapshot,
      "the former financial binding still matches the projected evidence",
    );
    assert.equal(
      contractFundingConfiguration(fixture.policy, fixture.context, fixture.now),
      null,
      "the funding boundary must not approve evidence rejected at the direct boundary",
    );
  });
}
