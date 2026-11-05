import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storeForgetLine, storeForgetMonth } from "@/lib/store-forget-retry";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
const month = "2026-11", key = `nl:forget:month:${month}`;
const original = redis.pipeline.bind(redis);
let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
async function reply(value: unknown) {
  redis.pipeline = async () => value as unknown[];
  try { return await storeForgetMonth(month); } finally { redis.pipeline = original; }
}
async function main() {
  await check("real complete sparse and empty monthly hashes keep known zeroes", async () => {
    redis.clear(); assert.equal((await storeForgetMonth(month))?.queued, 0);
    await original([["HSET", key, "done", 3]]);
    assert.deepEqual(await storeForgetMonth(month), { month, queued: 0, done: 3, gaveUp: 0, waitingNow: 0, keptNow: 0 });
    await original([["HSET", key, "queued", 7, "gaveUp", 1]]);
    assert.deepEqual(await storeForgetMonth(month), { month, queued: 7, done: 3, gaveUp: 1, waitingNow: 0, keptNow: 0 });
  });
  await check("missing outer replies are unknown", async () => { assert.equal(await reply([]), null); });
  await check("extra outer replies are unknown", async () => { assert.equal(await reply([[], 0, 0, 0, 0]), null); });
  await check("partial HGETALL cannot match confirmed HLEN", async () => {
    assert.equal(await reply([["queued", "7", "done", "3"], 3, 0, 0]), null);
  });
  await check("foreign and duplicate hash fields are unknown", async () => {
    for (const flat of [["queued", "7", "other", "3"], ["queued", "7", "queued", "3"]])
      assert.equal(await reply([flat, 2, 0, 0]), null);
  });
  await check("non-count shapes at every HLEN position are unknown", async () => {
    for (const bad of [null, "0", -1, 0.5, NaN, Infinity]) for (let position = 1; position <= 3; position++) {
      const replies: unknown[] = [[], 0, 0, 0]; replies[position] = bad;
      assert.equal(await reply(replies), null);
    }
  });
  await check("monthly counts accept canonical safe digits only", async () => {
    for (const bad of ["", "-1", "1.0", " 1", "01", "9007199254740992"])
      assert.equal(await reply([["queued", bad], 1, 0, 0]), null);
  });
  await check("known queue and kept sizes are preserved in the report", async () => {
    const result = await reply([["gaveUp", "2"], 1, 4, 6]);
    assert.deepEqual(result, { month, queued: 0, done: 0, gaveUp: 2, waitingNow: 4, keptNow: 6 });
    assert.match(storeForgetLine(result), /4 aguardando nova tentativa; 6 com dados ainda guardados/);
    assert.match(storeForgetLine(null), /estado é desconhecido/);
  });
  await check("invalid month never sends a paid read", async () => {
    let commands = 0; redis.pipeline = async () => { commands++; return []; };
    try { assert.equal(await storeForgetMonth("2026-13"), null); assert.equal(commands, 0); }
    finally { redis.pipeline = original; }
  });
  await check("LATENT: transport rejection should keep the documented unknown report state", async () => {
    redis.pipeline = async () => { throw new Error("Synthetic Redis outage"); };
    try { assert.equal(await storeForgetMonth(month), null); }
    finally { redis.pipeline = original; }
  });
  await check("LATENT: added paid HLEN has an explicit company reader registry entry", async () => {
    redis.clear(); const sent: Command[][] = [];
    redis.pipeline = async (commands: Command[]) => { sent.push(commands); return original(commands); };
    try { await storeForgetMonth(month); } finally { redis.pipeline = original; }
    console.log(JSON.stringify({ paidCommands: sent.flat().length, commands: sent.flat().map(c => [c[0], c[1]]), writes: sent.flat().filter(c => !["HLEN", "HGETALL"].includes(String(c[0]))).length }));
    const registry = readFileSync(join(process.cwd(), "tests/plan-cost-registry.ts"), "utf8");
    assert.match(registry, /store-forget-retry|STORE_FORGET_MONTH|FORGET_MONTH_READ/, "The new reader command needs its own company-cost attribution, separate from storage and per-try work");
  });
  console.log(`${passed} passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
