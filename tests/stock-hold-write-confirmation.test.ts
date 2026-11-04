import { test } from "node:test";
import assert from "node:assert/strict";
import { withStockHold } from "@/lib/stock";
import { parseProduct } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

// Since 2 November 2026 (513 [PF1], unit 3 review) a unit is held in two writes: a provisional hold
// under the lock, before any checkout is opened, and the checkout's own after it exists. Each needs an
// explicit acknowledgment; without the first nothing is opened, without the second the checkout is never returned.
// Since 4 November 2026 the provisional hold is written by one script that first checks every lock is still
// this checkout's (lib/stock.ts, STOCK_PENDING): only its reply 1 is a write.
const isPending = (command: unknown[]) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:stock-pending:v1");

test("checkout is not returned without a confirmed stock hold write", async () => {
  const product = parseProduct({ id: "limited123", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const creator = { statsId: "a".repeat(32) } as Store;
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  let pendingReply: unknown;
  let acknowledgment: unknown = 1;
  let opened = 0, writes = 0;
  redis.pipeline = async commands => commands.map(command => {
    if (command[0] === "SET") return "OK";
    if (command[0] === "HGETALL") return [];
    if (command[0] === "GET") return null;
    if (isPending(command)) { writes += 1; return pendingReply; }
    if (command[0] === "EVAL") return 1;
    if (command[0] === "HSET") { writes += 1; return acknowledgment; }
    if (command[0] === "HDEL" || command[0] === "DEL") return 1;
    throw Error("Unexpected synthetic command");
  });
  try {
    for (const unknown of [undefined, null, false, true, 0, "0", "1", "OK", 2, {}, []]) {
      pendingReply = unknown;
      const result: { ok: boolean; reason?: string } = await withStockHold(creator, product, async () => {
        opened += 1;
        return { id: "cs_test_synthetic" };
      });
      assert.deepEqual(result, { ok: false, reason: "busy" });
    }
    assert.equal(opened, 0, "an unconfirmed provisional hold opens no checkout");
    pendingReply = 1;
    for (const known of [0, 1]) {
      acknowledgment = known;
      const result: { ok: boolean; value?: { id: string }; reason?: string } = await withStockHold(creator, product, async held => {
        assert.equal(held, true);
        opened += 1;
        return { id: "cs_test_synthetic" };
      });
      assert.deepEqual(result, { ok: true, value: { id: "cs_test_synthetic" } });
    }
    assert.equal(opened, 2);
    assert.equal(writes, 11 + 2 * 2);
  } finally { redis.pipeline = original; }
});

test("inconsistent hold-write envelopes never return the opened checkout as confirmed", async () => {
  const product = parseProduct({ id: "limited123", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const creator = { statsId: "a".repeat(32) } as Store;
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  let opened = 0;
  const replies: unknown[] = [null, undefined, false, 0, "OK", {}, [], Array(1), [0], [2], ["1"], [1, 1], [1, null], { 0: 1, length: 1 }];
  const answer = (batch: unknown[][]) => batch.map(command => command[0] === "SET" ? "OK" : command[0] === "HGETALL" ? [] : command[0] === "GET" ? null : 1);
  try {
    // The provisional hold's write: refused before any checkout is opened, the provisional hold taken back, the lock let go.
    for (const reply of replies) {
      const commands: unknown[][] = [];
      redis.pipeline = async batch => {
        commands.push(...batch);
        if (batch.length === 1 && isPending(batch[0])) return reply as unknown[];
        return answer(batch);
      };
      const result: { ok: boolean; reason?: string } = await withStockHold(creator, product, async () => {
        opened += 1;
        return { id: "cs_test_synthetic" };
      });
      assert.deepEqual(result, { ok: false, reason: "busy" });
      assert.deepEqual(commands.map(command => command[0]), ["SET", "HGETALL", "GET", "EVAL", "HDEL", "EVAL"]);
    }
    assert.equal(opened, 0);
    // The checkout's own hold: opened, never returned while its write is unconfirmed.
    // A reply for its two commands (the hold, and taking back the provisional one) that is not two known acknowledgments.
    const second: unknown[] = [null, undefined, false, 0, 1, "OK", {}, [], Array(1), Array(2), [1], [1, null], ["OK", 1], [1, 2], [0, 1, 1], { 0: 1, 1: 1, length: 2 }];
    for (const reply of second) {
      const commands: unknown[][] = [];
      redis.pipeline = async batch => {
        commands.push(...batch);
        if (batch.length === 2 && batch[0][0] === "HSET") return reply as unknown[];
        return answer(batch);
      };
      const result: { ok: boolean; reason?: string } = await withStockHold(creator, product, async held => {
        assert.equal(held, true);
        opened += 1;
        return { id: "cs_test_synthetic" };
      });
      assert.deepEqual(result, { ok: false, reason: "busy" });
      assert.deepEqual(commands.map(command => command[0]), ["SET", "HGETALL", "GET", "EVAL", "EVAL", "HSET", "HDEL"]);
    }
  } finally { redis.pipeline = original; }
  assert.equal(opened, 16);
});
