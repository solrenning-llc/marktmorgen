/**
 * #4624 (residual): the job that settles offers after paying that the buyer's browser did not settle
 * (lib/upsell.ts settlePendingOffers) takes the 50 oldest waiting offers a run. A member whose look threw (its store
 * read failed, Stripe failed) kept its old score, so 50 of them held the front and every healthy offer behind them
 * waited their whole watch: the buyer's confirmation email and the affiliate credit came late. A thrown look now moves
 * the member behind, on the same schedule as an offer still pending (WATCH_AFTER_MS), so the next run reaches the
 * others. The no-store and no-Stripe cases already did so (d283d36307). Synthetic data only; nothing is charged.
 */
import { settlePendingOffers } from "@/lib/upsell";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { OFFER_WATCH_LOOKS_MOST } from "./plan-cost-registry";
import { done, is, part } from "./check";

const PENDING = "nl:upsell:pending";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
console.error = () => {};

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const broken = Array.from({ length: 50 }, (_, i) => `cs_test_brokenoffer${String(i).padStart(3, "0")}`);
  for (const [i, session] of broken.entries()) {
    redis.run(["SET", `nl:upsell:${session}`, JSON.stringify({ state: "pending", product: "p1", pi: `pi_broken${i}`, at: now - 10 * 60_000 })]);
    redis.run(["ZADD", PENDING, i, `broken|${session}|`]);
  }
  const healthy = "healthy|cs_test_healthyoffer001|";
  redis.run(["ZADD", PENDING, now - 5 * 60_000, healthy]);
  const front = () => (redis.run(["ZRANGEBYSCORE", PENDING, 0, Date.now() - 60_000, "LIMIT", 0, 50]) as string[]);

  part("Control: before the run, the 50 offers whose look throws hold the job's front");
  is("the healthy offer is the 51st", front().includes(healthy), false);

  part("A look that throws moves its offer behind, so the next run reaches the others");
  const storeFor = async (handle: string): Promise<Store | null> => {
    if (handle === "broken") throw new Error("synthetic store read failure");
    return null;
  };
  const run = await settlePendingOffers(storeFor, Date.now() + 10_000);
  is("the run looked at the 50 at the front", run.checked, 50);
  is("none of them was dropped: each is still waiting", broken.every((s) => redis.run(["ZSCORE", PENDING, `broken|${s}|`]) !== null), true);
  is("each is now due later than now, at its next look", broken.every((s) => Number(redis.run(["ZSCORE", PENDING, `broken|${s}|`])) > Date.now() - 60_000), true);
  is("so the healthy offer is at the front of the next run", front()[0], healthy);

  part("An offer whose look throws past its whole watch is let go, as the other branches do");
  redis.clear();
  const old = "cs_test_oldbrokenoffer01";
  redis.run(["SET", `nl:upsell:${old}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_old", at: now - 8 * 86_400_000 })]);
  redis.run(["ZADD", PENDING, 1, `broken|${old}|`]);
  await settlePendingOffers(storeFor, Date.now() + 10_000);
  is("past the watch for a payment still clearing (seven days), it leaves the list", redis.run(["ZSCORE", PENDING, `broken|${old}|`]), null);

  // Claude 5 iYwjc's LEVE on #5482: an offer whose record never reads was looked at hourly until the record lapsed
  // (RECORD_SECONDS, 8 days), up to ~192 looks against the OFFER_WATCH_LOOKS_MOST the orders line prices.
  part("An offer whose record never reads is looked at no more often than the priced looks, over the record's whole life");
  redis.clear();
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const garbled = "cs_test_garbledoffer001";
    redis.run(["SET", `nl:upsell:${garbled}`, "{not json"]);
    redis.run(["ZADD", PENDING, 1, `broken|${garbled}|`]);
    let looks = 0;
    const counted = async (handle: string): Promise<Store | null> => storeFor(handle);
    const reads = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "GET" && c[1] === `nl:upsell:${garbled}`)) looks += 1;
      return reads(commands);
    }) as typeof redis.pipeline;
    // Every five minutes for the record's eight days, as the job runs.
    for (let t = 0; t <= 8 * 86_400_000; t += 5 * 60_000) {
      shift = t;
      await settlePendingOffers(counted, Date.now() + 10_000);
    }
    redis.pipeline = reads;
    is(`looked at ${looks} times in eight days, inside the priced ${OFFER_WATCH_LOOKS_MOST}`, looks <= OFFER_WATCH_LOOKS_MOST, true);
    is("and still waiting, never dropped on an unknown record", redis.run(["ZSCORE", PENDING, `broken|${garbled}|`]) !== null, true);
  } finally {
    Date.now = realNow;
  }

  done();
}

void main();
