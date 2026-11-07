/** Real membership reader; synthetic Stripe transport and MemoryRedis only. */
import { membershipNumbers, membershipCacheKey } from "@/lib/membership-numbers";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
process.env.STRIPE_SECRET_KEY = "sk_test_reviewsub_stand_in";
let commands = 0;
const run = redis.run.bind(redis);
redis.run = (command) => { if (++commands > 20000) throw new Error("Review command ceiling"); return run(command); };
let requests = 0, invoices = 0;
let quantity: unknown = 1, unit: unknown = 1500;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (++requests > 20) throw new Error("Review request ceiling");
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/invoices")) { invoices++; return new Response(JSON.stringify({ data: [], has_more: false })); }
  if (!path.endsWith("/subscriptions")) throw new Error("Unexpected review request");
  return new Response(JSON.stringify({ data: [{ id: "sub_review1", status: "active", currency: "usd", start_date: 1790000000,
    metadata: { store: "reviewsub", product: "club" }, items: { data: [{ quantity, price: { unit_amount: unit, recurring: { interval: "month", interval_count: 1 } } }] } }], has_more: false }));
}) as typeof fetch;
async function main() {
  redis.clear();
  const owner = "review-sub-owner@example.test";
  await claimHandle(owner, "reviewsub", "Review", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_ReviewSub1", true);
  const store = (await storeForEmail(owner))!;
  for (const [label, q, u, expected] of [
    ["healthy paid", 1, 1500, 1500], ["zero quantity", 0, 1500, 0],
    ["unknown quantity", "1", 1500, "unknown"], ["unknown price", 1, "1500", "unknown"],
  ] as const) {
    quantity = q; unit = u; invoices = 0;
    await redis.pipeline([["DEL", membershipCacheKey(store.statsId!)]]);
    let result: unknown;
    try { result = (await membershipNumbers(store, true, Date.parse("2026-11-07T12:00:00Z")))?.mrr; }
    catch { result = "unknown"; }
    const [cached] = await redis.pipeline([["GET", membershipCacheKey(store.statsId!)]]);
    is(label + ": value, invoice calls, cache written", [result, invoices, typeof cached === "string"], [expected, expected === "unknown" ? 0 : 1, expected !== "unknown"]);
  }
  console.log(JSON.stringify({ commands, requests, externalRequests: 0 }));
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
