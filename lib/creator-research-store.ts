/**
 * Where the answers to the creator research form are kept, and how long:
 * the privacy policy promises up to 24 months, so the daily job lets older
 * answers go (app/api/cron/plans). Newest first, as the form adds them.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

export const RESPONSES_KEY = "nl:creators:responses";

/**
 * The most answers the list keeps (MR): the form is public, and the per-address rate (5 an hour) is passed by many
 * addresses together, so the list has a ceiling of its own. With each answer at most 20,000 bytes (the route's body
 * limit), it never holds more than about 100 MB.
 */
export const MAX_RESEARCH_ANSWERS = 5_000;

/** How long an answer is kept: 24 months. */
const KEEP_MS = 730 * 24 * 60 * 60 * 1000;

/** A missing or extra result cannot establish absence or a completed removal. */
function singleResult(reply: unknown): unknown {
  if (!Array.isArray(reply) || reply.length !== 1) throw new Error("Research pruning reply is unconfirmed");
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  if (!slot || !Object.prototype.hasOwnProperty.call(slot, "value")) throw new Error("Research pruning reply is unconfirmed");
  return slot.value;
}

/** Drops the answers older than 24 months, from the oldest end. Returns how many. */
export async function pruneResearch(now = Date.now()): Promise<number> {
  if (!isRedisConfigured()) return 0;
  let dropped = 0;
  for (let step = 0; step < 500; step += 1) {
    const oldest = singleResult(await redisPipeline([["LINDEX", RESPONSES_KEY, -1]]));
    if (oldest === null) break;
    if (typeof oldest !== "string") throw new Error("Research pruning read is unconfirmed");
    let created = Number.NaN;
    try {
      created = Date.parse(String((JSON.parse(oldest) as { createdAt?: unknown }).createdAt));
    } catch {
      created = Number.NaN;
    }
    // Something unreadable at the old end is let go of too: it cannot be dated.
    if (Number.isFinite(created) && now - created < KEEP_MS) break;
    const removed = singleResult(await redisPipeline([["LREM", RESPONSES_KEY, -1, oldest]]));
    if (removed !== 0 && removed !== 1) throw new Error("Research pruning removal is unconfirmed");
    dropped += removed;
  }
  return dropped;
}
