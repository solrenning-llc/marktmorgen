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

for (const [label, reply] of [["an empty pipeline", []], ["a per-command error", [{ error: "ERR synthetic" }, 1]], ["a short pipeline", [1]], ["text", ["1", 1]]] as [string, unknown][]) {
  test(`a recovery-email count answered with ${label} is visible and does not abort sending`, async () => {
    const previous = console.error;
    const logged: unknown[][] = [];
    redis.pipeline = (async () => reply) as typeof redis.pipeline;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      await assert.doesNotReject(countSent("stats_synthetic", "failed"));
      assert.equal(logged.length, 1);
      assert.equal(logged[0][0], "recording a payment recovery email count failed");
      assert.match(String(logged[0][1]), /unknown shape/);
    } finally {
      redis.pipeline = actual;
      console.error = previous;
    }
  });
}

test("a recovery-email count answered exactly is not logged (healthy control)", async () => {
  const previous = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await countSent("stats_synthetic", "cards");
    assert.equal(logged.length, 0);
  } finally {
    console.error = previous;
  }
});
