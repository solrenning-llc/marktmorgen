/**
 * #3858 money MEDIUM (Claude 3 cloud M, confirmed by Codex L): readAffiliate now throws on an unknown reply (rule 24),
 * and the two credits that read it after a sale was taken only logged the throw. A PayPal sale (creditPayPalSale,
 * lib/paypal-delivery.ts) lost its affiliate's referral and its partners' shares, and a paid offer after paying
 * (noteCharge, lib/upsell.ts) lost its referral, for good: unknown became zero on the other side.
 *
 * Now the partners' shares are written before the affiliate is read, and a credit that fails is kept in the list the
 * sweep already reads (PayPal: `credit:<order>` in the hand-over list; offers: `<member>|credit` in the job's list)
 * and credited again from the paid record, or from Stripe's own payment, never by handing over, charging or emailing
 * again. Synthetic store, affiliate and payments only; Stripe, PayPal and email are stand-ins.
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { handOverPayPal, sweepPayPal } from "@/lib/paypal-delivery";
import { handOverKey, type Paid } from "@/lib/paypal-sales";
import { settlePendingOffers, settleUpsells } from "@/lib/upsell";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_credit_retry_only";
process.env.RESEND_API_KEY = "re_test_credit_retry_only";

const OWNER = "owner@example.com";
const ACCOUNT = "acct_1CreditRetry01";
const AFF = "aaaaaaaaaaaa";
const PARTNER = "bbbbbbbbbbbb";
const SESSION = "cs_test_CreditRetry0000000001";
const PI = "pi_test_CreditRetry0001";
const NOW = Math.floor(Date.now() / 1000);

let payment: Record<string, unknown> = {};
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
  const saved = (await storeForEmail(OWNER))!;
  const store: Store = { ...saved, affiliates: { ...NO_AFFILIATES, enabled: true, percent: 20 } };
  const stats = store.statsId!;
  const product = added.product.id;
  await pipeline([
    ["HSET", `nl:aff:${stats}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${stats}:people`, PARTNER, JSON.stringify({ id: PARTNER, email: "pat@example.com", code: "pat", status: "approved", appliedAt: 1, decidedAt: 2, note: "", share: { products: [product], percent: 10 } })],
  ]);

  part("PayPal: a sale whose affiliate read is unknown");
  const order = "5O190127TN3647101";
  const paid: Paid = { store: stats, order, capture: "3C679366HH908701", email: "buyer@example.com", product, cents: 4900, currency: "usd", at: NOW, handle: store.handle, via: { aff: AFF, rate: 20 } };
  await pipeline([["SET", `nl:ppsell:paid:${order}`, JSON.stringify(paid)]]);
  affiliateReadBroken(stats);
  await handOverPayPal(store, paid).catch(() => undefined);
  heal();
  is("the partner's share is written although the affiliate could not be read", typeof (await hget(`nl:aff:${stats}:shares`, `paypal:${order}:${PARTNER}`)), "string");
  is("the failed credit is kept for the sweep, as its own member of the hand-over list", (await pipeline([["ZSCORE", handOverKey(stats), `credit:${order}`]]))[0] !== null, true);
  await sweepPayPal(store, Date.now() + 10_000);
  is("once the read heals, the sweep credits the affiliate's referral", typeof (await hget(`nl:aff:${stats}:sales`, `paypal:${order}`)), "string");
  is("and takes it out of the list", (await pipeline([["ZSCORE", handOverKey(stats), `credit:${order}`]]))[0], null);

  part("Offer after paying: a paid offer whose affiliate read is unknown");
  payment = { id: PI, object: "payment_intent", status: "succeeded", amount: 2500, currency: "usd", receipt_email: "buyer@example.com", created: NOW, metadata: { parent: SESSION, step: "", product: "gone-product", title: "Extra", via: AFF, via_rate: "20" } };
  await pipeline([["SET", `nl:upsell:${SESSION}`, JSON.stringify({ state: "pending", product: "gone-product", pi: PI, at: Date.now() })]]);
  affiliateReadBroken(stats);
  await settleUpsells(store, SESSION);
  heal();
  is("nothing credited while the read is unknown", await hget(`nl:aff:${stats}:sales`, PI), null);
  const members = (await pipeline([["ZRANGEBYSCORE", "nl:upsell:pending", "-inf", "+inf"]]))[0] as string[];
  const kept = members.find((m) => m.startsWith(`harbor|${SESSION}||credit:`));
  is("the failed credit is kept in the job's list, with the time it first failed", /\|credit:\d{13}$/.test(kept ?? ""), true);
  // Old enough for the job's minute of grace; still unknown: kept for the next run.
  await pipeline([["ZADD", "nl:upsell:pending", 0, kept!]]);
  affiliateReadBroken(stats);
  await settlePendingOffers(async () => store, Date.now() + 10_000);
  heal();
  const still = (await pipeline([["ZRANGEBYSCORE", "nl:upsell:pending", "-inf", "+inf"]]))[0] as string[];
  is("a run while the read is still unknown keeps it", [still.includes(kept!), await hget(`nl:aff:${stats}:sales`, PI)], [true, null]);
  await pipeline([["ZADD", "nl:upsell:pending", 0, kept!]]);
  await settlePendingOffers(async () => store, Date.now() + 10_000);
  is("once the read heals, the job credits the affiliate's referral from Stripe's own payment", typeof (await hget(`nl:aff:${stats}:sales`, PI)), "string");
  const after = (await pipeline([["ZRANGEBYSCORE", "nl:upsell:pending", "-inf", "+inf"]]))[0] as string[];
  is("and takes it out of the list", after.includes(kept!), false);

  part("A credit that never heals is let go after the watch, by the time it carries");
  const old = `harbor|${SESSION}||credit:${Date.now() - 3 * 24 * 60 * 60 * 1000}`;
  await pipeline([["ZADD", "nl:upsell:pending", 0, old]]);
  affiliateReadBroken(stats);
  await settlePendingOffers(async () => store, Date.now() + 10_000);
  heal();
  const gone = (await pipeline([["ZRANGEBYSCORE", "nl:upsell:pending", "-inf", "+inf"]]))[0] as string[];
  is("a credit older than the watch leaves the list", gone.includes(old), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
