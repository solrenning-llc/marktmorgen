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

for (const boundary of ["context", "review"] as const) {
  test(`the captured dispute assessment matches the ${boundary} review bound after projection`, () => {
    const fixture = contractFixture();
    const baseline = contractFundingConfiguration(fixture.policy, fixture.context, fixture.now);
    assert.ok(baseline);

    const original = fixture.review;
    const later = structuredClone(fixture.review);
    later.planPaymentDisputes!.creator_year!.maximumPaidPrincipalCents! += 100;
    fixture.policy.financialSnapshot = canonicalFinancialSnapshot(later)!;
    assert.equal(
      contractFundingConfiguration(
        fixture.policy,
        { ...fixture.context, review: later },
        fixture.now,
      ),
      null,
      "the larger plain liability does not fit the previously reserved cash",
    );
    const fullyFunded = contractFundingConfiguration(
      { ...fixture.policy, reservedFundsCents: fixture.policy.reservedFundsCents + 200 },
      { ...fixture.context, review: later },
      fixture.now,
    );
    assert.ok(fullyFunded);
    assert.equal(fullyFunded.grantCents.creator_year, baseline.grantCents.creator_year + 100);

    let reads = 0;
    const context = boundary === "context"
      ? new Proxy(fixture.context, {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            return key === "review" && descriptor
              ? { ...descriptor, value: ++reads === 1 ? original : later }
              : descriptor;
          },
        })
      : {
          ...fixture.context,
          review: new Proxy(fixture.review, {
            getOwnPropertyDescriptor(target, key) {
              const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
              return key === "planPaymentDisputes" && descriptor
                ? {
                    ...descriptor,
                    value: ++reads === 1
                      ? original.planPaymentDisputes
                      : later.planPaymentDisputes,
                  }
                : descriptor;
            },
          }),
        };
    assert.equal(
      contractFundingConfiguration(fixture.policy, context, fixture.now),
      null,
      "a later bound liability cannot use an earlier smaller assessment",
    );
    assert.ok(reads > 1, "the regression exercises distinct boundary captures");
  });
}
