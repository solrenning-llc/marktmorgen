/**
 * Reading a Redis reply only in its exact shape (audit SG2, CX-123 rule 24).
 *
 * A reply that is missing, cut short or of another shape is not an empty
 * set, a zero or a success: it is unknown, and what depends on it fails
 * closed. These answer null for anything but the exact shape, and the
 * caller decides what failing closed means there (keep what it would have
 * deleted, refuse, or say it could not read).
 */

/** A list of strings (SMEMBERS, LRANGE, ZRANGEBYSCORE, HGETALL): exactly that, or null. */
export function stringList(reply: unknown): string[] | null {
  if (!Array.isArray(reply)) return null;
  for (let i = 0; i < reply.length; i += 1) if (typeof reply[i] !== "string") return null;
  return reply as string[];
}

/** A count (DEL, EXISTS, SCARD, HLEN, an EVAL that answers one): a whole number from zero up, or null. */
export function countOf(reply: unknown): number | null {
  return typeof reply === "number" && Number.isSafeInteger(reply) && reply >= 0 ? reply : null;
}

/**
 * A pipeline's replies, only when there is exactly one for each command sent, each held in the array's own data slot:
 * a hole, a getter or a slot inherited from the prototype is unknown, never read (Codex G on #2806). Answers a plain
 * copy, so nothing the caller reads afterwards can change under it.
 */
export function repliesFor(replies: unknown, commands: number): unknown[] | null {
  if (!Array.isArray(replies) || replies.length !== commands) return null;
  const exact: unknown[] = [];
  for (let i = 0; i < commands; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(replies, i);
    if (!slot || !("value" in slot)) return null;
    exact.push(slot.value);
  }
  return exact;
}

/** Thrown where a reply was not in its exact shape, so what depended on it is said as not done. */
export class UnknownReplyError extends Error {
  constructor(what: string) {
    super(`Redis answered ${what} in an unknown shape`);
    this.name = "UnknownReplyError";
  }
}
