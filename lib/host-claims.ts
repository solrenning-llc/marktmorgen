/**
 * The times each host is taken for, across every store they host on, and
 * the one atomic step that takes a time for them.
 *
 * A store's bookings are checked under the store's own lock (lib/calls.ts),
 * which is enough for one store. A host can be on the teams of two stores,
 * though, and two stores have two locks: two buyers on two stores could each
 * pass their own store's check for the same person at the same hour. So
 * every team booking, held or paid, is also written into the host's own
 * list, and that write is a Lua script that checks and writes in one step on
 * the Redis side: it refuses when anything already in the list comes within
 * the host's gap, or when the host's day already has their daily cap of team
 * calls, and for a collective call it takes every host's time or none.
 *
 *   nl:host:claims:<host id>   hash: claim id -> "start|end|until|ref"
 *
 * `until` is 0 for a paid booking and the moment a hold runs out otherwise;
 * a hold that ran out, and anything that ended two days ago, is dropped by
 * the script as it reads. A claim keeps its id for life, so moving a booking
 * is the same script with the same id at the new time (it never conflicts
 * with itself), and letting it go deletes that one field.
 *
 * The host id is a hash of the sign-in address, the same on every store, so
 * the list is the person's and not a store's.
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList, UnknownReplyError } from "@/lib/redis-reply";

/**
 * KEYS: one claims hash per host. ARGV: now, start, end, claim id, until
 * (0 = booked), ref; then four per key: gap ms, start and end of the host's
 * day, daily cap. Returns {1, 0} when every host's time was taken, {-1, i}
 * when host i has something within the gap, {-2, i} when host i's day is
 * full, {-3, i} for anything malformed, writing nothing in every refusal.
 * A claim of the same id already kept for good (until 0) stays kept for good:
 * a hold written over it never downgrades it, so a group call's seat paid
 * while another seat's hold was being written keeps the owner's time (cloud
 * J's review of #3490, MEDIUM; team claims have ids of their own).
 */
export const CLAIM_HOST_TIMES = `-- marktmorgen:host-claim:v2
local now = tonumber(ARGV[1])
local s = tonumber(ARGV[2])
local e = tonumber(ARGV[3])
local claim = ARGV[4]
local hold = tonumber(ARGV[5])
local ref = ARGV[6]
if not now or not s or not e or e <= s or not hold or claim == "" or #ARGV ~= 6 + 4 * #KEYS or #KEYS == 0 then return {-3, 0} end
for i = 1, #KEYS do
  local kind = redis.call("TYPE", KEYS[i]).ok
  if kind ~= "none" and kind ~= "hash" then return {-3, i} end
end
local drop = {}
local paid = {}
for i = 1, #KEYS do
  local base = 6 + (i - 1) * 4
  local gap = tonumber(ARGV[base + 1])
  local d0 = tonumber(ARGV[base + 2])
  local d1 = tonumber(ARGV[base + 3])
  local cap = tonumber(ARGV[base + 4])
  if not gap or not d0 or not d1 or not cap or gap < 0 then return {-3, i} end
  local rows = redis.call("HGETALL", KEYS[i])
  local count = 0
  local stale = {}
  for j = 1, #rows, 2 do
    local a, b, u = string.match(rows[j + 1], "^(%d+)|(%d+)|(%d+)|")
    a = tonumber(a)
    b = tonumber(b)
    u = tonumber(u)
    if not a or not b or not u then return {-3, i} end
    if (u > 0 and u < now) or b < now - 172800000 then
      stale[#stale + 1] = rows[j]
    elseif rows[j] == claim then
      if u == 0 then paid[i] = true end
    else
      if s < b + gap and e + gap > a then return {-1, i} end
      if a >= d0 and a < d1 then count = count + 1 end
    end
  end
  if count >= cap then return {-2, i} end
  drop[i] = stale
end
local keep = e - now + 172800000
for i = 1, #KEYS do
  if #drop[i] > 0 then redis.call("HDEL", KEYS[i], unpack(drop[i])) end
  local until_ = hold
  if paid[i] then until_ = 0 end
  redis.call("HSET", KEYS[i], claim, s .. "|" .. e .. "|" .. until_ .. "|" .. ref)
  if redis.call("PTTL", KEYS[i]) < keep then redis.call("PEXPIRE", KEYS[i], keep) end
end
return {1, 0}`;

/** How long a held claim outlasts the checkout it was made for: the checkout's own half hour is counted by the caller. */
export const CLAIM_MARGIN_MS = 10 * 60_000;

const CLAIM_ID = /^k[0-9a-f]{24}$/;
const HOST_ID = /^[0-9a-f]{24}$/;

/** The id a person has as a host, the same on every store. */
export function hostId(email: string): string {
  return createHash("sha256").update(`marktmorgen-host:${email.trim().toLowerCase()}`).digest("hex").slice(0, 24);
}

export function isHostId(value: unknown): value is string {
  return typeof value === "string" && HOST_ID.test(value);
}

export function newClaimId(): string {
  return `k${randomBytes(12).toString("hex")}`;
}

export function isClaimId(value: unknown): value is string {
  return typeof value === "string" && CLAIM_ID.test(value);
}

export const claimsKey = (id: string) => `nl:host:claims:${id}`;

export type HostClaim = { claim: string; start: number; end: number; until: number; ref: string };

/** One stored claim, or null when it cannot be read. */
export function parseClaim(claim: string, raw: unknown): HostClaim | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d+)\|(\d+)\|(\d+)\|(.*)$/.exec(raw);
  if (!match) return null;
  return { claim, start: Number(match[1]), end: Number(match[2]), until: Number(match[3]), ref: match[4] };
}

/**
 * Each host's live claims: held ones still running and booked ones. A list
 * that cannot be read throws, and the caller offers none of that host's times.
 */
export async function readClaims(ids: string[], now = Date.now()): Promise<Map<string, HostClaim[]>> {
  const out = new Map<string, HostClaim[]>();
  if (!ids.length || !isRedisConfigured()) return out;
  const replies = repliesFor(await redisPipeline(ids.map((id) => ["HGETALL", claimsKey(id)])), ids.length);
  if (!replies) throw new UnknownReplyError("the hosts' claims");
  ids.forEach((id, i) => {
    // Only a list of field/value strings is a host's claims; an absent list is an empty one.
    const flat = stringList(replies[i]);
    if (!flat || flat.length % 2) throw new UnknownReplyError("a host's claims");
    const list: HostClaim[] = [];
    for (let j = 0; j + 1 < flat.length; j += 2) {
      const claim = parseClaim(String(flat[j]), flat[j + 1]);
      if (!claim) throw new Error("a host's claims could not be read");
      if (claim.until > 0 && claim.until < now) continue;
      list.push(claim);
    }
    out.set(id, list);
  });
  return out;
}

export type ClaimHost = { id: string; gapMs: number; day: [number, number]; cap: number };

export type ClaimResult = { ok: true } | { ok: false; reason: "taken" | "cap" | "invalid"; host: number };

/**
 * Takes [start, end) for every host given, in one step, or for none. `until`
 * is when a hold runs out, or 0 for a booking.
 */
export async function claimHosts(input: {
  hosts: ClaimHost[];
  start: number;
  end: number;
  claim: string;
  until: number;
  ref: string;
  now?: number;
}): Promise<ClaimResult> {
  const now = input.now ?? Date.now();
  if (!input.hosts.length || !isClaimId(input.claim) || !/^[A-Za-z0-9:_-]{1,120}$/.test(input.ref)) return { ok: false, reason: "invalid", host: 0 };
  const args: (string | number)[] = [now, input.start, input.end, input.claim, input.until, input.ref];
  for (const h of input.hosts) args.push(Math.max(0, Math.round(h.gapMs)), h.day[0], h.day[1], h.cap);
  const replies = repliesFor(await redisPipeline([["EVAL", CLAIM_HOST_TIMES, input.hosts.length, ...input.hosts.map((h) => claimsKey(h.id)), ...args]]), 1);
  // Only the script's exact pair of whole numbers is an answer; anything else is refused as invalid.
  const pair = replies ? repliesFor(replies[0], 2) : null;
  const [code, index] = pair && pair.every((n) => Number.isSafeInteger(n)) ? (pair as number[]) : [Number.NaN, 0];
  if (code === 1 && index === 0) return { ok: true };
  const host = Math.max(0, (index || 1) - 1);
  if (code === -1) return { ok: false, reason: "taken", host };
  if (code === -2) return { ok: false, reason: "cap", host };
  return { ok: false, reason: "invalid", host };
}

/** A pipeline's replies, exactly one per command, or null: a reply in another shape, or a request that failed, is unknown. */
async function exactly(commands: (string | number)[][]): Promise<unknown[] | null> {
  try {
    return repliesFor(await redisPipeline(commands), commands.length);
  } catch {
    return null;
  }
}

/** A PTTL reply: a whole number from -2 (no key) and -1 (no lifetime) up, or null. */
const ttlOf = (reply: unknown): number | null => (typeof reply === "number" && Number.isSafeInteger(reply) && reply >= -2 ? reply : null);

/** Whether the field holds exactly this paid value, read with an exact HGET (unknown is not). */
async function holds(key: string, claim: string, value: string): Promise<boolean> {
  const replies = await exactly([["HGET", key, claim]]);
  return replies !== null && replies[0] === value;
}

/** Whether the list lives at least `keep` (less a minute for the time the reads took), read with an exact PTTL. */
async function lasts(key: string, keep: number): Promise<boolean> {
  const replies = await exactly([["PTTL", key]]);
  const ttl = replies ? ttlOf(replies[0]) : null;
  return ttl !== null && ttl >= keep - 60_000;
}

/**
 * A paid booking: its claim stays for good (until its time is past). Written
 * whatever is there, because the buyer has paid for this time: a claim that
 * ran out before they came back is written again rather than lost.
 *
 * A reply not exactly what was asked for is never taken for done or for not
 * done: the field is read back with HGET, and if it does not hold the paid
 * value, the same write is sent once more and read back again; the lifetime
 * is read back with PTTL the same way. Every host of a group booking is tried,
 * each on its own, before anything throws: a host that fails never leaves the
 * others as holds that lapse. Only what is still not confirmed throws, once,
 * after the last host, and lib/calls.ts logs it. Sent again, it is the same
 * write under the same claim id, so a host already confirmed stays as it is.
 */
export async function confirmClaim(ids: string[], claim: string, start: number, end: number, ref: string): Promise<void> {
  if (!ids.length || !isClaimId(claim) || !isRedisConfigured()) return;
  const keep = Math.max(3600_000, end - Date.now() + 172_800_000);
  const value = `${start}|${end}|0|${ref}`;
  const commands = ids.flatMap((id) => [["HSET", claimsKey(id), claim, value], ["PTTL", claimsKey(id)]]);
  const replies = await exactly(commands);
  const short: string[] = [];
  // What is still not confirmed, host by host; thrown only once every host has been tried.
  const failed: string[] = [];
  for (const [i, id] of ids.entries()) {
    const key = claimsKey(id);
    const written = replies !== null && countOf(replies[i * 2]) !== null;
    if (!written) {
      console.error("a paid booking's host claim was not answered as asked; reading it back");
      if (!(await holds(key, claim, value))) {
        await exactly([["HSET", key, claim, value]]);
        if (!(await holds(key, claim, value))) {
          failed.push("a paid booking's host claim");
          continue;
        }
      }
    }
    // The PTTL read with the write counts only when the write was answered; otherwise it is read again.
    let ttl = written ? ttlOf(replies[i * 2 + 1]) : null;
    if (ttl === null) {
      const again = await exactly([["PTTL", key]]);
      ttl = again ? ttlOf(again[0]) : null;
      if (ttl === null) {
        failed.push("a paid booking's host claims' lifetime");
        continue;
      }
    }
    // Never shortened: a later booking on the same list may need it longer.
    if (ttl < keep) short.push(id);
  }
  const set = short.length ? await exactly(short.map((id) => ["PEXPIRE", claimsKey(id), keep])) : [];
  for (const [i, id] of short.entries()) {
    if (set !== null && set[i] === 1) continue;
    const key = claimsKey(id);
    console.error("a paid booking's host claim's lifetime was not answered as set; reading it back");
    if (await lasts(key, keep)) continue;
    await exactly([["PEXPIRE", key, keep]]);
    if (!(await lasts(key, keep))) failed.push("a paid booking's host claims' lifetime");
  }
  if (failed.length) throw new UnknownReplyError(failed[0]);
}

/** Lets a claim go on every host it was taken for: a hold given back, or a booking refunded in full. */
export async function releaseClaim(ids: string[], claim: string): Promise<void> {
  if (!ids.length || !isClaimId(claim) || !isRedisConfigured()) return;
  const commands = ids.map((id) => ["HDEL", claimsKey(id), claim]);
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  if (!replies || replies.some((r) => countOf(r) === null)) throw new UnknownReplyError("a host claim's release");
}
