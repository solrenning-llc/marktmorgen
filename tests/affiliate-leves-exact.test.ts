/**
 * Rule 24 in two smaller reads of lib/affiliates.ts:
 *
 *   - recurringReferrals (read by readBook): a Stripe invoice list in another shape (no data list, has_more not a
 *     boolean, more listed after a row with no id) leaves the recurring commissions unchecked (invoicesChecked false),
 *     never "read to the end, none", which dropped commissions owed while saying the invoices were read;
 *   - removePayout: the HGET/HDEL answered in another shape throws (the creator is asked to try again) and gives no
 *     room back, never "not removed" for a payout that may be gone.
 *
 * Synthetic only: a stand-in for the creator's Stripe account.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readBook, removePayout } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_leves_only";
const STATS = "statsleves01";
let invoicesBody: unknown = { object: "list", data: [], has_more: false };
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/invoices") return answer(invoicesBody);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const store = {
  sid: "sidleves01", handle: "levesshop", name: "Leves Shop", previousHandles: [], releasedHandles: [], statsId: STATS,
  stripeAccountId: "acct_1TestAffLeves01", currency: "usd",
  affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0, recurring: 12 },
} as unknown as Store;

async function seed(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:payouts`, "0123456789ab", JSON.stringify({ id: "0123456789ab", aff: "aaaaaaaaaaaa", cents: 500, currency: "usd", date: "2026-11-01", reference: "cash", at: 1 })],
  ]);
}

for (const [label, body] of [
  ["no data list", { object: "list", has_more: false }],
  ["has_more that is not a boolean", { object: "list", data: [], has_more: "no" }],
  ["more listed after a row with no id", { object: "list", data: [{ status: "paid" }], has_more: true }],
] as [string, unknown][]) {
  test(`invoices listed with ${label}: recurring commissions unchecked`, async () => {
    await seed();
    invoicesBody = body;
    assert.equal((await readBook(store)).invoicesChecked, false);
  });
}

test("invoices read exactly: checked", async () => {
  await seed();
  invoicesBody = { object: "list", data: [], has_more: false };
  assert.equal((await readBook(store)).invoicesChecked, true);
});

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
for (const [label, alter] of [["no reply", () => []], ["the delete as text", (r: unknown[]) => [r[0], "1"]]] as [string, (r: unknown[]) => unknown[]][]) {
  test(`removePayout answered as ${label}: throws, never "not removed"`, async () => {
    await seed();
    redis.pipeline = (async (b: Batch) => {
      const real = await pipeline(b);
      return b.length === 2 && b[0][0] === "HGET" && b[1][0] === "HDEL" ? alter(real) : real;
    }) as typeof redis.pipeline;
    let outcome: string;
    try {
      outcome = String(await removePayout(store, "0123456789ab"));
    } catch {
      outcome = "threw";
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(outcome, "threw");
  });
}
