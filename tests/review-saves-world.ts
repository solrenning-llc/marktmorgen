/**
 * The review route counts an order's saves in the store's month (app/api/store/review, withinMonthWhy "review-saves",
 * REVIEW_SAVES_PER_ORDER_MONTH; #5010 row 180). A test that saves the same order's review again, as a buyer may in a
 * later month, starts that later month here: every order's save count in the in-memory Redis is let go. Nothing else
 * is touched, and nothing is counted as a command.
 */
import { store as redis } from "./redis-stub";

export function nextReviewMonth(): void {
  // Straight into the store, never through the pipeline a test may be counting.
  const keys = (redis.run(["SCAN", "0", "MATCH", "nl:rlm:review-saves:*", "COUNT", 10_000]) as [string, string[]])[1];
  if (keys.length) redis.run(["DEL", ...keys]);
}
