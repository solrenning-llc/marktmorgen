/**
 * The kept record of each order made to order (761 [STN8], unit 2,
 * lib/made-to-order.ts), on the in-memory database. Checked: a paid sale is
 * kept once, with the person's one-way key and never their address; the
 * same sale again is "already"; a sale, an address or an order the rules
 * refuse is "invalid"; the store's cap and its data room refuse before
 * anything is written; the record ends by itself; the store's list is
 * written before the record; an answer in another shape is unknown, never
 * kept; a record that does not read is never taken as absent; the person's
 * copy and erasure take only their own records; and the module is named in
 * the person-data registry, the erasure and the copy.
 */
import { readFileSync } from "node:fs";
import { startOrder, moveStage } from "@/lib/made-to-order-rules";
import { CLOCK_SLACK_SECONDS, KEEP_SECONDS, MAX_KEPT_ORDERS, ROOM_BYTES, forgetMadeOrdersPerson, keepMadeOrder, madeOrdersOf, readMadeOrders } from "@/lib/made-to-order";
import type { DataStore } from "@/lib/store-data";
import { dataRoomFor } from "@/lib/store-data-rules";
import { PERSON_DATA } from "@/lib/person-data";
import { ERASERS } from "@/lib/person-erasure";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis) as Pipeline;

const STATS = "mto-stats-1";
const SHOP: DataStore = { sid: "mto-store-1", statsId: STATS, tier: "creator", subscriptionActive: true, subscriptionId: "sub_mto", trialEnds: 0, planEndedAt: "" };
const NOW = Date.now();
const PAID = Math.floor(NOW / 1000) - 3_600;
const order = startOrder({ paidAt: PAID, days: 14 })!;
const sale = (n: number) => `cs_test_${String(n).padStart(12, "0")}`;
const ANN = "ann@example.com";
const BOB = "bob@example.com";
const list = `nl:mto:i:${STATS}`;
const keys = async (pattern: string) => {
  const [scan] = await real([["SCAN", "0", "MATCH", pattern, "COUNT", 10_000]]);
  return Array.isArray(scan) && Array.isArray(scan[1]) ? (scan[1] as string[]) : [];
};
/** The made-to-order listing script (LIST_IF_ROOM), not the data-room script before it. */
const listing = (commands: Commands) => commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:mto-list-if-room:v1\n");
const reset = () => {
  redis.pipeline = real;
  redis.clear();
};

void (async () => {
  part("A paid sale is kept once, with a one-way key of the person");
  reset();
  is("kept", await keepMadeOrder(SHOP, { sale: sale(1), email: ANN, order }, NOW), "kept");
  is("the same sale again", await keepMadeOrder(SHOP, { sale: sale(1), email: ANN, order }, NOW), "already");
  const kept = await readMadeOrders(SHOP, NOW);
  is("the queue reads it back", kept?.records.map((r) => [r.sale, r.order]), [[sale(1), order]]);
  is("nothing unreadable", kept?.unreadable, 0);
  const records = await keys(`nl:mto:o:${STATS}:*`);
  is("one record key", records.length, 1);
  const [value] = await real([["GET", records[0]]]);
  is("the record never holds the address", typeof value === "string" && !value.includes("@") && !value.includes("ann"), true);
  const [ttl] = await real([["TTL", records[0]]]);
  is("it ends by itself, the payment plus KEEP_SECONDS", typeof ttl === "number" && ttl <= KEEP_SECONDS - 3_600 && ttl > KEEP_SECONDS - 3_700, true);
  const [listed] = await real([["ZCARD", list]]);
  is("listed once, though kept twice", listed, 1);
  const [roomUsed] = await real([["HGET", `nl:data:${SHOP.sid}`, "#"]]);
  is("its room was taken once", Number(roomUsed) >= ROOM_BYTES && Number(roomUsed) < 2 * ROOM_BYTES, true);

  part("What the rules refuse is never written");
  reset();
  const moved = moveStage(order, "in_production", PAID + 60);
  is("not a sale reference", await keepMadeOrder(SHOP, { sale: "order-1", email: ANN, order }, NOW), "invalid");
  is("an order already moved: only a new order is kept", moved.ok ? await keepMadeOrder(SHOP, { sale: sale(2), email: ANN, order: moved.order }, NOW) : null, "invalid");
  is("an order whose record would already have ended", await keepMadeOrder(SHOP, { sale: sale(3), email: ANN, order: startOrder({ paidAt: PAID - KEEP_SECONDS, days: 14 })! }, NOW), "invalid");
  is("not an address", await keepMadeOrder(SHOP, { sale: sale(4), email: "ann", order }, NOW), "invalid");
  is("a store with no id", await keepMadeOrder({ ...SHOP, statsId: null }, { sale: sale(5), email: ANN, order }, NOW), "invalid");
  is("nothing was written", (await keys("nl:mto:*")).length, 0);

  part("The store's cap and its room refuse before anything is written");
  reset();
  await real([["ZADD", list, ...Array.from({ length: MAX_KEPT_ORDERS }, (_, i) => [PAID + KEEP_SECONDS, `${String(i).padStart(32, "0")}`]).flat()]]);
  is("at the cap", await keepMadeOrder(SHOP, { sale: sale(6), email: ANN, order }, NOW), "full");
  is("no record written at the cap", (await keys(`nl:mto:o:${STATS}:*`)).length, 0);
  await real([["ZADD", list, Math.floor(NOW / 1000) - 1, "f".repeat(32)]]);
  await real([["ZREMRANGEBYSCORE", list, PAID + KEEP_SECONDS, PAID + KEEP_SECONDS]]);
  await real([["ZADD", list, ...Array.from({ length: MAX_KEPT_ORDERS - 1 }, (_, i) => [PAID + KEEP_SECONDS, `${String(i).padStart(32, "0")}`]).flat()]]);
  is("an ended record is taken off the list first, so a place opens", await keepMadeOrder(SHOP, { sale: sale(7), email: ANN, order }, NOW), "kept");
  reset();
  await real([["HSET", `nl:data:${SHOP.sid}`, "#", String(dataRoomFor(SHOP) - 10)]]);
  is("the room full", await keepMadeOrder(SHOP, { sale: sale(8), email: ANN, order }, NOW), "full");
  is("no record and no listing when the room is full", [(await keys(`nl:mto:o:${STATS}:*`)).length, (await real([["ZCARD", list]]))[0]], [0, 0]);

  part("An answer in another shape is unknown, never kept");
  reset();
  redis.pipeline = (async (commands: Commands) => (commands[0][0] === "ZREMRANGEBYSCORE" ? [0, "3", null] : real(commands))) as Pipeline;
  is("a count that is not one", await keepMadeOrder(SHOP, { sale: sale(9), email: ANN, order }, NOW), "unknown");
  is("nothing written on it", (await keys("nl:mto:*")).length, 0);
  reset();
  redis.pipeline = (async (commands: Commands) => (commands[0][0] === "SET" ? ["QUEUED"] : commands[0][0] === "GET" ? [42] : real(commands))) as Pipeline;
  is("a record write answered in another shape, not read back", await keepMadeOrder(SHOP, { sale: sale(10), email: ANN, order }, NOW), "unknown");
  redis.pipeline = real;
  is("the store's list was written before the record, so it can be found", (await real([["ZCARD", list]]))[0], 1);
  is("the same sale kept again writes the record, without taking room twice", await keepMadeOrder(SHOP, { sale: sale(10), email: ANN, order }, NOW), "kept");
  reset();
  redis.pipeline = (async (commands: Commands) => (commands[0][0] === "ZADD" ? [1, 0] : listing(commands) ? ["OK"] : real(commands))) as Pipeline;
  is("a list write that does not answer as it should", await keepMadeOrder(SHOP, { sale: sale(11), email: ANN, order }, NOW), "unknown");
  is("then no record is written", (await keys(`nl:mto:o:${STATS}:*`)).length, 0);

  part("The cap holds when keeps run at the same time");
  reset();
  await real([["ZADD", list, ...Array.from({ length: MAX_KEPT_ORDERS - 1 }, (_, i) => [PAID + KEEP_SECONDS, `${String(i).padStart(32, "0")}`]).flat()]]);
  const together = await Promise.all([20, 21, 22, 23, 24].map((i) => keepMadeOrder(SHOP, { sale: sale(i), email: ANN, order }, NOW)));
  is("one place left: one kept, the others full", [together.filter((r) => r === "kept").length, together.filter((r) => r === "full").length], [1, 4]);
  is("the list never passes the cap", (await real([["ZCARD", list]]))[0], MAX_KEPT_ORDERS);
  is("only the kept one has a record", (await keys(`nl:mto:o:${STATS}:*`)).length, 1);
  is("Ann's copy finds her record", (await madeOrdersOf(SHOP, ANN, NOW)).length, 1);
  is("and her erasure deletes it", await forgetMadeOrdersPerson(SHOP, ANN, NOW), 1);
  is("nothing of hers is left", (await keys(`nl:mto:o:${STATS}:*`)).length, 0);
  reset();
  redis.pipeline = (async (commands: Commands) => (listing(commands) ? [-1] : real(commands))) as Pipeline;
  is("the script finding a list key of another kind is unknown", await keepMadeOrder(SHOP, { sale: sale(25), email: ANN, order }, NOW), "unknown");
  is("and no record is written on it", (await keys(`nl:mto:o:${STATS}:*`)).length, 0);
  reset();
  redis.pipeline = (async (commands: Commands) => (listing(commands) ? [0] : real(commands))) as Pipeline;
  is("the script finding the list full is full", await keepMadeOrder(SHOP, { sale: sale(26), email: ANN, order }, NOW), "full");
  is("and no record is written then", (await keys(`nl:mto:o:${STATS}:*`)).length, 0);
  redis.pipeline = real;

  part("A list longer than the cap is never read as complete");
  reset();
  await real([["ZADD", list, ...Array.from({ length: MAX_KEPT_ORDERS + 1 }, (_, i) => [PAID + KEEP_SECONDS, `${String(i).padStart(32, "0")}`]).flat()]]);
  const throws = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return false;
    } catch {
      return true;
    }
  };
  is("the queue throws", await throws(() => readMadeOrders(SHOP, NOW)), true);
  is("the copy throws, never a copy missing records", await throws(() => madeOrdersOf(SHOP, ANN, NOW)), true);
  is("the erasure throws, never done with records left", await throws(() => forgetMadeOrdersPerson(SHOP, ANN, NOW)), true);

  part("A record that does not read is never absent");
  reset();
  await keepMadeOrder(SHOP, { sale: sale(12), email: ANN, order }, NOW);
  await keepMadeOrder(SHOP, { sale: sale(13), email: BOB, order }, NOW);
  const bobRecords: string[] = [];
  for (const key of await keys(`nl:mto:o:${STATS}:*`)) {
    const [v] = await real([["GET", key]]);
    if (typeof v === "string" && v.includes(sale(13))) bobRecords.push(key);
  }
  await real([["SET", bobRecords[0], "{not json", "EX", 600]]);
  const withBad = await readMadeOrders(SHOP, NOW);
  is("the queue counts it as unreadable", [withBad?.records.length, withBad?.unreadable], [1, 1]);
  let copyFailed = false;
  try {
    await madeOrdersOf(SHOP, ANN, NOW);
  } catch {
    copyFailed = true;
  }
  is("a person's copy does not pretend it is not theirs", copyFailed, true);
  let eraseFailed = false;
  try {
    await forgetMadeOrdersPerson(SHOP, ANN, NOW);
  } catch {
    eraseFailed = true;
  }
  is("nor does their erasure", eraseFailed, true);
  is("and the erasure deleted nothing", (await keys(`nl:mto:o:${STATS}:*`)).length, 2);
  redis.pipeline = (async (commands: Commands) => (commands[0][0] === "ZRANGEBYSCORE" ? ["not a list"] : real(commands))) as Pipeline;
  let listFailed = false;
  try {
    await readMadeOrders(SHOP, NOW);
  } catch {
    listFailed = true;
  }
  is("a list that does not read throws, never an empty queue", listFailed, true);

  part("A person's copy and erasure take only their own records");
  reset();
  await keepMadeOrder(SHOP, { sale: sale(14), email: ANN, order }, NOW);
  await keepMadeOrder(SHOP, { sale: sale(15), email: BOB, order }, NOW);
  await keepMadeOrder(SHOP, { sale: sale(16), email: "ANN@Example.com", order }, NOW);
  is("Ann's copy: her two sales, the address read in any case", (await madeOrdersOf(SHOP, ANN, NOW)).map((r) => r.sale).sort(), [sale(14), sale(16)]);
  is("Ann's erasure deletes her two", await forgetMadeOrdersPerson(SHOP, ANN, NOW), 2);
  is("Bob's stays", (await readMadeOrders(SHOP, NOW))?.records.map((r) => r.sale), [sale(15)]);
  is("and the list keeps only his", (await real([["ZCARD", list]]))[0], 1);
  is("Ann's copy is then empty", (await madeOrdersOf(SHOP, ANN, NOW)).length, 0);
  is("an ended record is not in the queue", (await readMadeOrders(SHOP, (PAID + KEEP_SECONDS) * 1000))?.records.length, 0);

  part("Named in the person-data registry, the erasure and the copy");
  const file = "lib/made-to-order.ts";
  is("person data says it is erased", PERSON_DATA.some((p) => p.file === file && p.how === "erased"), true);
  is("the erasure runs it", ERASERS.some((e) => e.module === file), true);
  is("the copy copies it", COPY_PLAN[file]?.how === "copied" && typeof COPIERS[file] === "function", true);
  is("the store data registry names both key families as the room", ["nl:mto:i:@lib/made-to-order.ts", "nl:mto:o:@lib/made-to-order.ts"].every((k) => readFileSync("tests/store-data-registry.ts", "utf8").includes(`"${k}": room(`)), true);

  part("A payment time in the future never outlives the store's list (Claude 3 on #3630, MEDIUM)");
  reset();
  const nowS = Math.floor(NOW / 1000);
  const future = startOrder({ paidAt: nowS + 5 * 365 * 86_400, days: 14 })!;
  is("paid years from now: refused, nothing written", [await keepMadeOrder(SHOP, { sale: sale(40), email: ANN, order: future }, NOW), (await keys("nl:mto:*")).length], ["invalid", 0]);
  const beyond = startOrder({ paidAt: nowS + CLOCK_SLACK_SECONDS + 1, days: 14 })!;
  is("just past the clock's slack: refused", await keepMadeOrder(SHOP, { sale: sale(41), email: ANN, order: beyond }, NOW), "invalid");
  const ahead = startOrder({ paidAt: nowS + CLOCK_SLACK_SECONDS, days: 14 })!;
  is("within the clock's slack: kept", await keepMadeOrder(SHOP, { sale: sale(42), email: ANN, order: ahead }, NOW), "kept");
  const [aheadRecord] = (await keys("nl:mto:o:*"));
  const [recordTtl] = await real([["TTL", aheadRecord]]);
  const [listTtl] = await real([["TTL", list]]);
  is("and its record never ends after the list that finds it", typeof recordTtl === "number" && typeof listTtl === "number" && recordTtl > 0 && recordTtl <= listTtl, true);
  const later = (nowS + KEEP_SECONDS - 1) * 1000;
  is("a second before the list ends, the copy still finds it", (await madeOrdersOf(SHOP, ANN, later)).length, 1);
  is("and the erasure deletes it", await forgetMadeOrdersPerson(SHOP, ANN, later), 1);

  reset();
  done();
})();
