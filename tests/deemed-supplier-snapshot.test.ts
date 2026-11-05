import test from "node:test";
import assert from "node:assert/strict";
import { DEEMED_SUPPLIER_JURISDICTIONS, DEEMED_SUPPLIER_RECORDS, deemedSupplierProblems, deemedSupplierReady } from "@/lib/deemed-supplier";
import { PLANS_ON_SALE } from "@/lib/opening";
const rows = () => DEEMED_SUPPLIER_JURISDICTIONS.map(jurisdiction => ({
  jurisdiction, treatment: "collect", implementedIn: "lib/deemed-supplier.ts",
  recordedOn: "2026-10-27", registration: "synthetic registration", evidence: "synthetic only",
}));
test("a changing treatment cannot skip the registration requirement", () => {
  const records = rows(); let reads = 0;
  records[0].registration = "";
  Object.defineProperty(records[0], "treatment", { get() { return ++reads === 1 ? "collect" : "refuse-consumers"; } });
  assert.equal(deemedSupplierReady(records), false);
  assert.equal(reads, 0);
});
test("every review field and array entry must be data without getter execution", () => {
  for (const key of Object.keys(rows()[0])) {
    const records = rows(); let reads = 0;
    Object.defineProperty(records[0], key, { get() { reads++; throw Error("must not execute"); } });
    assert.equal(deemedSupplierReady(records), false, key);
    assert.equal(reads, 0, key);
  }
  const records = rows(); let reads = 0;
  Object.defineProperty(records, "0", { get() { reads++; return rows()[0]; } });
  assert.equal(deemedSupplierReady(records), false);
  assert.equal(reads, 0);
});
test("inherited, sparse, malformed and unknown jurisdiction reviews remain closed", () => {
  const inherited = rows(); inherited[0] = Object.create(inherited[0]);
  const sparse = rows(); delete (sparse as unknown[])[0];
  const unknown = rows(); unknown[0].jurisdiction = "unknown" as typeof unknown[0]["jurisdiction"];
  for (const records of [null, {}, inherited, sparse, unknown, rows().slice(1), [...rows(), rows()[0]]]) {
    assert.equal(deemedSupplierReady(records), false);
  }
  const throwing = new Proxy({}, { ownKeys() { throw Error("unreadable evidence"); } });
  assert.equal(deemedSupplierReady([throwing, ...rows().slice(1)]), false);
});
test("detached data preserves existing validation and never creates real treatment", () => {
  assert.deepEqual(deemedSupplierProblems(rows()), []);
  assert.equal(deemedSupplierReady(rows().map(row => Object.assign(Object.create(null), row))), true);
  const refused = rows().map(row => ({ ...row, treatment: "refuse-consumers", registration: "" }));
  assert.equal(deemedSupplierReady(refused), true);
  for (const key of ["implementedIn", "recordedOn", "registration", "evidence"] as const) {
    const records = rows(); records[0][key] = "";
    assert.equal(deemedSupplierReady(records), false, key);
  }
  assert.deepEqual([DEEMED_SUPPLIER_RECORDS.length, deemedSupplierReady(), PLANS_ON_SALE], [0, false, false]);
});

test("oversized treatment reviews stop before key enumeration or member inspection", () => {
  let enumerations = 0, members = 0;
  const observed = (records: ReturnType<typeof rows>) => new Proxy(records, {
    ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      if (key !== "length") members++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  // Prove both probes observe a normal complete review first.
  assert.equal(deemedSupplierReady(observed(rows())), true);
  assert.ok(enumerations > 0);
  assert.ok(members > 0);
  enumerations = 0; members = 0;
  for (const size of [DEEMED_SUPPLIER_JURISDICTIONS.length + 1, 1_000_000]) {
    const records = rows();
    records.length = size;
    assert.equal(deemedSupplierReady(observed(records)), false);
    assert.deepEqual([enumerations, members], [0, 0]);
  }
  // Partial reviews keep the existing specific missing-jurisdiction reasons.
  assert.equal(deemedSupplierProblems([]).length, DEEMED_SUPPLIER_JURISDICTIONS.length);
  assert.deepEqual([DEEMED_SUPPLIER_RECORDS.length, deemedSupplierReady(), PLANS_ON_SALE], [0, false, false]);
});

test("missing review fields cannot be supplied by descriptor-map prototype data", () => {
  for (const key of ["registration", "evidence"] as const) {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
    const records = rows();
    delete (records[0] as Partial<typeof records[0]>)[key];
    Object.defineProperty(records[0], "unexpected", { value: "keeps the own-field count", enumerable: true });
    try {
      Object.defineProperty(Object.prototype, key, {
        configurable: true, writable: true,
        value: { value: "inherited synthetic evidence" },
      });
      assert.equal(deemedSupplierReady(records), false, key);
      assert.deepEqual(deemedSupplierProblems(records), ["tax-treatment records: complete own data required"], key);
    } finally {
      if (original) Object.defineProperty(Object.prototype, key, original);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
});

test("missing review fields never execute descriptor-map prototype getters", () => {
  for (const key of ["registration", "evidence"] as const) {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
    const records = rows(); let reads = 0;
    delete (records[0] as Partial<typeof records[0]>)[key];
    Object.defineProperty(records[0], "unexpected", { value: "keeps the own-field count", enumerable: true });
    try {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() { reads++; return { value: "inherited synthetic evidence" }; },
      });
      assert.equal(deemedSupplierReady(records), false, key);
      assert.equal(reads, 0, key);
    } finally {
      if (original) Object.defineProperty(Object.prototype, key, original);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
  assert.deepEqual(deemedSupplierProblems(rows()), []);
  assert.deepEqual([DEEMED_SUPPLIER_RECORDS.length, deemedSupplierReady(), PLANS_ON_SALE], [0, false, false]);
});

test("detaching own treatment data never invokes inherited setters or replacement getters", () => {
  for (const key of ["jurisdiction", "treatment", "implementedIn", "recordedOn", "registration", "evidence"] as const) {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
    const records = rows(); let reads = 0, writes = 0;
    try {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() { reads++; return "inherited substitution"; },
        set() { writes++; },
      });
      assert.deepEqual(deemedSupplierProblems(records), [], key);
      assert.deepEqual([reads, writes], [0, 0], key);
    } finally {
      if (original) Object.defineProperty(Object.prototype, key, original);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
  assert.deepEqual([DEEMED_SUPPLIER_RECORDS.length, deemedSupplierReady(), PLANS_ON_SALE], [0, false, false]);
});
