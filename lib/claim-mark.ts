/**
 * A mark taken so a thing is done once (an email, a notice): SET NX with a
 * value no other run could write, read exactly (CX-123 rule 24, Claude 4 on
 * #2714). "OK" is ours and nil is somebody else's. Any other answer is read
 * back: the key holding our own value means the write landed and the mark is
 * ours; holding another value, it is somebody else's; anything else (absent,
 * unreadable) is unknown, so nothing is done on it this run and nothing is
 * let go, since it is not ours to let go.
 *
 * The value starts with the time in milliseconds, so a reader that takes the
 * mark's value as the time it was taken (lib/payment-recovery.ts) still reads
 * it: `Number("1730000000000.123456789")` is that time.
 */
import { randomInt } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { releaseLock } from "@/lib/redis-lock";

export type Claimed = "ours" | "taken" | "unknown";

/** A value only this claim writes: the time now, and a random part after the point. */
export function claimValue(now = Date.now()): string {
  return `${now}.${String(randomInt(1_000_000_000)).padStart(9, "0")}`;
}

export async function claimMark(key: string, seconds: number | null, value = claimValue()): Promise<Claimed> {
  let reply: unknown[] | null = null;
  // null: a claim kept for good (a record written once, such as a credit), with no expiry.
  const command = seconds === null ? ["SET", key, value, "NX"] : ["SET", key, value, "NX", "EX", seconds];
  try {
    reply = repliesFor(await redisPipeline([command]), 1);
  } catch {
    reply = null;
  }
  if (reply && reply[0] === "OK") return "ours";
  if (reply && reply[0] === null) return "taken";
  // Answered in another shape, or not at all: the write may have landed. Read it back.
  try {
    const held = repliesFor(await redisPipeline([["GET", key]]), 1);
    if (!held) return "unknown";
    if (held[0] === value) return "ours";
    if (typeof held[0] === "string") return "taken";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Lets go of a claim only while it still holds this claim's own value (Revisor 1 on #2719): a run whose mark ran out
 * and was taken by another run never deletes the other run's mark. The compare and delete is one script; when the
 * script cannot run, nothing is sent and the mark stays (lib/redis-lock.ts, releaseLock; Codex G on #2721): one taken
 * with an expiry runs out at it, but one kept for good (claimMark with seconds null) never does: it stays, and whatever
 * it guards is not done again on it (Claude 5 on #2722). Never throws.
 */
export async function releaseMark(key: string, value: string): Promise<void> {
  await releaseLock({ key, token: value, ttlSeconds: 1 });
}
