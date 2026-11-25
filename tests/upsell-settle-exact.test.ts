/**
 * #5285 row #4537 (Codex X6's two LOWs on the merged head 40aa37e98e, still in main 86bd73f989), lib/upsell.ts settleOne:
 *  1. A payment whose status Stripe answered in another shape (not text) was returned as null, "read, not about this
 *     offer", so the five-minute job let a payment still clearing at the bank go for good. It is now unknown (UNREAD):
 *     the offer stays watched, and nothing is written on it.
 *  2. Every write of how an offer went was a plain SET, made from the record read before Stripe was asked. The
 *     buyer's thanks page and the job settle the same offer, so a "paid" written by one while the other waited on
 *     Stripe was overwritten back to "pending" from the older read. Each write is now made only while the record still
 *     holds what was read (one script), and a settle that lost the race writes nothing.
 * Synthetic Stripe and in-memory Redis only.
 */
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readUpsell, settlePendingOffers, settleUpsells } from "@/lib/upsell";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_settle_exact_only";
const OWNER = "settle-exact@example.com";
const SESSION = "cs_test_SettleExact000001";
const SLOT = "kit001";
const PI = "pi_test_SettleExact01";
const DAY = 24 * 60 * 60 * 1000;

/** What GET /payment_intents/<id> answers, and what happens while Stripe is working on it. */
let answerStatus: unknown = "processing";
let whileAsked: () => void = () => {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === `/payment_intents/${PI}`) {
    whileAsked();
    return new Response(JSON.stringify({ id: PI, object: "payment_intent", status: answerStatus, metadata: { parent: SESSION, step: SLOT } }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

const key = `nl:upsell:${SESSION}:${SLOT}`;
const member = `settleexact|${SESSION}|${SLOT}`;
const seed = (record: Record<string, unknown>) => {
  redis.run(["SET", key, JSON.stringify(record), "EX", 30 * 86_400]);
  redis.run(["SADD", `nl:upsell-slots:${SESSION}`, SLOT]);
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "settleexact", "Settle Exact Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSettleEx01", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  console.error = () => {};

  part("1. A payment status in another shape keeps the offer watched");
  // Past the first watch (nextLook is over), still inside the week a payment clearing at the bank is followed.
  const at = Date.now() - 3 * DAY;
  seed({ state: "pending", product: "prod000001", pi: PI, at, waiting: "processing" });
  redis.run(["ZADD", "nl:upsell:pending", at, member]);
  answerStatus = { weird: true };
  await settlePendingOffers(async (handle) => (handle === "settleexact" ? store : null), Date.now() + 60_000);
  is("RED: the offer is still watched (an unreadable status is unknown, not 'not processing')", redis.run(["ZSCORE", "nl:upsell:pending", member]) !== null, true);
  is("and its record is untouched", (await readUpsell(SESSION, SLOT))?.state, "pending");

  part("2. A paid written by the other settle while Stripe was asked is never written back to pending");
  redis.run(["DEL", "nl:upsell:pending"]);
  seed({ state: "pending", product: "prod000001", pi: PI, at: Date.now() - 5 * 60_000 });
  answerStatus = "processing";
  // The job settles the same offer meanwhile and writes it paid.
  whileAsked = () => {
    whileAsked = () => {};
    redis.run(["SET", key, JSON.stringify({ state: "paid", product: "prod000001", pi: PI, at: Date.now() - 5 * 60_000 }), "EX", 30 * 86_400]);
  };
  await settleUpsells(store, SESSION);
  is("RED: the offer stays paid", (await readUpsell(SESSION, SLOT))?.state, "paid");

  part("3. With nothing in between, a settle still writes what Stripe says");
  seed({ state: "pending", product: "prod000001", pi: PI, at: Date.now() - 5 * 60_000 });
  answerStatus = "requires_payment_method";
  await settleUpsells(store, SESSION);
  is("the offer is failed", (await readUpsell(SESSION, SLOT))?.state, "failed");

  // Claude 2 lpgvy's MEDIUM on #5343: a settle that lost the race to a write that left the offer pending took it off
  // the job's watch anyway, so a paid (or failed) offer stayed pending and was never looked at again.
  for (const status of ["succeeded", "requires_payment_method"]) {
    part(`4. ${status}, but the other settle wrote "pending, processing" meanwhile: still watched`);
    seed({ state: "pending", product: "prod000001", pi: PI, at: Date.now() - 5 * 60_000 });
    redis.run(["ZADD", "nl:upsell:pending", Date.now() - 5 * 60_000, member]);
    answerStatus = status;
    whileAsked = () => {
      whileAsked = () => {};
      redis.run(["SET", key, JSON.stringify({ state: "pending", product: "prod000001", pi: PI, at: Date.now() - 5 * 60_000, waiting: "processing" }), "EX", 30 * 86_400]);
    };
    await settleUpsells(store, SESSION);
    is("the lost write left it pending, as the other settle wrote it", (await readUpsell(SESSION, SLOT))?.state, "pending");
    is("RED: and it is still on the job's watch, to be settled at the next look", redis.run(["ZSCORE", "nl:upsell:pending", member]) !== null, true);

    part(`4. ${status}, with nothing in between: written and off the watch`);
    seed({ state: "pending", product: "prod000001", pi: PI, at: Date.now() - 5 * 60_000 });
    await settleUpsells(store, SESSION);
    is("written", (await readUpsell(SESSION, SLOT))?.state, status === "succeeded" ? "paid" : "failed");
    is("and off the watch", redis.run(["ZSCORE", "nl:upsell:pending", member]), null);
  }
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
