import test from "node:test";
import assert from "node:assert/strict";
import { assessMinimumCustomerBase, type CustomerBaseReview } from "@/lib/customer-base-rules";
import { txCustomerFixture } from "./customer-tax-review-fixture";

const fixed = (): CustomerBaseReview => ({
  monthlyFixedCostsCeilingCents: 10_000,
  monthlyFixedTaxesCeilingCents: 0,
  allFixedCostsBounded: true,
  allFixedTaxesReviewed: true,
  fixedCostsEvidence: "TEST ONLY",
  fixedTaxEvidence: "TEST ONLY",
  reviewedPayingCustomers: 2,
});
const units = () => [{ months: 1 as const, scenario: txCustomerFixture() }];
const unknown = { status: "unknown", minimumCustomers: null, reviewedBaseSufficient: false };

test("minimum-base assessment rejects a proxied unit envelope before any trap executes", () => {
  let traps = 0;
  const supplied = new Proxy(units(), {
    getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { traps++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  assert.deepEqual(assessMinimumCustomerBase(supplied, fixed()), unknown);
  assert.equal(traps, 0);
});

test("minimum-base assessment rejects a proxied fixed review before any trap executes", () => {
  let traps = 0;
  const supplied = new Proxy(fixed(), {
    getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { traps++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  assert.deepEqual(assessMinimumCustomerBase(units(), supplied), unknown);
  assert.equal(traps, 0);
});
