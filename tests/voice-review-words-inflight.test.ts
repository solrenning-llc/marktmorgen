/**
 * Codex L-20261120-0948 (MEDIUM, erasure; #5010 row 30): a summary being built when a review's words are deleted.
 * makeVoice took the lock, read the review and was still building, so no month's summary was there yet. The buyer
 * deleted or rewrote the review, and forgetReviewWords read the summaries first, found none and returned, leaving the
 * reader's lock alone. The reader then wrote its summary with the deleted words through VOICE_KEEP, whose token still
 * held the lock, and they stayed for about two months. The erasure must take the reader's lock before it reads the
 * summaries, so a reader that saw the old words can no longer keep them. Synthetic store and words only.
 */
import { VOICE_KEEP, forgetReviewWords, keptMonths } from "@/lib/customer-voice";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS_ID = "stats_voice_inflight_synthetic";
const WORDS = "Synthetic deleted review words";
const NOW = Date.UTC(2026, 10, 20, 12);
const LOCK = `nl:voice:lock:${STATS_ID}`;
const TOKEN = "reader-token-synthetic";

async function main(): Promise<void> {
  redis.clear();
  const month = keptMonths(NOW)[0];
  const key = `nl:voice:${STATS_ID}:${month}`;
  const summary = JSON.stringify({ at: Math.floor(NOW / 1000), month, read: { review: 1 }, themes: [{ title: "t", count: 1, sources: { review: 1 }, examples: [{ source: "review", text: WORDS, n: 1, stars: 5 }] }], other: 0 });

  part("A reader holds the lock with the old words, and no summary is kept yet");
  await redis.pipeline([["SET", LOCK, TOKEN, "EX", 600]]);
  is("the erasure finds no summary to delete", await forgetReviewWords(STATS_ID, WORDS, NOW), 0);
  is("but it takes the reader's lock first", await redis.pipeline([["EXISTS", LOCK]]), [0]);

  part("The reader then tries to keep its summary");
  const [kept] = await redis.pipeline([["EVAL", VOICE_KEEP, 2, LOCK, key, TOKEN, summary, 3600]]);
  is("VOICE_KEEP refuses: the token no longer holds the lock", kept, 0);
  is("so the deleted words are never written", await redis.pipeline([["GET", key]]), [null]);

  part("A summary already kept that quotes the words is still found and deleted");
  await redis.pipeline([["SET", key, summary, "EX", 3600]]);
  is("one summary removed", await forgetReviewWords(STATS_ID, WORDS, NOW), 1);
  is("and it is gone", await redis.pipeline([["GET", key]]), [null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
