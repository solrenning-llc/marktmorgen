import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { memberHealth } from "@/lib/member-health";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const shop = { handle: "j-quantity-proof", previousHandles: [], releasedHandles: [], stripeAccountId: "acct_test_j_quantity", statsId: "e".repeat(32), currency: "usd", community: { on: false }, catalog: { items: [] } } as unknown as Store;
const now = 1_800_000_000_000;
const valid = () => ({ id: "sub_JQuantity", status: "past_due", currency: "usd", start_date: now / 1000 - 8_640_000, cancel_at_period_end: true, customer: { id: "cus_JQuantity", email: "member@example.test" }, metadata: { store: shop.handle, product: "synthetic-product" }, items: { data: [{ quantity: 3 as unknown, current_period_end: now / 1000 + 86400, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] } });
let row = valid();
const originalFetch = globalThis.fetch;
beforeEach(() => {
  redis.clear(); row = valid();
  process.env.STRIPE_SECRET_KEY = "sk_test_member_health_evidence_only";
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com"); assert.equal(url.pathname, "/v1/subscriptions");
    return Response.json({ object: "list", data: [row], has_more: false });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });
test("confirmed quantity three contributes its exact monthly amount", async () => {
  const health = (await memberHealth(shop, true, now))!;
  assert.deepEqual([health.complete, health.members[0].monthly, health.atRisk], [true, 6000, 6000]);
});
for (const quantity of [undefined, null]) test(`unknown quantity ${String(quantity)} cannot silently become one`, async () => {
  row.items.data[0].quantity = quantity;
  let refused = false;
  try { await memberHealth(shop, true, now); } catch { refused = true; }
  assert.deepEqual({ refused, cache: redis.run(["GET", `nl:health:${shop.statsId}`]) }, { refused: true, cache: null }, "unknown quantity cannot certify complete:true with a fabricated 2000 monthly amount");
});
