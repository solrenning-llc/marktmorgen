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
import { ENDING_KEY, flowKeyOf } from "@/lib/plan-refund-flow";

export async function refundUnderway(sid: string): Promise<boolean> {
  const [noted, running] = await redisPipeline([
    ["HEXISTS", ENDING_KEY, sid],
    ["EXISTS", flowKeyOf(sid)],
  ]);
  return Number(noted) === 1 || Number(running) === 1;
}
