/**
 * The weekly samples the benchmark ranges are worked out from are read exactly (lib/benchmarks.ts, refreshRanges;
 * CX-123 rule 24). Found by Claude 3 (cloud D)'s audit of main (11 November 2026): a week whose HGETALL answered in
 * another shape was read as a week with no samples, and the ranges worked out from what was left were written over
 * the ones kept, so a lost reply took every creator's "stores like yours" ranges away until the next day's run. Now
 * such a reply throws UnknownReplyError (the plans cron logs it), and the ranges kept stay as they were.
 * Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { readRanges, refreshRanges } from "@/lib/benchmarks";
import { UnknownReplyError } from "@/lib/redis-reply";

const real = redis.pipeline.bind(redis);
let odd: { reply: unknown } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = (await real(commands)) as unknown[];
  if (!odd || !commands.some((c) => c[0] === "HGETALL")) return replies;
  if (odd.reply === "LOST") return [];
  return commands.map((c, i) => (c[0] === "HGETALL" ? odd!.reply : replies[i]));
}) as typeof redis.pipeline;

const KEPT = { at: 1_780_000_000, stores: 12, ranges: { small: { conversion: { low: 1, median: 2, high: 3, stores: 12 } } } };

beforeEach(async () => {
  redis.clear();
  odd = null;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await real([["SET", "nl:bench:ranges", JSON.stringify(KEPT)]]);
});

for (const reply of ["LOST", "lots", 7, null, { a: 1 }, ["only-a-field"], [1, "{}"]]) {
  test(`a week of samples read ${JSON.stringify(reply)} is unknown: nothing is worked out or written over`, async () => {
    const before = await real([["GET", "nl:bench:ranges"]]);
    odd = { reply };
    await assert.rejects(refreshRanges(), (e) => e instanceof UnknownReplyError);
    odd = null;
    assert.deepEqual(await real([["GET", "nl:bench:ranges"]]), before);
  });
}

test("readable replies: two empty weeks work out ranges from no stores, as before", async () => {
  const kept = await refreshRanges();
  assert.equal(kept?.stores, 0);
  assert.equal((await readRanges())?.stores, 0);
});
