/**
 * Rule 24 in the refund walk that ends refunded calls' meetings (lib/call-meetings.ts, refundsOf via syncMeetings):
 *
 *   - the walk's place (the anchor, GET) read in another shape stops the store's walk with the place as it was, never
 *     "first run" (a one-day window) written over the real, older place, which skipped the refunds in between;
 *   - the checkout a refunded payment belongs to, listed by Stripe in another shape, leaves the refund unread (not
 *     added to the seen set), never read as "no call", so the next run ends the refunded call's meeting.
 *
 * Synthetic only: a minimal stand-in for the creator's Stripe account.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_call_refund_anchor_only";
const NOW = Math.floor(Date.now() / 1000);
const CALLS = "e".repeat(16);
const anchorKey = `nl:meet:rf:${CALLS}:since`;
const seenKey = `nl:meet:rf:${CALLS}:seen`;
let refunds: Record<string, unknown>[] = [];
let sessionsData: unknown = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: false });
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessionsData, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const store = { handle: "callshop", statsId: "0123456789abcdef0123456789abcd06", callsId: CALLS, stripeAccountId: "acct_1CallRefundAnchor", previousHandles: [], releasedHandles: [] } as unknown as Store;
const find = async (handle: string) => (handle === "callshop" ? store : null);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function seed(): Promise<void> {
  redis.clear();
  await pipeline([["ZADD", MEET_STORES, String(Date.now() + 86_400_000), `${CALLS}|callshop`]]);
}

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["text that is not a time", ["soon"]]] as [string, unknown[]][]) {
  test(`the walk's place read as ${label}: the older place is kept`, async () => {
    await seed();
    refunds = [];
    const older = String(NOW - 20 * 86_400);
    await pipeline([["SET", anchorKey, older, "EX", 86_400 * 60]]);
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "GET" && b[0][1] === anchorKey ? reply : pipeline(b))) as typeof redis.pipeline;
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      redis.pipeline = pipeline;
    }
    assert.deepEqual(await pipeline([["GET", anchorKey]]), [older]);
  });
}

for (const [label, data] of [["a number", 7], ["an object", {}], ["text", "x"]] as [string, unknown][]) {
  test(`the refunded payment's checkouts listed as ${label}: the refund is not taken as read`, async () => {
    await seed();
    refunds = [{ id: "re_CallRefund0001", object: "refund", created: NOW - 60, status: "succeeded", payment_intent: "pi_CallRefund0001", charge: { object: "charge", amount: 5000, amount_refunded: 5000, refunded: true } }];
    sessionsData = data;
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      sessionsData = [];
    }
    assert.deepEqual(await pipeline([["SISMEMBER", seenKey, "re_CallRefund0001"]]), [0]);
  });
}
