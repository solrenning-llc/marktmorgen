/**
 * #4725: today's sales and revenue in the studio are never the sum of one
 * Stripe page while Stripe says more pages exist. A partial read is shown as
 * unavailable (sales null) and kept so for the same two minutes; a complete
 * read, empty or not, is the real number. Synthetic Stripe stand-in only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { readToday } from "@/lib/stats";

process.env.STRIPE_SECRET_KEY = "sk_test_m3_1417";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
let more = true;
let rows = 1;
let asked = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const now = Math.floor(Date.now() / 1000);
  if (path === "/checkout/sessions") {
    asked += 1;
    const data = Array.from({ length: rows }, (_, i) => ({ id: `cs_test_m3_0000000${i + 1}`, status: "complete", payment_status: "paid", amount_total: 4000, currency: "usd", created: now, metadata: { store: "m3shop", product: "prod000001" } }));
    return answer({ object: "list", has_more: more, data });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function shop() {
  redis.clear();
  await claimHandle("m3@example.com", "m3shop", "M3 Shop", "");
  await ensureStatsId("m3@example.com");
  await setStripeAccount("m3@example.com", "acct_1M3xxxxxxxxxxxx", true);
  return (await storeForEmail("m3@example.com"))!;
}

test("a first page with more pages behind it does not certify today's sales", async () => {
  more = true; rows = 1; asked = 0;
  const store = await shop();
  const today = await readToday(store);
  assert.equal(today.sales, null, `sales should be unavailable, got ${JSON.stringify(today.sales)}`);
  const again = await readToday(store);
  assert.equal(again.sales, null);
  assert.equal(asked, 1, "the unavailable reading is kept for the two minutes, so Stripe is not asked again");
});

test("a complete reading is the real number, and an empty complete one is zero", async () => {
  more = false; rows = 1;
  assert.deepEqual((await readToday(await shop())).sales, { sales: 1, cents: 4000 });
  rows = 0;
  assert.deepEqual((await readToday(await shop())).sales, { sales: 0, cents: 0 });
});
