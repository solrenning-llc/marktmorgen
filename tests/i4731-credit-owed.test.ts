/**
 * Issue #4731 (money, MEDIUM): a PayPal sale with a commission left the hand-over list although its affiliate or
 * partner credit failed. #3858 keeps the failed credit owed (`credit:<order>`) on the ordinary hand-over; the path for a
 * buyer who deleted themselves at their own request before the hand-over (lib/paypal-delivery.ts, handOver: credited
 * with nothing that names them) still only logged the failure and handed the order over, so the sale's commission was
 * lost. Now it keeps the credit owed the same way, and the sweep credits it again from the paid record, still naming
 * nobody. Depends on #3858 (claude4/r24-read-affiliate). Synthetic store, affiliate and payments only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { handOverPayPal, sweepPayPal } from "@/lib/paypal-delivery";
import { handOverKey, type Paid } from "@/lib/paypal-sales";
import { ownErasureCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_credit_retry_only";
process.env.RESEND_API_KEY = "re_test_credit_retry_only";

const OWNER = "owner@example.com";
const ACCOUNT = "acct_1CreditRetry01";
const AFF = "aaaaaaaaaaaa";
const PARTNER = "bbbbbbbbbbbb";
const PI = "pi_test_CreditRetry0001";
const NOW = Math.floor(Date.now() / 1000);

const payment: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.hostname === "api.stripe.com" && url.pathname === `/v1/payment_intents/${PI}`) return answer(payment);
  return answer({ error: { message: `no stand-in for ${url.hostname}${url.pathname}` } }, 404);
}) as typeof fetch;

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
/** The affiliate's own record answered in another shape (readAffiliate's HGET), everything else as stored. */
function affiliateReadBroken(statsId: string): void {
  redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "HGET" && b[0][1] === `nl:aff:${statsId}:people` ? [7] : pipeline(b))) as typeof redis.pipeline;
}
const heal = () => { redis.pipeline = pipeline; };
const hget = async (key: string, field: string) => (await pipeline([["HGET", key, field]]))[0];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT);
  const added = await addProduct(OWNER, "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await ensureListId(OWNER);
  const saved = (await storeForEmail(OWNER))!;
  const store: Store = { ...saved, affiliates: { ...NO_AFFILIATES, enabled: true, percent: 20 } };
  const stats = store.statsId!;
  const product = added.product.id;
  await pipeline([
    ["HSET", `nl:aff:${stats}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${stats}:people`, PARTNER, JSON.stringify({ id: PARTNER, email: "pat@example.com", code: "pat", status: "approved", appliedAt: 1, decidedAt: 2, note: "", share: { products: [product], percent: 10 } })],
  ]);

  part("PayPal: a sale whose buyer deleted themselves before the hand-over, its credit failing");
  const order = "5O190127TN3647105";
  const paid: Paid = { store: stats, order, capture: "3C679366HH908705", email: "gone-first@example.com", product, cents: 4900, currency: "usd", at: NOW, handle: store.handle, via: { aff: AFF, rate: 20 } };
  await pipeline([["SET", `nl:ppsell:paid:${order}`, JSON.stringify(paid)]]);
  const listId = saved.listId!;
  await pipeline([ownErasureCommand(listId, paid.email, NOW + 1)]);
  const owed = () => pipeline([["ZSCORE", handOverKey(stats), `credit:${order}`]]).then((r) => r[0] !== null);
  affiliateReadBroken(stats);
  const result = await handOverPayPal(store, paid).catch(() => "threw");
  heal();
  is("the order is handed over as for a deleted buyer, nothing of them written", result, true);
  is("the credit that failed is kept owed, not dropped with the order", await owed(), true);
  await sweepPayPal(store, Date.now() + 10_000);
  is("once the read heals, the sweep credits the affiliate's referral for the sale paid", typeof (await hget(`nl:aff:${stats}:sales`, `paypal:${order}`)), "string");
  is("with no bond naming the person", (await pipeline([["HLEN", `nl:aff:${stats}:bond`]]))[0], 0);
  is("and the credit leaves the list", await owed(), false);

  part("A second sweep credits nothing twice (51LL, LEVE)");
  const tally = async () => (await pipeline([["HLEN", `nl:aff:${stats}:sales`], ["HGETALL", `nl:aff:${stats}:sales`], ["HLEN", `nl:aff:${stats}:shares`], ["HGETALL", `nl:aff:${stats}:shares`]]));
  const once = await tally();
  is("the partner's share for the sale is there after the first sweep", typeof (await hget(`nl:aff:${stats}:shares`, `paypal:${order}:${PARTNER}`)), "string");
  await sweepPayPal(store, Date.now() + 20_000);
  is("after a second sweep the sales and the shares are the same, count and content", await tally(), once);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
