import assert from "node:assert/strict";
import { test } from "node:test";
import { assessTaxThreshold, TAX_THRESHOLD_RULES, type TaxThresholdSnapshot } from "@/lib/tax-threshold";
import { DEEMED_SUPPLIER_RECORDS, deemedSupplierReady } from "@/lib/deemed-supplier";
import { PLANS_ON_SALE } from "@/lib/opening";
const NOW = Date.parse("2026-10-27T12:00:00Z");
const row = (ruleId: TaxThresholdSnapshot["ruleId"], total: number): TaxThresholdSnapshot => ({
  ruleId, currency: TAX_THRESHOLD_RULES[ruleId].currency, recordedOn: "2026-10-27",
  completeRollingCoverage: true, applicableScopeReviewed: true,
  settledApplicableMinor: total, reservedApplicableMinor: 0, proposedApplicableMinor: 0,
});
test("Canadian exceed and Norwegian reach boundaries remain distinct in exact minor units", () => {
  for (const [id, at, equal] of [
    ["ca-specified-supplies", 3_000_000, "below-threshold"],
    ["no-remote-services", 5_000_000, "treatment-required"],
  ] as const) {
    assert.equal(assessTaxThreshold(row(id, at - 1), NOW).status, "below-threshold");
    assert.equal(assessTaxThreshold(row(id, at), NOW).status, equal);
    assert.equal(assessTaxThreshold(row(id, at + 1), NOW).status, "treatment-required");
  }
});
test("outstanding reservations and proposed supplies count before crossing the boundary", () => {
  const value = row("no-remote-services", 4_999_998);
  value.reservedApplicableMinor = 1;
  value.proposedApplicableMinor = 1;
  assert.deepEqual(assessTaxThreshold(value, NOW), { status: "treatment-required", projectedApplicableMinor: 5_000_000 });
  const ca = row("ca-specified-supplies", 3_000_000);
  ca.proposedApplicableMinor = 1;
  assert.equal(assessTaxThreshold(ca, NOW).status, "treatment-required");
});
test("missing coverage, classification, amounts, currency and current-day evidence fail closed", () => {
  const value = row("ca-specified-supplies", 0);
  for (const change of [
    {completeRollingCoverage:false}, {applicableScopeReviewed:false}, {settledApplicableMinor:null},
    {reservedApplicableMinor:null}, {proposedApplicableMinor:null}, {currency:"NOK"},
    {recordedOn:"2026-10-26"}, {recordedOn:"2026-10-28"}, {ruleId:"US"}, {ruleId:"__proto__"},
  ]) assert.equal(assessTaxThreshold({...value,...change}, NOW).status, "unknown");
  assert.equal(assessTaxThreshold(value, Date.parse("2026-10-26T12:00:00Z")).status, "unknown");
  assert.equal(assessTaxThreshold(null, NOW).status, "unknown");
  const missing = {...value} as Partial<TaxThresholdSnapshot>;
  delete missing.reservedApplicableMinor;
  assert.equal(assessTaxThreshold(missing, NOW).status, "unknown");
});
test("invalid cents, totals and clocks never become threshold approval", () => {
  for (const amount of [-1, .1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(assessTaxThreshold({...row("ca-specified-supplies",0), proposedApplicableMinor:amount},NOW).status,"invalid");
  }
  assert.equal(assessTaxThreshold({...row("ca-specified-supplies",Number.MAX_SAFE_INTEGER),reservedApplicableMinor:1},NOW).status,"invalid");
  for (const clock of [-1,NaN,Infinity,253_402_300_800_000]) assert.equal(assessTaxThreshold(row("no-remote-services",0),clock).status,"invalid");
});
test("inherited fields and getters are not evidence and are never executed", () => {
  let reads=0;
  const value=row("ca-specified-supplies",0);
  const accessor={...value};
  Object.defineProperty(accessor,"settledApplicableMinor",{enumerable:true,get(){reads++;return 0;}});
  assert.equal(assessTaxThreshold(accessor,NOW).status,"unknown");
  assert.equal(reads,0);
  assert.equal(assessTaxThreshold(Object.create(value),NOW).status,"unknown");
});
test("threshold arithmetic creates no actual registration, treatment record or permission to sell", () => {
  assert.equal(assessTaxThreshold(row("ca-specified-supplies",0),NOW).status,"below-threshold");
  assert.equal(DEEMED_SUPPLIER_RECORDS.length,0);
  assert.equal(deemedSupplierReady(),false);
  assert.equal(PLANS_ON_SALE,false);
});


test("ledger assessment derives the country totals and reserves before the Canadian boundary", async () => {
  const { assessTaxSalesThreshold } = await import("@/lib/tax-threshold");
  const ledger = {
    place: { country: "CA", state: null }, currency: "CAD",
    periodStart: "2025-10-28", periodEnd: "2026-10-27",
    coverageFrom: "2025-10-28", coverageThrough: "2026-10-27", complete: true,
    entries: [
      { id: "own", country: "CA", state: "ON", currency: "CAD", supplyOn: "2026-10-27", position: "settled", amountMinor: 2_000_000, applicable: true },
      { id: "facilitated", country: "CA", state: "QC", currency: "CAD", supplyOn: "2026-10-27", position: "reserved", amountMinor: 1_000_000, applicable: true },
    ],
  };
  const evidence = { ruleId: "ca-specified-supplies", ledger, completeRollingCoverage: true, applicableScopeReviewed: true };
  assert.deepEqual(assessTaxSalesThreshold(evidence, NOW), { status: "below-threshold", projectedApplicableMinor: 3_000_000 });
  ledger.entries.push({ ...ledger.entries[0], id: "next", position: "proposed", amountMinor: 1 });
  assert.deepEqual(assessTaxSalesThreshold(evidence, NOW), { status: "treatment-required", projectedApplicableMinor: 3_000_001 });
  for (const change of [
    { completeRollingCoverage: false }, { applicableScopeReviewed: false }, { ruleId: "unknown" },
    { ledger: { ...ledger, complete: false } },
    { ledger: { ...ledger, place: { country: "CA", state: "ON" } } },
    { ledger: { ...ledger, place: { country: "NO", state: null } } },
    { ledger: { ...ledger, currency: "USD" } },
    { ledger: { ...ledger, periodEnd: "2026-10-26" } },
    { ledger: { ...ledger, entries: [ledger.entries[0], ledger.entries[0]] } },
  ]) assert.equal(assessTaxSalesThreshold({ ...evidence, ...change }, NOW).status, "unknown");
  assert.equal(DEEMED_SUPPLIER_RECORDS.length, 0);
  assert.equal(deemedSupplierReady(), false);
  assert.equal(PLANS_ON_SALE, false);
});
test("Norwegian national ledger reaches its distinct threshold and propagates invalid totals", async () => {
  const { assessTaxSalesThreshold } = await import("@/lib/tax-threshold");
  const ledger = {
    place: { country: "NO", state: null }, currency: "NOK",
    periodStart: "2025-10-28", periodEnd: "2026-10-27",
    coverageFrom: "2025-10-28", coverageThrough: "2026-10-27", complete: true,
    entries: [{ id: "remote", country: "NO", state: null, currency: "NOK", supplyOn: "2026-10-27", position: "proposed", amountMinor: 5_000_000, applicable: true }],
  };
  const evidence = { ruleId: "no-remote-services", ledger, completeRollingCoverage: true, applicableScopeReviewed: true };
  assert.deepEqual(assessTaxSalesThreshold(evidence, NOW), { status: "treatment-required", projectedApplicableMinor: 5_000_000 });
  ledger.entries[0].amountMinor = -1;
  assert.equal(assessTaxSalesThreshold(evidence, NOW).status, "invalid");
  assert.equal(assessTaxSalesThreshold(null, NOW).status, "unknown");
  let reads = 0;
  const accessor = { ...evidence };
  Object.defineProperty(accessor, "ledger", { enumerable: true, get() { reads++; return ledger; } });
  assert.equal(assessTaxSalesThreshold(accessor, NOW).status, "unknown");
  assert.equal(reads, 0);
});

test("prototype descriptor defaults cannot forge a missing own threshold amount", () => {
  let reads = 0;
  const malformed: Record<string, unknown> = { ...row("ca-specified-supplies", 0) };
  delete malformed.settledApplicableMinor;
  malformed.extra = 0;
  Object.defineProperty(Object.prototype, "settledApplicableMinor", {
    configurable: true, get() { reads++; return { value: 0 }; },
  });
  try {
    assert.equal(assessTaxThreshold(malformed, NOW).status, "unknown");
    assert.equal(reads, 0);
  } finally { Reflect.deleteProperty(Object.prototype, "settledApplicableMinor"); }
});

test("detached threshold amounts cannot be replaced through inherited setters", () => {
  const value = row("ca-specified-supplies", 3_000_001);
  let reads = 0, writes = 0;
  let result: ReturnType<typeof assessTaxThreshold> | undefined;
  Object.defineProperty(Object.prototype, "settledApplicableMinor", {
    configurable: true,
    get() { reads++; return 0; },
    set() { writes++; },
  });
  try {
    result = assessTaxThreshold(value, NOW);
  } finally { Reflect.deleteProperty(Object.prototype, "settledApplicableMinor"); }
  assert.deepEqual([reads, writes], [0, 0]);
  assert.deepEqual(result, { status: "treatment-required", projectedApplicableMinor: 3_000_001 });
});
test("detached ledger evidence does not invoke an inherited ledger setter", async () => {
  const { assessTaxSalesThreshold } = await import("@/lib/tax-threshold");
  const ledger = {
    place: { country: "NO", state: null }, currency: "NOK",
    periodStart: "2025-10-28", periodEnd: "2026-10-27",
    coverageFrom: "2025-10-28", coverageThrough: "2026-10-27", complete: true,
    entries: [{ id: "remote", country: "NO", state: null, currency: "NOK", supplyOn: "2026-10-27", position: "proposed", amountMinor: 5_000_000, applicable: true }],
  };
  const evidence = { ruleId: "no-remote-services", ledger, completeRollingCoverage: true, applicableScopeReviewed: true };
  let reads = 0, writes = 0;
  let result: ReturnType<typeof assessTaxSalesThreshold> | undefined;
  Object.defineProperty(Object.prototype, "ledger", {
    configurable: true,
    get() { reads++; return null; },
    set() { writes++; },
  });
  try {
    result = assessTaxSalesThreshold(evidence, NOW);
  } finally { Reflect.deleteProperty(Object.prototype, "ledger"); }
  assert.deepEqual([reads, writes], [0, 0]);
  assert.deepEqual(result, { status: "treatment-required", projectedApplicableMinor: 5_000_000 });
});
