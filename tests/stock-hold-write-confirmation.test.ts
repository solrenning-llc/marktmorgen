import { test } from "node:test";
import assert from "node:assert/strict";
import { withStockHold } from "@/lib/stock";
import { parseProduct } from "@/lib/catalog";
import type { Product, Store } from "@/lib/store";
import { NO_DEAL } from "@/lib/cart-rules";
import { NO_RECOVERY } from "@/lib/recovery-setting";
import { NO_SALE } from "@/lib/store-sale";
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
      // The admission lets the lock go in its own step (STOCK_ADMIT), so no separate release follows it.
      assert.deepEqual(commands.map(command => command[0]), ["SET", "HGETALL", "HSET", "EVAL", "HSET"]);
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

// Claude 4's review of #1732 (C4-2980, 6 November 2026), two holds for nothing. (1) Any error raised before Stripe is asked to
// open the checkout (a false option id, read at lib/store-checkout.ts) held the last unit for the provisional hold's whole term,
// about 37 minutes, so one address could pin units it never paid for. (2) A hold that ran out and was not settled yet made the
// first click "Sold out" (it is counted as used under the lock, where Stripe is never asked) though Stripe says it expired.
const pinnedStore = { statsId: "f".repeat(32), stripeAccountId: "acct_test_pinned01", handle: "pinned", name: "Pinned", email: "pinned@example.com", language: "en", currency: "usd",
  sale: { ...NO_SALE }, cartDeal: { ...NO_DEAL }, recovery: { ...NO_RECOVERY }, hasDiscounts: false, tax: { enabled: false, included: false, ids: false, invoices: false },
  affiliates: { enabled: false, percent: 0, days: 30, rates: {}, payday: 0, hold: 0 }, catalog: { id: null, items: [], head: [], inline: null } } as unknown as Store;
/** Stripe, counted: every request, the checkouts it opens, and the ones it says expired. */
function countingStripe(expiredAt: Set<string>) {
  const counts = { asked: 0, opened: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") throw new Error(`Unexpected request ${url.hostname}`);
    counts.asked += 1;
    if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
      counts.opened += 1;
      const id = `cs_test_pinned${String(counts.opened).padStart(8, "0")}`;
      return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open" }));
    }
    const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
    if (one && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ id: one[1], status: expiredAt.has(one[1]) ? "expired" : "open" }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  }) as typeof fetch;
  return { counts, restore: () => { globalThis.fetch = realFetch; } };
}

test("an error raised before Stripe is asked to open the checkout gives the unit back at once", async () => {
  const { stockLeft, withCartStockHolds } = await import("@/lib/stock");
  const { createCheckout } = await import("@/lib/store-checkout");
  const { TEST_CONSENT } = await import("./digital-consent-fixture");
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  const sized = { ...parseProduct({ id: "sized00001", title: "Sized", summary: "", priceCents: 100, stock: 1, link: "https://example.com/sized" })!,
    options: [{ id: "opt_real01", label: "Large", priceCents: 100, file: null, link: "https://example.com/large" }] } as unknown as Product;
  const stripe = countingStripe(new Set());
  try {
    redis.clear();
    // A false option id, refused by the real checkout before it asks Stripe anything, tried again and again from one address.
    for (let i = 0; i < 3; i += 1) {
      const pinned = await withStockHold(pinnedStore, sized, held => createCheckout(pinnedStore, sized, "https://marktmorgen.com", "opt_false01", { held, digitalConsent: TEST_CONSENT }))
        .then((result) => JSON.stringify(result), (error: Error) => error.message);
      assert.equal(pinned, "This product needs one of its options", `try ${i + 1} is refused for its option, never sold out by the tries before`);
    }
    assert.equal(stripe.counts.asked, 0, "Stripe was never asked");
    assert.equal(await stockLeft(pinnedStore, sized), 1, "every refused try gave its unit back at once");
    // Any other error raised before Stripe is asked, through a cart's checkout too.
    const print = parseProduct({ id: "print00001", title: "Print", summary: "", priceCents: 100, stock: 1 })!;
    await assert.rejects(withCartStockHolds(pinnedStore, [print], async () => { throw new Error("This bundle needs its buyer's choice"); }));
    assert.equal(await stockLeft(pinnedStore, print), 1, "a cart's unit given back too");
    // And a buyer who then picks a real option gets the unit.
    const bought = await withStockHold(pinnedStore, sized, held => createCheckout(pinnedStore, sized, "https://marktmorgen.com", "opt_real01", { held, digitalConsent: TEST_CONSENT }));
    assert.equal(bought.ok, true, "the last unit is still there for a real buyer");
    assert.deepEqual([stripe.counts.opened, await stockLeft(pinnedStore, sized)], [1, 0]);
  } finally {
    stripe.restore();
  }
});

test("a hold that ran out and is not settled yet never makes the first click sold out", async () => {
  const { stockLeft } = await import("@/lib/stock");
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  const stripe = countingStripe(new Set(["cs_test_ranout000001"]));
  const last = parseProduct({ id: "lastone002", title: "Last one", summary: "", priceCents: 100, stock: 1 })!;
  const holds = `nl:stock:${pinnedStore.statsId}:${last.id}`;
  try {
    redis.clear();
    // The last unit's hold ran out; Stripe says its checkout expired.
    await redis.pipeline([["HSET", holds, "cs_test_ranout000001", JSON.stringify({ until: Date.now() - 1000 })]]);
    const first = await withStockHold(pinnedStore, last, async () => ({ id: "cs_test_firstclick01" }));
    assert.deepEqual(first, { ok: true, value: { id: "cs_test_firstclick01" } }, "the first click gets the unit the expired checkout gave back");
    assert.equal(await stockLeft(pinnedStore, last), 0);
    // A hold that ran out but whose checkout Stripe still has open stays counted: sold out, and nothing opened.
    redis.clear();
    await redis.pipeline([["HSET", holds, "cs_test_stillopen001", JSON.stringify({ until: Date.now() - 1000 })]]);
    let opened = 0;
    assert.deepEqual(await withStockHold(pinnedStore, last, async () => { opened += 1; return { id: "cs_test_never0000001" }; }), { ok: false, reason: "soldout" });
    assert.equal(opened, 0);
  } finally {
    stripe.restore();
  }
});
