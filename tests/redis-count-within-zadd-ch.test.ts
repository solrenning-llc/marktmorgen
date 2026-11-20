/** countWithin bounds a ZADD reply by what Redis can answer: with CH and without NX, each score/member pair can count (Codex P on #4904, P-20261119-1730). Synthetic only. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { countWithin } from "@/lib/redis-reply";

test("ZADD CH counts repeated changes, including a newly added member", () => {
  assert.equal(countWithin(2, ["ZADD", "k", "CH", 1, "m", 2, "m"]), 2);
});
test("ZADD XX CH can change an existing member twice", () => {
  assert.equal(countWithin(2, ["ZADD", "k", "XX", "CH", 1, "m", 2, "m"]), 2);
});
test("ZADD GT CH can change the same member twice", () => {
  assert.equal(countWithin(2, ["ZADD", "k", "GT", "CH", 1, "m", 2, "m"]), 2);
});
test("ZADD NX CH still adds each distinct member at most once", () => {
  assert.equal(countWithin(2, ["ZADD", "k", "NX", "CH", 1, "m", 2, "m"]), null);
});
test("ZADD without CH still counts distinct additions", () => {
  assert.equal(countWithin(2, ["ZADD", "k", 1, "m", 2, "m"]), null);
});
test("ZADD CH never counts more changes than score/member pairs", () => {
  assert.equal(countWithin(3, ["ZADD", "k", "CH", 1, "m", 2, "m"]), null);
});
