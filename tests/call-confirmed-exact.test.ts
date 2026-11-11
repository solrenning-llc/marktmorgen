/**
 * Whether a booked call was already confirmed (lib/calls.ts, isConfirmed) is read exactly (rule 24). It read the EXISTS
 * reply as `Number(seen) === 1`, so a reply lost or in another shape (true, [1], "1", null) was "not confirmed": the
 * reminder job (lib/call-reminders.ts) then confirmed the booking again, sending the buyer and the creator the paid
 * confirmation a second time, and a package's lapsed hold counted as a session not used. Now EXISTS 1 is confirmed,
 * 0 is not, and anything else throws UnknownReplyError (the reminder stays in line for the next run). Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { isConfirmed } from "@/lib/calls";
import { UnknownReplyError } from "@/lib/redis-reply";

const real = redis.pipeline.bind(redis);
let odd: unknown = undefined;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (odd !== undefined && commands.length === 1 && commands[0][0] === "EXISTS") return odd === "LOST" ? [] : [odd];
  return real(commands);
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  odd = undefined;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
});

for (const reply of [true, [1], "1", null, 2, -1, "LOST"]) {
  test(`a confirmation mark read as ${JSON.stringify(reply)} is unknown, never "not confirmed"`, async () => {
    odd = reply;
    await assert.rejects(isConfirmed("cs_test_" + "a".repeat(24)), UnknownReplyError);
  });
}

test("EXISTS 1 is confirmed and 0 is not", async () => {
  odd = 1;
  assert.equal(await isConfirmed("cs_test_" + "b".repeat(24)), true);
  odd = 0;
  assert.equal(await isConfirmed("cs_test_" + "b".repeat(24)), false);
});
