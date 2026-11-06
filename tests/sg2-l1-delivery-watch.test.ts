/**
 * The delivery watch reads its counters only in their exact shape (audit
 * SG2, CX-123 rule 24).
 *
 * - storesOverAllowance (lib/delivery.ts), read by the daily usage watch,
 *   turned a malformed SMEMBERS into "no store is over" and a malformed
 *   total into 0 bytes, and a Redis error into an empty list: the watch then
 *   logged that every store was inside the allowance. Now an unknown reply
 *   or an error throws, so the run fails visibly and is tried again; a total
 *   whose key is gone (no key) is 0 and is not named.
 * - recordDelivery read INCRBY's total with Number(): an unknown total was
 *   "recorded", and a crossing could be missed. Now it answers whether the
 *   delivery was counted, only on a whole total at least the bytes just
 *   added; on anything else the store is put on the month's list to look at
 *   (the watch reads the real total and names it only when it is over).
 */
import { DELIVERY_ALLOWANCE_BYTES, monthKey, recordDelivery, storesOverAllowance } from "@/lib/delivery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const sent: (string | number)[][][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(commands);
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const first = (name: string, prefix: string) => (commands: (string | number)[][]) =>
  commands[0]?.[0] === name && String(commands[0]?.[1]).startsWith(prefix);
const overList = `nl:store:delivery:over:${monthKey()}`;
const listedSince = (from: number, folder: string) =>
  sent.slice(from).some((commands) => commands.some((c) => c[0] === "SADD" && c[1] === overList && c[2] === folder));

async function outcome<T>(run: () => Promise<T>): Promise<T | "rejected"> {
  try {
    return await run();
  } catch {
    return "rejected";
  }
}

const GB = 1024 * 1024 * 1024;
const file = (folder: string) => `stores/${folder}/products/thing.zip`;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("recordDelivery: counted only on a whole total");
  for (const [label, reply] of [
    ["a total that is null", [null, 1]],
    ["a total written as text", ["20", 1]],
    ["a fractional total", [10.5, 1]],
    ["a negative total", [-10, 1]],
    ["a total below what was just added", [3, 1]],
    ["a total that is an object", [{ n: 20 }, 1]],
    ["the EXPIRE's answer missing", [20]],
    ["an empty reply", []],
    ["a reply that is not a list", { result: 20 }],
    ["a Redis that cannot be asked", "throw"],
  ] as [string, unknown][]) {
    rule = { when: first("INCRBY", "nl:store:delivery:"), reply };
    const from = sent.length;
    is(`${label}: not counted`, await recordDelivery(file("odd"), 10), false);
    if (reply !== "throw") is(`${label}: the store is put on the month's list to look at`, listedSince(from, "odd"), true);
  }
  rule = { when: first("INCRBY", "nl:store:delivery:"), reply: [10, 1] };
  {
    const from = sent.length;
    is("an exact total: counted", await recordDelivery(file("fine"), 10), true);
    is("and not listed, being far inside", listedSince(from, "fine"), false);
  }
  rule = null;
  {
    const from = sent.length;
    is("the real counter: counted", await recordDelivery(file("real"), DELIVERY_ALLOWANCE_BYTES - 1), true);
    is("inside: not listed", listedSince(from, "real"), false);
    is("the delivery that crosses: counted", await recordDelivery(file("real"), 2), true);
    is("and listed once, as before", listedSince(from, "real"), true);
  }
  is("nothing to count (no bytes) is not a failure", await recordDelivery(file("real"), 0), true);
  is("nor a file outside any store", await recordDelivery("elsewhere/thing.zip", 10), true);

  part("storesOverAllowance: an unknown list or total is never 'nobody is over'");
  redis.clear();
  await recordDelivery(file("big"), DELIVERY_ALLOWANCE_BYTES + 5 * GB);
  await recordDelivery(file("small"), GB);
  await redis.pipeline([["SADD", overList, "small"]]);
  rule = null;
  is("the real list: only the store really over", await storesOverAllowance(), [{ folder: "big", bytes: DELIVERY_ALLOWANCE_BYTES + 5 * GB }]);
  for (const [label, reply] of [
    ["the list answered null", [null]],
    ["the list holding a number", [["big", 1]]],
    ["the list as an object", [{ big: 1 }]],
    ["an empty reply", []],
    ["a reply that is not a list", { result: ["big"] }],
    ["a Redis that cannot be asked", "throw"],
  ] as [string, unknown][]) {
    rule = { when: first("SMEMBERS", "nl:store:delivery:over:"), reply };
    is(`${label}: refused, never an empty list`, await outcome(() => storesOverAllowance()), "rejected");
  }
  for (const [label, reply] of [
    ["a total that is not a number", ["lots", "1"]],
    ["a negative total", ["-5", "1"]],
    ["a fractional total", ["1.5", "1"]],
    ["a total that is true", [true, "1"]],
    ["one total missing", ["1"]],
    ["a total too many", ["1", "1", "1"]],
    ["a reply that is not a list", { result: "1" }],
    ["a Redis that cannot be asked", "throw"],
  ] as [string, unknown][]) {
    rule = { when: (commands) => commands.length === 2 && commands.every((c) => c[0] === "GET"), reply };
    is(`${label}: refused, never 0 bytes`, await outcome(() => storesOverAllowance()), "rejected");
  }
  rule = { when: (commands) => commands.length === 2 && commands.every((c) => c[0] === "GET"), reply: [null, String(DELIVERY_ALLOWANCE_BYTES + 1)] };
  const listed = await storesOverAllowance();
  is("a total whose key is gone is 0 and not named; the rest are read", listed.map((row) => row.bytes), [DELIVERY_ALLOWANCE_BYTES + 1]);
  rule = null;

  done();
}

void main();
