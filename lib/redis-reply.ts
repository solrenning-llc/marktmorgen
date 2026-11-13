/**
 * Reading a Redis reply only in its exact shape (audit SG2, CX-123 rule 24).
 *
 * A reply that is missing, cut short or of another shape is not an empty
 * set, a zero or a success: it is unknown, and what depends on it fails
 * closed. These answer null for anything but the exact shape, and the
 * caller decides what failing closed means there (keep what it would have
 * deleted, refuse, or say it could not read).
 *
 * Node's isProxy (node:util) is read at run time through
 * process.getBuiltinModule (Node 20.16+/22.3+; CI and the server run Node 22/24)
 * rather than imported, so a client bundle that reaches this file through a
 * shared module (components/blog-body.tsx -> lib/store-blog.ts) still builds: in
 * a browser there is no Redis reply to read, and no Proxy check is needed there.
 */
type ProxyCheck = (value: unknown) => boolean;
/**
 * The Proxy check for where this runs: Node's own when it can be read; in a browser (no Redis reply ever reaches
 * there) none is needed; on a server without it (a Node older than 20.16/22.3), every reply counts as a Proxy, so
 * each read fails closed as unknown and says so once, never quietly accepting a reply whose traps would run
 * (Revisor 1 on #2822).
 */
export function proxyCheckFor(host: { getBuiltinModule?: (id: string) => unknown } | undefined, browser: boolean): ProxyCheck {
  const util = host?.getBuiltinModule?.("node:util") as { types?: { isProxy?: unknown } } | undefined;
  const check = util?.types?.isProxy;
  if (typeof check === "function") return check as ProxyCheck;
  if (browser) return () => false;
  let told = false;
  return () => {
    if (!told) {
      told = true;
      console.error("node:util isProxy is not available on this server; every Redis reply is read as unknown (Node 20.16+/22.3+ needed)");
    }
    return true;
  };
}
const isProxy: ProxyCheck = proxyCheckFor(
  typeof process === "undefined" ? undefined : (process as { getBuiltinModule?: (id: string) => unknown }),
  typeof window !== "undefined",
);

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
  if (isProxy(reply) || !Array.isArray(reply)) return null;
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

/**
 * A list of any members (an EVAL that answers a list of numbers), as a fresh
 * plain list read from the reply's own data slots, or null: a Proxy, a hole,
 * an inherited member or a getter is refused (ownSlots). The caller checks
 * each member's shape.
 */
export function replyList(reply: unknown): unknown[] | null {
  return ownSlots(reply);
}

/**
 * A list's own data slots, whatever each holds, as a fresh plain list, or null for anything that is not a plain list
 * (a Proxy, a hole, an inherited slot or a getter). For a reply whose members are read one by one, so a member that
 * cannot be read is told apart from the ones that can; nothing of the reply is run.
 */
export function listSlots(reply: unknown): unknown[] | null {
  return ownSlots(reply);
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

/**
 * One page of a SCAN, SSCAN, HSCAN or ZSCAN, read exactly (rules 24 and 30, review of #2921): the pipeline's one
 * reply, a [cursor, items] pair whose cursor is a string of digits and whose items are strings; null for anything
 * else. A page that does not read is unknown: never the end of the walk ("0"), never a page with nothing on it.
 * The caller throws UnknownReplyError on null, and bounds its walk with a page ceiling past which it is unknown too.
 */
export function scanPage(replies: unknown): { next: string; items: string[] } | null {
  const reply = ownSlots(replies, 1);
  const page = reply ? ownSlots(reply[0], 2) : null;
  if (!page) return null;
  const next = page[0];
  // "", "abc", " 0" or a number is not a cursor (Codex T on #2921): it would end the walk or mislead it.
  if (typeof next !== "string" || !/^[0-9]+$/.test(next)) return null;
  const items = stringList(page[1]);
  return items ? { next, items } : null;
}

/** Thrown where a reply was not in its exact shape, so what depended on it is said as not done. */
export class UnknownReplyError extends Error {
  constructor(what: string) {
    super(`Redis answered ${what} in an unknown shape`);
    this.name = "UnknownReplyError";
  }
}
