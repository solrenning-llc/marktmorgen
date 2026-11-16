import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("minimum-base assessment rejects a proxied unit before any trap executes", () => {
  let traps = 0;
  const supplied = new Proxy(units()[0], {
    getOwnPropertyDescriptor(target, key) {
      traps++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.deepEqual(assessMinimumCustomerBase([supplied], fixed()), unknown);
  assert.equal(traps, 0);
});

test("a unit proxy cannot replace an unknown scenario with reviewed evidence", () => {
  let traps = 0;
  const unit = { months: 1 as const, scenario: null };
  const substitute = txCustomerFixture();
  const supplied = new Proxy(unit, {
    getOwnPropertyDescriptor(target, key) {
      traps++;
      if (key === "scenario") {
        return { value: substitute, enumerable: true, configurable: true, writable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.equal(unit.scenario, null);
  assert.deepEqual(assessMinimumCustomerBase([supplied], fixed()), unknown);
  assert.equal(traps, 0);
});

test("customer-base rules stay importable from browser client graphs", () => {
  const source = readFileSync("lib/customer-base-rules.ts", "utf8");
  assert.doesNotMatch(source, /from\s+["']node:/);
});
