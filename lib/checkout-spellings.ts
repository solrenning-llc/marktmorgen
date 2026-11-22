/**
 * The spellings of a buyer's address as they typed it at a store's checkout, for the copy of their data (#5125,
 * "checkoutsOf casing"; coordinator c414, f474, 80ec, f2e3 and 1b74, 22 November 2026).
 *
 * The copy finds what is kept by the payment (a gift bought, places bought for a group, a shipment, a booked call, a
 * pre-order) by listing the person's paid checkouts on the creator's Stripe account, filtered by the address
 * (lib/person-copy-stripe.ts, paidCheckoutsOf). Stripe's documentation does not say that filter ignores case (its
 * Customers list says its own email filter is case-sensitive), so it is taken as exact. The copy asks it for the address
 * as the person gives it and in lower case; a buyer who typed "Ada@Example.com" at checkout would be found by neither.
 * So each paid checkout's address, when it is not already in lower case, is kept here, and the copy also asks Stripe
 * for each spelling kept for the address.
 *
 *   nl:spell:<store>   hash   sha256 of the address in lower case → the spellings typed, as typed (trimmed), one a line
 *
 * Kept as long as the store is, like the buyer's contact: the records it leads to can outlive any date set from the
 * order (a pre-order's hash is kept 400 days from its product's last change, whoever made it). Deleted with the store,
 * and with the person unless a record kept on purpose still leads to it (lib/person-erasure.ts).
 *
 * Written by the five-minute sweep's walk over the day's completed checkouts (lib/checkout-sweep.ts), which reads every
 * paid checkout of the store whatever kind of order it is. An address typed all in lower case writes nothing: the copy
 * asks for that spelling anyway. Charged in the store's data room as an order's records are (lib/order-data.ts), and
 * held inside ORDER_DATA_BYTES (tests/store-data-registry.ts, nl:spell:).
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isSettled } from "@/lib/instant-pay";
import { orderWriteIfSame } from "@/lib/order-data";
import { paidCheckoutsOf } from "@/lib/person-copy-stripe";
import { entriesKey } from "@/lib/preorders";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { type Store, saleHandles } from "@/lib/store";

/** The longest spelling kept: an address longer than this is not one (RFC 5321 allows 254). */
export const SPELLING_MOST_BYTES = 254;
/** Tries of one address's checked write before the page is left for the next run (another writer changed it between). */
export const SPELLING_TRIES = 3;
/**
 * The most Redis commands one try sends: the HGET of the address's field, then the checked write's EVAL and every
 * redis.call its script (ORDER_WRITE_IF_SAME) can make for one HSET, counted from the script's text in
 * tests/checkout-spellings.test.ts.
 */
export const SPELLING_TRY_COMMANDS = 21;
/** The most one paid checkout's spelling costs in commands: every try, at its most. Priced in the orders line. */
export const SPELLING_ORDER_COMMANDS = SPELLING_TRIES * SPELLING_TRY_COMMANDS;

export const spellingsKey = (statsId: string) => `nl:spell:${statsId}`;
export const spellingField = (email: string) => createHash("sha256").update(normaliseEmail(email)).digest("hex");
const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

type Paid = { id?: unknown; status?: unknown; payment_status?: unknown; metadata?: Record<string, string> | null; customer_details?: { email?: unknown } | null };

/**
 * The spelling a paid checkout of this store leaves to keep, or null: not paid, not this store's, no address, an
 * address already in lower case (the copy asks for it anyway), or one longer than any address.
 */
export function spellingOf(store: Pick<Store, "handle" | "previousHandles" | "releasedHandles">, session: Paid): string | null {
  if (!isSettled(session) || !saleHandles(store).has(session.metadata?.store ?? "")) return null;
  const typed = session.customer_details?.email;
  if (typeof typed !== "string") return null;
  const spelling = typed.trim();
  if (!spelling || /[\r\n]/.test(spelling) || spelling === normaliseEmail(spelling) || Buffer.byteLength(spelling) > SPELLING_MOST_BYTES) return null;
  return spelling;
}

/** The spellings in a field's value, read exactly: lines of text, each a spelling. Anything else is unknown. */
function linesOf(value: unknown): string[] {
  if (value === null) return [];
  if (typeof value !== "string" || !value) throw new UnknownReplyError("the spellings of a person's address");
  const lines = value.split("\n");
  if (lines.some((line) => !line || Buffer.byteLength(line) > SPELLING_MOST_BYTES)) throw new UnknownReplyError("the spellings of a person's address");
  return lines;
}

/**
 * Keeps the spellings of these checkouts' addresses, each address's new spelling added once to its field, by a checked
 * write that never writes over a change made in between. Throws when one is not known to be kept, so the caller does
 * not go past these checkouts as if it were.
 */
export async function keepSpellings(store: Store, sessions: readonly Paid[]): Promise<number> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return 0;
  const key = spellingsKey(statsId);
  const spellings = [...new Set(sessions.map((session) => spellingOf(store, session)).filter((s): s is string => s !== null))];
  let added = 0;
  for (const spelling of spellings) {
    const field = spellingField(spelling);
    for (let tried = 0; ; tried += 1) {
      if (tried >= SPELLING_TRIES) throw new UnknownReplyError("the spelling of a buyer's address, changed by another writer each time");
      const read = repliesFor(await redisPipeline([["HGET", key, field]]), 1);
      if (!read) throw new UnknownReplyError("the spellings of a person's address");
      const kept = linesOf(read[0]);
      if (kept.includes(spelling)) break;
      const value = typeof read[0] === "string" ? read[0] : "";
      const written = await orderWriteIfSame(store, [{ key, field, sha1: value ? sha1(value) : "" }], [["HSET", key, field, [...kept, spelling].join("\n")]]);
      if (written === null) continue;
      if (written.length !== 1 || (written[0] !== 0 && written[0] !== 1)) throw new UnknownReplyError("the spelling of a buyer's address");
      added += 1;
      break;
    }
  }
  return added;
}

/**
 * The spellings kept for an address in this store, read exactly: lines of text, or none. Anything else throws
 * UnknownReplyError, never "no other spelling", which would leave the person's records out of their copy.
 */
export async function spellingsOf(statsId: string, email: string): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const read = repliesFor(await redisPipeline([["HGET", spellingsKey(statsId), spellingField(email)]]), 1);
  if (!read) throw new UnknownReplyError("the spellings of a person's address");
  return linesOf(read[0]);
}

/**
 * Whether a spelling still leads to a record kept on purpose after the person's erasure: a pre-order (lib/preorders.ts,
 * kept until it is delivered or refunded, lib/person-data.ts), found as the copy finds it, through the person's paid
 * checkouts of the store under that spelling. A list that cannot be read whole, or an entry that does not read, throws:
 * the erasure keeps the spellings and is made again, never deletes the way to a record still kept.
 */
async function leadsToKept(store: Store, spellings: readonly string[]): Promise<boolean> {
  const statsId = store.statsId;
  if (!statsId) return false;
  for (const spelling of spellings) {
    const checkouts = await paidCheckoutsOf(store, spelling);
    if (checkouts === null) throw new UnknownReplyError("a person's paid checkouts, read before their spellings go");
    const asked = checkouts.filter((c) => c.meta.preorder === "yes" && Boolean(c.meta.product));
    if (!asked.length) continue;
    const replies = repliesFor(await redisPipeline(asked.map((c) => ["HGET", entriesKey(statsId, c.meta.product), c.id])), asked.length);
    if (!replies || replies.some((reply) => reply !== null && typeof reply !== "string")) throw new UnknownReplyError("a person's pre-orders, read before their spellings go");
    if (replies.some((reply) => reply !== null)) return true;
  }
  return false;
}

/**
 * A person's spellings in this store, at their erasure: deleted, unless one still leads to a pre-order kept on
 * purpose, when they stay until it does not (the next erasure of the person, or the store's). Nothing is added or
 * renewed here. Answers the fields deleted, 0 or 1; a reply of another shape throws, so the erasure is made again.
 */
export async function forgetSpellingsPerson(store: Store, email: string): Promise<number> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return 0;
  const spellings = await spellingsOf(statsId, email);
  if (!spellings.length || (await leadsToKept(store, spellings))) return 0;
  const [gone] = repliesFor(await redisPipeline([["HDEL", spellingsKey(statsId), spellingField(email)]]), 1) ?? [undefined];
  if (gone !== 0 && gone !== 1) throw new UnknownReplyError("the deletion of a person's spellings");
  return gone;
}
