/**
 * The cap on one closing's emails to its buyers (queue item 307 [EC1]):
 * set once, when the members of a store whose plan ended are held
 * (lib/plan-closing.ts), at EMAILS_PER_BUYER_PER_ENDING for each buyer its
 * cap allows (lib/closing-buyers-rules.ts, buyerNoticeCap), and taken from
 * before every email (lib/closing-buyers.ts). Never added to after.
 *
 *   nl:closing:credit:<folder>   what is left, until the store closes or stays
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { signedOf } from "@/lib/redis-count";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";

export const creditKey = (folder: string) => `nl:closing:credit:${folder}`;

/**
 * Sets the closing's emails, for one ending. Throws UnknownReplyError unless
 * SET answers exactly "OK" (CX-123 rule 24): closeOne (lib/plan-closing.ts)
 * then writes no holdFrom, so the credit is set again the next day, never
 * taken as set when it may not be there (every buyer's email would be
 * refused, and no buyer told).
 */
export async function startClosingCredit(folder: string, emails: number): Promise<void> {
  if (!isRedisConfigured() || !folder) return;
  const replies = repliesFor(await redisPipeline([["SET", creditKey(folder), Math.max(0, Math.floor(emails))]]), 1);
  if (replies?.[0] !== "OK") throw new UnknownReplyError("a closing's email credit");
}

/**
 * Takes `n`, all or none. Nothing set is nothing to take. Throws
 * UnknownReplyError when DECRBY's total is not a whole number (CX-123 rule
 * 24): no email goes, and nothing is given back, since it is not known
 * whether the take ran; a closing that loses some credit sends fewer
 * emails, never more than its cap.
 */
export async function takeCredit(folder: string, n: number): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([["DECRBY", creditKey(folder), n]]), 1);
  const left = replies ? signedOf(replies[0]) : null;
  if (left === null) throw new UnknownReplyError("a closing's email credit");
  if (left >= 0) return true;
  await redisPipeline([["INCRBY", creditKey(folder), n]]);
  return false;
}

/**
 * Puts back what was taken for emails that did not go: once. When INCRBY's
 * total is not a whole number it is not known whether it ran, so it is
 * logged and never sent again (a second one could give back twice).
 */
export async function returnCredit(folder: string, n: number): Promise<void> {
  if (n <= 0) return;
  const replies = repliesFor(await redisPipeline([["INCRBY", creditKey(folder), n]]), 1);
  if ((replies ? signedOf(replies[0]) : null) === null) console.error(`giving back ${n} of a closing's email credit answered in an unknown shape; not tried again`);
}

/** Let go once the store is closed or runs on. */
export async function forgetCredit(folder: string): Promise<void> {
  await redisPipeline([["DEL", creditKey(folder)]]);
}
