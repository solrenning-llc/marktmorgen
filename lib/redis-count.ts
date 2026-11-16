/**
 * Reading a counter from Redis only in its exact shape (audit SG2, CX-123 rule 24).
 *
 * The companions of lib/redis-reply.ts for the two counter replies it does
 * not cover: a counter read back with GET or MGET, and the signed total that
 * DECRBY, INCRBY and HINCRBY answer. Anything but the exact shape is null,
 * unknown, and what depends on it fails closed: nothing granted, sent,
 * charged or shown as certain.
 */

/** A whole number written as Redis writes one: no sign, no leading zero, no space, no decimal point. */
const DIGITS = /^(0|[1-9]\d*)$/;

/**
 * A counter read with GET, or one slot of an MGET. Upstash's REST API answers
 * a value set with INCR/INCRBY as the text Redis keeps ("42"), and the
 * in-memory double does too; a number is also taken, in case a client
 * decodes it. "absent" is the one legitimate null: GET on a key that does not
 * exist, which for a counter means nothing was counted yet. The caller says
 * what that is (usually zero). Anything else (a negative, a fraction, text
 * that is not a whole number, true, an object, undefined) is null: unknown.
 */
export function textCountOf(reply: unknown): number | "absent" | null {
  if (reply === null) return "absent";
  if (typeof reply === "number") return Number.isSafeInteger(reply) && reply >= 0 ? reply : null;
  if (typeof reply !== "string" || !DIGITS.test(reply)) return null;
  const n = Number(reply);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The total DECRBY, INCRBY or HINCRBY answers: a whole number, which may be
 * below zero (a credit taken past what was left), or null. Redis answers
 * these as integers, and so does Upstash's REST API (a JSON number); text,
 * null, a fraction or anything else is unknown.
 */
export function signedOf(reply: unknown): number | null {
  return typeof reply === "number" && Number.isSafeInteger(reply) ? reply : null;
}
