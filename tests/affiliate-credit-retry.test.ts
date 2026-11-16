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
import { bondPlace } from "@/lib/affiliate-bond";
import { handOverPayPal, sweepPayPal } from "@/lib/paypal-delivery";
import { handOverKey, type Paid } from "@/lib/paypal-sales";
import { ownErasureCommand, ownErasureField, suppressedKey } from "@/lib/suppression";
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

  part("PayPal: a credit made again for a person who deleted themselves since names nobody (Claude 1 cloud, MEDIUM on #3858)");
  // A store that keeps its affiliates' buyers (lifetime): crediting a sale again would tie the buyer to the affiliate.
  const lasting: Store = { ...((await storeForEmail(OWNER))!), affiliates: { ...NO_AFFILIATES, enabled: true, percent: 20, lifetime: true } };
  const bonds = async () => (await pipeline([["HLEN", `nl:aff:${stats}:bond`]]))[0];
  const owed = (o: string) => pipeline([["ZSCORE", handOverKey(stats), `credit:${o}`]]).then((r) => r[0] !== null);
  const sale = (o: string, email: string): Paid => ({ store: stats, order: o, capture: `CAP${o}`, email, product, cents: 4900, currency: "usd", at: NOW, handle: store.handle, via: { aff: AFF, rate: 20 } });
  const erasedOrder = "5O190127TN3647102";
  const erasedSale = sale(erasedOrder, "gone@example.com");
  await pipeline([["SET", `nl:ppsell:paid:${erasedOrder}`, JSON.stringify(erasedSale)]]);
  affiliateReadBroken(stats);
  await handOverPayPal(lasting, erasedSale).catch(() => undefined);
  heal();
  const listId = (await storeForEmail(OWNER))!.listId!;
  is("handed over while the affiliate read was unknown: the credit is owed and no bond is written yet", [await owed(erasedOrder), await bonds()], [true, 0]);
  await pipeline([ownErasureCommand(listId, erasedSale.email, NOW + 1)]);
  await sweepPayPal({ ...lasting, listId }, Date.now() + 10_000);
  is("the sweep still credits the affiliate's referral for the sale paid", typeof (await hget(`nl:aff:${stats}:sales`, `paypal:${erasedOrder}`)), "string");
  is("but writes no bond naming the person who deleted themselves", await bonds(), 0);
  is("and the credit leaves the list", await owed(erasedOrder), false);

  // Control: the same retry for a buyer still there ties them to the affiliate, as a first credit does.
  const keptOrder = "5O190127TN3647103";
  const keptSale = sale(keptOrder, "stays@example.com");
  await pipeline([["SET", `nl:ppsell:paid:${keptOrder}`, JSON.stringify(keptSale)]]);
  affiliateReadBroken(stats);
  await handOverPayPal({ ...lasting, listId }, keptSale).catch(() => undefined);
  heal();
  await sweepPayPal({ ...lasting, listId }, Date.now() + 10_000);
  is("control: a buyer still there is tied to the affiliate by the credit made again", [typeof (await hget(`nl:aff:${stats}:sales`, `paypal:${keptOrder}`)), await bonds()], ["string", 1]);

  // A deletion mark that does not read (rule 24): nothing credited on a guess, the credit stays owed for the next sweep.
  const unreadOrder = "5O190127TN3647104";
  const unreadSale = sale(unreadOrder, "unread@example.com");
  await pipeline([["SET", `nl:ppsell:paid:${unreadOrder}`, JSON.stringify(unreadSale)]]);
  affiliateReadBroken(stats);
  await handOverPayPal({ ...lasting, listId }, unreadSale).catch(() => undefined);
  const mark = ownErasureField(listId, unreadSale.email);
  redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "HGET" && b[0][1] === suppressedKey(listId) && b[0][2] === mark ? ["soon"] : pipeline(b))) as typeof redis.pipeline;
  await sweepPayPal({ ...lasting, listId }, Date.now() + 10_000).catch(() => undefined);
  heal();
  is("an unreadable deletion mark: nothing credited, the credit still owed", [await hget(`nl:aff:${stats}:sales`, `paypal:${unreadOrder}`), await owed(unreadOrder)], [null, true]);
  await sweepPayPal({ ...lasting, listId }, Date.now() + 10_000);

  // The person's own deletion completes during the retry, after its first read of the mark and before the bond is
  // written (Claude 6, MEDIUM on #3858): the mark is read once more after the bond, as the hand-over does, and the bond
  // that names them is taken back. The credit itself stays, for the sale paid.
  const racedOrder = "5O190127TN3647105";
  const racedSale = sale(racedOrder, "raced@example.com");
  await pipeline([["SET", `nl:ppsell:paid:${racedOrder}`, JSON.stringify(racedSale)]]);
  affiliateReadBroken(stats);
  await handOverPayPal({ ...lasting, listId }, racedSale).catch(() => undefined);
  heal();
  const bondsBefore = await bonds();
  is("owed, and no bond for the raced buyer yet", [await owed(racedOrder), await hget(`nl:aff:${stats}:bond`, bondPlace(stats, racedSale.email).field)], [true, null]);
  const racedMark = ownErasureField(listId, racedSale.email);
  let fired = false;
  redis.pipeline = (async (b: Batch) => {
    const replies = await pipeline(b);
    if (!fired && b.length === 1 && b[0][0] === "HGET" && b[0][1] === suppressedKey(listId) && b[0][2] === racedMark) {
      fired = true;
      await pipeline([ownErasureCommand(listId, racedSale.email, NOW + 1)]);
    }
    return replies;
  }) as typeof redis.pipeline;
  await sweepPayPal({ ...lasting, listId }, Date.now() + 10_000);
  heal();
  is("the deletion completed during the credit's retry", fired, true);
  is("the affiliate is still credited for the sale paid", typeof (await hget(`nl:aff:${stats}:sales`, `paypal:${racedOrder}`)), "string");
  is("no bond names the person whose deletion completed during the credit", [await hget(`nl:aff:${stats}:bond`, bondPlace(stats, racedSale.email).field), await bonds()], [null, bondsBefore]);
  is("and the credit leaves the list", await owed(racedOrder), false);

  // A retry that finds the person already deleted takes back a bond an earlier try wrote for this order's affiliate
  // (that try stopped after the bond, before its second read), so nothing that names them is left.
  const staleOrder = "5O190127TN3647106";
  const staleSale = sale(staleOrder, "stale@example.com");
  await pipeline([["SET", `nl:ppsell:paid:${staleOrder}`, JSON.stringify(staleSale)]]);
  affiliateReadBroken(stats);
  await handOverPayPal({ ...lasting, listId }, staleSale).catch(() => undefined);
  heal();
  const stalePlace = bondPlace(stats, staleSale.email);
  await pipeline([["HSET", stalePlace.key, stalePlace.field, AFF], ownErasureCommand(listId, staleSale.email, NOW + 1)]);
  await sweepPayPal({ ...lasting, listId }, Date.now() + 10_000);
  is("a bond an earlier try wrote for a person since deleted is taken back by the retry", await hget(stalePlace.key, stalePlace.field), null);
  is("and that credit leaves the list too", await owed(staleOrder), false);

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
