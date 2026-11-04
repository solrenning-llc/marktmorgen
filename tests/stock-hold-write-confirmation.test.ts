import { test } from "node:test";
import assert from "node:assert/strict";
import { stockLeft, withStockHold } from "@/lib/stock";
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

// A provisional hold whose write throws may still have landed (its reply was lost): it is taken back, as an
// unconfirmed one is, so the unit is not counted as used for the provisional hold's whole life (3 November 2026).
test("a provisional hold whose write throws is taken back, and nothing is opened", async () => {
  const product = parseProduct({ id: "thrown001", title: "Limited", summary: "", priceCents: 100, stock: 2 });
  assert.ok(product);
  const creator = { statsId: "t".repeat(32) } as Store;
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  let opened = 0;
  redis.pipeline = async commands => {
    // The provisional hold's write (since 4 November 2026 one script that checks the locks, STOCK_PENDING).
    if (commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:stock-pending:v1")) {
      await original(commands);
      throw new Error("connection reset after the write");
    }
    return original(commands);
  };
  let result: unknown;
  try {
    result = await withStockHold(creator, product, async () => {
      opened += 1;
      return { id: "cs_test_thrownhold01" };
    });
  } finally { redis.pipeline = original; }
  assert.deepEqual(result, { ok: false, reason: "busy" });
  assert.equal(opened, 0);
  const [hash, lock] = await redis.pipeline([["HGETALL", `nl:stock:${creator.statsId}:thrown001`], ["GET", `nl:stock:lock:${creator.statsId}:thrown001`]]);
  assert.deepEqual(hash, [], "the provisional hold that landed is taken back");
  assert.equal(lock, null, "the lock is let go");
  assert.equal(await stockLeft(creator, product), 2);
});

// The checkout's own hold replaces the provisional one in one pipeline (HSET, then HDEL). Its HDEL must answer 1: a 0
// means the provisional hold was already gone, so another checkout may have counted the unit free in between.
test("a checkout whose provisional hold was already gone is closed, and never shares the last unit", async () => {
  const product = parseProduct({ id: "gone0001", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const creator = { statsId: "g".repeat(32), stripeAccountId: "acct_test_gonehold01" } as Store;
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_only";
  const expired: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
    if (url.hostname === "api.stripe.com" && expire && (init?.method ?? "GET") === "POST") {
      expired.push(expire[1]);
      return new Response(JSON.stringify({ id: expire[1], status: "expired" }));
    }
    return new Response(JSON.stringify({ id: "x", status: "open" }));
  }) as typeof fetch;
  const key = `nl:stock:${creator.statsId}:gone0001`;
  let other = null as { ok: boolean } | null;
  let first: { ok: boolean; reason?: string };
  try {
    first = await withStockHold(creator, product, async () => {
      // The provisional hold is lost while Stripe opens this checkout, and another buyer counts the unit free meanwhile.
      const [raw] = await redis.pipeline([["HGETALL", key]]);
      const fields = (raw as string[]).filter((_, i) => i % 2 === 0);
      await redis.pipeline(fields.map(field => ["HDEL", key, field]));
      other = await withStockHold(creator, product, async () => ({ id: "cs_test_gonehold00002" }));
      return { id: "cs_test_gonehold00001" };
    });
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(first, { ok: false, reason: "busy" }, "the first checkout is not returned");
  assert.equal(other?.ok, true, "the other buyer keeps the unit");
  assert.deepEqual(expired, ["cs_test_gonehold00001"], "the first checkout is closed at Stripe");
  const [raw] = await redis.pipeline([["HGETALL", key]]);
  assert.deepEqual((raw as string[]).filter((_, i) => i % 2 === 0), ["cs_test_gonehold00002"], "only the other checkout holds the unit");
  assert.equal(await stockLeft(creator, product), 0);
});
