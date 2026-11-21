/**
 * Claude 4 (cloud N) on #2509, MEDIUM: lib/redis.ts now throws UnknownReplyError for a batch Upstash answered out of
 * shape (short, extra, or without `result`). withinLimit and withinMonth keep failing open when Redis cannot be asked
 * at all (a transport failure), but an answer out of shape is an unknown count, never room (SG2 17, rule 24, MR):
 * both must refuse it, as they did on main when the same shape reached countWithin.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withinLimit, withinMonth } from "@/lib/request-guard";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

async function whenPipelineThrows<T>(error: Error, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async () => { throw error; };
  try { return await run(); } finally { redis.pipeline = original; }
}

test("control: a counter that answers is within its limit", async () => {
  redis.clear();
  assert.equal(await withinLimit("unknown-batch", "who", 5, 60), true);
  assert.equal(await withinMonth("unknown-batch", "who", 5, "2026-11"), true);
});

test("Redis that cannot be asked at all still opens, as before", async () => {
  assert.equal(await whenPipelineThrows(new Error("fetch failed (test)"), () => withinLimit("unknown-batch", "who", 5, 60)), true);
  assert.equal(await whenPipelineThrows(new Error("fetch failed (test)"), () => withinMonth("unknown-batch", "who", 5, "2026-11")), true);
});

test("a batch answered out of shape is an unknown count: withinLimit refuses", async () => {
  assert.equal(await whenPipelineThrows(new UnknownReplyError("a Redis batch (test)"), () => withinLimit("unknown-batch", "who", 5, 60)), false);
});

test("a batch answered out of shape is an unknown count: withinMonth refuses", async () => {
  assert.equal(await whenPipelineThrows(new UnknownReplyError("a Redis batch (test)"), () => withinMonth("unknown-batch", "who", 5, "2026-11")), false);
});
