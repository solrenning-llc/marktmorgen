import { redisPipeline } from "@/lib/redis";
import { QUIZ_MONTHLY_SUBMISSIONS, QUIZ_USAGE_RETENTION_SECONDS, quizUsageKey } from "@/lib/quiz-usage-rules";
export async function reserveQuizSubmission(sid: string, now = Date.now(), window?: string | null): Promise<"ok" | "usage_limit" | "unavailable"> {
  const key = quizUsageKey(sid, now, window);
  if (!key) return "unavailable";
  try {
    // Atomic increment admits at most the allowance under concurrency.
    // Reservations are never returned by a failed response, reset, or quiz deletion.
    // Retention always exceeds a full UTC month, so expiry cannot replenish that month.
    const reply = await redisPipeline([["INCR", key], ["EXPIRE", key, QUIZ_USAGE_RETENTION_SECONDS]]);
    if (reply.length !== 2) return "unavailable";
    const [count, expiry] = reply;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || expiry !== 1) return "unavailable";
    return count <= QUIZ_MONTHLY_SUBMISSIONS ? "ok" : "usage_limit";
  } catch {
    return "unavailable";
  }
}
