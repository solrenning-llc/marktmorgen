/**
 * The numbers a store's pages say about its reviews (lib/reviews.ts, summaryOf and summaries): the stars, how many, the
 * spread. Read exactly (CX-123 rule 24): a product with no summary kept has no reviews; a kept summary that does not
 * read in its own shape, or a reply out of shape, is unknown and throws, so every page that shows the numbers says
 * nothing (its own catch) instead of "0.0 from 12 reviews", a hidden list, or store-wide stars that leave one product out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { summaries, summaryOf } from "@/lib/reviews";
import { store as redis } from "./redis-stub";

const statsId = "0123456789abcdef0123456789abcdef";
const key = `nl:rev:sum:${statsId}`;
const good = { count: 12, stars: 54, visible: 12, hidden: 0, refunded: 0, dist: [0, 0, 1, 3, 8] };
const put = (product: string, value: string) => redis.run(["HSET", key, product, value]);

async function rejects(run: () => Promise<unknown>) {
  try { await run(); } catch { return true; }
  return false;
}
async function withReply(reply: unknown, run: () => Promise<unknown>) {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async () => [reply] as never;
  try { return await rejects(run); } finally { redis.pipeline = original; }
}

test("control: a kept summary reads as kept, and none kept is no reviews", async () => {
  redis.clear();
  put("prod000001", JSON.stringify(good));
  assert.deepEqual(await summaryOf(statsId, "prod000001"), good);
  assert.equal((await summaryOf(statsId, "prod000002")).count, 0);
  assert.deepEqual([...(await summaries(statsId)).keys()], ["prod000001"]);
});

for (const [name, bad] of [
  ["stars as text", { ...good, stars: "54" }],
  ["a count below zero", { ...good, count: -1 }],
  ["a spread of four", { ...good, dist: [0, 1, 3, 8] }],
  ["no visible count", { ...good, visible: undefined }],
] as const) {
  test(`a kept summary with ${name} is unknown, never zero`, async () => {
    redis.clear();
    put("prod000001", JSON.stringify(bad));
    put("prod000003", JSON.stringify(good));
    assert.equal(await rejects(() => summaryOf(statsId, "prod000001")), true, "one product's summary");
    assert.equal(await rejects(() => summaries(statsId)), true, "the store's summaries");
  });
}

test("a kept summary that is not JSON is unknown", async () => {
  redis.clear();
  put("prod000001", "{not json");
  assert.equal(await rejects(() => summaryOf(statsId, "prod000001")), true);
  assert.equal(await rejects(() => summaries(statsId)), true);
});

test("a reply out of shape is unknown, never no reviews", async () => {
  assert.equal(await withReply(12, () => summaryOf(statsId, "prod000001")), true, "HGET answered a number");
  assert.equal(await withReply("OK", () => summaries(statsId)), true, "HGETALL answered text");
  assert.equal(await withReply(["prod000001"], () => summaries(statsId)), true, "HGETALL answered an odd list");
});
