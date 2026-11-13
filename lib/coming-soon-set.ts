/**
 * The products of a store that are coming soon, read on their own: the set
 * lib/waitlist.ts keeps (setSoon) and its pages read, with nothing else of
 * the waitlist pulled in. lib/bundle-available.ts reads it from the
 * checkouts, which must not depend on the waitlist's mail and limits.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";

/** The key of a store's coming-soon set, as lib/waitlist.ts writes it. */
export const soonKey = (sid: string) => `nl:wl:${sid}:soon`;

/**
 * The products of a store that are coming soon, for its pages. A reply that is
 * not exactly a list of text (none, another shape, a hole, a lost pipeline) is
 * unknown, never an empty set: it throws, so no caller can take a product whose
 * state could not be read for one already on sale (rule 24).
 */
export async function soonProducts(store: Store): Promise<Set<string>> {
  if (!store.statsId || !isRedisConfigured()) return new Set();
  const members = stringList(repliesFor(await redisPipeline([["SMEMBERS", soonKey(store.statsId)]]), 1)?.[0]);
  if (!members) throw new UnknownReplyError("the products coming soon");
  return new Set(members);
}
