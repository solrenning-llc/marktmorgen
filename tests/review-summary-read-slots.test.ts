import assert from "node:assert/strict";
import { test } from "node:test";
import { readReviewSummary, lastReviewSummaryAt, readReviewSummaries } from "@/lib/review-ai-summary";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const original = redis.pipeline;
async function answer<T>(reply: unknown, read: () => Promise<T>) {
  redis.pipeline = async () => reply as unknown[];
  try { return await read(); } finally { redis.pipeline = original; }
}
for (const last of [false, 1, "01", "-1", "1.5", "bad", "1000000000000", {}]) {
  test(`invalid weekly timestamp ${JSON.stringify(last)} remains unknown`, async () => {
    await assert.rejects(() => answer([null, [], last], () => lastReviewSummaryAt("synthetic-summary", "lesson")), UnknownReplyError);
  });
}
test("non-string head remains unknown", async () => {
  await assert.rejects(() => answer([{}, [], null], () => readReviewSummary("synthetic-summary", "lesson")), UnknownReplyError);
});
test("a malformed theme member is not silently removed", async () => {
  await assert.rejects(() => answer([null, ["valid string", 0], null], () => readReviewSummary("synthetic-summary", "lesson")), UnknownReplyError);
});
test("one unknown product prevents a partially certified summary map", async () => {
  await assert.rejects(() => answer([null, [], null, null, {}, null], () => readReviewSummaries("synthetic-summary", ["first", "second"])), UnknownReplyError);
});
test("confirmed null and canonical zero retain known absence", async () => {
  assert.equal(await answer([null, [], null], () => lastReviewSummaryAt("synthetic-summary", "lesson")), 0);
  assert.equal(await answer([null, [], "0"], () => lastReviewSummaryAt("synthetic-summary", "lesson")), 0);
});
