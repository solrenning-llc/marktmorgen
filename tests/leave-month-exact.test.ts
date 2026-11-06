/**
 * This month's counts on a store's cancel page (lib/leave-flow.ts, leaveMonth) are read only in their exact shape
 * (CX-123 rule 24): HMGET answers one list, one slot for each field asked, each a whole count or nil (never
 * counted). A reply of another shape throws UnknownReplyError, which the studio's memberships page already takes as
 * "nothing to show" (app/studio/memberships/page.tsx), never as figures with some of them missing.
 *
 * Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { countLeave, leaveMonth, saidField } from "@/lib/leave-flow";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const SID = "leavemonthexact00000000000000001";
const EMPTY = "leavemonthexact00000000000000002";

const fixture = (async () => {
  redis.clear();
  await countLeave(SID, saidField("too_expensive"));
  await countLeave(SID, saidField("too_expensive"));
  await countLeave(SID, "paused");
  await countLeave(SID, "left");
})();

async function withMonthReply<T>(alter: (reply: unknown) => unknown, run: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => {
    const answers = await original(batch);
    return batch.length === 1 && batch[0][0] === "HMGET" ? [alter(answers[0])] : answers;
  }) as typeof redis.pipeline;
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = original;
  }
}

test("control: the month's counts read back as counted", async () => {
  await fixture;
  assert.deepEqual(await leaveMonth(SID), { said: 2, paused: 1, switched: 0, left: 1 });
});

test("control: a month with nothing counted (every slot nil) is all zeros", async () => {
  await fixture;
  assert.deepEqual(await leaveMonth(EMPTY), { said: 0, paused: 0, switched: 0, left: 0 });
});

const UNKNOWN: [string, (reply: unknown) => unknown][] = [
  ["not a list", () => 5],
  ["nil for the whole reply", () => null],
  ["a list cut short", (reply) => (reply as unknown[]).slice(0, 1)],
  ["a list too long", (reply) => [...(reply as unknown[]), "1"]],
  ["a count that is not a number", (reply) => (reply as unknown[]).map((v) => (v === null ? v : "x"))],
  ["a count of another type", (reply) => (reply as unknown[]).map((v) => (v === null ? v : 2))],
  ["a negative count", (reply) => (reply as unknown[]).map((v) => (v === null ? v : "-1"))],
];

for (const [name, alter] of UNKNOWN) {
  test(`a month answered as ${name} throws UnknownReplyError, never partial figures`, async () => {
    await fixture;
    const read = await withMonthReply(alter, () => leaveMonth(SID));
    assert.ok(read.error instanceof UnknownReplyError, `leaveMonth answered ${JSON.stringify(read.value)}`);
  });
}

test("a count that cannot be written never stops the member's way out", async () => {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async () => {
    throw new Error("synthetic outage");
  }) as typeof redis.pipeline;
  try {
    await assert.doesNotReject(countLeave(SID, "left"));
  } finally {
    redis.pipeline = original;
  }
});
