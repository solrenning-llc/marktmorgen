/**
 * CX-123 rule 24 (inventory R24, item 13): a buyer's own review that could not
 * be read is unknown, never "no review yet". readReview answers only an exact
 * reply (one slot, text or nil); anything else throws, and the thanks page and
 * the review page then say the review could not be loaded just now instead of
 * drawing a blank form that would post over the review the buyer already
 * wrote. Synthetic store, product and review only.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readReview, reviewId, saveReview } from "@/lib/reviews";
import { givingWords } from "@/lib/buyer-words/giving";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const statsId = "0123456789abcdef0123456789abcdef";
const product = "synthbread01";
const email = "review-unread@example.com";
const id = reviewId(statsId, product, email);

redis.clear();
const fixture = (async () => {
  const saved = await saveReview(statsId, { productId: product, email, reference: "cs_test_unread0001", pi: "pi_unread0001", rating: 5, text: "Clear lessons.", name: "Ana", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000);
  assert.equal(saved.state, "created");
})();

test("a buyer's review in its exact shape is read, and a confirmed absence is still none", async () => {
  await fixture;
  assert.equal((await readReview(statsId, product, id))?.text, "Clear lessons.");
  assert.equal(await readReview(statsId, product, reviewId(statsId, product, "nobody@example.com")), null);
});

for (const [label, reply] of [
  ["missing envelope", []],
  ["two slots for one command", [null, null]],
  ["a number", [7]],
  ["an object", [{}]],
  ["a list", [["{}"]]],
] as const) {
  test(`a review answered as ${label} is unknown, never "no review yet"`, async () => {
    await fixture;
    const original = redis.pipeline;
    redis.pipeline = async () => [...reply];
    try {
      await assert.rejects(() => readReview(statsId, product, id), UnknownReplyError);
    } finally {
      redis.pipeline = original;
    }
  });
}

const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
const reviewPage = readFileSync("app/[handle]/review/page.tsx", "utf8");

test("the thanks page keeps an unread review unknown, never a blank form", () => {
  assert.equal(/readReview\([^;]*\)\.catch\(\(\) => null\)/.test(thanks), false, "an unread review is not read as none");
  assert.match(thanks, /readReview\([^;]*\)\.catch\(\(\) => "unknown" as const\)/);
  assert.match(thanks, /reviewed\.get\(product\.id\) === "unknown" \?/);
  assert.match(thanks, /role="status"[^>]*>\s*\{giving\.reviewUnread\(product\.title\)\}/);
});

test("the review page says an unread review could not be loaded, never a blank form or the error page", () => {
  assert.match(reviewPage, /readReview\([^;]*\)\.catch\(\(\) => "unknown" as const\)/);
  assert.match(reviewPage, /existing\.get\(product\.id\) === "unknown" \?/);
  assert.match(reviewPage, /role="status"[^>]*>\s*\{g\.reviewUnread\(product\.title\)\}/);
});

test("the sentence is plain US English and every store language says it", () => {
  assert.equal(givingWords("en").reviewUnread("Bread Course"), "Your review of Bread Course could not be loaded just now. Refresh this page in a moment to see or change it.");
  for (const language of ["es", "fr", "de", "it", "nl", "pt"]) {
    const said = givingWords(language).reviewUnread("Bread Course");
    assert.ok(said.includes("Bread Course") && said !== givingWords("en").reviewUnread("Bread Course"), language);
  }
});
