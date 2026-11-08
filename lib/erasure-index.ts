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
import { UnknownReplyError, countOf, listSlots, repliesFor } from "@/lib/redis-reply";

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

/**
 * Reads an address's notes and deletes them, with every record they name, in one step (KEYS: the old-kind set, the
 * scored notes). Two steps lost a record noted between them: the read missed its key and the DEL took the notes with
 * its entry, so no later erasure could find it (disclosed on #3296). Only members starting with "nl:" are deleted,
 * in DELs of at most 1,000 keys (a script cannot unpack many more). Answers {keys deleted, notes that held a key}.
 *
 * The records are not in KEYS: they are known only once the notes are read, inside the step. That relies on a
 * single-node Redis (the product's Upstash database); Redis Cluster may refuse a key not declared in KEYS.
 */
export const FORGET_NOTED = `-- marktmorgen:forget-noted:v1
local raw = redis.call('SMEMBERS', KEYS[1])
local scored = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '+inf')
local held = 0
if #raw > 0 then held = held + 1 end
if #scored > 0 then held = held + 1 end
local keys, seen = {KEYS[1], KEYS[2]}, {}
for _, list in ipairs({raw, scored}) do
  for _, key in ipairs(list) do
    if string.sub(key, 1, 3) == 'nl:' and not seen[key] then
      seen[key] = true
      keys[#keys + 1] = key
    end
  end
end
local gone = 0
for i = 1, #keys, 1000 do
  gone = gone + redis.call('DEL', unpack(keys, i, math.min(i + 999, #keys)))
end
return {gone, held}`;

/**
 * Deletes every record noted for this address in this store, and the note itself.
 *
 * The note is the only way to the records (audit SG2, finding 4): a reply
 * not in its exact shape fails, so the erasure says this step is not
 * finished instead of a receipt of none. A script Redis refuses (a note of
 * another type) deletes nothing.
 */
export async function forgetNoted(statsId: string | null | undefined, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const index = indexKey(statsId, email);
  const notes = notesKey(statsId, email);
  const [reply] = repliesFor(await redisPipeline([["EVAL", FORGET_NOTED, 2, index, notes]]), 1) ?? [];
  const answer = listSlots(reply);
  const count = answer?.length === 2 ? countOf(answer[0]) : null;
  const held = answer?.length === 2 ? countOf(answer[1]) : null;
  // The notes that held a key were deleted with the records, so a count below them is not a deletion Redis made.
  if (count === null || held === null || held > 2 || count < held) throw new UnknownReplyError("the deletion of an address's records");
  return Math.max(0, count - held);
}
