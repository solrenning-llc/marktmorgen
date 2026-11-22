/**
 * The reviews' refund pass (lib/review-proof.ts markRefundedReviews) asks which refunds of a page an earlier pass
 * already took with one ZMSCORE a page (a sorted set scored by the row's time, trimmed each run), never one SISMEMBER a row (Claude 1 c1-revcusto on #5092, 22/11/2026: the
 * pass had no cost line, and a page of 100 refunds re-read every run was 100 commands). Synthetic store, reviews and
 * refunds; Stripe answered by a stand-in; the Redis stand-in's pipeline counted.
 */
import { markRefundedReviews } from "@/lib/review-proof";
import { saveReview } from "@/lib/reviews";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

process.env.STRIPE_SECRET_KEY = "sk_test_review_refund_sweep_seen";
const OWNER = "sweep-seen@example.com";
const ACCOUNT = "acct_1SweepSeen01";
const NOW = Math.floor(Date.now() / 1000);
type Refund = { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Record<string, unknown> };
const refunds: Refund[] = [];
const listOf = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ error: "nothing leaves this test" }), { status: 500 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/refunds") {
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    return listOf(refunds.filter((r) => r.created >= since).sort((a, b) => b.created - a.created));
  }
  return listOf([]);
}) as typeof fetch;

type Batch = (string | number)[][];
const sent: Batch = [];
const healthy = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Batch) => {
  sent.push(...batch);
  return healthy(batch);
}) as typeof redis.pipeline;

function refundOf(pi: string, n: number): Refund {
  const charge = { object: "charge", id: `ch_seen${String(n).padStart(6, "0")}`, amount: 4900, amount_refunded: 4900, refunded: true, disputed: false };
  return { id: `re_seen${String(n).padStart(6, "0")}`, object: "refund", created: NOW - 7_200, status: "succeeded", amount: 4900, payment_intent: pi, charge };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "sweepseen", "Sweep Seen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const products: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const made = await addProduct(OWNER, `Guide ${i + 1}`, "", "49", null);
    if (!made.ok) throw new Error("no product");
    products.push(made.product.id);
  }
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  // Three payments, each reviewed on one product; all three given back in full.
  for (let i = 0; i < 3; i += 1) {
    const pi = `pi_seen${String(i).padStart(12, "0")}`;
    const saved = await saveReview(statsId, { productId: products[i], email: `buyer${i}@example.com`, reference: `cs_test_seen${i}000000000`, pi, rating: 5, text: "Clear and kind.", name: `Buyer ${i}`, paidAt: NOW - 86_400 }, ROOM, (NOW - 80_000) * 1000);
    if (saved.state !== "created") throw new Error(`review ${i} not saved: ${saved.state}`);
    refunds.push(refundOf(pi, i));
  }

  part("A page of refunds is asked about with one command, not one a row");
  sent.length = 0;
  const marked = await markRefundedReviews(store, Date.now() + 60_000);
  const seenKey = `nl:rev:refunds:seen:${statsId}`;
  const smismember = sent.filter((c) => c[0] === "ZMSCORE" && c[1] === seenKey);
  const sismember = sent.filter((c) => c[0] === "SISMEMBER" && c[1] === seenKey);
  is("the three refunded reviews are marked", marked, 3);
  // The rows' three ids, then their three payments' ids (a payment marked once, whatever its parts: 9th audit on #5100).
  is("one ZMSCORE for the page, with its three ids and their payments' ids", [smismember.length, smismember[0]?.length], [1, 8]);
  is("and no SISMEMBER a row", sismember.length, 0);

  part("A pass with nothing new asks once more, with one command");
  sent.length = 0;
  const again = await markRefundedReviews(store, Date.now() + 60_000);
  is("nothing marked again", again, 0);
  is("the rows still on the page asked about with one command", sent.filter((c) => c[0] === "ZMSCORE" && c[1] === seenKey).length <= 1, true);
  is("and still no SISMEMBER a row", sent.filter((c) => c[0] === "SISMEMBER" && c[1] === seenKey).length, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
