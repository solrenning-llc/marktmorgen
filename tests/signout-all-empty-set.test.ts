/**
 * #4365 LOW (Claude 2 nuvem I; Codex G): when the account's session set reads empty, "Log out of all devices" sent an
 * empty pipeline. Upstash may answer an empty /pipeline with an error, which turned "nothing to close" into "could not
 * be confirmed" (null). Nothing listed is nothing to close: 0 at once, with no second request.
 *
 * Synthetic: in-memory Redis through the runner's alias; an empty batch throws as a real empty pipeline may.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { endAllSessions } from "@/lib/auth";
import { store as redis } from "./redis-stub";

test("endAllSessions returns 0 without an empty Redis pipeline when no session is listed", async () => {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const real = redis.pipeline.bind(redis);
  const batches: number[] = [];
  redis.pipeline = (async (batch: (string | number)[][]) => {
    batches.push(batch.length);
    if (batch.length === 0) throw new Error("Redis request failed with status 400");
    return real(batch);
  }) as typeof redis.pipeline;
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await endAllSessions("empty-4365@example.test"), 0);
  } finally {
    console.error = quiet;
    redis.pipeline = real;
  }
  assert.deepEqual(batches, [1]);
});
