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
 * A pipeline's replies, only when there is exactly one for each command sent,
 * as a fresh plain list. Each reply is read from the list's own data slot:
 * a slot that is missing (a hole), inherited from a prototype or a getter is
 * not a reply, and the whole answer is null (Codex S on #2672), so nothing
 * read later can answer differently from what was checked.
 */
export function repliesFor(replies: unknown, commands: number): unknown[] | null {
  if (!Array.isArray(replies)) return null;
  const length = Object.getOwnPropertyDescriptor(replies, "length");
  if (!length || !Object.hasOwn(length, "value") || length.value !== commands) return null;
  const out: unknown[] = [];
  for (let i = 0; i < commands; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(replies, String(i));
    if (!slot || !Object.hasOwn(slot, "value")) return null;
    out.push(slot.value);
  }
  return out;
}

/** Thrown where a reply was not in its exact shape, so what depended on it is said as not done. */
export class UnknownReplyError extends Error {
  constructor(what: string) {
    super(`Redis answered ${what} in an unknown shape`);
    this.name = "UnknownReplyError";
  }
}
