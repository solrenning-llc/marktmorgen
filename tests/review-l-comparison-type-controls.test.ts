import assert from "node:assert/strict";
import test from "node:test";
import { overdue, type DatedFact } from "@/lib/competitor-review";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5);
const facts: DatedFact[] = [
  { where: "today", readOn: "2026-11-05" },
  { where: "old", readOn: "2026-01-01" },
  { where: "future", readOn: "2027-01-01" },
];
const all = [facts[1], facts[0], facts[2]];

test("unknown primitive and boxed inputs require review on both boundaries", () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [true, false, "", "90", "2026-11-05", null, Symbol("unknown"), BigInt(90), Object(90), Object("90"), Object(false), revoked.proxy]) {
    assert.deepEqual(overdue(facts, value as number), all);
    assert.deepEqual(overdue(facts, NOW, value as number), all);
  }
});

test("unknown objects cannot invoke conversion or property traps", () => {
  let calls = 0;
  const unknown = new Proxy({}, {
    get() { calls++; throw new Error("Review inputs must not be coerced"); },
    getPrototypeOf() { calls++; throw new Error("Review inputs must not be inspected"); },
  });
  assert.deepEqual(overdue(facts, unknown as unknown as number), all);
  assert.deepEqual(overdue(facts, NOW, unknown as unknown as number), all);
  assert.equal(calls, 0);
});

test("numeric clocks and windows retain the elapsed-time oracle and source identities", () => {
  for (const clock of [0, -DAY, NOW - DAY, NOW, NOW + DAY, NOW + DAY / 2]) {
    for (const days of [0, 1, 30, 90, 365, -1, 0.5, NaN]) {
      const valid = Number.isInteger(days) && days >= 0;
      const wanted = facts.filter(fact => {
        const at = Date.parse(fact.readOn + "T00:00:00Z");
        return !valid || at > clock || clock - at > days * DAY;
      }).sort((a, b) => a.readOn.localeCompare(b.readOn));
      assert.deepEqual(overdue(facts, clock, days), wanted);
      assert.equal(facts[0].where, "today");
    }
  }
});
