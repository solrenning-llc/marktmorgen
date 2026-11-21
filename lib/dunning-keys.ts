/**
 * The keys the daily payment emails (lib/payment-recovery.ts) and their report
 * (lib/payment-recovery-report.ts) share, kept apart so neither imports the
 * other.
 *
 *   nl:dun:<account>:<invoice>         the first email about a failed payment
 *   nl:dun:count:<statsId>:<yyyy-mm>   hash: failed → n, cards → n; 400 days
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";

/**
 * One invoice's first email, holding when it was sent (ms; "1" for one sent
 * before reminders existed, which gets none), kept long past the 30 days its
 * page stays open. The second and third each have a key of their own.
 */
export const sentKey = (account: string, invoice: string) => `nl:dun:${account}:${invoice}`;

export const countKey = (statsId: string, month: string) => `nl:dun:count:${statsId}:${month}`;
export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const COUNT_SECONDS = 400 * 86_400;

/** Counts one email the daily job sent, for the month's line in the studio. Never fails the sending. */
export async function countSent(statsId: string | null, kind: "failed" | "cards"): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const key = countKey(statsId, monthOf(Date.now()));
  let replies: unknown;
  try {
    replies = await redisPipeline([
      ["HINCRBY", key, kind, 1],
      ["EXPIRE", key, COUNT_SECONDS],
    ]);
  } catch (error) {
    console.error("recording a payment recovery email count failed", error);
    return;
  }
  // A reply out of shape (a per-command error, a short pipeline) is as unseen a failure as a thrown one (CX-123 rule
  // 24, LEVE on #3736): logged the same way, and still never stops the emails.
  const counts = repliesFor(replies, 2)?.map(countOf);
  if (!counts || counts.some((count) => count === null)) {
    console.error("recording a payment recovery email count failed", new UnknownReplyError("a payment recovery email count"));
  }
}
