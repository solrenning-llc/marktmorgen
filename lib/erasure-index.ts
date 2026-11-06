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
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";

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
 * Deletes every record noted for this address in this store, and the note itself.
 *
 * The note is the only way to the records (audit SG2, finding 4): a reply
 * not in its exact shape deletes nothing, keeps the note and fails, so the
 * erasure says this step is not finished instead of a receipt of none.
 */
export async function forgetNoted(statsId: string | null | undefined, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const index = indexKey(statsId, email);
  const notes = notesKey(statsId, email);
  const replies = repliesFor(await redisPipeline([["SMEMBERS", index], ["ZRANGEBYSCORE", notes, "-inf", "+inf"]]), 2);
  const raw = stringList(replies?.[0]);
  const scored = stringList(replies?.[1]);
  if (!raw || !scored) throw new UnknownReplyError("the notes of an address's records");
  const keys = [...new Set([...raw, ...scored].filter((k) => k.startsWith("nl:")))];
  const held = (raw.length ? 1 : 0) + (scored.length ? 1 : 0);
  const [gone] = await redisPipeline([["DEL", index, notes, ...keys]]);
  const count = countOf(gone);
  if (count === null) throw new UnknownReplyError("the deletion of an address's records");
  return Math.max(0, count - held);
}
