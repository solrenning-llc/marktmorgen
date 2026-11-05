/**
 * Deletions that answer what they deleted, in one step (added 4 November
 * 2026, for lib/person-erasure.ts).
 *
 * A deletion that gives room back to a store's data room (lib/store-data.ts)
 * has to give back what it removed, and only once. Reading a record and then
 * deleting it in a second command lets two deletions at the same moment both
 * read it and both give its room back; each script below reads and deletes
 * inside Redis, so the second one finds nothing and gives nothing.
 * lib/redis-memory.ts runs the same scripts for the tests.
 */

/** KEYS[1] a hash: every field and value it held (HGETALL's flat list), and the hash deleted. */
export const HASH_TAKE_ALL = `-- marktmorgen:hash-take-all:v1
local held = redis.call("HGETALL", KEYS[1])
if #held > 0 then redis.call("DEL", KEYS[1]) end
return held`;

/** KEYS[1] a hash, ARGV[1] a field: its value, and the field deleted; nil when there was none. */
export const HASH_TAKE_FIELD = `-- marktmorgen:hash-take-field:v1
local value = redis.call("HGET", KEYS[1], ARGV[1])
if value then redis.call("HDEL", KEYS[1], ARGV[1]) end
return value`;

/** KEYS[1] a hash, ARGV[1] a field, ARGV[2] the value it was read with, ARGV[3] its next value: written only when it still holds that value; 1 when written. */
export const HASH_SWAP_IF = `-- marktmorgen:hash-swap-if:v1
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[3])
return 1`;

/** KEYS[1] a hash, ARGV[1] a field, ARGV[2] the value it was read with: deleted only when it still holds that value; 1 when deleted. */
export const HASH_DEL_IF = `-- marktmorgen:hash-del-if:v1
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
return redis.call("HDEL", KEYS[1], ARGV[1])`;

/** KEYS[1] a set: how many members it held, and the set deleted. */
export const SET_TAKE_COUNT = `-- marktmorgen:set-take-count:v1
local n = redis.call("SCARD", KEYS[1])
if n > 0 then redis.call("DEL", KEYS[1]) end
return n`;

/**
 * KEYS[1] a set, KEYS[2..] plain values: {the set's members, each value
 * (false for none, so their places are kept), how many keys were deleted},
 * all of them deleted.
 */
export const SET_AND_VALUES_TAKE = `-- marktmorgen:set-and-values-take:v1
local members = redis.call("SCARD", KEYS[1]) > 0 and redis.call("SMEMBERS", KEYS[1]) or {}
local values = {}
for i = 2, #KEYS do values[i - 1] = redis.call("GET", KEYS[i]) end
local gone = redis.call("DEL", unpack(KEYS))
return {members, values, gone}`;

/**
 * A reply that is not exactly what was asked for: too few or too many
 * replies, or one of the wrong shape. What the command did is then unknown,
 * so nothing is taken for gone and no room is given back; the caller throws
 * it on, and a person's deletion reports its module as incomplete.
 */
export class UnknownReply extends Error {
  constructor(what: string) {
    super(`Redis answered ${what} with a reply it was not asked for; its outcome is unknown`);
    this.name = "UnknownReply";
  }
}

/**
 * A list as Redis's JSON answers it: a real array whose every place holds a
 * plain value, read without running a getter; null for anything else (a hole,
 * an accessor, an array-like object).
 */
function plainList(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw)) return null;
  const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
  if (typeof length !== "number") return null;
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const place = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!place || !("value" in place)) return null;
    out.push(place.value);
  }
  return out;
}

/** The pipeline's replies, exactly `count` of them, each a plain value, or UnknownReply. */
export function exactReplies(replies: unknown, count: number, what: string): unknown[] {
  const list = plainList(replies);
  if (!list || list.length !== count) throw new UnknownReply(what);
  return list;
}

/** A count Redis answered (DEL, HDEL, SREM and the like): a whole number from zero, or UnknownReply. */
export function replyCount(raw: unknown, what: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) throw new UnknownReply(what);
  return raw;
}

/**
 * HGETALL's answer (HASH_TAKE_ALL's) as pairs: only a flat list of strings of
 * even length, as the REST API answers it; an empty list is a confirmed empty
 * hash. Anything else (nothing, a list cut short, another shape) is UnknownReply.
 */
export function takenPairs(raw: unknown, what = "a hash's deletion"): [string, string][] {
  const list = plainList(raw);
  if (!list || list.length % 2 !== 0 || !list.every((item) => typeof item === "string")) throw new UnknownReply(what);
  const out: [string, string][] = [];
  for (let i = 0; i < list.length; i += 2) out.push([list[i] as string, list[i + 1] as string]);
  return out;
}
