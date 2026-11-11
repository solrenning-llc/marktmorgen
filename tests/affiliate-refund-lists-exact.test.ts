/**
 * Rule 24 in the affiliate book's refunds and chargebacks (lib/affiliates.ts, refundsSince and disputesSince, read by
 * readBook): a Stripe list answered in another shape (no `data` list, `has_more` not a boolean, a last row with no id
 * while more are listed) or a refund/dispute that takes money with no readable amount leaves the book's refunds
 * unchecked (refundsChecked false, so no payout is made on it), never "read to the end, nothing refunded", which kept
 * the commission on a refunded or charged-back sale payable.
 *
 * Synthetic only: a stand-in for the creator's Stripe account.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_refund_lists_only";
const STATS = "statsrefl01";
let refundsBody: unknown = { object: "list", data: [], has_more: false };
let disputesBody: unknown = { object: "list", data: [], has_more: false };
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/refunds") return answer(refundsBody);
  if (path === "/disputes") return answer(disputesBody);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const store = {
  sid: "sidrefl01", handle: "reflshop", name: "Refl Shop", previousHandles: [], releasedHandles: [], statsId: STATS,
  stripeAccountId: "acct_1TestRefundLists", currency: "usd",
  affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
} as unknown as Store;

async function seed(): Promise<void> {
  redis.clear();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_refl1", aff: "aaaaaaaaaaaa", at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })],
  ]);
}

const LISTS: [string, unknown][] = [
  ["no data list", { object: "list", has_more: false }],
  ["data that is not a list", { object: "list", data: {}, has_more: false }],
  ["has_more that is not a boolean", { object: "list", data: [], has_more: "no" }],
  ["more listed after a row with no id", { object: "list", data: [{ status: "succeeded" }], has_more: true }],
];

for (const [label, body] of LISTS) {
  test(`refunds listed with ${label}: the book's refunds are unchecked`, async () => {
    await seed();
    refundsBody = body;
    disputesBody = { object: "list", data: [], has_more: false };
    assert.equal((await readBook(store)).refundsChecked, false);
  });
  test(`disputes listed with ${label}: the book's refunds are unchecked`, async () => {
    await seed();
    refundsBody = { object: "list", data: [], has_more: false };
    disputesBody = body;
    assert.equal((await readBook(store)).refundsChecked, false);
  });
}

test("a refund that succeeded with no readable amount: unchecked, never a refund of nothing", async () => {
  await seed();
  refundsBody = { object: "list", data: [{ id: "re_1", status: "succeeded", payment_intent: "pi_refl1", amount: "10000" }], has_more: false };
  disputesBody = { object: "list", data: [], has_more: false };
  assert.equal((await readBook(store)).refundsChecked, false);
});

test("a dispute the bank holds with no readable amount: unchecked", async () => {
  await seed();
  refundsBody = { object: "list", data: [], has_more: false };
  disputesBody = { object: "list", data: [{ id: "du_1", status: "lost", payment_intent: "pi_refl1", amount: null }], has_more: false };
  assert.equal((await readBook(store)).refundsChecked, false);
});

test("lists read exactly: checked, and a full refund takes the commission", async () => {
  await seed();
  refundsBody = { object: "list", data: [{ id: "re_1", status: "succeeded", payment_intent: "pi_refl1", amount: 10000 }], has_more: false };
  disputesBody = { object: "list", data: [], has_more: false };
  const book = await readBook(store);
  assert.equal(book.refundsChecked, true);
  assert.equal(book.rows[0]?.payable ?? 0, 0);
});
