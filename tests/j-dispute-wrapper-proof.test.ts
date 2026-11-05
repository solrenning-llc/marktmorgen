import assert from "node:assert/strict";
import test from "node:test";
import { contractFixture } from "./contract-funding-fixture";
import { canonicalFinancialSnapshot, contractFundingConfiguration } from "@/lib/contract-funding-rules";
import { assessPlanPaymentDisputeCosts } from "@/lib/plan-payment-dispute-cost-rules";

test("plain hypothetical funding still works and a missing actual policy remains closed", () => {
  const f = contractFixture();
  assert.ok(contractFundingConfiguration(f.policy, f.context, f.now));
  assert.equal(contractFundingConfiguration(null, f.context, f.now), null);
});
for (const wrapper of ["context", "review"] as const) for (const hidden of ["outer", "row"] as const) {
  test(`${wrapper} wrapper cannot replace validated evidence with a hidden ${hidden} liability`, () => {
    const f = contractFixture();
    const original = f.review;
    const later = structuredClone(original);
    if (hidden === "outer") {
      later.planPaymentDisputes = new Proxy({ ...later.planPaymentDisputes, unreviewedPlan: null }, {
        ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "unreviewedPlan"),
      });
    } else {
      later.planPaymentDisputes!.creator_year = new Proxy({ ...later.planPaymentDisputes!.creator_year!, additionalFeesCents: null }, {
        ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "additionalFeesCents"),
      });
    }
    assert.equal(assessPlanPaymentDisputeCosts(later.planPaymentDisputes), null, "the actual later evidence is unknown at the direct boundary");
    assert.equal(canonicalFinancialSnapshot(later), f.policy.financialSnapshot, "projection discards the concealed liability without changing known totals");
    let reads = 0;
    const context = wrapper === "context" ? new Proxy(f.context, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "review" && descriptor ? { ...descriptor, value: ++reads === 1 ? original : later } : descriptor;
      },
    }) : {
      ...f.context,
      review: new Proxy(f.review, {
        getOwnPropertyDescriptor(target, key) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          return key === "planPaymentDisputes" && descriptor ? { ...descriptor, value: ++reads === 1 ? original.planPaymentDisputes : later.planPaymentDisputes } : descriptor;
        },
      }),
    };
    const result = contractFundingConfiguration(f.policy, context, f.now);
    assert.ok(reads > 1, "the real entry point observes different original references");
    assert.equal(result === null, true, "matching projected numeric totals cannot approve a substituted unknown liability");
  });
}
