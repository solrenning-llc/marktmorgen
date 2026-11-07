/**
 * The one thing kept about a person a store deleted (added 17 October 2026):
 * a one-way fingerprint of their address, so that store never emails them
 * again (CAN-SPAM's opt-out, the GDPR's objection to direct marketing) and
 * no import, API call or list from another platform puts them back.
 *
 *   nl:erased:<listId>   hash  fingerprint -> when they were deleted (seconds)
 *
 * Kept under the store's list id (lib/contacts.ts), which every path that
 * emails a store's people already reads; deleting somebody gives a store
 * without a list one, so the fingerprint always has a place.
 *
 * The fingerprint is a SHA-256 of the store and the address, cut to 32
 * characters. It cannot be read back into an address; it can only answer
 * "is this address the one that was deleted?" when the address is typed
 * again. It holds nothing else: not their name, not what they bought, not
 * who deleted them.
 *
 * Only the person can lift it, by giving their own yes again: asking for
 * something free and confirming by the emailed link, or ticking the box to
 * hear from the creator when they buy (lib/contacts.ts upsertContact). A
 * creator's import never does.
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

type Command = (string | number)[];

/** The store's hash of deleted people's prints, for a script that checks them where it writes (lib/store-readings.ts, lib/calendar-sync.ts). */
export const suppressedKey = (listId: string) => `nl:erased:${listId}`;

/** The fingerprint of one address for one store. */
export function suppressionPrint(listId: string, email: string): string {
  return createHash("sha256").update(`nimbus-erased:${listId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32);
}

/** Notes that this address was deleted from this store. */
export function suppressCommand(listId: string, email: string, nowSeconds = Math.floor(Date.now() / 1000)): Command {
  return ["HSET", suppressedKey(listId), suppressionPrint(listId, email), nowSeconds];
}

/** A command that answers when this address was deleted from this store (seconds), or nil. */
export function suppressedAtCommand(listId: string, email: string): Command {
  return ["HGET", suppressedKey(listId), suppressionPrint(listId, email)];
}

/** Lifts it: the person's own yes, given again. */
export function liftCommand(listId: string, email: string): Command {
  return ["HDEL", suppressedKey(listId), suppressionPrint(listId, email)];
}

/**
 * A command that answers 1 when this address was deleted from this store,
 * to put beside the reads a sending path already makes. A store with no
 * list has deleted nobody.
 */
export function suppressedCommand(listId: string | null | undefined, email: string): Command {
  return listId ? ["HEXISTS", suppressedKey(listId), suppressionPrint(listId, email)] : ["EXISTS", "nl:none"];
}

/** Whether a reply to suppressedCommand says the address was deleted. */
export function wasSuppressed(reply: unknown): boolean {
  return Number(reply) === 1;
}

/** Whether this address was deleted from this store. */
export async function isSuppressed(listId: string | null | undefined, email: string): Promise<boolean> {
  if (!listId || !isRedisConfigured()) return false;
  const [reply] = await redisPipeline([suppressedCommand(listId, email)]);
  return wasSuppressed(reply);
}

/** One command whose answer has, for each address in order, a value when it was deleted from this store and null when not. */
export function suppressedAmongCommand(listId: string, emails: string[]): Command {
  return ["HMGET", suppressedKey(listId), ...emails.map((e) => suppressionPrint(listId, e))];
}

/**
 * A reply to suppressedAmongCommand, read only when it is whole: a list of
 * exactly one entry for each address, each nothing (not deleted), text or a
 * number (deleted). Anything else throws, so a print where nothing came back
 * is never read as "not deleted" (Codex E on #2111): the caller fails closed.
 */
export function wholeErasedReply(reply: unknown, addresses: number): (string | number | null)[] {
  if (!Array.isArray(reply) || reply.length !== addresses || !reply.every((v) => v === null || typeof v === "string" || typeof v === "number")) {
    throw new Error("the store's deleted people could not be read whole");
  }
  return reply as (string | number | null)[];
}

/**
 * A copy kept only when nobody it names was deleted from the store, in one
 * step with the write (review of #2111): KEYS[1] the copy, KEYS[2] the
 * store's prints; ARGV[1] the copy, ARGV[2] its seconds, ARGV[3..] the prints
 * of who it names (at least one). One HMGET; any found: the copy goes and
 * their places (1 for ARGV[3]) are answered; otherwise SET, and an empty
 * list. Billed 1 + 2. Used for the readings (lib/store-readings.ts,
 * READING_COPY) and the memberships' cache (lib/membership-numbers.ts);
 * lib/redis-memory.ts runs it the same way.
 */
export const KEEP_UNLESS_ERASED = `-- marktmorgen:reading-copy:v1
local found = redis.call("HMGET", KEYS[2], unpack(ARGV, 3))
local gone = {}
for i = 1, #found do
  if found[i] then gone[#gone + 1] = i end
end
if #gone > 0 then
  redis.call("DEL", KEYS[1])
  return gone
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return gone`;

/**
 * Keeps `text` at `key` for `seconds` unless one of `emails` (at least one)
 * was deleted from the store, in one step (KEEP_UNLESS_ERASED): returns who
 * was found, and then nothing is kept. Throws when the step cannot run or its
 * reply is not a list of places among them: the caller keeps nothing.
 */
export async function keepUnlessErased(key: string, listId: string, text: string, seconds: number, emails: string[]): Promise<Set<string>> {
  const names = [...new Set(emails)];
  if (!names.length) throw new Error("nobody to look up");
  const replies = await redisPipeline([["EVAL", KEEP_UNLESS_ERASED, 2, key, suppressedKey(listId), text, seconds, ...names.map((e) => suppressionPrint(listId, e))]]);
  const reply: unknown = Array.isArray(replies) && replies.length === 1 ? replies[0] : null;
  if (!Array.isArray(reply) || !reply.every((i) => Number.isInteger(i) && (i as number) >= 1 && (i as number) <= names.length)) {
    throw new Error("the copy could not be checked where it is kept");
  }
  return new Set((reply as number[]).map((i) => names[i - 1]));
}

/** Which of these addresses were deleted from this store, in one command. Throws when the reply is not whole (wholeErasedReply). */
export async function suppressedAmong(listId: string | null | undefined, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!listId || !emails.length || !isRedisConfigured()) return out;
  const replies = await redisPipeline([suppressedAmongCommand(listId, emails)]);
  if (!Array.isArray(replies) || replies.length !== 1) throw new Error("the store's deleted people could not be read whole");
  const list = wholeErasedReply(replies[0], emails.length);
  emails.forEach((email, i) => {
    if (list[i] !== null) out.add(email);
  });
  return out;
}
