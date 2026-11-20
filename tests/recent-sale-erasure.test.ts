/**
 * A store's recent purchases (lib/recent-sales.ts, rememberSale) against its erasure (Codex L-20261120-0455): a settled
 * checkout already being handled when the erasure begins never writes nl:recent:<statsId> back after the erasure
 * removed it. The purchase list (payment, product, billing country, time) is written only while the store's own key is
 * there and no erasing mark is, in one step, as its cached feed already is (KEEP_FEED_IF_LIVE). Synthetic Redis only.
 */
import { rememberSale } from "@/lib/recent-sales";
import { claimHandle, ERASING_KEY, erasingField, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const record = {
  id: "cs_live_a1b2c3d4e5f6",
  mode: "payment",
  created: Math.floor(Date.now() / 1000) - 60,
  amount_total: 2_500,
  payment_intent: "pi_3RecentSale0001",
  metadata: { product: "p1" },
  customer_details: { address: { country: "DE" } },
};

async function made(): Promise<Store> {
  redis.clear();
  const result = await claimHandle("recent-race@example.com", "recentrace", "Synthetic", "");
  if (!result.ok) throw new Error("store not made");
  return { ...result.store, statsId: result.store.statsId ?? "statsrecent01", recentSales: true } as Store;
}

const kept = (store: Store) => Number(redis.run(["LLEN", `nl:recent:${store.statsId}`]));

async function main(): Promise<void> {
  part("A live store with recent purchases switched on keeps the purchase");
  const live = await made();
  await rememberSale(live, record);
  is("written down, with its expiry", [kept(live), Number(redis.run(["TTL", `nl:recent:${live.statsId}`])) > 0], [1, true]);

  part("A store whose erasure has begun (its erasing mark there) gets nothing written back");
  const marked = await made();
  await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(marked)), String(Date.now())]]);
  await rememberSale(marked, record);
  is("no purchase list is made for it", kept(marked), 0);

  part("A store already erased (its id key gone) gets nothing written back either");
  const gone = await made();
  await redis.pipeline([["DEL", storeIdCommand(gone.sid)[1]], ["DEL", `nl:recent:${gone.statsId}`]]);
  await rememberSale(gone, record);
  is("no purchase list is made for it", kept(gone), 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
