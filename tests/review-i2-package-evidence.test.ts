/** Independent I2 term matrix; existing policy constants, no IO. */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCallPackage, packageLimitWords } from "@/lib/call-package-rules";
const terms = [0, 30, 60, 90, 180, 365];
test("all existing session and day terms preserve exact integer data", () => {
  for (let sessions = 2; sessions <= 20; sessions += 1) for (const days of terms) for (const priceCents of [1, 50000]) {
    const value = { sessions, priceCents, days };
    for (const input of [value, Object.freeze({ ...value }), Object.assign(Object.create(null), value), JSON.parse(JSON.stringify(value))]) {
      assert.deepEqual(parseCallPackage(input), value);
      assert.equal(packageLimitWords(parseCallPackage(input)!), days === 0 ? "No time limit to use them" : `Use them within ${days} days`);
    }
  }
});
test("unknown fields cannot be rescued by coercion or an inherited term", () => {
  const valid = { sessions: 5, priceCents: 50000, days: 90 };
  let conversions = 0;
  for (const field of ["sessions", "priceCents", "days"] as const) {
    for (const bad of [undefined, null, true, false, "0", "90", NaN, Infinity, -Infinity, Symbol("unknown"), BigInt(1), { valueOf() { conversions += 1; return valid[field]; } }]) {
      assert.equal(parseCallPackage({ ...valid, [field]: bad }), null);
    }
    const inherited = Object.assign(Object.create({ [field]: valid[field] }), valid);
    delete inherited[field]; assert.equal(parseCallPackage(inherited), null);
  }
  assert.equal(conversions, 0);
});
test("known integer boundaries and unsupported validity stay unavailable", () => {
  for (const sessions of [-1, 0, 1, 21, Number.MAX_SAFE_INTEGER + 1]) assert.equal(parseCallPackage({ sessions, priceCents: 1, days: 0 }), null);
  for (const priceCents of [-1, 0, 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(parseCallPackage({ sessions: 2, priceCents, days: 0 }), null);
  for (const days of [-1, 1, 29, 31, 45, 366, 365.1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(parseCallPackage({ sessions: 2, priceCents: 1, days }), null);
});
