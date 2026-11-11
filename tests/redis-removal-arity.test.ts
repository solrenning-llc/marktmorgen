import assert from "node:assert/strict";
import {test} from "node:test";
import {MemoryRedis} from "@/lib/redis-memory";

const arity = (name: string) =>
  `ERR wrong number of arguments for '${name.toLowerCase()}' command`;

for (const name of ["SREM", "ZREM"] as const) {
  test(`${name} requires at least one member and leaves the key unchanged`, () => {
    const store = new MemoryRedis();
    if (name === "SREM") store.run(["SADD", "members", "kept"]);
    else store.run(["ZADD", "members", 1, "kept"]);

    assert.throws(() => store.run([name, "members"]), {message: arity(name)});
    assert.equal(
      name === "SREM"
        ? store.run(["SISMEMBER", "members", "kept"])
        : store.run(["ZSCORE", "members", "kept"]),
      name === "SREM" ? 1 : "1",
    );
  });

  test(`${name} still removes one or more named members`, () => {
    const store = new MemoryRedis();
    if (name === "SREM") store.run(["SADD", "members", "first", "second"]);
    else store.run(["ZADD", "members", 1, "first", 2, "second"]);

    assert.equal(store.run([name, "members", "first", "second"]), 2);
  });
}
