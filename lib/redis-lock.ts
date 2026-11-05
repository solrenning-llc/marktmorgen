/**
 * A lock in Redis that only its holder can let go of, and that a write can
 * check it still holds before it lands.
 *
 * Several records here are read, changed and written back: a store and its
 * product index (lib/store.ts), a store's team (lib/team.ts). Two requests
 * doing that at the same instant would each write back what they read, and
 * the second would quietly undo the first — a product that vanishes from the
 * index, a person taken off a team who is back a moment later. So each
 * change takes the record's lock first, and the next one waits its turn.
 *
 * The lock is a key set with NX and an expiry, holding a random token of the
 * request that took it. Three things about it are done in one step on the
 * Redis side, with a short script, because doing them as two commands leaves
 * a gap another request can fall into:
 *
 *   - letting go deletes the key only if it still holds our token, so a lock
 *     that ran out and was taken by the next request is never deleted by us;
 *   - holding on (before a write that matters) makes the lock last longer,
 *     again only if it is still ours, and says whether it was;
 *   - a fenced write sets a record only while the lock is still ours, so a
 *     request that was held up past its lock's expiry — a slow network, a
 *     paused function — cannot land a stale copy over a newer one.
 *
 * Upstash runs these scripts (EVAL). Where a Redis does not, each falls back
 * to the same checks made as separate commands, which keeps the rules and
 * only loses the single step; the stand-ins the local checks use are like
 * that.
 */
import { redisPipeline } from "@/lib/redis";

const RELEASE = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
const EXTEND = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end';
const FENCED_SET = 'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[2], ARGV[2]) return 1 else return 0 end';
const FENCED_SET_NEW =
  'if redis.call("GET", KEYS[1]) == ARGV[1] and redis.call("EXISTS", KEYS[2]) == 0 then redis.call("SET", KEYS[2], ARGV[2]) return 1 else return 0 end';

export type Held = { key: string; token: string; ttlSeconds: number };

/** Thrown when a lock stayed taken for longer than we wait, or was lost before a write. */
export class LockBusyError extends Error {
  constructor(message = "busy") {
    super(message);
    // Named, so a caller that tells it by its name (lib/paypal-payouts.ts) or a log line knows it; prefer instanceof.
    this.name = "LockBusyError";
  }
}

async function script(source: string, keys: string[], args: (string | number)[], fallback: () => Promise<number>): Promise<number> {
  try {
    const [result] = await redisPipeline([["EVAL", source, keys.length, ...keys, ...args]]);
    return result === 1 ? 1 : 0;
  } catch {
    return fallback();
  }
}

/**
 * Takes the lock at `key`, waiting up to `waitMs` for another holder to let
 * go. Returns what the holder needs to keep and release it, or throws
 * LockBusyError.
 */
export async function takeLock(key: string, ttlSeconds: number, waitMs: number): Promise<Held> {
  const token = crypto.randomUUID();
  const giveUpAt = Date.now() + waitMs;
  for (let wait = 20; ; wait = Math.min(wait * 2, 250)) {
    const receipt = await redisPipeline([["SET", key, token, "NX", "EX", ttlSeconds]]);
    // One acquisition command needs exactly one reply before work can start.
    if (!Array.isArray(receipt) || receipt.length !== 1) throw new LockBusyError();
    const got: unknown = receipt[0];
    if (got === "OK") return { key, token, ttlSeconds };
    if (got !== null) throw new LockBusyError();
    if (Date.now() + wait > giveUpAt) throw new LockBusyError();
    await new Promise((resolve) => setTimeout(resolve, wait + Math.floor(Math.random() * 20)));
  }
}

/** Lets go of a lock, only if it is still ours. Never throws. */
export async function releaseLock(held: Held): Promise<void> {
  await script(RELEASE, [held.key], [held.token], async () => {
    const [now] = await redisPipeline([["GET", held.key]]);
    if (now !== held.token) return 0;
    const [gone] = await redisPipeline([["DEL", held.key]]);
    return Number(gone);
  }).catch(() => 0);
}

/**
 * Makes the lock last another full term, if it is still ours. False when it
 * ran out and somebody else may have written since: the caller must not
 * write what it read.
 */
export async function holdLock(held: Held): Promise<boolean> {
  const kept = await script(EXTEND, [held.key], [held.token, held.ttlSeconds], async () => {
    const [now] = await redisPipeline([["GET", held.key]]);
    if (now !== held.token) return 0;
    const [renewed] = await redisPipeline([["EXPIRE", held.key, held.ttlSeconds]]);
    return renewed === 1 ? 1 : 0;
  });
  return kept === 1;
}

/**
 * Sets `key` to `value` only while the lock is still ours — and, with
 * `absent`, only when nothing is there yet. False, and nothing written,
 * otherwise.
 */
export async function setIfHeld(held: Held, key: string, value: string, options: { absent?: boolean } = {}): Promise<boolean> {
  const done = await script(options.absent ? FENCED_SET_NEW : FENCED_SET, [held.key, key], [held.token, value], async () => {
    const [now, there] = await redisPipeline([["GET", held.key], ["EXISTS", key]]);
    if (now !== held.token || (options.absent && there !== 0)) return 0;
    const [written] = await redisPipeline([["SET", key, value]]);
    return written === "OK" ? 1 : 0;
  });
  return done === 1;
}

/**
 * Fenced writes that never fall back (lib/passkeys.ts, lib/two-step.ts): each
 * is one script on the Redis side, and when the script cannot run, nothing is
 * written and the answer is false, so the caller treats it as a lost lock.
 * The first line names the script for the local stand-in (lib/redis-memory.ts).
 */
const FENCED_SET_ONLY = '-- marktmorgen:fenced-set:v1\nif redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[2], ARGV[2]) return 1 else return 0 end';
const FENCED_SET_NEW_ONLY =
  '-- marktmorgen:fenced-set-new:v1\nif redis.call("GET", KEYS[1]) == ARGV[1] and redis.call("EXISTS", KEYS[2]) == 0 then redis.call("SET", KEYS[2], ARGV[2]) return 1 else return 0 end';
const FENCED_DEL_ONLY =
  '-- marktmorgen:fenced-del:v1\nif redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end\nfor i = 2, #KEYS do redis.call("DEL", KEYS[i]) end\nreturn 1';

async function strictScript(source: string, keys: string[], args: string[]): Promise<boolean> {
  try {
    const [result] = await redisPipeline([["EVAL", source, keys.length, ...keys, ...args]]);
    return result === 1;
  } catch {
    return false;
  }
}

/** Sets `key` only while the lock is still ours (and, with `absent`, only when nothing is there), in one script; false otherwise, never a fallback. */
export async function setIfHeldOnly(held: Held, key: string, value: string, options: { absent?: boolean } = {}): Promise<boolean> {
  return strictScript(options.absent ? FENCED_SET_NEW_ONLY : FENCED_SET_ONLY, [held.key, key], [held.token, value]);
}

/** Deletes `keys` only while the lock is still ours, in one script; false otherwise, never a fallback. */
export async function deleteIfHeldOnly(held: Held, keys: string[]): Promise<boolean> {
  if (!keys.length) return true;
  return strictScript(FENCED_DEL_ONLY, [held.key, ...keys], [held.token]);
}

/** Runs `work` with the lock at `key` held, and lets go of it after, whatever happens. */
export async function withLock<T>(key: string, ttlSeconds: number, waitMs: number, work: (held: Held) => Promise<T>): Promise<T> {
  const held = await takeLock(key, ttlSeconds, waitMs);
  try {
    return await work(held);
  } finally {
    await releaseLock(held);
  }
}

/**
 * Strict raw-record CAS for a future funded Store writer. This is only an
 * atomic persistence primitive, never a payment/funding/ledger authorization.
 * No production caller uses it yet. Unlike legacy helpers, an ambiguous EVAL
 * never falls back to separate GET/SET commands.
 */
export const STRICT_FENCED_CAS_MAX_BYTES = 1_000_000;
export const STRICT_FENCED_CAS = `
if #KEYS~=2 or #ARGV~=4 or KEYS[1]==KEYS[2] then return 0 end
local limit=tonumber(ARGV[4])
if not limit or limit~=math.floor(limit) or limit<1 or limit>1000000 then return 0 end
if #KEYS[1]<1 or #KEYS[1]>512 or #KEYS[2]<1 or #KEYS[2]>512 or #ARGV[1]<1 or #ARGV[1]>128 or #ARGV[2]>limit or #ARGV[3]>limit then return 0 end
local lockType=redis.call('TYPE',KEYS[1]).ok
local valueType=redis.call('TYPE',KEYS[2]).ok
if lockType~='string' or valueType~='string' then return 0 end
if redis.call('PTTL',KEYS[1])<=0 or redis.call('PTTL',KEYS[2])~=-1 then return 0 end
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local current=redis.call('GET',KEYS[2])
if current==ARGV[3] then return 2 end
if current~=ARGV[2] then return 0 end
redis.call('SET',KEYS[2],ARGV[3])
return 1
`;

export type StrictFencedCasResult = "written" | "already-current" | "refused" | "unknown";
export async function strictFencedCompareAndSet(
  held: Held, key: string, expected: string, next: string, maximumBytes: number,
): Promise<StrictFencedCasResult> {
  try {
    // Detached own data only; never invoke a lock token getter or inherited hook.
    if (!held || typeof held !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(held))) return "refused";
    const descriptors = Object.getOwnPropertyDescriptors(held);
    if (Reflect.ownKeys(held).length !== 3 || !["key", "token", "ttlSeconds"].every(name =>
      Object.hasOwn(descriptors, name) && Object.hasOwn(descriptors[name]!, "value"))) return "refused";
    const lock = descriptors.key!.value, token = descriptors.token!.value, ttl = descriptors.ttlSeconds!.value;
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
    if (typeof lock !== "string" || typeof token !== "string" || typeof key !== "string" ||
      !lock || !token || !key || lock === key || bytes(lock) > 512 || bytes(key) > 512 || bytes(token) > 128 ||
      typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0 ||
      typeof expected !== "string" || typeof next !== "string" ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > STRICT_FENCED_CAS_MAX_BYTES ||
      bytes(expected) > maximumBytes || bytes(next) > maximumBytes) return "refused";
    const reply = await redisPipeline([["EVAL", STRICT_FENCED_CAS, 2, lock, key, token, expected, next, maximumBytes]]);
    if (!Array.isArray(reply) || reply.length !== 1 || !Object.hasOwn(reply, 0)) return "unknown";
    const acknowledgement = Object.getOwnPropertyDescriptor(reply, "0");
    if (!acknowledgement || !Object.hasOwn(acknowledgement, "value")) return "unknown";
    if (acknowledgement.value === 1) return "written";
    if (acknowledgement.value === 2) return "already-current";
    return acknowledgement.value === 0 ? "refused" : "unknown";
  } catch { return "unknown"; }
}

/** No production caller yet: a financial writer must not fall back to GET/DEL. */
export const STRICT_RELEASE_LOCK = `
if #KEYS~=1 or #ARGV~=1 or #KEYS[1]<1 or #KEYS[1]>512 or #ARGV[1]<1 or #ARGV[1]>128 then return 0 end
if redis.call('TYPE',KEYS[1]).ok~='string' or redis.call('PTTL',KEYS[1])<=0 then return 0 end
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
return redis.call('DEL',KEYS[1])
`;
export type StrictLockReleaseResult = "released" | "not-owned" | "refused" | "unknown";
/** A lost ACK is unknown even when DEL might have committed. Never retry as
 * separate GET/DEL: a new holder could take the lock between those commands. */
export async function releaseLockStrict(held: Held): Promise<StrictLockReleaseResult> {
  try {
    if (!held || typeof held !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(held))) return "refused";
    const descriptors = Object.getOwnPropertyDescriptors(held);
    if (Reflect.ownKeys(held).length !== 3 || !["key", "token", "ttlSeconds"].every(name =>
      Object.hasOwn(descriptors, name) && Object.hasOwn(descriptors[name]!, "value"))) return "refused";
    const key = descriptors.key!.value, token = descriptors.token!.value, ttl = descriptors.ttlSeconds!.value;
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
    if (typeof key !== "string" || typeof token !== "string" || !key || !token ||
      bytes(key) > 512 || bytes(token) > 128 ||
      typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0) return "refused";
    const reply = await redisPipeline([["EVAL", STRICT_RELEASE_LOCK, 1, key, token]]);
    if (!Array.isArray(reply) || reply.length !== 1) return "unknown";
    const ack = Object.getOwnPropertyDescriptor(reply, "0");
    if (!ack || !Object.hasOwn(ack, "value")) return "unknown";
    return ack.value === 1 ? "released" : ack.value === 0 ? "not-owned" : "unknown";
  } catch { return "unknown"; }
}
