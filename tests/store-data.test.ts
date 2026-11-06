/**
 * A store's data room (lib/store-data.ts): what it keeps is taken before it
 * is written and refused past the room, what it deletes is given back, what
 * expires by itself comes off with its month, and an order is never refused
 * once paid, because its room was held when its checkout opened (what it
 * really writes is charged by lib/order-data.ts, tests/order-data.test.ts). Runs the
 * real code against the in-memory Redis (tests/redis-stub.ts);
 * scripts/test_store_data_redis.py runs the same script on a real Redis.
 */
import { DataRoomError, dataKey, dataUsed, giveData, keepFor, needData, noteData, takeData } from "@/lib/store-data";
import { orderWriteCharged } from "@/lib/order-data";
import { DATA_FULL_BUYER_WORDS, DATA_ROOM_BYTES, NON_PAYING_DATA_ROOM_BYTES, ORDER_DATA_BYTES, contentRoomFor, dataBytes, dataFullWords, dataRoomFor, itemsHandedOver, orderDataBytes, orderReserveFor, utf8Length } from "@/lib/store-data-rules";
import { StoreFullError } from "@/lib/store-full";
import { cappedCount, cappedCountCommand } from "@/lib/capped-count";
import { admitOrders } from "@/lib/order-admission";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const paid = { sid: "data-test-1", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };
const now = Date.UTC(2026, 9, 18, 12);

async function main() {
  part("What a room is, by plan");
  is("a paid store's room is its plan's", dataRoomFor(paid, now / 1000), DATA_ROOM_BYTES.creator);
  is("a free trial's, and an ended plan's", [dataRoomFor({ ...paid, trialEnds: now / 1000 + 86_400 }, now / 1000), dataRoomFor({ ...paid, subscriptionActive: false }, now / 1000)], [NON_PAYING_DATA_ROOM_BYTES.trial, NON_PAYING_DATA_ROOM_BYTES.ended]);
  is("what a store keeps may fill it up to two windows of its orders from the top", contentRoomFor(paid, now / 1000), DATA_ROOM_BYTES.creator - orderReserveFor(paid, now / 1000));
  is("bytes are UTF-8 and every entry counts, rounded up", [utf8Length("añ€😀"), dataBytes(["abc"], 1), dataBytes("x".repeat(17), 0)], [10, 144, 32]);
  is("an order takes what it hands over", [orderDataBytes(1), orderDataBytes(3) - orderDataBytes(1)], [ORDER_DATA_BYTES + (orderDataBytes(2) - orderDataBytes(1)), 2 * (orderDataBytes(2) - orderDataBytes(1))]);
  is("a bundle hands over each of its items", itemsHandedOver([{ bundle: ["a", "b", "c"] }, { bundle: null }]), 4);

  part("Taken before it is written, refused past the room");
  const room = contentRoomFor(paid, now / 1000);
  const first = await takeData(paid, [{ slot: "p:one", bytes: 1_000, set: true }], now);
  is("a write that fits is taken, with its own field", first, { ok: true, used: 1_064 });
  const big = await takeData(paid, [{ slot: "p:two", bytes: room, set: true }], now);
  is("one past the room is refused with what it is", big.ok ? "taken" : [big.reason, big.used], ["full", 1_064]);
  is("and the creator is told in plain words", big.ok ? "" : big.message, dataFullWords(1_064, DATA_ROOM_BYTES.creator));
  is("nothing of it was written", (await dataUsed(paid, now))?.used, 1_064);
  let thrown: unknown = null;
  try {
    await needData(paid, [{ slot: "p:two", bytes: room, set: true }], now);
  } catch (error) {
    thrown = error;
  }
  is("needData says it as a full store, so every studio route answers it", [thrown instanceof DataRoomError, thrown instanceof StoreFullError], [true, true]);
  is("a buyer is told it is the store's room, not theirs", DATA_FULL_BUYER_WORDS.includes("store"), true);
  await giveData(paid, [{ slot: "p:one", bytes: 0, set: true }], now);
  is("deleting gives the room back, field and all", (await dataUsed(paid, now))?.used, 0);
  await giveData(paid, [{ slot: "p:one", bytes: 500 }], now);
  is("and never below nothing", (await dataUsed(paid, now))?.used, 0);

  part("What expires by itself comes off with its month");
  const inTwoMonths = Date.UTC(2026, 11, 2);
  is("a record kept until December is counted until then", await keepFor(paid, 2_000, (inTwoMonths - now) / 1000, now), true);
  is("in the room", (await dataUsed(paid, now))?.used, 2_064);
  await takeData(paid, [{ slot: "p:any", bytes: 10 }], Date.UTC(2027, 0, 3));
  is("and gone once its month is over", (await dataUsed(paid, Date.UTC(2027, 0, 3)))?.used, 74);
  is("a cache that does not fit is not kept", await keepFor(paid, room * 2, 60, now), false);

  part("An order is never refused once paid");
  await noteData(paid, [{ slot: "p:huge", bytes: room, set: true }], now);
  const left = await orderWriteCharged(paid, [["HSETNX", "nl:learn:enr:data-test:buyer", "p1", "1760000000"], ["SADD", "nl:lib:data-test-buyer", "a".repeat(32)]]);
  const used = (await dataUsed(paid, now))!;
  is("what an order leaves is added whatever the room holds, at what it really adds", [used.orders, left.charged > 0, left.charged < orderDataBytes(1)], [left.charged, true, true]);
  is("so the room may be passed by what was paid for", used.used > room, true);

  part("A checkout is held only while the room has space for its order");
  const OWNER = "data-room@example.com";
  await claimHandle(OWNER, "dataroom", "Data Room", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Data0001", subscriptionId: "sub_Data0001", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const at = Date.now();
  is("an empty room admits a checkout", (await admitOrders(store, 1, at)).ok, true);
  await noteData(store, [{ slot: "p:full", bytes: dataRoomFor(store, at / 1000) - orderDataBytes(1) * 2, set: true }], at);
  is("a room with space for one more order admits one", (await admitOrders(store, 1, at)).ok, false);
  await giveData(store, [{ slot: "p:full", bytes: 0, set: true }], at);
  is("room made, sales go on", (await admitOrders(store, 1, at)).ok, true);
  is("a store is known by its id", dataKey(store)?.startsWith("nl:data:"), true);

  part("Unknown is not zero");
  const key = dataKey(paid)!;
  redis.run(["HSET", key, "#", "x"]);
  const unread = await takeData(paid, [{ slot: "p:x", bytes: 1 }], now);
  is("a room that cannot be read takes nothing", unread.ok ? "taken" : unread.reason, "unknown");
  thrown = null;
  try {
    await needData(paid, [{ slot: "p:x", bytes: 1 }], now);
  } catch (error) {
    thrown = error;
  }
  is("and is an ordinary failure, to try again, not a full store", [thrown instanceof Error, thrown instanceof DataRoomError], [true, false]);
  is("a change that is not a number is refused before anything", (await takeData({ ...paid, sid: "data-test-2" }, [{ slot: "p:x", bytes: Number.NaN }], now)).ok, false);

  part("Counts that never grow a hash past its most");
  const counts = "nl:test:capped";
  is("new names fill the hash to its most", await cappedCount(counts, 2, [{ field: "a", by: 1 }, { field: "b", by: 1 }, { field: "c", by: 4 }]), [1, 1, 0]);
  is("what does not fit is counted under ~, and a name there always counts", [await cappedCount(counts, 2, [{ field: "a", by: 1 }]), redis.run(["HGET", counts, "~"])], [[2], "4"]);
  // What it runs inside, which Upstash bills one by one beside the EVAL
  // (https://upstash.com/docs/redis/overall/billing, read 31 October 2026;
  // 313 [CV1]): one HLEN a hash and one HINCRBY a count, and one HMGET more
  // for a hash a new name may not fit in. Version 1 asked HEXISTS, and for a
  // new name HLEN, before every count. scripts/test_capped_count_redis.py
  // holds the same figures on a real server.
  const inside = async (most: number, names: string[]) => {
    const before = redis.scriptCalls;
    await cappedCount("nl:test:capped-calls", most, names.map((field) => ({ field, by: 1 })));
    return redis.scriptCalls - before;
  };
  is("counting names that all fit runs its length once and a count each", await inside(10, ["v", "r:a", "k:US", "d:mobile"]), 1 + 4);
  is("near its most, one read more says which are there", await inside(5, ["v", "r:b", "k:BR"]), 1 + 1 + 3);
  let twice: unknown = null;
  try {
    await redis.pipeline([cappedCountCommand([{ key: "nl:test:capped-twice", most: 3 }, { key: "nl:test:capped-twice", most: 1 }], [{ hash: 0, field: "p", by: 1 }, { hash: 1, field: "q", by: 1 }])]);
  } catch (error) {
    twice = error;
  }
  is("the same hash named twice is refused, and nothing is written", [twice instanceof Error, redis.run(["HLEN", "nl:test:capped-twice"])], [true, 0]);
  is("and the same names again, past it, as many", [await inside(5, ["v", "r:c", "k:DE"]), redis.run(["HLEN", "nl:test:capped-calls"]), Number(redis.run(["HGET", "nl:test:capped-calls", "~"]))], [1 + 1 + 3, 6, 3]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
