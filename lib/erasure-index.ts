/**
 * Where to find the links a store emailed one person (added 17 October 2026).
 *
 * A link in an email — to stop a kind of email, confirm a waitlist, leave a
 * review, take a place in a group — is kept under its own random token, and
 * its record names the address it was sent to. Nothing leads from the
 * address to the token, which is the point of a token, and also why
 * deleting a person could not find them. So each such record, as it is
 * made, is noted here too, under a one-way fingerprint of the store and the
 * address, for longer than the longest of them lives:
 *
 *   nl:erase:ix:<statsId>:<fingerprint>   sorted set   the keys of the records made for that address, by when
 *
 * Deleting the person (lib/person-erasure.ts) deletes every key in it, and it.
 *
 * Since 18 October 2026 each key is scored by when it was noted, and what
 * was noted longer ago than INDEX_SECONDS, whose record has expired, is let
 * go with the next note: so an address written to every month keeps the
 * notes of its last INDEX_SECONDS, not of every email it ever had
 * (tests/store-data-registry.ts). A set written before that day is read and
 * deleted all the same.
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, listSlots, repliesFor, stringList } from "@/lib/redis-reply";

type Command = (string | number)[];

/** How long a set is kept after its latest record: longer than the longest record noted (a stop link, 400 days). */
export const INDEX_SECONDS = 401 * 86_400;

const indexKey = (statsId: string, email: string) =>
  `nl:erase:ix:${statsId}:${createHash("sha256").update(`nimbus-erase-ix:${statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}`;
/** The same, scored by when each key was noted (since 18 October 2026): a set of the old kind cannot take a score. */
const notesKey = (statsId: string, email: string) => `${indexKey(statsId, email)}:z`;

/**
 * Commands that note a record made for this address, to send with the
 * command that writes it. A store with no stats id notes nothing: it has
 * none of these records.
 */
export function noteForErasure(statsId: string | null | undefined, email: string, key: string, now = Date.now()): Command[] {
  if (!statsId || !email || !key) return [];
  const index = notesKey(statsId, email);
  return [["ZADD", index, now, key], ["ZREMRANGEBYSCORE", index, "-inf", now - INDEX_SECONDS * 1000], ["EXPIRE", index, INDEX_SECONDS]];
}

/** How many times an erasure reads the notes again when they changed between its read and its delete. */
export const FORGET_TRIES = 3;
/**
 * The most records one step names in KEYS: unpacked well under Lua's limit of about 8,000 values, in a request of
 * about 100 KB. An address with more is deleted in batches of this size first (FORGET_NOTED_PART).
 */
export const FORGET_KEYS = 1000;
/** The most batches one erasure deletes (100,000 records) before it says it is not finished. */
const FORGET_BATCHES = 100;

/**
 * Deletes the notes and the records read from them, only while the notes still hold exactly what was read
 * (disclosed on #3296: as a read and then a DEL, a record noted between them lost its note and no later erasure
 * could find it). KEYS: the old-kind set, the scored notes, then each "nl:" record read. ARGV: how many members the
 * set held, those members, then the scored notes' members. Answers {keys deleted, notes that held a key}, or
 * "changed", having deleted nothing, when either note no longer holds exactly those members.
 */
export const FORGET_NOTED = `-- marktmorgen:forget-noted:v2
local n = tonumber(ARGV[1])
if not n or redis.call('SCARD', KEYS[1]) ~= n or redis.call('ZCARD', KEYS[2]) ~= #ARGV - 1 - n then return 'changed' end
for i = 2, n + 1 do
  if redis.call('SISMEMBER', KEYS[1], ARGV[i]) ~= 1 then return 'changed' end
end
for i = n + 2, #ARGV do
  if not redis.call('ZSCORE', KEYS[2], ARGV[i]) then return 'changed' end
end
local held = 0
if n > 0 then held = held + 1 end
if #ARGV - 1 - n > 0 then held = held + 1 end
return {redis.call('DEL', unpack(KEYS)), held}`;

/**
 * One batch of an address with more than FORGET_KEYS records: deletes these records and takes exactly them out of
 * both notes, in one step, so a record is never left without its note (one noted again after this step is noted
 * again with it). KEYS: the old-kind set, the scored notes, then the batch. Answers how many records were deleted,
 * or -1, having deleted nothing, when a note is of another type (a script is not undone: a real redis-server ran the
 * DEL and only then refused the SREM, so the types are checked before any write).
 */
export const FORGET_NOTED_PART = `-- marktmorgen:forget-noted-part:v2
local set, zset = redis.call('TYPE', KEYS[1]).ok, redis.call('TYPE', KEYS[2]).ok
if (set ~= 'none' and set ~= 'set') or (zset ~= 'none' and zset ~= 'zset') then return -1 end
local gone = redis.call('DEL', unpack(KEYS, 3))
redis.call('SREM', KEYS[1], unpack(KEYS, 3))
redis.call('ZREM', KEYS[2], unpack(KEYS, 3))
return gone`;

/**
 * Deletes every record noted for this address in this store, and the note itself.
 *
 * The note is the only way to the records (audit SG2, finding 4): a reply
 * not in its exact shape deletes nothing more, keeps the note and fails, so
 * the erasure says this step is not finished instead of a receipt of none.
 * Notes that keep changing between the read and the delete (FORGET_TRIES
 * times) fail the same way, with nothing deleted by the tries that changed.
 */
export async function forgetNoted(statsId: string | null | undefined, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const index = indexKey(statsId, email);
  const notes = notesKey(statsId, email);
  const what = "the deletion of an address's records";
  let deleted = 0;
  for (let changed = 0, batches = 0; changed < FORGET_TRIES; ) {
    const replies = repliesFor(await redisPipeline([["SMEMBERS", index], ["ZRANGEBYSCORE", notes, "-inf", "+inf"]]), 2);
    const raw = stringList(replies?.[0]);
    const scored = stringList(replies?.[1]);
    if (!raw || !scored) throw new UnknownReplyError("the notes of an address's records");
    const keys = [...new Set([...raw, ...scored].filter((k) => k.startsWith("nl:")))];
    if (keys.length > FORGET_KEYS) {
      // The allowance is checked before the batch is sent: at most FORGET_BATCHES, and still more than FORGET_KEYS
      // records after them means not finished. The final checked step is still allowed after the last batch.
      if (batches >= FORGET_BATCHES) break;
      batches += 1;
      const part = keys.slice(0, FORGET_KEYS);
      const [reply] = repliesFor(await redisPipeline([["EVAL", FORGET_NOTED_PART, 2 + part.length, index, notes, ...part]]), 1) ?? [];
      const count = countOf(reply);
      if (count === null || count > part.length) throw new UnknownReplyError(what);
      deleted += count;
      continue;
    }
    const [reply] = repliesFor(await redisPipeline([["EVAL", FORGET_NOTED, 2 + keys.length, index, notes, ...keys, raw.length, ...raw, ...scored]]), 1) ?? [];
    if (reply === "changed") {
      changed += 1;
      continue;
    }
    const answer = listSlots(reply);
    const count = answer?.length === 2 ? countOf(answer[0]) : null;
    const held = answer?.length === 2 ? countOf(answer[1]) : null;
    // Unchanged notes: exactly the notes read as holding a key were deleted, with at most the keys named.
    if (count === null || held !== (raw.length ? 1 : 0) + (scored.length ? 1 : 0) || count < held || count > keys.length + 2) throw new UnknownReplyError(what);
    return deleted + count - held;
  }
  throw new UnknownReplyError(`${what} (its notes kept changing, or held too many records)`);
}
