/**
 * Rule 24 in the refund walk that revokes refunded gifts (lib/gifts.ts, revokeRefundedGifts): the walk's place (the
 * anchor) read as something that is not a time stops the run and asks nothing of Stripe, never "seven days ago"
 * written over the real place at the end of the pass, which skipped the refunds in between.
 *
 * Synthetic only: a stand-in for the creator's Stripe account with no refunds.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { revokeRefundedGifts } from "@/lib/gifts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_gift_refund_anchor_only";
let asked = 0;
globalThis.fetch = (async () => {
  asked += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const SID = "0123456789abcdef0123456789abcd07";
const store = { statsId: SID, stripeAccountId: "acct_1GiftRefundAnchor", handle: "giftshop", previousHandles: [], releasedHandles: [] } as unknown as Store;

for (const [label, value] of [["text that is not a time", "soon"], ["a time with letters", "17x"]] as [string, string][]) {
  test(`the place read as ${label}: kept, and Stripe not asked`, async () => {
    redis.clear();
    await redis.pipeline([["SET", `nl:gift:${SID}:any`, "1"], ["SET", `nl:gift:${SID}:refunds`, value]]);
    asked = 0;
    await revokeRefundedGifts(store, Date.now() + 10_000, async () => {}).catch(() => null);
    assert.deepEqual(await redis.pipeline([["GET", `nl:gift:${SID}:refunds`]]), [value], "the place is not written over");
    assert.equal(asked, 0, "nothing asked of Stripe on an unread place");
  });
}

test("a place read exactly is used", async () => {
  redis.clear();
  const older = String(Math.floor(Date.now() / 1000) - 20 * 86_400);
  await redis.pipeline([["SET", `nl:gift:${SID}:any`, "1"], ["SET", `nl:gift:${SID}:refunds`, older]]);
  await revokeRefundedGifts(store, Date.now() + 10_000, async () => {});
  const [after] = await redis.pipeline([["GET", `nl:gift:${SID}:refunds`]]);
  assert.ok(Number(after) >= Number(older));
});
