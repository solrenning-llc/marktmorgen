/**
 * 757 [STN4] unit 3, the server's one read: whether a store has made its
 * first sale, from the mark lib/yearly-offer.ts keeps for good
 * (noteFirstSale), read exactly. The studio asks it only for an account with
 * no second step (lib/two-step-ask-rules.ts noSecondStep), so a protected
 * account costs nothing; one GET of a short value, inside the studio page's
 * own price (STUDIO_PAGE_UNITS).
 *
 * Never throws: the day in seconds, 0 for "not yet" (nothing kept), null for
 * anything that could not be read for sure, and null never asks.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { firstSaleKey } from "@/lib/yearly-offer";
import { firstSaleFromReply } from "@/lib/two-step-ask-rules";
import { lockedUntil } from "@/lib/two-step";

export async function firstSaleKnown(store: Pick<Store, "sid" | "handle">): Promise<number | null> {
  if (!isRedisConfigured()) return null;
  try {
    const replies = repliesFor(await redisPipeline([["GET", firstSaleKey(store)]]), 1);
    return replies ? firstSaleFromReply(replies[0]) : null;
  } catch {
    return null;
  }
}

/**
 * The session's lock as the studio reads it (lib/two-step.ts lockedUntil): its day in milliseconds, 0 for unlocked,
 * and null when it could not be read, never 0 (Codex H2 on #3511): an unread lock is unknown, and the ask is not shown
 * on unknown. Never throws.
 */
export async function lockKnown(session: string | undefined): Promise<number | null> {
  try {
    return await lockedUntil(session);
  } catch {
    return null;
  }
}
