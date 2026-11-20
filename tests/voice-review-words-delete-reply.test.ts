/**
 * A deleted review's words are not reported forgotten when Redis did not say
 * whether the matching customer-voice summary was deleted (CX-123 rule 24).
 * Synthetic store, summary and words only; no external service is used.
 */
import { forgetReviewWords, keptMonths, type VoiceSummary } from "@/lib/customer-voice";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS_ID = "stats_voice_delete_reply_synthetic";
const WORDS = "Synthetic review words to forget";
const NOW = Date.UTC(2026, 10, 19, 12);

function summary(month: string): VoiceSummary {
  const theme = {
    title: "Synthetic theme",
    count: 1,
    sources: { review: 1 },
    examples: [{ source: "review" as const, text: WORDS, n: 1, stars: 5 }],
  };
  return {
    at: Math.floor(NOW / 1000),
    month,
    read: { review: 1 },
    themes: [theme],
    reviewThemes: [theme],
    other: 0,
  };
}

async function main(): Promise<void> {
  redis.clear();
  const month = keptMonths(NOW)[0];
  const key = `nl:voice:${STATS_ID}:${month}`;
  const raw = JSON.stringify(summary(month));
  const original = redis.pipeline.bind(redis);
  await original([["SET", key, raw, "EX", 3600]]);

  let cutDeleteReply: unknown[] | null = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (cutDeleteReply && commands.some((command) => command[0] === "DEL")) return cutDeleteReply as never;
    return original(commands);
  }) as typeof redis.pipeline;

  part("An unread DEL reply is not reported as a completed erasure");
  let error: unknown = null;
  try {
    await forgetReviewWords(STATS_ID, WORDS, NOW);
  } catch (caught) {
    error = caught;
  }
  cutDeleteReply = null;
  const [stillThere] = await original([["GET", key]]);
  is(
    "the caller receives the exact unknown-reply failure, and the summary is still present",
    [(error as Error | null)?.name ?? null, stillThere],
    ["UnknownReplyError", raw],
  );

  // Claude 5: one lock and one summary deleted can answer at most 1 and 1; a larger count is impossible, so unknown.
  part("A DEL count above the keys it named is not a completed erasure either");
  cutDeleteReply = [1, 2];
  error = null;
  try {
    await forgetReviewWords(STATS_ID, WORDS, NOW);
  } catch (caught) {
    error = caught;
  }
  cutDeleteReply = null;
  is("an impossible count is the exact unknown-reply failure", (error as Error | null)?.name ?? null, "UnknownReplyError");

  part("An exact DEL reply reports the summaries Redis actually removed");
  is(
    "the retry removes and counts the one matching summary",
    await forgetReviewWords(STATS_ID, WORDS, NOW),
    1,
  );
  is("the summary is gone", await original([["GET", key]]), [null]);

  done();
}

void main();
