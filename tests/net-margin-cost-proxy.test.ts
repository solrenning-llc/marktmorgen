import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCustomerWorstCase, customerCostSnapshot, CUSTOMER_COST_CATEGORIES, type CustomerWorstCase } from "../lib/net-margin-rules";
import { fundedCustomerScenario } from "./margin-test-fixtures";

function refused(input: CustomerWorstCase): void {
  const result = assessCustomerWorstCase(input);
  assert.equal(result.approved, false);
  assert.equal(result.reason, "unknown");
  assert.equal(result.netCents, null);
  assert.equal(result.marginBps, null);
}

test("a hidden additional cost never becomes zero in the real individual assessment", () => {
  for (const value of [null, 0, 100_000]) {
    const exposed = fundedCustomerScenario(); Object.assign(exposed.costCeilings, { unpricedSupplier: value });
    refused(exposed);
    const input = fundedCustomerScenario();
    const costs = Object.assign(input.costCeilings, { unpricedSupplier: value });
    input.costCeilings = new Proxy(costs, { ownKeys(target) { return Reflect.ownKeys(target).filter(key => key !== "unpricedSupplier"); } });
    refused(input);
  }
});

test("transparent, revoked and self-detaching cost proxies cannot certify complete costs", () => {
  const transparent = fundedCustomerScenario(); transparent.costCeilings = new Proxy(transparent.costCeilings, {});
  refused(transparent);
  const revoked = fundedCustomerScenario();
  const pair = Proxy.revocable(revoked.costCeilings, {}); pair.revoke(); revoked.costCeilings = pair.proxy;
  refused(revoked);
  const detached = fundedCustomerScenario();
  const original = Object.assign(detached.costCeilings, { unpricedSupplier: null });
  detached.costCeilings = new Proxy(original, {
    ownKeys(target) {
      detached.costCeilings = Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key => [key, original[key]]));
      return Reflect.ownKeys(target).filter(key => key !== "unpricedSupplier");
    },
  });
  refused(detached);
});

test("proxy descriptors cannot disguise a getter and the native refusal never calls it", () => {
  const input = fundedCustomerScenario();
  let reads = 0;
  Object.defineProperty(input.costCeilings, "other", { enumerable: true, configurable: true, get() { reads++; return 0; } });
  input.costCeilings = new Proxy(input.costCeilings, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "other") return { value: 0, writable: true, enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  refused(input);
  assert.equal(reads, 0);
});

test("valid own scalar maps retain exact results, including frozen and null-prototype data", () => {
  for (const kind of ["plain", "frozen", "null-prototype"]) {
    const input = fundedCustomerScenario();
    if (kind === "frozen") Object.freeze(input.costCeilings);
    if (kind === "null-prototype") input.costCeilings = Object.assign(Object.create(null), input.costCeilings);
    assert.deepEqual(assessCustomerWorstCase(input), { approved: true, reason: "approved", netCents: 6000, marginBps: 6000 });
    assert.notEqual(customerCostSnapshot(input.costCeilings), null);
  }
  for (const value of [null, undefined, "0", NaN, Infinity, -1, 0.5]) {
    const input = fundedCustomerScenario(); Object.assign(input.costCeilings, { other: value });
    assert.equal(assessCustomerWorstCase(input).approved, false);
  }
  let reads = 0;
  const input = fundedCustomerScenario(); Object.assign(input.costCeilings, { other: { get value() { reads++; return 0; } } });
  assert.equal(assessCustomerWorstCase(input).approved, false);
  assert.equal(reads, 0);
});
