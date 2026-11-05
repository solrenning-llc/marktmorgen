import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { memberHealth } from "@/lib/member-health";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
const shop = { handle: "j-health-proof", previousHandles: [], releasedHandles: [], stripeAccountId: "acct_test_j_health_proof", statsId: "f".repeat(32), currency: "usd", community: { on: false }, catalog: { items: [] } } as unknown as Store;
const now = 1_800_000_000_000;
const valid = () => ({ id: "sub_JHealthProof", status: "past_due", currency: "usd", start_date: now / 1000 - 8_640_000, cancel_at_period_end: true, customer: { id: "cus_JHealthProof", email: "member@example.com" }, metadata: { store: shop.handle, product: "synthetic-product" }, items: { data: [{ quantity: 1, current_period_end: now / 1000 + 86400, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] } });
let row: unknown;
beforeEach(() => {
  redis.clear(); row = valid();
  process.env.STRIPE_SECRET_KEY = "sk_test_member_health_evidence_only";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com"); assert.equal(url.pathname, "/v1/subscriptions"); assert.equal(init?.method ?? "GET", "GET");
    return Response.json({ object: "list", data: [row], has_more: false });
  };
});
test("a fully confirmed member and amount remain a complete report", async () => {
  const health = (await memberHealth(shop, true, now))!;
  assert.equal(health.complete, true); assert.equal(health.members.length, 1);
  assert.equal(health.atRisk, 2000); assert.equal(health.members[0].monthly, 2000);
});
for (const missing of ["customer", "amount", "currency"] as const) {
  test(`a confirmed page with unknown member ${missing} cannot become a complete zero report`, async () => {
    const value = valid();
    if (missing === "customer") Reflect.deleteProperty(value, "customer");
    if (missing === "amount") Reflect.deleteProperty(value.items.data[0].price, "unit_amount");
    if (missing === "currency") Reflect.deleteProperty(value, "currency");
    row = value;
    let health;
    try { health = await memberHealth(shop, true, now); } catch { return; }
    console.log("UNKNOWN_MEMBER_ROW", missing, JSON.stringify(health), "cacheWritten", typeof redis.run(["GET", `nl:health:${shop.statsId}`]) === "string");
    assert.ok(!health || !health.complete, "one unknown owned member must not certify a complete member count/revenue report");
  });
}
