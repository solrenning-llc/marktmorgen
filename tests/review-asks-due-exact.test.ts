/**
 * The review requests that are due (lib/review-requests.ts, sendReviewRequests) are read exactly (CX-123 rule 24).
 * Found by Claude 3 (cloud D)'s audit of main (11 November 2026): a reply of another shape read as "nothing due", so
 * the mail cron (app/api/cron/mail/route.ts) reported a run that read nothing as a run with nothing to send, and an
 * entry that was not text was passed on as an order. Now such a reply throws UnknownReplyError, which the cron
 * reports as a failed step, and the next run reads the queue again. Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { sendReviewRequests } from "@/lib/review-requests";
import { UnknownReplyError } from "@/lib/redis-reply";

const real = redis.pipeline.bind(redis);
let odd: { reply: unknown } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = (await real(commands)) as unknown[];
  if (!odd || !commands.some((c) => c[0] === "ZRANGEBYSCORE")) return replies;
  if (odd.reply === "LOST") return [];
  return commands.map((c, i) => (c[0] === "ZRANGEBYSCORE" ? odd!.reply : replies[i]));
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  odd = null;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
});

for (const reply of ["LOST", "member", 7, null, { a: 1 }, [1, 2]]) {
  test(`the due review requests read ${JSON.stringify(reply)} are unknown, never nothing due`, async () => {
    odd = { reply };
    await assert.rejects(sendReviewRequests(async () => null, Date.now() + 10_000), (e) => e instanceof UnknownReplyError);
  });
}

test("readable replies: an empty queue is nothing due", async () => {
  assert.deepEqual(await sendReviewRequests(async () => null, Date.now() + 10_000), { sent: 0, dropped: 0, waiting: 0 });
});
