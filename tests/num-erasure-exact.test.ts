/**
 * Deleting a person (lib/person-erasure.ts): the count each step reports, and
 * the counts that size the erasure's allowance, are read exactly (CX-123 rule
 * 24). A reply that is not Redis's own count is not "nothing was there": the
 * step throws, so the erasure is said as not finished (or, for its size, as
 * unavailable), never finished with 0 records or charged as if nothing were kept.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { forgetBondPerson } from "@/lib/affiliate-bond";
import { forgetFeedCopyPerson } from "@/lib/calendar-sync";
import { forgetGrantPerson } from "@/lib/chat-grant";
import { forgetVoicePerson, keptMonths } from "@/lib/customer-voice";
import { allKey, certificateCount } from "@/lib/certificate";
import { roomSize } from "@/lib/community-chat";
import { store as redis } from "./redis-stub";

const sid = "synthetic-num-erasure";
const email = "fictional.buyer@example.test";
const now = Date.UTC(2026, 10, 6, 12);
const bondField = createHash("sha256").update(`nimbus-aff-bond:${sid}:${email}`).digest("hex").slice(0, 32);

/** Each reply that is not a count: text, null, negative, fraction, an object, or none at all. */
const BAD: [string, unknown[]][] = [
  ["text '1'", ["1"]],
  ["null", [null]],
  ["negative", [-1]],
  ["fraction", [1.5]],
  ["object", [{}]],
  ["missing", []],
];

async function withReplies<T>(replies: unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = async () => [...replies];
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const steps: [string, () => Promise<number>][] = [
  ["the affiliate bond", () => forgetBondPerson(sid, email)],
  ["the calendar feed copy", () => forgetFeedCopyPerson(sid, now)],
  ["the room leave", () => forgetGrantPerson("c-synthetic", "m-synthetic")],
  ["the certificates' count", () => certificateCount(["course-synthetic"])],
  ["the room's size", () => roomSize("c-synthetic")],
];

for (const [name, run] of steps) {
  for (const [label, replies] of BAD) {
    test(`${name}: a ${label} reply throws, never counts as 0`, async () => {
      await assert.rejects(() => withReplies(replies, run));
    });
  }
}

for (const [label, replies] of [
  ["text second count", [0, "1"]],
  ["null second count", [0, null]],
  ["negative first count", [-1, 1]],
  ["one reply of two", [1]],
] as [string, unknown[]][]) {
  test(`the customer voice summaries: a ${label} throws, never counts as 0`, async () => {
    await assert.rejects(() => withReplies(replies, () => forgetVoicePerson(sid, now)));
  });
}

test("healthy: each step counts what it really deleted", async () => {
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${sid}:bond`, bondField, "abcdef123456"],
    ["SET", `nl:cal:out:${sid}`, "BEGIN:VCALENDAR"],
    ["SET", "nl:cm:c-synthetic:rg:m-synthetic", "1"],
    ["SET", `nl:voice:${sid}:${keptMonths(now)[0]}`, "{}"],
    ["SADD", allKey("course-synthetic"), "a", "b"],
    ["ZADD", "nl:cm:c-synthetic:ch", 1, "x", 2, "y", 3, "z"],
  ]);
  assert.equal(await certificateCount(["course-synthetic"]), 2);
  assert.equal(await roomSize("c-synthetic"), 3);
  assert.equal(await forgetBondPerson(sid, email), 1);
  assert.equal(await forgetFeedCopyPerson(sid, now), 1);
  assert.equal(await forgetGrantPerson("c-synthetic", "m-synthetic"), 1);
  assert.equal(await forgetVoicePerson(sid, now), 1);
});

test("confirmed absence: nothing kept counts as 0, as Redis answers it", async () => {
  redis.clear();
  assert.equal(await forgetBondPerson(sid, email), 0);
  assert.equal(await forgetFeedCopyPerson(sid, now), 0);
  assert.equal(await forgetGrantPerson("c-synthetic", "m-synthetic"), 0);
  assert.equal(await forgetVoicePerson(sid, now), 0);
  assert.equal(await certificateCount(["course-synthetic", "course-other"]), 0);
  assert.equal(await certificateCount([]), 0);
  assert.equal(await roomSize("c-synthetic"), 0);
});
