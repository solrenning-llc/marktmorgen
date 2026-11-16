/**
 * Where a daily walk of every store stopped, read back exactly (CX-123 rule 24).
 *
 * The walks (lib/winback-send.ts, lib/member-nudge.ts, lib/payment-recovery.ts, lib/checkout-sweep.ts,
 * lib/verified-numbers.ts) keep "cursor|done": the Redis cursor of the batch being read and how many of its stores
 * were done. A point that does not read is unknown: never the start, which would walk the first stores again and
 * write a fresh point over the kept one, so the stores at the end of the list would wait for ever.
 */
import { repliesFor } from "@/lib/redis-reply";

/** A whole number as Redis writes one, no sign and no leading zero. */
const POINT = /^(0|[1-9]\d*)\|(0|[1-9]\d*)$/;

/**
 * The pipeline's one reply to GET of the kept point: absent (null) is the start, "digits|digits" is itself, and
 * anything else (no reply, text in another shape, a number, an error) is null, unknown; the caller throws
 * UnknownReplyError before it reads a store.
 */
export function resumePoint(replies: unknown): { cursor: string; skip: number } | null {
  const reply = repliesFor(replies, 1);
  if (!reply) return null;
  const saved = reply[0];
  if (saved === null) return { cursor: "0", skip: 0 };
  if (typeof saved !== "string") return null;
  const match = POINT.exec(saved);
  if (!match) return null;
  const skip = Number(match[2]);
  return Number.isSafeInteger(skip) ? { cursor: match[1], skip } : null;
}
