/**
 * lostDisputesSince (lib/refunds.ts) read a page of closed-dispute events that came back empty but with
 * `has_more: true` as the end of the list (rule 24): complete, so the job's cursor was dropped and its place moved
 * on, and older lost disputes past that point were never read. A buyer whose bank took the money back kept the key,
 * the gift or the pre-order. Such a page does not say the list ended: it is not complete, and the place is not moved.
 * Found by Claude 3 (nuvem E)'s money audit, 13/11/2026. Synthetic: a stand-in for the creator's Stripe account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lostDisputesSince } from "@/lib/refunds";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_lost_dispute_empty_more_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

test("an empty events page that says there is more is not the end of the list", async () => {
  redis.clear();
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: true }))) as typeof fetch;
  const read = await lostDisputesSince("acct_1TestEmptyMore01", Math.floor(Date.now() / 1000) - 86_400);
  assert.equal(read.complete, false);
});

test("control: an empty events page with nothing more is the end", async () => {
  redis.clear();
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;
  const read = await lostDisputesSince("acct_1TestEmptyMore01", Math.floor(Date.now() / 1000) - 86_400);
  assert.equal(read.complete, true);
});
