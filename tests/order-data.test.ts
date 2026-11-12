/**
 * What an order really keeps (lib/order-data.ts): each write is charged what
 * it adds, never less than what is stored, a buyer who has bought before
 * costs next to nothing, and a store's room now holds many times the orders
 * the fixed ceiling let it. Runs the real code against the in-memory Redis
 * (tests/redis-stub.ts); scripts/test_order_data_redis.py runs the same
 * script on a real Redis and holds each charge to Redis's own MEMORY USAGE.
 */
import { ORDER_BOARD_ENTRY_BYTES, ORDER_COMMANDS, ORDER_ENTRY_BYTES, ORDER_KEY_BYTES, ORDER_WRITE, ORDER_WRITE_MAX, orderWriteCharged } from "@/lib/order-data";
import { dataKey, dataUsed } from "@/lib/store-data";
import { DATA_ROOM_BYTES, DATA_STEP_BYTES, orderDataBytes } from "@/lib/store-data-rules";
import { orderRoom, upsertContact } from "@/lib/contacts";
import { rememberBuyers } from "@/lib/buyer-library";
import { recordEnrollment } from "@/lib/learn";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { TIERS } from "@/lib/plan";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = { sid: "order-data-test" };
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const charge = (raw: number) => Math.ceil((raw * 5) / 4 / DATA_STEP_BYTES) * DATA_STEP_BYTES;

/** What the in-memory Redis holds for these keys, by the plain measure: every key's name, and every field, member and value. */
function stored(keys: string[]): number {
  let total = 0;
  for (const key of keys) {
    const type = String(redis.run(["TYPE", key]));
    if (type === "none") continue;
    total += bytes(key);
    if (type === "string") total += bytes(String(redis.run(["GET", key])));
    if (type === "hash") for (const piece of redis.run(["HGETALL", key]) as string[]) total += bytes(piece);
    if (type === "set") for (const m of redis.run(["SMEMBERS", key]) as string[]) total += bytes(m);
    if (type === "zset") for (const m of redis.run(["ZREVRANGE", key, 0, -1]) as string[]) total += bytes(m) + 8;
  }
  return total;
}

async function main() {
  part("The script, as Redis runs it");
  is("its sizes are the constants'", [ORDER_WRITE.includes(`local KEY = ${ORDER_KEY_BYTES}\n`), ORDER_WRITE.includes(`local ENTRY = ${ORDER_ENTRY_BYTES}\n`), ORDER_WRITE.includes(`local ZENTRY = ${ORDER_BOARD_ENTRY_BYTES}\n`), ORDER_WRITE.includes(`local STEP = ${DATA_STEP_BYTES}\n`), ORDER_WRITE.includes(`n > ${ORDER_WRITE_MAX} then`)], [true, true, true, true, true]);
  is("it runs the commands the code allows, and no other", ORDER_COMMANDS.every((name) => ORDER_WRITE.includes(`${name}=1`)) && (ORDER_WRITE.match(/[A-Z]+=1/g) ?? []).length === ORDER_COMMANDS.length, true);
  is("nothing is fixed in it", ORDER_WRITE.includes("${"), false);

  part("Each write is charged what it adds");
  const key = "nl:learn:enr:t:buyer";
  const first = await orderWriteCharged(owner, [["HSETNX", key, "p1", "1760000000"]]);
  is("a new key and field: its name and the key's own, the field, the value and the entry's own, a quarter more, in steps", first.charged, charge(bytes(key) + ORDER_KEY_BYTES + 2 + 10 + ORDER_ENTRY_BYTES));
  is("the reply is HSETNX's", first.replies, [1]);
  is("the room's slot for orders, and its total with the slot's own field", [redis.run(["HGET", dataKey(owner)!, "o"]), redis.run(["HGET", dataKey(owner)!, "#"])], [String(first.charged), String(first.charged + 64)]);
  const again = await orderWriteCharged(owner, [["HSETNX", key, "p1", "1760000001"]]);
  is("what is already there costs nothing: a buyer's second order of it", [again.charged, again.replies], [0, [0]]);
  const grow = await orderWriteCharged(owner, [["HSET", key, "p1", "17600000000000"]]);
  is("a value made longer is charged what it grew by", grow.charged, charge(4));
  is("one made shorter is charged nothing, and given nothing back", (await orderWriteCharged(owner, [["HSET", key, "p1", "1"]])).charged, 0);
  let refused: unknown = null;
  try {
    await orderWriteCharged(owner, [["GET", key]]);
  } catch (error) {
    refused = error;
  }
  is("a command outside the list is refused before it is sent", refused instanceof Error, true);
  refused = null;
  try {
    await orderWriteCharged(owner, [["SADD", key, "x"]]);
  } catch (error) {
    refused = error;
  }
  is("one Redis refuses throws, as a pipeline does", refused instanceof Error, true);

  part("Never below what is stored");
  redis.clear();
  const keys = Array.from({ length: 6 }, (_, i) => `nl:test:order:${i}`);
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  const word = () => "é€x😀abc".repeat(1 + rand(40)).slice(0, 1 + rand(200));
  let lowest = Infinity;
  for (let round = 0; round < 300; round += 1) {
    const k = keys[rand(keys.length)];
    const type = keys.indexOf(k) % 4;
    const command: (string | number)[] =
      type === 0 ? (rand(2) ? ["SET", k, word()] : ["SET", k, word(), "NX"])
      : type === 1 ? (rand(2) ? ["HSET", k, `f${rand(20)}`, word()] : ["HSETNX", k, `f${rand(20)}`, word()])
      : type === 2 ? ["SADD", k, `m${rand(50)}`, `m${rand(50)}`]
      : ["ZINCRBY", k, 1, `z${rand(30)}`];
    await orderWriteCharged(owner, [command]);
    const charged = Number(redis.run(["HGET", dataKey(owner)!, "o"]) ?? 0);
    lowest = Math.min(lowest, charged - stored(keys));
  }
  is("after each of 300 writes of every kind, all that was charged is at least all that is kept", lowest >= 0, true);

  part("What one order really leaves, and what a room now holds");
  redis.clear();
  const OWNER = "order-data@example.com";
  await claimHandle(OWNER, "orderdata", "Order Data", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const room = () => Number(redis.run(["HGET", dataKey(store)!, "o"]) ?? 0);
  const buy = async (email: string, productId: string, title: string) => {
    const before = room();
    await upsertContact(store.listId!, email, { agreed: false, explicit: false, source: "buyer", sid: store.sid, productId, title, at: new Date().toISOString() }, orderRoom(store));
    await rememberBuyers(store.sid, [email]);
    await recordEnrollment(store, email, productId, Math.floor(Date.now() / 1000), "stripe");
    return room() - before;
  };
  const newBuyer = await buy("first.buyer@example.com", "prod_course_one", "The Weeknight Course");
  const repeat = await buy("first.buyer@example.com", "prod_guide_two", "The Spice Guide");
  const fixed = orderDataBytes(1);
  console.log(`  a new buyer's one-product course order leaves ${newBuyer} bytes, a repeat buyer's next ${repeat}; the ceiling held at the checkout is ${fixed}`);
  is("a new buyer's order is a small part of the ceiling it was charged before", newBuyer > 0 && newBuyer * 4 < fixed, true);
  is("a buyer who has bought before costs less still", repeat < newBuyer, true);
  for (const tier of TIERS) {
    const before = Math.floor(DATA_ROOM_BYTES[tier] / fixed);
    const now = Math.floor(DATA_ROOM_BYTES[tier] / newBuyer);
    console.log(`  ${tier}: ${DATA_ROOM_BYTES[tier].toLocaleString("en-US")} bytes held ${before.toLocaleString("en-US")} orders at the fixed charge; ${now.toLocaleString("en-US")} orders of new buyers now, each a new address`);
  }
  is("the order's own records were all counted, nothing kept beside them uncounted", (await dataUsed(store))!.orders, room());
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
