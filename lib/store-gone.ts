/**
 * Whether a store a job was queued for is gone, said only when Redis says so exactly (CX-123 rule 24).
 *
 * storeForHandle (lib/store.ts) answers null for a missing address and for an answer it cannot read alike: a missing or
 * short pipeline slot, a reply of another shape, a record that is not a store. A job that drops its work on "no store"
 * (the review requests, lib/review-requests.ts; the meeting retries, lib/call-meetings.ts) would then drop it for good on
 * an odd answer. So, only after a read answered null, the address is read once more, exactly: nil or a released name is
 * a store that is gone; an address that still leads to a store, or any other answer, is unknown and throws
 * UnknownReplyError, so the job waits and a later run reads it again. One GET, only on that null path.
 */
import { type Store, handleLeadsToStore, storeHandleKey } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";

export async function storeOrGone(load: (handle: string) => Promise<Store | null>, handle: string): Promise<Store | null> {
  const store = await load(handle);
  if (store || !isRedisConfigured()) return store;
  const reply = repliesFor(await redisPipeline([["GET", storeHandleKey(handle)]]), 1);
  if (!reply) throw new UnknownReplyError("a store's address");
  const owner = reply[0];
  if (owner === null) return null;
  if (typeof owner !== "string" || !owner) throw new UnknownReplyError("a store's address");
  // A name let go is held, not owned: it leads nowhere on purpose (lib/store.ts).
  if (!handleLeadsToStore(owner)) return null;
  throw new UnknownReplyError("a store its address still leads to");
}
