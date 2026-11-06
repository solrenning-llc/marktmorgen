/**
 * Whether a plan refund the creator asked for is still being settled (305
 * [SY1]): a request is running (its lock is held) or a note says a refund
 * may have been made and is not decided yet (lib/plan-refund-flow.ts writes
 * the note before any money moves and the daily job decides it). Read by the
 * review page, which then shows no new confirmation, and by the route, which
 * then never says "Nothing was refunded". Throws when the store cannot be
 * read: the caller treats that as underway, never as settled.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { ENDING_KEY, flowKeyOf } from "@/lib/plan-refund-flow";

export async function refundUnderway(sid: string): Promise<boolean> {
  const reply = repliesFor(await redisPipeline([
    ["HEXISTS", ENDING_KEY, sid],
    ["EXISTS", flowKeyOf(sid)],
  ]), 2);
  // Each exactly 0 or 1 (rule 24): any other answer throws, which the callers take as underway, never as settled.
  if (!reply || reply.some((n) => n !== 0 && n !== 1)) throw new UnknownReplyError("whether a plan refund is underway");
  return reply[0] === 1 || reply[1] === 1;
}
