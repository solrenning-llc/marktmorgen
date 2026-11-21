/**
 * Codex P's two MEDIUMs on #4846 (P-2104), synthetic stores and the stand-in Redis only:
 * (1) besideHeld reads a pool share only in the exact form the pool writes it (a decimal whole number of bytes, or
 *     nothing); any other value is an unreadable pool, never "not held" nor "held";
 * (2) a product save whose room answered nothing readable keeps the share it took in the pool: the room's script may
 *     have run, so the product may be counted there without the share it would carry outside the pool. The share is
 *     given back only when the room said "full", which means its script wrote nothing.
 */
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { BESIDE_PRODUCT_BYTES as BESIDE_PRODUCT } from "@/lib/store-data-rules";
import * as data from "@/lib/store-data";
import { store as redis, redisPipeline } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "beside-exact@example.com";

async function poolTotal(key: string): Promise<number> {
  const [total] = await redisPipeline([["HGET", key, "#"]]);
  return Number(total ?? 0);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "besideexact", "Beside Exact", "");
  await setSubscription(OWNER, { customerId: "cus_BesideEx001", subscriptionId: "sub_BesideEx001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  await ensureStatsId(OWNER);
  const first = await addProduct(OWNER, "First", "One product.", "5");
  if (!first.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const pool = data.besideKey(store)!;
  const room = data.dataKey(store)!;
  const id = first.product.id;

  part("A pool share is read only in the form the pool writes it");
  is("control: the saved product's share is held", [...((await data.besideHeld(store, [id])) ?? [])], [id]);
  is("control: a product with no share is not held", [...((await data.besideHeld(store, ["none-such"])) ?? [])], []);
  for (const value of ["abc", "1e3", "-1", "01", "1.5", " 4", "Infinity"]) {
    await redisPipeline([["HSET", pool, `b:${id}`, value]]);
    is(`a share kept as ${JSON.stringify(value)} is an unreadable pool`, await data.besideHeld(store, [id]), null);
  }
  await redisPipeline([["HSET", pool, `b:${id}`, String(BESIDE_PRODUCT)]]);
  // A reply with a hole where a slot should be (Claude 5's LOW): not a reply, so the pool is unreadable too.
  const plain = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands[0]?.[0] === "HMGET" && commands[0][1] === pool ? [Object.assign(new Array(2), { 1: String(BESIDE_PRODUCT) })] : plain(commands)) as typeof redis.pipeline;
  is("a reply with a hole where a slot should be is an unreadable pool", await data.besideHeld(store, ["none-such", id]), null);
  redis.pipeline = plain;

  // The sweep's read of the room's slots (lib/store-data.ts, roomSlots; #4847) takes them in the same exact form.
  const roomSlots = (data as Record<string, unknown>).roomSlots as ((s: typeof store, slots: string[]) => Promise<number[] | null>) | undefined;
  if (roomSlots) {
    const slot = `p:${id}`;
    const [kept] = await redisPipeline([["HGET", room, slot]]);
    for (const value of ["01", "1e3", "-1", " 4", "1.5"]) {
      await redisPipeline([["HSET", room, slot, value]]);
      is(`a room slot kept as ${JSON.stringify(value)} is an unreadable room (#4847)`, await roomSlots(store, [slot]), null);
    }
    await redisPipeline(kept === null ? [["HDEL", room, slot]] : [["HSET", room, slot, String(kept)]]);
  }

  // Every room script on this store answers as `mode` says; the pool's own key is left alone.
  let mode: "unknown" | "full" | null = null;
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const roomEval = commands.length === 1 && commands[0][0] === "EVAL" && commands[0][3] === room;
    if (mode === "full" && roomEval) return [[0, 0]];
    const replies = await real(commands);
    if (mode === "unknown" && roomEval) return ["not a receipt"];
    return replies;
  }) as typeof redis.pipeline;

  part("A room that said full gives the share back");
  const beforeFull = await poolTotal(pool);
  mode = "full";
  const full = await addProduct(OWNER, "Second", "Refused as full.", "5").then((made) => made.ok, () => false);
  mode = null;
  is("the save is refused", full, false);
  is("and the pool holds what it held before", await poolTotal(pool), beforeFull);

  part("A room that answered nothing readable keeps the share in the pool");
  const beforeUnknown = await poolTotal(pool);
  mode = "unknown";
  const unknown = await addProduct(OWNER, "Third", "Room unreadable.", "5").then((made) => made.ok, () => false);
  mode = null;
  is("the save is refused", unknown, false);
  is(`and the pool still holds the share it took (${BESIDE_PRODUCT} bytes and its field)`, await poolTotal(pool), beforeUnknown + BESIDE_PRODUCT + 64);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
