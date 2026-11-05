/** Real measuring/refusal boundary; only MemoryRedis and synthetic records. */
import test from "node:test";
import assert from "node:assert/strict";
import { recentEvents, type Hold } from "@/lib/api-read";
import { apiError } from "@/lib/api-guard";
import { LOG_SIZE } from "@/lib/webhooks";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
const shop = { statsId: "7".repeat(32) } as Store;
const log = `nl:hooks:log:${shop.statsId}`;
const ids = Array.from({ length: LOG_SIZE }, (_, i) => "dlv_" + i.toString(16).padStart(24, "0"));
async function world(first: boolean, refusal: Response) {
 redis.clear();
 const base = redis.pipeline.bind(redis);
 const payload = JSON.stringify({ note: "synthetic payload, deliberately not read", body: "x".repeat(30000) });
 await base([["RPUSH", log, ...ids], ...ids.map(id => ["SET", "nl:hooks:d:" + id, payload])]);
 const commands: (string | number)[][] = [];
 const holds: number[] = [], settled: number[] = [];
 const order: string[] = [];
 redis.pipeline = async batch => { commands.push(...batch); order.push(...batch.map(c => String(c[0]))); return base(batch); };
 const hold: Hold = async most => {
  holds.push(most); order.push("hold");
  if (first || holds.length === 2) return refusal;
  return async actual => { settled.push(actual); order.push("settle"); return null; };
 };
 try { return { out: await recentEvents(shop, "sale.completed", 10, hold), commands, holds, settled, order }; }
 finally { redis.pipeline = base; }
}
test("monthly refusal after measuring retains paid measuring and reads no event payload", async () => {
 const result = await world(false, apiError(429, "monthly_limit", "Synthetic refusal"));
 assert.ok(result.out instanceof Response);
 assert.equal(result.out.status, 429);
 const body = await result.out.json();
 assert.equal(body.error, "monthly_limit");
 assert.match(body.message, /so no event was read\. The requests used to measure them stay counted\./);
 assert.doesNotMatch(body.message, /nothing was read/);
 assert.equal(result.order[0], "hold", "measuring must be admitted before its first command");
 assert.equal(result.holds.length, 2);
 assert.ok(result.holds[1] > 0);
 assert.ok(result.settled.length === 1 && result.settled[0] > 0 && result.settled[0] <= result.holds[0]);
 assert.deepEqual(result.commands.map(c => c[0]), ["LRANGE", ...ids.map(() => "STRLEN")]);
 assert.equal(result.order.at(-1), "settle");
});
test("initial admission refusal preserves its response and reads nothing", async () => {
 const refusal = apiError(429, "monthly_limit", "Initial admission was refused");
 const result = await world(true, refusal);
 assert.equal(result.out, refusal);
 assert.deepEqual(result.commands, []);
 assert.deepEqual(result.settled, []);
});
test("a different second-stage refusal preserves its exact status and words", async () => {
 const refusal = apiError(503, "unavailable", "Synthetic unavailable admission");
 const result = await world(false, refusal);
 assert.equal(result.out, refusal);
 assert.deepEqual(result.commands.map(c => c[0]), ["LRANGE", ...ids.map(() => "STRLEN")]);
 assert.ok(result.settled.length === 1 && result.settled[0] > 0);
});
