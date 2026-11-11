import assert from "node:assert/strict";
import { test } from "node:test";
import { countSent } from "@/lib/dunning-keys";
import { store as redis } from "./redis-stub";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.UPSTASH_REDIS_REST_TOKEN ??= "synthetic";
const actual = redis.pipeline.bind(redis);

test("a failed recovery-email count is visible and does not abort sending", async () => {
  const previous = console.error;
  const logged: unknown[][] = [];
  const failure = new Error("synthetic Redis count failure");
  redis.pipeline = (async () => { throw failure; }) as typeof redis.pipeline;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await assert.doesNotReject(countSent("stats_synthetic", "failed"));
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "recording a payment recovery email count failed");
    assert.equal(logged[0][1], failure);
  } finally {
    redis.pipeline = actual;
    console.error = previous;
  }
});
