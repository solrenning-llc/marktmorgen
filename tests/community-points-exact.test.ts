/**
 * A member's points are read exactly, never 0 for an answer that does not read (CX-123 rule 24; Claude 7's
 * unknown-is-never-zero sweep).
 *
 * pointsOf (lib/community-points.ts) read each ZSCORE as `Math.max(0, Number(reply) || 0)`: a reply in another shape
 * (a word, an object, a reply missing) was 0 points. Points set a member's level, and a level opens spaces
 * (app/[handle]/community/page.tsx, `locked`): a member who earned a space was shut out of it, and shown level 1 with
 * "points to the next level" counted from 0. Now null (no points) is 0 and a number is that number; anything else
 * throws UnknownReplyError, as a read that fails already does, so the page never draws a level it did not read.
 *
 * Synthetic community; real MemoryRedis with one reply replaced per case.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pointsOf } from "@/lib/community-points";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const ID = "c0mmunitypoints1";
const A = "a".repeat(32), B = "b".repeat(32);

async function withReplies<T>(swap: ((replies: unknown[]) => unknown[]) | null, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (batch: Command[]) => {
    const replies = await real(batch);
    return swap && batch.every((c) => c[0] === "ZSCORE") ? swap(replies) : replies;
  }) as typeof redis.pipeline;
  try { return await work(); } finally { redis.pipeline = real; }
}

test("control: points read as Redis answers them, and no points is 0", async () => {
  redis.clear();
  const points = await withReplies(null, () => pointsOf(ID, [A, B]));
  assert.equal(points.get(A), 0);
  assert.equal(points.get(B), 0);
  const counted = await withReplies(() => ["12", null], () => pointsOf(ID, [A, B]));
  assert.deepEqual([counted.get(A), counted.get(B)], [12, 0]);
});

for (const [what, swap] of [
  ["a word", () => ["QUEUED", null]],
  ["an object", () => [{}, null]],
  ["a reply missing", (replies: unknown[]) => replies.slice(0, 1)],
  ["a number that is not one", () => ["NaN", null]],
] as const) {
  test(`${what} is unknown, never 0 points`, async () => {
    redis.clear();
    const read = await withReplies(swap, () => pointsOf(ID, [A, B]).then(() => "known", () => "unknown"));
    assert.equal(read, "unknown");
  });
}
