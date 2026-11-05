import { test } from "node:test";
import assert from "node:assert/strict";
import { withStockHold } from "@/lib/stock";
import { parseProduct } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

// Since 2 November 2026 (513 [PF1], unit 3 review) a unit is held in two writes: a provisional hold
// under the lock, before any checkout is opened, and the checkout's own after it exists. Each needs an
// explicit acknowledgment; without the first nothing is opened, without the second the checkout is never returned.
test("checkout is not returned without a confirmed stock hold write", async () => {
  const product = parseProduct({ id: "limited123", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const creator = { statsId: "a".repeat(32) } as Store;
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  let acknowledgment: unknown;
  let opened = 0, writes = 0;
  redis.pipeline = async commands => commands.map(command => {
    if (command[0] === "SET") return "OK";
    if (command[0] === "HGETALL") return [];
    if (command[0] === "EVAL") return 1;
    if (command[0] === "HSET") { writes += 1; return acknowledgment; }
    if (command[0] === "HDEL" || command[0] === "DEL") return 1;
    throw Error("Unexpected synthetic command");
  });
  try {
    for (const unknown of [undefined, null, false, true, "0", "1", "OK", 2, {}, []]) {
      acknowledgment = unknown;
      const result: { ok: boolean; reason?: string } = await withStockHold(creator, product, async () => {
        opened += 1;
        return { id: "cs_test_synthetic" };
      });
      assert.deepEqual(result, { ok: false, reason: "busy" });
    }
    assert.equal(opened, 0, "an unconfirmed provisional hold opens no checkout");
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
    assert.equal(writes, 10 + 2 * 2);
  } finally { redis.pipeline = original; }
});

test("inconsistent hold-write envelopes never return the opened checkout as confirmed", async () => {
  const product = parseProduct({ id: "limited123", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const creator = { statsId: "a".repeat(32) } as Store;
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  let opened = 0;
  const replies: unknown[] = [null, undefined, false, 0, 1, "OK", {}, [], Array(1), [1, null], [0, 1], { 0: 1, length: 1 }];
  const answer = (batch: unknown[][]) => batch.map(command => command[0] === "SET" ? "OK" : command[0] === "HGETALL" ? [] : 1);
  try {
    // The provisional hold's write: refused before any checkout is opened, the provisional hold taken back, the lock let go.
    for (const reply of replies) {
      const commands: unknown[][] = [];
      redis.pipeline = async batch => {
        commands.push(...batch);
        if (batch.length === 1 && batch[0][0] === "HSET") return reply as unknown[];
        return answer(batch);
      };
      const result: { ok: boolean; reason?: string } = await withStockHold(creator, product, async () => {
        opened += 1;
        return { id: "cs_test_synthetic" };
      });
      assert.deepEqual(result, { ok: false, reason: "busy" });
      // Since Codex G2's review (5 November 2026) the lock is checked with the provisional hold in one script (STOCK_ADMIT), after the write.
      assert.deepEqual(commands.map(command => command[0]), ["SET", "HGETALL", "HSET", "HDEL", "EVAL"]);
    }
    assert.equal(opened, 0);
    // The checkout's own hold: opened, never returned while its write is unconfirmed, and the provisional one never let go
    // before it is (STOCK_BIND is not even asked). A reply for its one command that is not one known acknowledgment.
    const second: unknown[] = [null, undefined, false, 0, 1, "OK", {}, [], Array(1), [null], ["OK"], [2], [1, 1], { 0: 1, length: 1 }];
    for (const reply of second) {
      const commands: unknown[][] = [];
      redis.pipeline = async batch => {
        commands.push(...batch);
        if (batch.length === 1 && batch[0][0] === "HSET" && batch[0][2] === "cs_test_synthetic") return reply as unknown[];
        return answer(batch);
      };
      const result: { ok: boolean; reason?: string } = await withStockHold(creator, product, async held => {
        assert.equal(held, true);
        opened += 1;
        return { id: "cs_test_synthetic" };
      });
      assert.deepEqual(result, { ok: false, reason: "busy" });
      assert.deepEqual(commands.map(command => command[0]), ["SET", "HGETALL", "HSET", "EVAL", "EVAL", "HSET"]);
    }
    // The hand-over itself (STOCK_BIND) answered in any shape but 1: never returned.
    for (const reply of [[0], [-1], [null], [], Array(1), ["1"], [true], null, { 0: 1, length: 1 }]) {
      redis.pipeline = async batch => (batch.length === 1 && batch[0][0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:stock-bind:v1\n") ? reply as unknown[] : answer(batch));
      const result: { ok: boolean; reason?: string } = await withStockHold(creator, product, async () => {
        opened += 1;
        return { id: "cs_test_synthetic" };
      });
      assert.deepEqual(result, { ok: false, reason: "busy" });
    }
  } finally { redis.pipeline = original; }
  assert.equal(opened, 14 + 9);
});

// Codex G2's three races (review of #1730, 5 November 2026; tests/review-g2-cart-stock-races.test.ts) for a product bought on
// its own, which is a cart of one since unit 3b: a lock that ran out before the provisional hold was written, an opening whose
// answer was lost, and a hand-over whose writes were answered in part, with Stripe unable to close the checkout.
test("a product bought on its own never gets two checkouts for its last unit", async () => {
  const { onAccount } = await import("@/lib/stripe-account");
  const { stockLeft } = await import("@/lib/stock");
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  const product = parseProduct({ id: "lastone001", title: "Last one", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const creator = { statsId: "d".repeat(32), stripeAccountId: "acct_test_lastone01" } as Store;
  const active = new Set<string>();
  let loseReply = false, refuseExpire = false, sequence = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
      const id = `cs_test_lastone${String(++sequence).padStart(8, "0")}`;
      active.add(id);
      if (loseReply) { loseReply = false; throw new TypeError("Connection lost after checkout creation"); }
      return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }));
    }
    const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
    if (expire && init?.method === "POST") {
      if (refuseExpire) throw new TypeError("Expiration unavailable");
      active.delete(expire[1]);
      return new Response(JSON.stringify({ id: expire[1], status: "expired" }));
    }
    throw new Error(`Unexpected request ${init?.method} ${url.pathname}`);
  }) as typeof fetch;
  const open = async () => {
    const made = await onAccount("POST", creator.stripeAccountId!, "/checkout/sessions", new URLSearchParams({ mode: "payment" }));
    return { id: String(made.id) };
  };
  const reserve = () => withStockHold(creator, product, open);
  const reset = () => { redis.clear(); active.clear(); loseReply = false; refuseExpire = false; };
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  try {
    reset();
    assert.equal((await reserve()).ok, true);
    assert.equal((await reserve()).ok, false, "the ordinary second attempt is refused");
    assert.equal(active.size, 1);

    // 1. Paused right before the provisional write, past the lock's whole term: another buyer takes the lock and the unit.
    reset();
    let arrive!: () => void, resume!: () => void, paused = false;
    const arrived = new Promise<void>(r => { arrive = r; }), resumed = new Promise<void>(r => { resume = r; });
    redis.pipeline = async commands => {
      if (!paused && commands.some(c => c[0] === "HSET" && String(c[2]).startsWith("p_"))) { paused = true; arrive(); await resumed; }
      return original(commands);
    };
    const first = reserve();
    await arrived;
    redis.advance(10 * 60 * 1000);
    const second = await reserve();
    resume();
    const late = await first;
    redis.pipeline = original;
    assert.equal(second.ok, true, "the buyer who took the expired lock gets the unit");
    assert.equal(late.ok, false, "the stale holder opens nothing");
    assert.equal(active.size, 1);

    // 2. Stripe made the checkout but its answer was lost: the unit stays held.
    reset();
    loseReply = true;
    await assert.rejects(reserve());
    assert.equal(active.size, 1);
    assert.equal(await stockLeft(creator, product), 0);
    assert.equal((await reserve()).ok, false);
    assert.equal(active.size, 1);

    // 3. The checkout's own hold answered in part, and Stripe cannot close it: the unit stays held.
    reset();
    refuseExpire = true;
    redis.pipeline = async commands => {
      if (commands.some(c => c[0] === "HSET" && String(c[2]).startsWith("cs_test_"))) {
        for (const command of commands) if (command[0] === "HDEL") await original([command]);
        return commands.map(c => c[0] === "HSET" ? { error: "write refused" } : 1) as never;
      }
      return original(commands);
    };
    assert.deepEqual(await reserve(), { ok: false, reason: "busy" });
    redis.pipeline = original;
    assert.equal(active.size, 1);
    assert.equal(await stockLeft(creator, product), 0);
    assert.equal((await reserve()).ok, false);
    assert.equal(active.size, 1);
  } finally {
    redis.pipeline = original;
    globalThis.fetch = realFetch;
  }
});
