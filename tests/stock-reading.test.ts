import { test } from "node:test";
import assert from "node:assert/strict";
import { stockLeft, withStockHold } from "@/lib/stock";
import { parseProduct } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

test("unknown or malformed inventory never becomes an empty set of holds", async () => {
  const product = parseProduct({ id: "limited123", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const store = { statsId: "a".repeat(32) } as Store;
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  let opened = 0;
  const bad: unknown[] = [undefined, null, {}, 0, ["session"], ["session", "{"], ["session", "null"], ["session", "[]"], ["session", "{}"], ["session", '{"until":-1}'], ["session", '{"until":1,"paid":"yes"}'], ["session", '{"until":1}', "session", '{"until":2}']];
  try {
    for (const raw of bad) {
      redis.pipeline = async (commands) => commands.map(command => command[0] === "HGETALL" ? raw : command[0] === "GET" ? null : command[0] === "SET" ? "OK" : 1);
      await assert.rejects(stockLeft(store, product), /Stock reading unavailable/);
      await assert.rejects(withStockHold(store, product, async () => { opened += 1; return { id: "cs_test_synthetic" }; }), /Stock reading unavailable/);
    }
    // A sold count (lib/stock.ts, since 4 November 2026) that is not a whole number is unknown too.
    for (const sold of ["x", "-1", "1.5", {}, [], true]) {
      redis.pipeline = async (commands) => commands.map(command => command[0] === "HGETALL" ? [] : command[0] === "GET" ? sold : command[0] === "SET" ? "OK" : 1);
      await assert.rejects(stockLeft(store, product), /Stock reading unavailable/);
      await assert.rejects(withStockHold(store, product, async () => { opened += 1; return { id: "cs_test_synthetic" }; }), /Stock reading unavailable/);
    }
    assert.equal(opened, 0);
    redis.pipeline = async () => [[], null];
    assert.equal(await stockLeft(store, product), 1);
    // A unit marked sold the old way, still in the hash, and one in the sold count.
    redis.pipeline = async () => [["session", '{"until":0,"paid":true}'], null];
    assert.equal(await stockLeft(store, product), 0);
    redis.pipeline = async () => [[], "1"];
    assert.equal(await stockLeft(store, product), 0);
  } finally { redis.pipeline = original; }
});

test("unknown outer inventory receipts cannot advertise availability or open checkout", async () => {
  const product = parseProduct({ id: "limited123", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const store = { statsId: "a".repeat(32) } as Store;
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  let opened = 0;
  const replies: unknown[] = [null, undefined, false, 0, "OK", {}, [], Array(1), Array(2), [[]], [[], []], [null, null], [[], null, null], { 0: [], 1: null, length: 2 }];
  try {
    for (const reply of replies) {
      const commands: unknown[][] = [];
      redis.pipeline = async (batch) => {
        commands.push(...batch);
        if (batch.length === 2 && batch[0][0] === "HGETALL") return reply as unknown[];
        return batch.map(command => command[0] === "SET" ? "OK" : 1);
      };
      await assert.rejects(stockLeft(store, product), /Stock reading unavailable/);
      assert.deepEqual(commands.map(command => command[0]), ["HGETALL", "GET"]);
      commands.length = 0;
      await assert.rejects(withStockHold(store, product, async () => { opened += 1; return { id: "cs_test_synthetic" }; }), /Stock reading unavailable/);
      // The lock is let go only if it is still this checkout's (lib/redis-lock.ts, compare-and-delete), since 2 November 2026.
      assert.deepEqual(commands.map(command => command[0]), ["SET", "HGETALL", "GET", "EVAL"]);
    }
  } finally { redis.pipeline = original; }
  assert.equal(opened, 0);
});
