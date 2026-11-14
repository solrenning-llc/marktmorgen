import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryRedis } from "@/lib/redis-memory";

// Redis rejects a ZREMRANGEBYSCORE bound that is not a float ("ERR min or max
// is not a float"). The stand-in used to read such a bound as NaN and remove
// nothing, so a script that sent "undefined" passed every test and failed on
// every call in real Redis (#3591, Claude 2 cloud G, HIGH).
const notFloat = { message: "ERR min or max is not a float" };

for (const bad of ["undefined", "NaN", "", "abc", "1x", "("]) {
  test(`ZREMRANGEBYSCORE refuses the bound ${JSON.stringify(bad)} and touches nothing`, () => {
    const store = new MemoryRedis();
    store.run(["ZADD", "z", 1, "a", 2, "b"]);
    assert.throws(() => store.run(["ZREMRANGEBYSCORE", "z", "-inf", bad]), notFloat);
    assert.throws(() => store.run(["ZREMRANGEBYSCORE", "z", bad, "+inf"]), notFloat);
    assert.equal(store.run(["ZCARD", "z"]), 2);
  });
}

test("ZREMRANGEBYSCORE keeps Redis's valid bounds: infinities, numbers and exclusive '('", () => {
  const store = new MemoryRedis();
  store.run(["ZADD", "z", 1, "a", 2, "b", 3, "c", 4, "d"]);
  assert.equal(store.run(["ZREMRANGEBYSCORE", "z", "(1", "2"]), 1); // b only
  assert.equal(store.run(["ZREMRANGEBYSCORE", "z", "-inf", "(3"]), 1); // a only
  assert.equal(store.run(["ZREMRANGEBYSCORE", "z", "3", "+inf"]), 2); // c and d
  store.run(["ZADD", "z", 5, "e"]);
  assert.equal(store.run(["ZREMRANGEBYSCORE", "z", "-inf", "inf"]), 1);
  store.run(["ZADD", "z", 6, "f"]);
  assert.equal(store.run(["ZREMRANGEBYSCORE", "z", "-inf", 6]), 1);
});
