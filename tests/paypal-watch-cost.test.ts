/**
 * The PayPal watch's two list reads, as the cost registry states them (Claude 5 on #2909): each sweep of a store
 * with PayPal reads its pending payments and its orders due a refund look (lib/paypal-sales.ts, watchPayPal), one
 * ZRANGEBYSCORE each, and each read asks for at most PAYPAL_WATCH_BATCH orders. The figures are read from what the
 * real sweep (lib/paypal-delivery.ts, sweepPayPal, as lib/checkout-sweep.ts calls it) sends and must equal the
 * registry's (PAYPAL_WATCH_RANGES and NOT_A_COST.PAYPAL_WATCH_BATCH in tests/plan-cost-registry.ts).
 *
 * Synthetic only: a stand-in for PayPal's API, the Redis stub and the real sweep. Only the commands on the two
 * lists are counted, so other work of the same sweep (the hand-over list of #2909) is left to its own line.
 */
import { claimHandle, ensureStatsId, setSubscription, setPayPalSeller, storeForEmail } from "@/lib/store";
import * as sales from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
let paypalCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  paypalCalls += 1;
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const pendingKey = (statsId: string) => `nl:ppsell:pending:${statsId}`;
const watchKey = (statsId: string) => `nl:ppsell:watch:${statsId}`;
const orderId = (list: string, n: number) => `${list}0190127TN364${String(n).padStart(3, "0")}`;
type Commands = (string | number)[][];

/** Every command sent while `run` runs. */
async function recorded(run: () => Promise<unknown>): Promise<Commands> {
  const sent: Commands = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => {
    sent.push(...commands);
    return pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = pipeline;
  }
  return sent;
}

const on = (sent: Commands, op: string, key: string) => sent.filter((c) => c[0] === op && c[1] === key);
const ranges = (sent: Commands, statsId: string) => sent.filter((c) => c[0] === "ZRANGEBYSCORE" && (c[1] === pendingKey(statsId) || c[1] === watchKey(statsId)));

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  const declared = (registry as unknown as Record<string, unknown>).PAYPAL_WATCH_RANGES as { rangeReadsPerStoreRun?: number; ordersPerRangeRead?: number } | undefined;
  const batch = (sales as unknown as Record<string, unknown>).PAYPAL_WATCH_BATCH;
  const reason = registry.NOT_A_COST.PAYPAL_WATCH_BATCH;

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const statsId = store.statsId!;
  const far = Date.now() + 60_000;

  part("the registry states the two reads and their batch");
  is("PAYPAL_WATCH_RANGES is in the registry", typeof declared, "object");
  is("PAYPAL_WATCH_BATCH is exported by lib/paypal-sales.ts", typeof batch, "number");
  is("NOT_A_COST.PAYPAL_WATCH_BATCH says why and what", typeof reason === "string" && reason.includes("ZRANGEBYSCORE") && reason.includes("never zero"), true);
  is("the batch the registry states is the code's", typeof batch === "number" && declared?.ordersPerRangeRead === batch, true);

  part("nothing waiting: both lists are still read, once each");
  const empty = await recorded(() => sweepPayPal(store, far));
  is("ZRANGEBYSCORE on the two lists, as the registry states", ranges(empty, statsId).length, declared?.rangeReadsPerStoreRun);
  is("one of the pending list", on(empty, "ZRANGEBYSCORE", pendingKey(statsId)).length, 1);
  is("one of the watch list", on(empty, "ZRANGEBYSCORE", watchKey(statsId)).length, 1);
  is("nothing asked of PayPal", paypalCalls, 0);

  part("more orders than a batch on each list: each read asks for one batch, and no more orders are looked at");
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 30; i += 1) {
    await redis.pipeline([
      ["ZADD", pendingKey(statsId), String(now - 600 + i), orderId("P", i)],
      ["ZADD", watchKey(statsId), String(now - 600 + i), orderId("W", i)],
    ]);
  }
  const full = await recorded(() => sweepPayPal(store, far));
  const read = ranges(full, statsId);
  is("ZRANGEBYSCORE on the two lists, as the registry states", read.length, declared?.rangeReadsPerStoreRun);
  is("each asks for the registry's batch", read.map((c) => c.slice(-3).map(String)), read.map(() => ["LIMIT", "0", String(declared?.ordersPerRangeRead)]));
  // Neither record exists, so each order looked at is let go (ZREM): their count is the orders the run looked at.
  is("pending orders looked at: one batch", on(full, "ZREM", pendingKey(statsId)).length, declared?.ordersPerRangeRead);
  is("watched orders looked at: one batch", on(full, "ZREM", watchKey(statsId)).length, declared?.ordersPerRangeRead);
  is("still nothing asked of PayPal for orders without records", paypalCalls, 0);

  part("the next run reads the rest with the same two reads");
  const rest = await recorded(() => sweepPayPal(store, far));
  is("again the registry's two reads", ranges(rest, statsId).length, declared?.rangeReadsPerStoreRun);
  is("the five pending left", on(rest, "ZREM", pendingKey(statsId)).length, 5);
  is("the five watched left", on(rest, "ZREM", watchKey(statsId)).length, 5);

  part("a run past its deadline reads no more than the registry states");
  await redis.pipeline([["ZADD", pendingKey(statsId), String(now), orderId("P", 99)]]);
  const late = await recorded(() => sweepPayPal(store, Date.now() - 1));
  is("at most the registry's reads", ranges(late, statsId).length <= (declared?.rangeReadsPerStoreRun ?? -1), true);

  part("a store without PayPal sends nothing to the two lists");
  await setPayPalSeller("owner@example.com", null);
  const without = (await storeForEmail("owner@example.com"))!;
  const none = await recorded(() => sweepPayPal(without, far));
  // Only the two lists are counted: the hand-over list of #2909 has its own line (PAYPAL_HAND_OVER_RETRY).
  is("no command on the two lists", none.filter((c) => c[1] === pendingKey(statsId) || c[1] === watchKey(statsId)).length, 0);

  done();
}

void main();
