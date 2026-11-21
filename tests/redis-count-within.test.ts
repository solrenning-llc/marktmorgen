/**
 * countWithin (lib/redis-reply.ts): a count is read exactly, and only within what the command sent could give
 * (#4795, #4796, #4798, #4794). Pure function; no Redis.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { countWithin } from "@/lib/redis-reply";

test("DEL and UNLINK: at most their distinct keys", () => {
  assert.equal(countWithin(2, ["DEL", "a", "b"]), 2);
  assert.equal(countWithin(3, ["DEL", "a", "b"]), null);
  assert.equal(countWithin(2, ["DEL", "a", "a"]), null, "the same key twice is one key");
  assert.equal(countWithin(1, ["UNLINK", "a"]), 1);
  assert.equal(countWithin(2, ["UNLINK", "a"]), null);
});

test("ZREM, SREM and HDEL: at most their distinct members or fields, never the key", () => {
  assert.equal(countWithin(1, ["ZREM", "k", "m"]), 1);
  assert.equal(countWithin(2, ["ZREM", "k", "m"]), null);
  assert.equal(countWithin(2, ["SREM", "k", "m", "n"]), 2);
  assert.equal(countWithin(2, ["HDEL", "k", "f", "f"]), null);
});

test("HSET: at most its distinct fields", () => {
  assert.equal(countWithin(1, ["HSET", "k", "f", "v"]), 1);
  assert.equal(countWithin(2, ["HSET", "k", "f", "v"]), null);
  assert.equal(countWithin(2, ["HSET", "k", "f", "v", "g", "w"]), 2);
  assert.equal(countWithin(2, ["HSET", "k", "f", "v", "f", "w"]), null, "the same field twice is one field");
});

test("SADD and ZADD: at most their distinct members, after ZADD's options", () => {
  assert.equal(countWithin(2, ["SADD", "k", "a", "b"]), 2);
  assert.equal(countWithin(3, ["SADD", "k", "a", "b"]), null);
  assert.equal(countWithin(2, ["ZADD", "k", 0, "a", 0, "b"]), 2);
  assert.equal(countWithin(3, ["ZADD", "k", 0, "a", 0, "b"]), null);
  assert.equal(countWithin(1, ["ZADD", "k", "NX", 5, "a"]), 1);
  assert.equal(countWithin(2, ["ZADD", "k", "NX", "CH", 5, "a"]), null);
  assert.equal(countWithin(7, ["ZADD", "k", "INCR", 7, "a"]), 7, "INCR answers a score: countOf alone");
});

test("any other shape is null; other commands keep countOf alone", () => {
  for (const reply of [-1, 1.5, "1", null, undefined, {}]) assert.equal(countWithin(reply, ["DEL", "a"]), null);
  assert.equal(countWithin(5, ["INCR", "k"]), 5);
  assert.equal(countWithin(0, ["DEL", "a"]), 0);
});
