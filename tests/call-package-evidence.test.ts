import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCallPackage, PACKAGE_DAYS, packageLimitWords } from "@/lib/call-package-rules";

const valid = { sessions: 5, priceCents: 50_000, days: 90 };
for (const [label, days] of Object.entries({ missing: undefined, null: null, text: "90", unsupported: 45, negative: -1, fractional: 30.5, infinite: Infinity, nan: NaN, object: {} })) {
  test(`unknown package validity is never an unlimited offer: ${label}`, () => {
    assert.equal(parseCallPackage({ ...valid, days }), null);
  });
}

for (const field of ["sessions", "priceCents", "days"] as const) {
  test(`${field} must be an own data number, never an executed getter`, () => {
    let calls = 0;
    const value = Object.defineProperty({ ...valid }, field, { enumerable: true, get() { calls += 1; return valid[field]; } });
    assert.equal(parseCallPackage(value), null);
    assert.equal(calls, 0);
  });
  test(`${field} is not inherited or coerced from text`, () => {
    const inherited = Object.assign(Object.create(valid), valid);
    delete inherited[field];
    assert.equal(parseCallPackage(inherited), null);
    assert.equal(parseCallPackage({ ...valid, [field]: String(valid[field]) }), null);
  });
}

test("unsafe stored package price is unknown, never rounded into an offer", () => {
  assert.equal(parseCallPackage({ ...valid, priceCents: Number.MAX_SAFE_INTEGER + 1 }), null);
});

test("all existing valid terms, including explicit unlimited validity, are preserved", () => {
  for (const days of PACKAGE_DAYS) {
    const value = { ...valid, days };
    assert.deepEqual(parseCallPackage(value), value);
    assert.deepEqual(parseCallPackage(Object.freeze(value)), value);
    assert.deepEqual(parseCallPackage(Object.assign(Object.create(null), value)), value);
    assert.equal(packageLimitWords(value), days === 0 ? "No time limit to use them" : `Use them within ${days} days`);
  }
});

test("absent and malformed packages remain unavailable", () => {
  for (const value of [null, undefined, "", [], {}, { ...valid, sessions: 1 }, { ...valid, priceCents: 0 }]) assert.equal(parseCallPackage(value), null);
});
