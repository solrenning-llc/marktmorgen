/**
 * Issue #4310 (money, rule 24): the list of what each member paid for past a
 * closing store's last day (`nl:closing:paid:<folder>`) is read exactly.
 *
 * Before this, `paidPeriods` read an HGETALL reply of another shape as "no
 * members" and silently left out a row it could not parse. On the closing day
 * that let `giveBackUnused` find nothing to refund, the closing write
 * `refunds`, and `forgetHeld` delete the only record of what members paid.
 * Now any reply that is not exactly a list of field/value strings, and any row
 * that does not read with its required fields, throws UnknownReplyError; the
 * closing's callers already turn that into "held, tried again tomorrow".
 *
 * Against the Redis stand-in only; nothing real is reached.
 */
import { paidKey, paidPeriods } from "@/lib/closing-holds";
import { unusedRows } from "@/lib/closing-refunds";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);

const SUB = "sub_1PaidPeriodsExact";
const NOW_S = Math.floor(Date.now() / 1000);
const ROW = JSON.stringify({ inv: "in_1PaidPeriodsExact", amt: 1500, tot: 1500, cur: "usd", ps: NOW_S - 10 * 86400, pe: NOW_S + 20 * 86400, e: "member@example.com" });

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return value instanceof Map ? `read ${value.size}` : Array.isArray(value) ? `read ${value.length}` : "read";
  } catch (error) {
    return error instanceof Error && error.name === "UnknownReplyError" ? "threw" : `other: ${String(error)}`;
  }
}

/** Every HGETALL of the paid list answers `reply` instead, for one run. */
async function withPaidReply(key: string, reply: unknown, run: () => Promise<unknown>): Promise<string> {
  redis.pipeline = async (commands: Commands) => {
    const real = await realPipeline(commands);
    return commands.map((command, i) => (command[0] === "HGETALL" && command[1] === key ? reply : real[i]));
  };
  try {
    return await outcome(run);
  } finally {
    redis.pipeline = realPipeline;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("paid-exact@example.com", "paidexact", "Paid Exact", "");
  const store = await storeForEmail("paid-exact@example.com");
  if (!store) throw new Error("the test store was not made");
  const key = paidKey(await storeFolder(storeRef(store)));

  part("Control: a member's row written down reads as one member");
  await redis.pipeline([["HSET", key, SUB, ROW]]);
  is("one row reads", await outcome(() => paidPeriods(store)), "read 1");

  part("Rule 24: a reply in another shape is unknown, never no members");
  is("a string", await withPaidReply(key, "garbled", () => paidPeriods(store)), "threw");
  is("a number", await withPaidReply(key, 1, () => paidPeriods(store)), "threw");
  is("an odd-length list", await withPaidReply(key, [SUB, ROW, "extra"], () => paidPeriods(store)), "threw");
  is("a list holding a number", await withPaidReply(key, [SUB, 7], () => paidPeriods(store)), "threw");
  is("an object", await withPaidReply(key, { [SUB]: ROW }, () => paidPeriods(store)), "threw");
  is("an empty list is a confirmed empty hash", await withPaidReply(key, [], () => paidPeriods(store)), "read 0");

  part("Rule 24: a member's row that does not read is unknown, never left out");
  await redis.pipeline([["HSET", key, "sub_2PaidPeriodsExact", "{not json"]]);
  is("a row that is not JSON", await outcome(() => paidPeriods(store)), "threw");
  await redis.pipeline([["HSET", key, "sub_2PaidPeriodsExact", JSON.stringify({ cur: "usd", inv: "in_2" })]]);
  is("a row without its amount", await outcome(() => paidPeriods(store)), "threw");
  await redis.pipeline([["HSET", key, "sub_2PaidPeriodsExact", JSON.stringify({ amt: 900, cur: "usd" })]]);
  is("a row without its invoice", await outcome(() => paidPeriods(store)), "threw");
  await redis.pipeline([["HSET", key, "sub_2PaidPeriodsExact", JSON.stringify({ ...JSON.parse(ROW), pe: undefined })]]);
  is("a row without the end of its period", await outcome(() => paidPeriods(store)), "threw");
  await redis.pipeline([["HSET", key, "sub_2PaidPeriodsExact", "null"]]);
  is("a row that is JSON null", await outcome(() => paidPeriods(store)), "threw");
  await redis.pipeline([["HDEL", key, "sub_2PaidPeriodsExact"], ["HSET", key, "not-a-sub", ROW]]);
  is("a field that is not a subscription id", await outcome(() => paidPeriods(store)), "threw");
  await redis.pipeline([["HDEL", key, "not-a-sub"]]);

  part("The refunds read the same list: an unknown is never zero rows to give back");
  is("unusedRows over a garbled reply", await withPaidReply(key, "garbled", () => unusedRows(store, Date.now())), "threw");
  is("unusedRows over a readable list", await outcome(() => unusedRows(store, 0)), "read 1");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
