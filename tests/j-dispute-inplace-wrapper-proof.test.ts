import assert from "node:assert/strict";
import test from "node:test";
import { contractFixture } from "./contract-funding-fixture";
import { canonicalFinancialSnapshot, contractFundingConfiguration } from "@/lib/contract-funding-rules";
import { assessPlanPaymentDisputeCosts } from "@/lib/plan-payment-dispute-cost-rules";

test("plain hypothetical configuration remains funded and absent actual policy remains closed", () => {
  const f = contractFixture();
  assert.ok(contractFundingConfiguration(f.policy, f.context, f.now));
  assert.equal(contractFundingConfiguration(null, f.context, f.now), null);
});
for (const boundary of ["context", "review"] as const) {
  test(`${boundary} wrapper cannot mutate the same validated dispute reference in place`, () => {
    const f = contractFixture();
    const disputes = f.review.planPaymentDisputes!;
    let mutationCount = 0, reviewReads = 0;
    const mutate = () => {
      if (mutationCount++) return;
      disputes.creator_year = new Proxy({ ...disputes.creator_year!, additionalFeesCents: null }, {
        ownKeys(target) { return Reflect.ownKeys(target).filter(key => key !== "additionalFeesCents"); },
      });
    };
    const context = boundary === "review" ? {
      ...f.context,
      review: new Proxy(f.review, {
        ownKeys(target) { mutate(); return Reflect.ownKeys(target); },
      }),
    } : new Proxy(f.context, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "review" && ++reviewReads === 2) mutate();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = contractFundingConfiguration(f.policy, context, f.now);
    assert.ok(mutationCount > 0, "the real caller reaches the post-assessment mutation");
    assert.equal(f.review.planPaymentDisputes, disputes, "the root reference never changes");
    assert.equal(assessPlanPaymentDisputeCosts(disputes), null, "the actual same-reference evidence is now unknown");
    assert.equal(canonicalFinancialSnapshot(f.review), f.policy.financialSnapshot, "projection still conceals the new unknown liability");
    assert.equal(result === null, true, "same reference and matching projected numbers cannot approve a later unknown liability");
  });
}
