import assert from "node:assert/strict";
import { test } from "node:test";
import { countTaxSales, MAX_TAX_SALES_ENTRIES, type TaxSalesEntry, type TaxSalesLedger } from "@/lib/tax-sales-counter";

const entry = (id: string, change: Partial<TaxSalesEntry> = {}): TaxSalesEntry => ({
  id, country: "CA", state: "ON", currency: "CAD", supplyOn: "2026-10-31",
  position: "settled", amountMinor: 100, applicable: true, ...change,
});
const ledger = (entries: TaxSalesEntry[] = []): TaxSalesLedger => ({
  place: { country: "CA", state: null }, currency: "CAD",
  periodStart: "2025-11-01", periodEnd: "2026-10-31",
  coverageFrom: "2025-11-01", coverageThrough: "2026-10-31", complete: true, entries,
});
test("complete national ledger totals own and facilitated supplies, reservations and proposals exactly", () => {
  const value = ledger([
    entry("own"), entry("facilitated", { state: "QC", amountMinor: 200 }),
    entry("reservation", { position: "reserved", amountMinor: 30 }),
    entry("proposal", { position: "proposed", amountMinor: 4 }),
  ]);
  assert.deepEqual(countTaxSales(value), {
    status: "known", place: { country: "CA", state: null }, currency: "CAD",
    periodStart: "2025-11-01", periodEnd: "2026-10-31",
    settledApplicableMinor: 300, reservedApplicableMinor: 30, proposedApplicableMinor: 4, applicableEntries: 4,
  });
  assert.equal(value.entries[0].amountMinor, 100);
});
test("national and state scopes do not mix places, and explicit non-applicability is distinguished from unknown", () => {
  const value = ledger([
    entry("on"), entry("qc", { state: "QC", amountMinor: 200 }),
    entry("us", { country: "US", state: "CA", amountMinor: 300 }),
    entry("excluded", { applicable: false, amountMinor: 400 }),
  ]);
  assert.equal(countTaxSales(value).status, "known");
  const state = countTaxSales({ ...value, place: { country: "CA", state: "ON" } });
  assert.equal(state.status, "known");
  if (state.status === "known") assert.deepEqual([state.settledApplicableMinor, state.applicableEntries], [100, 1]);
  assert.deepEqual(countTaxSales(ledger([entry("unknown", { applicable: null })])), { status: "unknown" });
  assert.deepEqual(countTaxSales({ ...value, place: { country: "CA", state: "ON" }, entries: [entry("missing-state", { state: null })] }), { status: "unknown" });
});
test("inclusive interval boundaries count, old settlements do not, pending out-of-period supplies stay unknown", () => {
  const value = ledger([
    entry("first", { supplyOn: "2025-11-01", amountMinor: 1 }),
    entry("last", { amountMinor: 2 }),
    entry("old", { supplyOn: "2025-10-31", amountMinor: 1000 }),
    entry("later", { supplyOn: "2026-11-01", amountMinor: 1000 }),
  ]);
  const totals = countTaxSales(value);
  assert.equal(totals.status, "known");
  if (totals.status === "known") assert.equal(totals.settledApplicableMinor, 3);
  for (const position of ["reserved", "proposed"] as const) {
    for (const supplyOn of ["2025-10-31", "2026-11-01"]) {
      assert.deepEqual(countTaxSales(ledger([entry("pending", { position, supplyOn })])), { status: "unknown" });
    }
  }
});
test("only explicit complete interval coverage can produce a known zero", () => {
  const zero = countTaxSales(ledger());
  assert.equal(zero.status, "known");
  if (zero.status === "known") assert.equal(zero.settledApplicableMinor, 0);
  for (const change of [
    { complete: false }, { coverageFrom: "2025-11-02" }, { coverageThrough: "2026-10-30" },
    { periodStart: "2026-02-30" }, { periodEnd: "unknown" }, { entries: null },
  ]) assert.deepEqual(countTaxSales({ ...ledger(), ...change }), { status: "unknown" });
  assert.deepEqual(countTaxSales({ ...ledger(), periodStart: "2026-11-01" }), { status: "invalid" });
});
test("unknown money, currency, place and classification never become zero or implicit FX", () => {
  for (const change of [
    { amountMinor: null }, { currency: "USD" }, { country: null }, { state: undefined },
    { applicable: undefined }, { position: "refunded" }, { supplyOn: "2026-13-01" },
  ]) assert.deepEqual(countTaxSales(ledger([entry("uncertain", change as Partial<TaxSalesEntry>)])), { status: "unknown" });
  assert.deepEqual(countTaxSales({ ...ledger(), currency: "cad" }), { status: "unknown" });
});
test("duplicate IDs across positions or places fail rather than omit or double-count a supply", () => {
  for (const change of [{}, { position: "reserved" }, { country: "US" }]) {
    assert.deepEqual(countTaxSales(ledger([entry("same"), entry("same", change as Partial<TaxSalesEntry>)])), { status: "unknown" });
  }
});
test("negative, fractional, coerced and overflowing amounts fail in exact minor units", () => {
  for (const amountMinor of [-1, 0.1, NaN, Infinity, "100", Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(countTaxSales(ledger([entry("bad", { amountMinor: amountMinor as number })])), { status: "invalid" });
  }
  assert.deepEqual(countTaxSales(ledger([
    entry("large", { amountMinor: Number.MAX_SAFE_INTEGER }),
    entry("one", { position: "proposed", amountMinor: 1 }),
  ])), { status: "invalid" });
  const maximum = countTaxSales(ledger([entry("large", { amountMinor: Number.MAX_SAFE_INTEGER })]));
  assert.equal(maximum.status, "known");
});
test("plain own fields are detached without executing accessors or coercion", () => {
  let reads = 0;
  const accessor = entry("accessor");
  Object.defineProperty(accessor, "amountMinor", { enumerable: true, get() { reads++; return 100; } });
  assert.deepEqual(countTaxSales(ledger([accessor])), { status: "unknown" });
  const top = ledger();
  Object.defineProperty(top, "entries", { enumerable: true, get() { reads++; return []; } });
  assert.deepEqual(countTaxSales(top), { status: "unknown" });
  assert.deepEqual(countTaxSales(Object.create(ledger())), { status: "unknown" });
  const inherited = Object.create(entry("inherited")) as TaxSalesEntry;
  assert.deepEqual(countTaxSales(ledger([inherited])), { status: "unknown" });
  const extra = { ...ledger(), [Symbol("hidden")]: true };
  assert.deepEqual(countTaxSales(extra), { status: "unknown" });
  assert.equal(reads, 0);
});
test("sparse, inherited, decorated and unreadable ledger arrays are not complete evidence", () => {
  const sparse = new Array<TaxSalesEntry>(1);
  const decorated = [entry("ok")];
  Object.defineProperty(decorated, "extra", { value: 1 });
  const inherited = [entry("ok")];
  Object.setPrototypeOf(inherited, null);
  const unreadable = new Proxy([entry("ok")], { ownKeys() { throw new Error("unreadable"); } });
  for (const entries of [sparse, decorated, inherited, unreadable]) {
    assert.deepEqual(countTaxSales({ ...ledger(), entries }), { status: "unknown" });
  }
});
test("oversized snapshots fail before enumerating or reading entries, with no truncation", () => {
  let enumerated = 0, inspected = 0;
  const entries = new Proxy(new Array(MAX_TAX_SALES_ENTRIES + 1), {
    ownKeys(target) { enumerated++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      if (key !== "length") inspected++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.deepEqual(countTaxSales({ ...ledger(), entries }), { status: "unknown" });
  assert.deepEqual([enumerated, inspected], [0, 0]);
});

test("a missing own field cannot be forged by a getter on the descriptor map prototype", () => {
  let reads = 0;
  const malformed: Record<string, unknown> = { ...entry("missing") };
  delete malformed.id;
  malformed.extra = "not an id";
  Object.defineProperty(Object.prototype, "id", {
    configurable: true, get() { reads++; return { value: "forged" }; },
  });
  try {
    assert.deepEqual(countTaxSales({ ...ledger(), entries: [malformed] }), { status: "unknown" });
    assert.equal(reads, 0);
  } finally { Reflect.deleteProperty(Object.prototype, "id"); }
});

test("detached own sales fields do not invoke inherited setters or replacement getters", () => {
  for (const key of ["applicable", "amountMinor"] as const) {
    const value = ledger([entry("real", { amountMinor: 500 })]);
    let reads = 0, writes = 0;
    let result: ReturnType<typeof countTaxSales> | undefined;
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get() { reads++; return key === "applicable" ? false : 0; },
      set() { writes++; },
    });
    try {
      result = countTaxSales(value);
    } finally { Reflect.deleteProperty(Object.prototype, key); }
    assert.deepEqual([reads, writes], [0, 0]);
    assert.equal(result?.status, "known");
    if (result?.status === "known") {
      assert.equal(result.settledApplicableMinor, 500);
      assert.equal(result.applicableEntries, 1);
    }
  }
});
