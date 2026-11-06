/**
 * Reading a Redis reply only in its exact shape (audit SG2, CX-123 rule 24).
 *
 * A reply that is missing, cut short or of another shape is not an empty
 * set, a zero or a success: it is unknown, and what depends on it fails
 * closed. These answer null for anything but the exact shape, and the
 * caller decides what failing closed means there (keep what it would have
 * deleted, refuse, or say it could not read).
 *
 * Node runtime only: `types.isProxy` comes from node:util. No importer is an
 * edge route, and no client bundle reaches this file (only server actions and
 * type imports do); Next 16's proxy.ts also runs on Node.
 */
import { types } from "node:util";

/**
 * A list's own data slots, as a fresh plain list, with no code of the reply
 * run to read it. A Proxy is refused before any reflection, so none of its
 * traps runs (Codex S on #2672; the check Codex E2 accepted in
 * lib/stats-notes.ts). A plain or frozen array has no executable envelope
 * left: its length and each slot are read as own descriptors, so a slot that
 * is missing (a hole), inherited from a prototype or a getter is not a reply,
 * and the whole answer is null. With `expected`, the length must be exactly it.
 */
function ownSlots(reply: unknown, expected?: number): unknown[] | null {
  if (types.isProxy(reply) || !Array.isArray(reply)) return null;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !Object.hasOwn(length, "value")) return null;
  const count: unknown = length.value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  if (expected !== undefined && count !== expected) return null;
  const out: unknown[] = [];
  for (let i = 0; i < count; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(reply, String(i));
    if (!slot || !Object.hasOwn(slot, "value")) return null;
    out.push(slot.value);
  }
  return out;
}

/**
 * A list of strings (SMEMBERS, LRANGE, ZRANGEBYSCORE, HGETALL): exactly that,
 * as a fresh list read from the reply's own data slots, or null. A Proxy, a
 * hole, an inherited member or a getter is refused, and nothing of the reply
 * is run (Codex S on #2672).
 */
export function stringList(reply: unknown): string[] | null {
  const slots = ownSlots(reply);
  if (!slots) return null;
  for (const member of slots) if (typeof member !== "string") return null;
  return slots as string[];
}

/** A count (DEL, EXISTS, SCARD, HLEN, an EVAL that answers one): a whole number from zero up, or null. */
export function countOf(reply: unknown): number | null {
  return typeof reply === "number" && Number.isSafeInteger(reply) && reply >= 0 ? reply : null;
}

/**
 * A pipeline's replies, only when there is exactly one for each command sent,
 * as a fresh plain list. Each reply is read from the list's own data slot:
 * a slot that is missing (a hole), inherited from a prototype or a getter is
 * not a reply, and the whole answer is null (Codex S on #2672; Codex G on #2806), so nothing
 * read later can answer differently from what was checked. A Proxy is refused
 * before any of its traps can run.
 */
export function repliesFor(replies: unknown, commands: number): unknown[] | null {
  return ownSlots(replies, commands);
}

/** Thrown where a reply was not in its exact shape, so what depended on it is said as not done. */
export class UnknownReplyError extends Error {
  constructor(what: string) {
    super(`Redis answered ${what} in an unknown shape`);
    this.name = "UnknownReplyError";
  }
}
