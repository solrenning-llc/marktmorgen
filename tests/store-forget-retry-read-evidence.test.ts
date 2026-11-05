/**
 * CX-123 rule 24: a monthly store-forgetting report is available only when
 * Redis returns every field it says the hash contains. A partial HGETALL is
 * unknown; it must never turn a missing count into zero.
 */
import assert from "node:assert/strict";
import { storeForgetMonth } from "@/lib/store-forget-retry";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

const month = "2026-11";
const key = `nl:forget:month:${month}`;
const original = redis.pipeline.bind(redis);

async function withMonthReply(reply: unknown): Promise<unknown> {
  redis.pipeline = async (commands: Command[]) => {
    const answers = await original(commands);
    return answers.map((answer, index) => (index === 0 && commands[index]?.[0] === "HGETALL" && commands[index]?.[1] === key ? reply : answer));
  };
  try {
    return await storeForgetMonth(month);
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await original([["HSET", key, "queued", 7, "done", 5, "gaveUp", 2]]);

  const incomplete = [
    await withMonthReply(["queued", "7", "done", "5"]),
    await withMonthReply(["queued", "7", "done", "5", "other", "2"]),
    await withMonthReply(["queued", "7", "done", "5", "queued", "2"]),
  ];
  assert.deepEqual(incomplete, [null, null, null], "missing, foreign, or duplicate fields are unknown, never zero");

  assert.deepEqual(await storeForgetMonth(month), { month, queued: 7, done: 5, gaveUp: 2, waitingNow: 0, keptNow: 0 });

  redis.clear();
  assert.deepEqual(await storeForgetMonth("2026-12"), { month: "2026-12", queued: 0, done: 0, gaveUp: 0, waitingNow: 0, keptNow: 0 });

  console.log("store-forget retry read evidence: 5/5");
}

void main();
