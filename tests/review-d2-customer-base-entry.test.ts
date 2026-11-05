import test from "node:test";
import assert from "node:assert/strict";
import { assessMinimumCustomerBase, type CustomerBaseReview, type CustomerBaseUnit } from "@/lib/customer-base-rules";
import { txCustomerFixture } from "./customer-tax-review-fixture";

const fixed = (): CustomerBaseReview => ({
  monthlyFixedCostsCeilingCents: 10_000, monthlyFixedTaxesCeilingCents: 0,
  allFixedCostsBounded: true, allFixedTaxesReviewed: true,
  fixedCostsEvidence: "TEST ONLY", fixedTaxEvidence: "TEST ONLY", reviewedPayingCustomers: 2,
});
const unknown = { status: "unknown", minimumCustomers: null, reviewedBaseSufficient: false };
const calculated = { status: "calculated", minimumCustomers: 2, reviewedBaseSufficient: true };

test("ordinary unit controls preserve arithmetic, frozen data and unknown costs", () => {
  const unit: CustomerBaseUnit = { months: 1, scenario: txCustomerFixture() };
  assert.deepEqual(assessMinimumCustomerBase([unit], fixed()), calculated);
  assert.deepEqual(assessMinimumCustomerBase(Object.freeze([Object.freeze(unit)]) as unknown as CustomerBaseUnit[], Object.freeze(fixed())), calculated);
  assert.deepEqual(assessMinimumCustomerBase([{ months: 1, scenario: null }], fixed()), unknown);
  const revoked = Proxy.revocable(unit, {}); revoked.revoke();
  assert.deepEqual(assessMinimumCustomerBase([revoked.proxy], fixed()), unknown);
});

test("a native Proxy unit cannot authorize a calculated sufficient base", () => {
  let traps = 0;
  const unit: CustomerBaseUnit = { months: 1, scenario: txCustomerFixture() };
  const supplied = new Proxy(unit, {
    getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const result = assessMinimumCustomerBase([supplied], fixed());
  console.log("D2 proxied unit observation", { result, traps });
  assert.deepEqual({ result, traps }, { result: unknown, traps: 0 });
});

test("a unit descriptor trap cannot replace an unreviewed null cost scenario", () => {
  let traps = 0;
  const unit: CustomerBaseUnit = { months: 1, scenario: null };
  const substitute = txCustomerFixture();
  const supplied = new Proxy(unit, {
    getOwnPropertyDescriptor(target, key) {
      traps++;
      if (key === "scenario") return { value: substitute, enumerable: true, configurable: true, writable: true };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.equal(unit.scenario, null);
  const result = assessMinimumCustomerBase([supplied], fixed());
  console.log("D2 substituted unknown unit observation", { result, traps, originalScenario: unit.scenario });
  assert.deepEqual({ result, traps }, { result: unknown, traps: 0 });
});
