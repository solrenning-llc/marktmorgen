/**
 * #5285, row of #3862 (Codex X6's LOW, comment 6867519464): the reviews' refunds pass (lib/review-proof.ts,
 * markRefundedReviews) asks which refunds an earlier pass already took with one SISMEMBER per refund, and read each
 * answer as `Number(seen[i]) !== 1`, so a reply cut short or of another shape read as "not taken yet": the refund was
 * taken again and the place could move on a reply that proved nothing. Each answer must now be exactly 0 or 1, one per
 * refund; anything else is unknown: nothing is taken as seen and the place stays. Synthetic store and Stripe only.
 */
import { markRefundedReviews } from "@/lib/review-proof";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_refund_seen_only";
const OWNER = "refund-seen-exact@example.com";
const before = Math.floor(Date.now() / 1000) - 3 * 86_400;
const newer = before + 86_400;
const refund = { id: "re_SeenExact00001", object: "refund", status: "succeeded", created: newer, payment_intent: "pi_SeenExact00001", charge: { id: "ch_SeenExact1", object: "charge", refunded: true, amount: 1000, amount_refunded: 1000, disputed: false } };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.stripe.com" || (init?.method ?? "GET") !== "GET") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/refunds") return Response.json({ object: "list", data: [refund], has_more: false });
  if (path === "/events") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({ error: { message: `no stand-in for ${path}` } }, { status: 404 });
}) as typeof fetch;

type Batch = (string | number)[][];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "refundseenexact", "Refund seen exact", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1SeenExact0001", true);
  const store = (await storeForEmail(OWNER))!;
  const seenKey = `nl:rev:refunds:seen:${store.statsId}`;
  const anchorKey = `nl:rev:refunds:since:${store.statsId}`;

  async function pass(answer: unknown[] | undefined): Promise<{ seen: number; anchor: number }> {
    redis.run(["SET", anchorKey, String(before)]);
    redis.run(["DEL", seenKey]);
    const original = redis.pipeline.bind(redis);
    redis.pipeline = (async (batch: Batch) =>
      answer !== undefined && batch.length > 0 && batch.every((c) => c[0] === "SISMEMBER" && c[1] === seenKey) ? answer : original(batch)) as typeof redis.pipeline;
    try {
      await markRefundedReviews(store, Date.now() + 30_000).catch(() => 0);
    } finally {
      redis.pipeline = original;
    }
    return { seen: Number(redis.run(["SISMEMBER", seenKey, refund.id])), anchor: Number(redis.run(["GET", anchorKey])) };
  }

  part("The real answer: the refund is taken as seen and the place moves, as before");
  is("[0]: taken, place moved", await pass(undefined), { seen: 1, anchor: newer });

  part("An answer that is not exactly 0 or 1, one per refund, is unknown: nothing taken, the place stays");
  for (const [what, answer] of [["[null]", [null]], ['["x"]', ["x"]], ["[2]", [2]], ["[] (cut short)", []], ["[0, 0] (one too many)", [0, 0]]] as [string, unknown[]][]) {
    is(`${what}: not taken, place stays`, await pass(answer), { seen: 0, anchor: before });
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
