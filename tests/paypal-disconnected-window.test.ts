/**
 * PayPal disconnected while orders still wait on it (Claude 7, 12 November 2026; decision C1-20261112-1102-C7-146,
 * item 2): the bounds of the work and the studio's notice. The full journey is tests/paypal-disconnected-orders.test.ts.
 *
 *   - the account is asked about only within PAYPAL_PAST_SECONDS of the disconnection (paypalMerchant);
 *   - the real sweep (lib/paypal-delivery.ts, sweepPayPal) of a disconnected store sends first the three ZCARD the
 *     registry states (PAYPAL_PAST_WATCH in tests/plan-cost-registry.ts), and forgets the account, so the store leaves
 *     the sweep, once its lists are empty; past the window it sends nothing to the lists at all;
 *   - an unknown count is not "none": the account is kept and asked again;
 *   - the studio's notice (components/paypal-waiting-notice.tsx): a named region with its own heading, a polite live
 *     region, nothing for no orders, plain US English with the deadline the code uses.
 *
 * Synthetic only: a stand-in for PayPal's API and the Redis stub.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { claimHandle, disconnectPayPalSeller, ensureStatsId, setPayPalSeller, setSubscription, storeForEmail } from "@/lib/store";
import { PAYPAL_PAST_SECONDS, PENDING_GIVE_UP_SECONDS, paypalMerchant, paypalOrdersWaiting, paypalPastWatched } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { PayPalWaitingNotice } from "@/components/paypal-waiting-notice";
import { NOT_A_COST, PAYPAL_PAST_WATCH } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

type Commands = (string | number)[][];
async function recorded(run: () => Promise<unknown>): Promise<{ sent: Commands; trips: Commands[] }> {
  const sent: Commands = [];
  const trips: Commands[] = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => {
    sent.push(...commands);
    trips.push(commands);
    return pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = pipeline;
  }
  return { sent, trips };
}

const lists = (statsId: string) => [`nl:ppsell:pending:${statsId}`, `nl:ppsell:watch:${statsId}`, `nl:ppsell:handover:${statsId}`];
const onLists = (sent: Commands, statsId: string) => sent.filter((c) => lists(statsId).includes(String(c[1])));

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  part("The window: PayPal's refund window after the disconnection, never more");
  const now = Date.now();
  is("the registry's window is the code's", PAYPAL_PAST_WATCH.windowSeconds, PAYPAL_PAST_SECONDS);
  is("connected: its account", paypalMerchant({ paypalSeller: { merchant: SELLER, at: 1 }, paypalPast: null }, now), SELLER);
  is("disconnected a day ago: the kept account", paypalMerchant({ paypalSeller: null, paypalPast: { merchant: SELLER, at: now - 86_400_000 } }, now), SELLER);
  is("disconnected past the window: none", paypalMerchant({ paypalSeller: null, paypalPast: { merchant: SELLER, at: now - (PAYPAL_PAST_SECONDS + 1) * 1000 } }, now), null);
  is("a time in the future is not taken for a disconnection", paypalPastWatched({ paypalSeller: null, paypalPast: { merchant: SELLER, at: now + 86_400_000 } }, now), false);
  is("never connected: none", paypalMerchant({ paypalSeller: null }, now), null);
  is("each new figure says why it is not a plan's cost", ["PAYPAL_PAST_SECONDS", "PENDING_GIVE_UP_SECONDS", "CANCEL_NOTICE_TRIES"].map((k) => typeof NOT_A_COST[k] === "string" && NOT_A_COST[k].includes("never zero") || NOT_A_COST[k]?.includes("Never zero")), [true, true, true]);

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  await setPayPalSeller("owner@example.com", SELLER);
  let store = (await storeForEmail("owner@example.com"))!;
  const statsId = store.statsId!;
  const far = Date.now() + 60_000;

  part("Disconnected with one order waiting: the three counts, then the watch");
  await redis.pipeline([["ZADD", `nl:ppsell:pending:${statsId}`, String(Math.floor(now / 1000)), "1A190127TN3647100"]]);
  await disconnectPayPalSeller("owner@example.com");
  store = (await storeForEmail("owner@example.com"))!;
  is("the account is kept as paypalPast", [store.paypalSeller, store.paypalPast?.merchant], [null, SELLER]);
  is("the studio's count", await paypalOrdersWaiting(store), 1);
  const first = await recorded(() => sweepPayPal(store, far));
  const counts = first.trips.find((trip) => trip.every((c) => c[0] === "ZCARD"));
  is("one round trip of ZCARD, as many as the registry states", counts?.length, PAYPAL_PAST_WATCH.countReadsPerStoreRun);
  is("of the three lists", counts?.map((c) => c[1]), lists(statsId));
  is("then the watch reads its two lists", first.sent.filter((c) => c[0] === "ZRANGEBYSCORE" && lists(statsId).slice(0, 2).includes(String(c[1]))).length, 2);

  part("Unknown counts are not 'none'");
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => (commands.every((c) => c[0] === "ZCARD") ? commands.map(() => "x") : pipeline(commands))) as typeof redis.pipeline;
  try {
    await sweepPayPal(store, far);
  } finally {
    redis.pipeline = pipeline;
  }
  is("the account is kept", (await storeForEmail("owner@example.com"))?.paypalPast?.merchant, SELLER);

  part("Nothing left: forgotten, and the store leaves the sweep");
  // The order without its record was let go by the first run (ZREM), so the lists are empty now.
  const second = await recorded(() => sweepPayPal(store, far));
  is("only the three counts this run", onLists(second.sent, statsId).map((c) => c[0]), ["ZCARD", "ZCARD", "ZCARD"]);
  store = (await storeForEmail("owner@example.com"))!;
  is("the kept account is forgotten", store.paypalPast, null);
  is("no studio notice is read for it", await paypalOrdersWaiting(store), null);
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  let job = { stores: -1 };
  const third = await recorded(async () => {
    job = await sweepCheckouts(Date.now() + 10_000);
  });
  is("the five-minute job no longer picks the store, and sends nothing to its lists", [job.stores, onLists(third.sent, statsId).length], [0, 0]);

  part("Past the window: nothing asked at all");
  const old = { ...store, paypalPast: { merchant: SELLER, at: Date.now() - (PAYPAL_PAST_SECONDS + 60) * 1000 } };
  await redis.pipeline([["ZADD", `nl:ppsell:pending:${statsId}`, String(Math.floor(now / 1000)), "1A190127TN3647101"]]);
  const late = await recorded(() => sweepPayPal(old, far));
  is("no command on its lists", onLists(late.sent, statsId).length, 0);
  is("and no studio count", await paypalOrdersWaiting(old), null);

  part("The studio's notice");
  is("none for no orders", renderToStaticMarkup(createElement(PayPalWaitingNotice, { count: 0 })), "");
  const one = renderToStaticMarkup(createElement(PayPalWaitingNotice, { count: 1 }));
  const three = renderToStaticMarkup(createElement(PayPalWaitingNotice, { count: 3 }));
  is("a polite live region named by its own heading", [one.includes('role="status"'), one.includes('aria-labelledby="paypal-waiting-title"'), /<h3 id="paypal-waiting-title"[^>]*>Reconnect PayPal: 1 PayPal order is still waiting<\/h3>/.test(one)], [true, true, true]);
  is("the count in words", three.includes("Reconnect PayPal: 3 PayPal orders are still waiting"), true);
  is("what happens, with the code's deadline", [one.includes("as soon as PayPal confirms it"), one.includes(`within ${PENDING_GIVE_UP_SECONDS / 86_400} days is cancelled`), one.includes("Connect your PayPal account again")], [true, true, true]);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
