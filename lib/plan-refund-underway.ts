/**
 * Whether a plan refund the creator asked for is still being settled (305
 * [SY1]): a request is running (its lock is held) or a note says a refund
 * may have been made and is not decided yet (lib/plan-refund-flow.ts writes
 * the note before any money moves and the daily job decides it). Read by the
 * review page, which then shows no new confirmation, and by the route, which
 * then never says "Nothing was refunded". Throws when the store cannot be
 * read, and throws UnknownReplyError when it answers in any but the exact
 * shape (CX-123 rule 24; sweep A5 finding 9): the caller treats both as
 * underway, never as settled.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { ENDING_KEY, flowKeyOf } from "@/lib/plan-refund-flow";

/** HEXISTS and EXISTS of one key answer exactly 0 or 1. */
const flag = (reply: unknown): boolean | null => {
  const count = countOf(reply);
  return count === 0 || count === 1 ? count === 1 : null;
};

export async function refundUnderway(sid: string): Promise<boolean> {
  const replies = repliesFor(
    await redisPipeline([
      ["HEXISTS", ENDING_KEY, sid],
      ["EXISTS", flowKeyOf(sid)],
    ]),
    2,
  );
  const noted = replies ? flag(replies[0]) : null;
  const running = replies ? flag(replies[1]) : null;
  if (noted === null || running === null) throw new UnknownReplyError("whether a plan refund is underway");
  return noted || running;
}
