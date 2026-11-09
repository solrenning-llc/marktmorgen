/**
 * PayPal sales on the Path (12 [D9], unit 1).
 *
 * A PayPal order the store's own server captured (lib/paypal-sales.ts) counts
 * toward the first real sale and the levels only when it was taken through
 * PayPal's live API: a sandbox or local one is neither a real sale nor a test
 * purchase. Refunds PayPal confirmed in full are taken off, matched by the
 * capture; when the refunds cannot all be read, the money is unknown (null) and
 * no level moves on it. A store that sells through PayPal without Stripe is
 * read, not taken for zero. Synthetic store and orders, in-memory Redis.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setPayPalSeller, setSubscription, storeForEmail } from "@/lib/store";
import { moneyFrom, readPathMoney, soldOf } from "@/lib/path-facts";
import { payPalSale } from "@/lib/stats";
import { paypalPaymentId, type Paid } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const order = (n: number) => `ORDER${String(n).padStart(10, "0")}`;

function paid(statsId: string, n: number, cents: number, at: number): Paid {
  return { store: statsId, order: order(n), capture: `CAPTURE${n}`, email: `buyer${n}@example.test`, product: "p1", cents, currency: "usd", at };
}

async function main(): Promise<void> {
  part("A PayPal order, as the path reads it");
  const one = payPalSale(paid("stats", 1, 2900, 1_800_000_000));
  is("live API: a real sale", soldOf(one, true), { cents: 2900, currency: "usd", intent: paypalPaymentId("CAPTURE1"), live: true });
  is("sandbox or local API: neither real nor a test purchase", soldOf(one, false).live, null);
  const stripeRow = { cents: 1000, currency: "usd", paymentIntent: "pi_1", row: { livemode: false } };
  is("a Stripe sale keeps its own livemode", soldOf(stripeRow, true).live, false);
  const sandbox = moneyFrom([soldOf(one, false)], [], "usd", 0);
  is("a sandbox PayPal order moves nothing", [sandbox.real, sandbox.cents, sandbox.test], [0, 0, false]);

  part("A store that sells through PayPal only");
  redis.clear();
  const owner = "paypal-path@example.test";
  await claimHandle(owner, "paypalpath", "PayPal Path", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_pp", subscriptionId: "sub_pp", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setPayPalSeller(owner, "MERCHANTPP01");
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const now = 1_800_000_000;
  const orders = [paid(statsId, 1, 2900, now - 300), paid(statsId, 2, 4900, now - 200), paid(statsId, 3, 1500, now - 100)];
  for (const o of orders) {
    redis.run(["SET", `nl:ppsell:paid:${o.order}`, JSON.stringify(o)]);
    redis.run(["ZADD", `nl:ppsell:sales:${statsId}`, String(o.at), o.order]);
  }
  // PayPal refunded the second in full.
  redis.run(["ZADD", `nl:ppsell:refunded:${statsId}`, String(now - 50), order(2)]);

  const live = await readPathMoney(store, now * 1000, { paypalLive: true });
  is("read, not taken for zero: two real sales kept, the refunded one taken off", [live?.real, live?.cents, live?.test], [2, 4400, false]);
  const sandboxStore = await readPathMoney(store, now * 1000, { paypalLive: false });
  is("the same orders through a sandbox API: nothing real", [sandboxStore?.real, sandboxStore?.cents], [0, 0]);

  part("Refunds that cannot all be read leave the money unknown");
  for (let i = 0; i < 501; i++) redis.run(["ZADD", `nl:ppsell:refunded:${statsId}`, String(now - 40 + i / 1000), `REFUND${String(i).padStart(10, "0")}`]);
  const partial = await readPathMoney(store, now * 1000, { paypalLive: true });
  is("money null: no level moves on it", partial?.cents, null);

  done();
}

main();
