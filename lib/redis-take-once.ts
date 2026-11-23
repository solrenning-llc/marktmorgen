import { redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";

/**
 * Reads a one-time value and deletes it, so two takers can never both have it (a move link, Google's sign-in state,
 * a team invitation; #4055, #4057): GETDEL, or, where that command is not served, GET then DEL, the value kept only
 * when the DEL removed exactly that one key. Every answer is read in its exact shape (CX-123 rule 24): a GETDEL, GET
 * or DEL answer that is not exactly one reply (one more, one less, another shape) proves nothing, and nothing is
 * taken. Null: nothing there, or nothing proven taken; the caller opens nothing on it.
 */
export async function takeOnce(key: string): Promise<unknown> {
  let replies: unknown[] | null;
  try {
    replies = repliesFor(await redisPipeline([["GETDEL", key]]), 1);
  } catch {
    const read = repliesFor(await redisPipeline([["GET", key]]), 1);
    const removed = repliesFor(await redisPipeline([["DEL", key]]), 1);
    replies = read && removed && countOf(removed[0]) === 1 ? read : null;
  }
  return replies ? replies[0] : null;
}
