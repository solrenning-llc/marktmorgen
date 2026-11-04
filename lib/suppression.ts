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

const suppressedKey = (listId: string) => `nl:erased:${listId}`;

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

/** Which of these addresses were deleted from this store, in one command. */
export async function suppressedAmong(listId: string | null | undefined, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!listId || !emails.length || !isRedisConfigured()) return out;
  const [rows] = await redisPipeline([suppressedAmongCommand(listId, emails)]);
  const list = Array.isArray(rows) ? rows : [];
  emails.forEach((email, i) => {
    if (list[i] !== null && list[i] !== undefined) out.add(email);
  });
  return out;
}
