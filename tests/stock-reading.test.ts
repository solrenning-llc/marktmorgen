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
      redis.pipeline = async (commands) => commands.map(command => command[0] === "HGETALL" ? raw : command[0] === "SET" ? "OK" : 1);
      await assert.rejects(stockLeft(store, product), /Stock reading unavailable/);
      await assert.rejects(withStockHold(store, product, async () => { opened += 1; return { id: "cs_test_synthetic" }; }), /Stock reading unavailable/);
    }
    assert.equal(opened, 0);
    redis.pipeline = async () => [[]];
    assert.equal(await stockLeft(store, product), 1);
    redis.pipeline = async () => [["session", '{"until":0,"paid":true}']];
    assert.equal(await stockLeft(store, product), 0);
  } finally { redis.pipeline = original; }
});

test("unknown outer inventory receipts cannot advertise availability or open checkout", async () => {
  const product = parseProduct({ id: "limited123", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const store = { statsId: "a".repeat(32) } as Store;
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  let opened = 0;
  const replies: unknown[] = [null, undefined, false, 0, "OK", {}, [], Array(1), [[], null], [[], []], { 0: [], length: 1 }];
  try {
    for (const reply of replies) {
      const commands: unknown[][] = [];
      redis.pipeline = async (batch) => {
        commands.push(...batch);
        if (batch.length === 1 && batch[0][0] === "HGETALL") return reply as unknown[];
        return batch.map(command => command[0] === "SET" ? "OK" : 1);
      };
      await assert.rejects(stockLeft(store, product), /Stock reading unavailable/);
      assert.deepEqual(commands.map(command => command[0]), ["HGETALL"]);
      commands.length = 0;
      await assert.rejects(withStockHold(store, product, async () => { opened += 1; return { id: "cs_test_synthetic" }; }), /Stock reading unavailable/);
      // The lock is let go only if it is still this checkout's (lib/redis-lock.ts, compare-and-delete), since 2 November 2026.
      assert.deepEqual(commands.map(command => command[0]), ["SET", "HGETALL", "EVAL"]);
    }
  } finally { redis.pipeline = original; }
  assert.equal(opened, 0);
});
