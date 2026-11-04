import { test } from "node:test";
import assert from "node:assert/strict";
import { stockLeft } from "@/lib/stock";
import { parseProduct } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

test("an expired hold is released only after an explicit expired checkout response", async () => {
  const product = parseProduct({ id: "limited123", title: "Limited", summary: "", priceCents: 100, stock: 1 });
  assert.ok(product);
  const creator = { statsId: "a".repeat(32), stripeAccountId: "acct_synthetic_stock" } as Store;
  const originalPipeline: typeof redis.pipeline = redis.pipeline.bind(redis);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.STRIPE_SECRET_KEY;
  let response: unknown = {};
  let deletes = 0, reads = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_local_only_synthetic";
  redis.pipeline = async commands => commands.map(command => {
    if (command[0] === "HGETALL") return ["cs_test_synthetic", '{"until":1}'];
    if (command[0] === "GET") return null;
    // A paid one is counted sold once (lib/stock.ts, STOCK_SOLD, since 4 November 2026); "asked" is kept beside an open one.
    if (command[0] === "EVAL") return 1;
    // Only a hold let go counts; when Stripe was asked about one (its "a:" field, since 3 November 2026) is bookkeeping.
    if (command[0] === "HDEL") { if (!String(command[2]).startsWith("a:")) deletes += 1; return 1; }
    if (command[0] === "HSET") return 1;
    throw Error("Unexpected synthetic command");
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/v1/checkout/sessions/cs_test_synthetic");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("Stripe-Account"), creator.stripeAccountId);
    reads += 1;
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    for (const unknown of [{}, null, [], { status: "open" }, { status: "complete", payment_status: "unpaid" }, { status: "future_status" }]) {
      response = unknown;
      assert.equal(await stockLeft(creator, product, 2), 0);
      assert.equal(deletes, 0);
    }
    response = { status: "complete", payment_status: "paid" };
    assert.equal(await stockLeft(creator, product, 2), 0);
    assert.equal(deletes, 0);
    response = { status: "expired", payment_status: "unpaid" };
    assert.equal(await stockLeft(creator, product, 2), 1);
    assert.equal(deletes, 1);
    assert.equal(reads, 8);
  } finally {
    redis.pipeline = originalPipeline;
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
  }
});
