/**
 * The stars under a store's name (lib/review-summary.ts, storeSummary; added
 * 9 October 2026): every listed product's reviews added together, from the
 * numbers the store page reads anyway. A draft's reviews do not count, and
 * nothing is invented: no reviews, no stars.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type Summary, average, showsRating, storeSummary } from "@/lib/review-summary";

const s = (count: number, stars: number, dist: Summary["dist"], extra: Partial<Summary> = {}): Summary => ({ count, stars, visible: count, hidden: 0, refunded: 0, dist, ...extra });

test("every listed product's reviews, added together", () => {
  const each = new Map([
    ["a", s(3, 14, [0, 0, 0, 1, 2])],
    ["b", s(2, 9, [0, 0, 0, 1, 1], { hidden: 1, refunded: 1, visible: 2 })],
    ["draft", s(5, 5, [5, 0, 0, 0, 0])],
  ]);
  const total = storeSummary(each, ["a", "b", "nothing-yet"])!;
  assert.deepEqual(total, { count: 5, stars: 23, visible: 5, hidden: 1, refunded: 1, dist: [0, 0, 0, 2, 3] });
  assert.equal(average(total), 4.6);
  assert.equal(showsRating(total), true);
});

test("no reviews, no stars", () => {
  assert.equal(showsRating(storeSummary(new Map(), ["a", "b"])!), false);
});
