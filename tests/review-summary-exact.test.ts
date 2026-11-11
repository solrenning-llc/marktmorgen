/**
 * A product's review numbers (lib/reviews.ts: summaryOf, summaries) are read exactly (CX-123 rule 24, rule 30;
 * VR item 2). Found by Claude 3 (cloud D)'s audit of main (11 November 2026): a reply of another shape read as
 * "no reviews". The product page's facts (lib/page-facts-read.ts) already mark a rating whose read throws as unread,
 * but the read never threw, so a product with reviews was described as having none, and the studio's reviews page
 * showed 0 reviews as real.
 *
 * Now both throw UnknownReplyError on such a reply; a product never reviewed still reads as none. Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { saveReview, summaries, summaryOf } from "@/lib/reviews";
import { UnknownReplyError } from "@/lib/redis-reply";
import { ROOM } from "./data-room";

const statsId = "0123456789abcdef0123456789abcdef";
const real = redis.pipeline.bind(redis);
let odd: { command: string; reply: unknown } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = (await real(commands)) as unknown[];
  if (!odd || !commands.some((c) => c[0] === odd!.command)) return replies;
  if (odd.reply === "LOST") return [];
  return commands.map((c, i) => (c[0] === odd!.command ? odd!.reply : replies[i]));
}) as typeof redis.pipeline;

beforeEach(async () => {
  redis.clear();
  odd = null;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const saved = await saveReview(statsId, { productId: "synthbread01", email: "sum@example.com", reference: "cs_test_sum0001", pi: "pi_sum0001", rating: 5, text: "Good.", name: "Bo", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000);
  assert.equal(saved.state, "created");
});

const unknown = (e: unknown) => e instanceof UnknownReplyError;

for (const reply of ["LOST", 7, { a: 1 }, ["x"]]) {
  test(`a product's numbers read ${JSON.stringify(reply)} are unknown, never no reviews`, async () => {
    odd = { command: "HGET", reply };
    await assert.rejects(summaryOf(statsId, "synthbread01"), unknown);
  });
}

for (const reply of ["LOST", "synthbread01", 7, null, { a: 1 }, ["synthbread01"], [1, "{}"]]) {
  test(`a store's numbers read ${JSON.stringify(reply)} are unknown, never no reviews`, async () => {
    odd = { command: "HGETALL", reply };
    await assert.rejects(summaries(statsId), unknown);
  });
}

test("readable replies: the review is counted, and a product never reviewed reads as none", async () => {
  assert.equal((await summaryOf(statsId, "synthbread01")).visible, 1);
  assert.equal((await summaryOf(statsId, "synthnever01")).count, 0);
  const all = await summaries(statsId);
  assert.equal(all.get("synthbread01")?.count, 1);
  assert.equal(all.size, 1);
  assert.equal((await summaries("fedcba9876543210fedcba9876543210")).size, 0);
});
