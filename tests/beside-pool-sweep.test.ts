/**
 * The beside pool's sweep (Claude 1's order C1-20261117-1500-c6c4-1, PR 2): a store's products saved before it paid
 * were counted whole in its data room, their worst page reading and side records included (BESIDE_PRODUCT_BYTES).
 * When the store starts paying, that share moves to its beside pool, MOVE_BESIDE_BATCH products a lock, and the room
 * keeps only each product's real size. Only a product whose room slot holds the whole share moves, so the room never
 * counts less than it holds; a full pool leaves the rest counted in the room, as before; a store already paying, or
 * one whose sweep is done, does not sweep again. Synthetic stores only.
 */
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import * as storeModule from "@/lib/store";
import { BESIDE_PRODUCT_BYTES } from "@/lib/store-data-rules";
import { dataKey, dataUsed } from "@/lib/store-data";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
// Read through the module, so this file also runs, and fails on what it measures, where the sweep does not exist yet.
const MOVE_BESIDE_BATCH = (storeModule as { MOVE_BESIDE_BATCH?: number }).MOVE_BESIDE_BATCH ?? 250;

async function trialStore(owner: string, handle: string, products: number) {
  await claimHandle(owner, handle, "Sweep Shop", "");
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(owner, { customerId: `cus_${handle.padEnd(10, "0")}`, subscriptionId: `sub_${handle.padEnd(10, "0")}`, active: true, tier: "creator", trialEnds: now + 7 * DAY });
  await ensureStatsId(owner);
  const ids: string[] = [];
  for (let n = 0; n < products; n += 1) {
    const made = await addProduct(owner, `Product ${n}`, "A product.", "9");
    if (!made.ok) throw new Error(`product ${n} refused: ${made.reason}`);
    ids.push(made.product.id);
  }
  return ids;
}
const pay = (owner: string, handle: string) =>
  setSubscription(owner, { customerId: `cus_${handle.padEnd(10, "0")}`, subscriptionId: `sub_${handle.padEnd(10, "0")}`, active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
const poolKey = async (owner: string) => `${dataKey((await storeForEmail(owner))!)}:b`;
const slot = async (owner: string, field: string) => {
  const [reply] = await redisPipeline([["HGET", dataKey((await storeForEmail(owner))!)!, field]]);
  return Number(reply ?? 0);
};

async function main(): Promise<void> {
  part("A store that made its products in its trial: paying moves each one's share to the pool");
  redis.clear();
  const OWNER = "sweep-owner@example.com";
  const ids = await trialStore(OWNER, "sweepshop", MOVE_BESIDE_BATCH + 10);
  const before = (await dataUsed((await storeForEmail(OWNER))!))!.used;
  const slotBefore = await slot(OWNER, `p:${ids[0]}`);
  is("control: in its trial, a product's slot holds its whole share", slotBefore > BESIDE_PRODUCT_BYTES, true);
  await pay(OWNER, "sweepshop");
  const after = (await dataUsed((await storeForEmail(OWNER))!))!.used;
  is("its room keeps each product at its real size: the shares came off", before - after, ids.length * BESIDE_PRODUCT_BYTES);
  is("a product's slot is its real size", await slot(OWNER, `p:${ids[0]}`), slotBefore - BESIDE_PRODUCT_BYTES);
  is("and the last product, past the first batch, moved too", (await slot(OWNER, `p:${ids[ids.length - 1]}`)) < BESIDE_PRODUCT_BYTES, true);
  const [pooled] = await redisPipeline([["HGET", await poolKey(OWNER), `b:${ids[ids.length - 1]}`]]);
  is("the pool holds its share", Number(pooled), BESIDE_PRODUCT_BYTES);

  part("Already paying, or swept: no sweep again");
  const seen: (string | number)[][] = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    seen.push(...commands);
    return pipeline(commands);
  }) as typeof redis.pipeline;
  await pay(OWNER, "sweepshop");
  redis.pipeline = pipeline;
  const poolReads = seen.filter((c) => c[0] === "HMGET" && String(c[1]).endsWith(":b")).length;
  is("a store that already pays reads its pool for no sweep", poolReads, 0);

  part("A product whose slot does not hold the whole share is not moved: the room never counts less than it holds");
  redis.clear();
  const SHORT = "sweep-short@example.com";
  const short = await trialStore(SHORT, "shortshop", 2);
  // A slot that holds less than the share (a product saved before the share was counted, say).
  await redisPipeline([["HSET", dataKey((await storeForEmail(SHORT))!)!, `p:${short[0]}`, 1_000]]);
  await pay(SHORT, "shortshop");
  is("that product's slot is left as it was", await slot(SHORT, `p:${short[0]}`), 1_000);
  const [notPooled] = await redisPipeline([["HGET", await poolKey(SHORT), `b:${short[0]}`]]);
  is("and the pool holds nothing for it", notPooled, null);
  is("the other product moved", (await slot(SHORT, `p:${short[1]}`)) < BESIDE_PRODUCT_BYTES, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
