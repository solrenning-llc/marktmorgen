/**
 * The PayPal counts a reading of every sale is paid for by (lib/paypal-sales.ts, paypalKept; rule 24, MR).
 *
 * Before: a ZCARD reply cut short or of another shape was read as 0 sales or refunds, so a reading of them all
 * (lib/segments.ts buyerLedger, lib/broadcasts.ts subject tests, lib/product-updates.ts) took fewer studio units
 * than it then moved. Now each count is read exactly and anything else throws; every caller already refuses on it.
 *
 * Synthetic store id only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { paypalKept } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";

const STATS = "e".repeat(32);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

for (const refunds of [false, true]) {
  const n = refunds ? 2 : 1;
  for (const [label, reply] of [
    ["no reply", []],
    ["text", Array(n).fill("4")],
    ["a negative number", Array(n).fill(-1)],
    ["one reply too many", Array(n + 1).fill(4)],
  ] as [string, unknown[]][]) {
    test(`refunds ${refunds}: the counts read as ${label} are unknown, never 0`, async () => {
      redis.clear();
      redis.pipeline = (async (b: Batch) => (b[0]?.[0] === "ZCARD" ? reply : pipeline(b))) as typeof redis.pipeline;
      try {
        await assert.rejects(paypalKept(STATS, refunds));
      } finally {
        redis.pipeline = pipeline;
      }
    });
  }
  test(`refunds ${refunds}: exact counts are read as they are`, async () => {
    redis.clear();
    redis.pipeline = (async (b: Batch) => (b[0]?.[0] === "ZCARD" ? Array(n).fill(4) : pipeline(b))) as typeof redis.pipeline;
    try {
      assert.deepEqual(await paypalKept(STATS, refunds), { sales: 4, refunds: refunds ? 4 : 0 });
    } finally {
      redis.pipeline = pipeline;
    }
  });
}
