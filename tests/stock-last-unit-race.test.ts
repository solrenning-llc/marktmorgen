/**
 * Buyers pressing buy for a limited product's last unit at the same instant get one checkout between them
 * (Claude 7's race hunt): the hold is taken under the product's lock and confirmed in one script (lib/stock.ts,
 * STOCK_ADMIT and STOCK_BIND), so no read-then-write window lets two of them through. Five buyers at once, alone and
 * in carts; Stripe and Redis are stand-ins (MemoryRedis). This holds on main: it guards the behavior, it fixes nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { withCartStockHolds, withStockHold, stockLeft } from "@/lib/stock";
import { parseProduct } from "@/lib/catalog";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const shop = { statsId: "d".repeat(32), handle: "prints", name: "Prints", email: "prints@example.com", language: "en", currency: "usd", stripeAccountId: "acct_test_lastunit1" } as unknown as Store;
const product = parseProduct({ id: "print1", title: "Print", summary: "", priceCents: 2000, stock: 1, link: "https://example.com/print" }) as Listing;
const other = parseProduct({ id: "guide1", title: "Guide", summary: "", priceCents: 900, link: "https://example.com/guide" }) as Listing;
process.env.STRIPE_SECRET_KEY = "sk_test_only";

let opened = 0;
globalThis.fetch = (async () => {
  throw new Error("no Stripe request is expected: the checkout is opened by the stand-in below");
}) as typeof fetch;
const open = async () => {
  // A checkout takes a moment to open at Stripe, so the others are all waiting meanwhile.
  await new Promise((resolve) => setTimeout(resolve, 5));
  opened += 1;
  return { id: `cs_test_lastunit${String(opened).padStart(8, "0")}` };
};

test("five buyers at once for the last unit: one checkout opens, the others are told it is sold out or to press again", async () => {
  redis.clear();
  opened = 0;
  const results = await Promise.all(Array.from({ length: 5 }, () => withStockHold(shop, product, open)));
  assert.equal(results.filter((r) => r.ok).length, 1, "one checkout holds the unit");
  assert.ok(results.every((r) => r.ok || r.reason === "soldout" || r.reason === "busy"));
  assert.equal(opened, 1, "one checkout opened");
  assert.equal(await stockLeft(shop, product), 0);
});

test("five carts at once holding the last unit: one opens", async () => {
  redis.clear();
  opened = 0;
  const results = await Promise.all(Array.from({ length: 5 }, () => withCartStockHolds(shop, [product, other], open)));
  assert.equal(results.filter((r) => r.ok).length, 1, "one cart holds the unit");
  assert.equal(opened, 1, "one checkout opened");
  assert.equal(await stockLeft(shop, product), 0);
});
