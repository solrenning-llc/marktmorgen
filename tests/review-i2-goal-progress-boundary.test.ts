import test from "node:test";
import assert from "node:assert/strict";
import { goalProgress, MAX_GOAL_CENTS } from "@/lib/sales-goal-rules";
let hooks = 0;
const hostile = { [Symbol.toPrimitive]() { hooks++; throw Error("conversion must not run"); } };
const proxy = new Proxy({}, { get() { hooks++; throw Error("property access must not run"); } });
const invalid: [string, unknown][] = [
 ["unavailable sentinel", -1], ["negative amount", -500], ["fractional amount", 1.5],
 ["above configured goal maximum", MAX_GOAL_CENTS + 1], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
 ["NaN", NaN], ["infinity", Infinity], ["minus infinity", -Infinity],
 ["numeric text", "500"], ["boolean", true], ["bigint", BigInt(500)], ["symbol", Symbol("goal")],
 ["conversion object", hostile], ["proxy", proxy], ["boxed number", Object(500)], ["array", [500]],
];
for (const [name, value] of invalid) test(name + " cannot create goal arithmetic", () => {
 const before = hooks;
 assert.equal(goalProgress(value as number, { "2026-11-04": 1000 }, "2026-11-05"), null);
 assert.equal(hooks, before);
});
test("confirmed zero and missing target remain without progress", () => {
 for (const value of [0, -0, null, undefined]) assert.equal(goalProgress(value as number, {}, "2026-11-05"), null);
});
test("positive valid amounts retain zero and reached progress without mutation", () => {
 const empty = Object.freeze({});
 for (const value of [1, 500, MAX_GOAL_CENTS]) {
  const result = goalProgress(value, empty, "2026-11-05");
  assert.ok(result);
  assert.deepEqual([result.goal, result.done, result.share, result.reachedOn], [value, 0, 0, null]);
 }
 const days = Object.freeze({ "2026-11-04": 1000 });
 assert.equal(goalProgress(500, days, "2026-11-05")?.reachedOn, "2026-11-04");
 assert.deepEqual(days, { "2026-11-04": 1000 });
});
