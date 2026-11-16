import assert from "node:assert/strict";
import test from "node:test";
import { BASE_PLAN_REVENUE_CEILINGS, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, commercialMarginReady, type CommercialMarginReview } from "@/lib/commercial-margin";
import { fundedCustomerWithAi, planPaymentDisputeFixture, zeroExposureFixture, zeroFixedCompanyFixture } from "./margin-test-fixtures";

const review = (): CommercialMarginReview => ({
  companyBase: { ...zeroFixedCompanyFixture, reviewedPayingCustomers: 100 },
  planPaymentDisputes: planPaymentDisputeFixture(),
  priceAndRightsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,
  taxEvidence: "TEST ONLY: not actual tax evidence",
  costAndLimitEvidence: "TEST ONLY: not actual funding",
  allocatedFixedCostsVerified: true, fundedExposure: zeroExposureFixture(), prepaidUsageEnforced: true,
  scenarios: Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key => {
    const gross = BASE_PLAN_REVENUE_CEILINGS[key] ?? 10000;
    return [key, fundedCustomerWithAi(gross, Math.floor(gross * .65), 12, key)];
  })),
});
test("plain, frozen and null-prototype hypothetical reviews remain assessable; actual review stays absent", () => {
  for (const value of [review(), Object.freeze(review()), Object.assign(Object.create(null), review())]) assert.equal(commercialMarginReady(value), true);
  assert.equal(commercialMarginReady(), false);
});
for (const boundary of ["outer", "row"] as const) test(`a hidden ${boundary} dispute liability is unknown before projection`, () => {
  const value = review();
  if (boundary === "outer") value.planPaymentDisputes = new Proxy({ ...value.planPaymentDisputes, unreviewedPlan: null }, {
    ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "unreviewedPlan"),
  });
  else value.planPaymentDisputes!.creator_year = new Proxy({ ...value.planPaymentDisputes!.creator_year!, additionalFeesCents: null }, {
    ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "additionalFeesCents"),
  });
  assert.equal(commercialMarginReady(value), false);
});
for (const boundary of ["root", "company", "scenario", "costs"] as const) test(`${boundary} Proxy is rejected before any trap`, () => {
  const value = review(); let traps = 0;
  const wrap = <T extends object>(object: T): T => new Proxy(object, {
    ownKeys(target) { traps++; return Reflect.ownKeys(target); },
    getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target); },
    getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  if (boundary === "company") value.companyBase = wrap(value.companyBase!);
  if (boundary === "scenario") value.scenarios.creator_month_full = wrap(value.scenarios.creator_month_full!);
  if (boundary === "costs") value.scenarios.creator_month_full!.costCeilings = wrap(value.scenarios.creator_month_full!.costCeilings);
  assert.equal(commercialMarginReady(boundary === "root" ? wrap(value) : value), false);
  assert.equal(traps, 0);
});
test("revoked data and accessors cannot execute or become a known review", () => {
  const revoked = Proxy.revocable(review(), {}); revoked.revoke();
  assert.equal(commercialMarginReady(revoked.proxy), false);
  let getters = 0;
  for (const name of ["planPaymentDisputes", "scenarios", "companyBase"]) {
    const value = review();
    Object.defineProperty(value, name, { enumerable: true, get() { getters++; throw new Error("must not run"); } });
    assert.equal(commercialMarginReady(value), false);
  }
  assert.equal(getters, 0);
});
test("an executable sibling cannot replace already inspected evidence or install getters", () => {
  const value = review(); let traps = 0, getters = 0;
  value.scenarios = new Proxy(value.scenarios, {
    ownKeys(target) {
      traps++;
      Object.defineProperty(value.planPaymentDisputes!.creator_year!, "maximumTotalFeesCents", { enumerable: true, configurable: true, get() { getters++; return 0; } });
      return Reflect.ownKeys(target);
    },
  });
  assert.equal(commercialMarginReady(value), false);
  assert.deepEqual([traps, getters], [0, 0]);
});
test("inherited, symbolic, cyclic and JSON-hook evidence remains unknown", () => {
  assert.equal(commercialMarginReady(Object.create(review())), false);
  const symbolic = review(); Object.assign(symbolic, { [Symbol("unknown liability")]: null });
  assert.equal(commercialMarginReady(symbolic), false);
  const cyclic = review(); Object.assign(cyclic, { cyclic });
  assert.equal(commercialMarginReady(cyclic), false);
  let hooks = 0;
  const hooked = review(); Object.assign(hooked, { toJSON() { hooks++; return {}; } });
  assert.equal(commercialMarginReady(hooked), false); assert.equal(hooks, 0);
});
test("missing native non-executable evidence detection is unknown, never permission", () => {
  const value = review();
  const descriptor = Object.getOwnPropertyDescriptor(process, "getBuiltinModule")!;
  try {
    Object.defineProperty(process, "getBuiltinModule", { ...descriptor, value: undefined });
    assert.equal(commercialMarginReady(value), false);
    assert.equal(commercialMarginReady(), false);
  } finally { Object.defineProperty(process, "getBuiltinModule", descriptor); }
  assert.equal(commercialMarginReady(value), true);
});
for (const name of ["allocatedFixedCostsVerified", "prepaidUsageEnforced"] as const) test(`an inherited ${name} cannot replace an absent own assertion`, () => {
  const value = review(); Reflect.deleteProperty(value, name);
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, name);
  try {
    // Synthetic ambient prototype pollution; no real input vector is claimed.
    Object.defineProperty(Object.prototype, name, { configurable: true, value: true });
    assert.equal(commercialMarginReady(value), false);
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
    else Reflect.deleteProperty(Object.prototype, name);
  }
  assert.equal(commercialMarginReady(review()), true);
});
