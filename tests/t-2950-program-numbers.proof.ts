/** Five synthetic cases: fixed envelope behavior and inherited record parsing. */
import assert from "node:assert/strict";
import { programNumbers } from "@/lib/affiliates";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
const store = { statsId: "a".repeat(32), currency: "usd" } as Store;
const person = JSON.stringify({ id: "aaaaaaaaaaaa", email: "affiliate@example.test", code: "aaaaaa", status: "approved" });
const sale = JSON.stringify({ ref: "legacy", aff: "aaaaaaaaaaaa", base: 2000, rate: 30, byCode: true });
const payout = JSON.stringify({ id: "legacy", aff: "aaaaaaaaaaaa", cents: 300 });
const healthy = () => [["aaaaaaaaaaaa", person], ["aaaaaaaaaaaa", "150"], ["legacy", sale], ["legacy", payout]];
let externalHttpAttempts = 0;
globalThis.fetch = (async () => { externalHttpAttempts += 1; throw Error("External HTTP forbidden"); }) as typeof fetch;

async function read(replies: unknown) {
  redis.pipeline = (async (commands: Commands) => {
    await original(commands);
    assert.equal(commands.length, 4);
    assert.ok(commands.every((command) => command[0] === "HGETALL"));
    return replies;
  }) as typeof redis.pipeline;
  try { return { rejected: false, value: await programNumbers(store) }; }
  catch (error) {
    if (!(error instanceof UnknownReplyError)) throw error;
    return { rejected: true, value: null };
  }
  finally { redis.pipeline = original; }
}

async function main(): Promise<void> {
  const results: { name: string; ok: boolean; actual: unknown }[] = [];
  const old = await read(healthy());
  results.push({ name: "legacy omitted currency and byCode remain valid", ok: old.value?.affiliates === 1 && old.value?.paidCents === 300 && old.value?.earnedCents === 600 && old.value?.clickSales === 0 && old.value?.since === 0, actual: old });

  const empty = await read([[], [], [], []]);
  results.push({ name: "confirmed empty hashes still yield zero", ok: empty.value?.paidCents === 0 && empty.value?.clicks === 0 && !empty.rejected, actual: empty });

  const missing = await read([]);
  results.push({ name: "the repaired missing envelope rejects", ok: missing.rejected, actual: missing });

  const brokenPayment = healthy();
  brokenPayment[3] = ["legacy", "{"];
  const payment = await read(brokenPayment);
  results.push({ name: "a malformed JSON payment record does not silently become zero paid", ok: payment.rejected, actual: payment });

  const brokenSale = healthy();
  brokenSale[2] = ["legacy", JSON.stringify({ ref: "legacy", aff: "aaaaaaaaaaaa", base: "unconfirmed", rate: 30, byCode: true })];
  const earning = await read(brokenSale);
  results.push({ name: "an unconfirmed sale amount does not silently become zero earned", ok: earning.rejected, actual: earning });

  assert.equal(results.length, 5);
  assert.equal(externalHttpAttempts, 0);
  console.log(JSON.stringify({ cases: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, externalHttpAttempts, results }, null, 2));
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
void main().catch((error: unknown) => { redis.pipeline = original; console.error(error); process.exitCode = 1; });
