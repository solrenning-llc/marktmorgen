import assert from "node:assert/strict";
import test from "node:test";
import {
  assessPlanPaymentDisputeCosts,
  PLAN_PAYMENT_DISPUTE_KEYS,
} from "../lib/plan-payment-dispute-cost-rules";
import { planPaymentDisputeFixture } from "./margin-test-fixtures";

test("a Proxy cannot conceal an unreviewed plan or liability field", () => {
  const review = planPaymentDisputeFixture();
  const outerTarget = { ...review, unreviewedPlan: null };
  const outer = new Proxy(outerTarget, {
    ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "unreviewedPlan"),
    getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
  });
  assert.equal(assessPlanPaymentDisputeCosts(outer), null);

  const rowReview = planPaymentDisputeFixture();
  const rowTarget = { ...rowReview.creator_month!, additionalFeesCents: null };
  rowReview.creator_month = new Proxy(rowTarget, {
    ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "additionalFeesCents"),
    getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
  });
  assert.equal(assessPlanPaymentDisputeCosts(rowReview), null);
});

test("Proxy-forged values and transparent or revoked evidence are unknown", () => {
  const forged = planPaymentDisputeFixture();
  forged.creator_month = new Proxy(forged.creator_month!, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === "maximumTotalFeesCents" && descriptor
        ? { ...descriptor, value: 0 }
        : descriptor;
    },
  });
  assert.equal(assessPlanPaymentDisputeCosts(forged), null);

  assert.equal(assessPlanPaymentDisputeCosts(new Proxy(planPaymentDisputeFixture(), {})), null);
  const revokedReview = Proxy.revocable(planPaymentDisputeFixture(), {});
  revokedReview.revoke();
  assert.equal(assessPlanPaymentDisputeCosts(revokedReview.proxy), null);

  const revokedRow = planPaymentDisputeFixture();
  const revoked = Proxy.revocable(revokedRow.creator_year!, {});
  revokedRow.creator_year = revoked.proxy;
  revoked.revoke();
  assert.equal(assessPlanPaymentDisputeCosts(revokedRow), null);
});

test("native validation never executes getters introduced by another evidence trap", () => {
  const review = planPaymentDisputeFixture();
  let reads = 0;
  review.creator_month = new Proxy(review.creator_month!, {
    ownKeys(target) {
      Object.defineProperty(review.creator_year!, "evidence", {
        configurable: true,
        enumerable: true,
        get() {
          reads++;
          throw new Error("must not execute");
        },
      });
      return Reflect.ownKeys(target);
    },
  });
  assert.equal(assessPlanPaymentDisputeCosts(review), null);
  assert.equal(reads, 0);
});

test("plain, frozen and null-prototype reviews retain every exact cost", () => {
  const plain = planPaymentDisputeFixture();
  const expected = assessPlanPaymentDisputeCosts(plain);
  assert.ok(expected);

  const frozen = Object.freeze(Object.fromEntries(
    PLAN_PAYMENT_DISPUTE_KEYS.map(key => [key, Object.freeze({ ...plain[key]! })]),
  ));
  const noPrototype = Object.assign(
    Object.create(null),
    Object.fromEntries(PLAN_PAYMENT_DISPUTE_KEYS.map(key => [
      key,
      Object.assign(Object.create(null), plain[key]),
    ])),
  );
  for (const review of [plain, frozen, noPrototype]) {
    assert.deepEqual(assessPlanPaymentDisputeCosts(review), expected);
  }
});
