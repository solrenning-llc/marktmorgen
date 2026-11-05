/**
 * CX-123 rule 24: a monthly store-forgetting report is available only when
 * Redis returns every field it says the hash contains. A partial HGETALL is
 * unknown; it must never turn a missing count into zero.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { storeForgetMonth } from "@/lib/store-forget-retry";
import { store as redis } from "./redis-stub";
import { NOT_A_COST } from "./plan-cost-registry";

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
  await original([["HSET", key, "queued", 1]]);
  assert.deepEqual(await storeForgetMonth(month), { month, queued: 1, done: 0, gaveUp: 0, waitingNow: 0, keptNow: 0 });

  redis.clear();
  assert.deepEqual(await storeForgetMonth("2026-12"), { month: "2026-12", queued: 0, done: 0, gaveUp: 0, waitingNow: 0, keptNow: 0 });

  const findings: string[] = [];
  redis.pipeline = async () => { throw new Error("transport unavailable"); };
  try {
    if (await storeForgetMonth(month) !== null) findings.push("a rejected Redis transport did not become unknown");
  } catch {
    findings.push("a rejected Redis transport escaped instead of becoming unknown");
  } finally {
    redis.pipeline = original;
  }

  const source = readFileSync("lib/store-forget-retry.ts", "utf8");
  if (!/export const STORE_FORGET_MONTH_READ_COMMANDS\s*=\s*4\b/.test(source)) findings.push("the four-command read has no named ceiling");
  const attribution = NOT_A_COST.STORE_FORGET_MONTH_READ_COMMANDS;
  if (!attribution || !/company/i.test(attribution) || !/unknown|not wired|before/i.test(attribution)) findings.push("the company read has no explicit non-zero attribution");

  assert.deepEqual(findings, []);
  console.log("store-forget retry read evidence: 8/8");
}

void main();
