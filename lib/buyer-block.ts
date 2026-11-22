/**
 * A creator blocks a person in their own store's messages (567 [GD1] (f),
 * unit 1): the chat, the contact form and a question the store assistant
 * hands over. The reason is the creator's note; it is in the person's copy of their data, and erased with the person.
 *
 *   nl:blk:<sid>   hash: HMAC of the person's address → {"r": reason, "at": ms}
 *
 * Only an HMAC of the address is kept (deriveKey("buyer-block")), never the
 * address itself, and no other store can read it: there is no list shared
 * between stores. At most MAX_BLOCKED a store; each entry's bytes are counted
 * in the store's data room before it is written and given back when it is
 * removed (giveData). The limit is held in one Lua step (BLOCK_LUA). Deleting a person (lib/person-erasure.ts) erases
 * the creator's reason and keeps the one-way mark, so asking to be deleted never lifts a block; the creator still can
 * (Codex X6 on #3839, as lib/community-dm.ts keeps a member's choice to decline messages). The person's copy of their
 * data holds the block with the reason and when (blockForCopy). Closing a store removes the whole list
 * (lib/closed-store-data.ts).
 *
 * What it never stops: a buyer's report of a problem with an order
 * (lib/order-problem.ts) and the EU withdrawal notice (lib/withdrawal.ts).
 * Those protect what a buyer already paid for (567 [GD1], general rule).
 *
 * An unknown reply is unknown: blockedState answers "unknown", never "not
 * blocked", and the callers then refuse the message rather than let it in.
 */
import { createHmac } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { deriveKey } from "@/lib/secret-box";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { dataKey, giveData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import type { Store } from "@/lib/store";

/** The most people one store may block. */
export const MAX_BLOCKED = 500;
/** The longest reason, in characters. */
export const BLOCK_REASON_MAX = 200;
/** The room one entry takes, at its largest: the hash and the reason at four bytes a character. */
export const BLOCK_ENTRY_BYTES = dataBytes(["0".repeat(64), JSON.stringify({ r: "x".repeat(BLOCK_REASON_MAX * 4), at: 8.64e15 })]);
/** The data room's slot for the list. */
export const BLOCK_SLOT = "blk";

export const blockKey = (sid: string) => `nl:blk:${sid}`;

type BlockStore = Pick<Store, "sid"> & Parameters<typeof takeData>[0];

/**
 * An address as one person: normalised, and its "+tag" left out of the part before the "@" (Claude 7 on #3839:
 * "x+tag@" was not blocked when "x@" was). Both spellings reach the same mailbox, so a block covers them all.
 */
function personAddress(email: string): string {
  const address = normaliseEmail(email);
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  const local = address.slice(0, at).replace(/\+.*$/, "");
  return local ? `${local}${address.slice(at)}` : address;
}

/** The HMAC of an address, or null when there is no key to make it with. */
export function personMark(email: string): string | null {
  const key = deriveKey("buyer-block");
  if (!key) return null;
  return createHmac("sha256", key).update(personAddress(email)).digest("hex");
}

/** A reason as kept: one line, at most BLOCK_REASON_MAX characters. */
export function blockReason(raw: unknown): string {
  return typeof raw === "string"
    ? // Well formed after the cut (Claude 7 on #3839): a lone surrogate is written by JSON as six bytes, past the entry's
      // room, and a pair cut at the most would leave one; each becomes U+FFFD, three bytes.
      raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, BLOCK_REASON_MAX).toWellFormed()
    : "";
}

export type BlockState = { blocked: false } | { blocked: true; reason: string; at: number } | "unknown";

function parseEntry(raw: unknown): { reason: string; at: number } | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as { r?: unknown; at?: unknown };
    if (typeof value.r !== "string" || typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
    return { reason: value.r, at: value.at };
  } catch {
    return null;
  }
}

/**
 * The commands one check sends (EXISTS and HGET, the entry up to BLOCK_ENTRY_BYTES), on every buyer message through
 * startChat, handOver, visitorSend and sendContact: priced in the inbox unit (tests/plan-cost-registry.ts
 * UNIT_COST.inbox) and held by tests/buyer-block-commands-priced.test.ts (Claude 7's MEDIUM on #3839).
 */
export const BLOCK_CHECK_COMMANDS = 2;

/**
 * Whether a person is blocked in a store; "unknown" when it cannot be read
 * exactly. A store with no list blocks nobody, which needs no key to say.
 */
export async function blockedState(store: Pick<Store, "sid">, email: string): Promise<BlockState> {
  // A store with no sid has no list, so it blocks nobody (Claude 7 on #3839): never every visitor refused as unknown.
  if (!store.sid) return { blocked: false };
  if (!isRedisConfigured()) return "unknown";
  const key = blockKey(store.sid);
  const mark = personMark(email);
  let replies: unknown[] | null;
  try {
    replies = repliesFor(await redisPipeline([["EXISTS", key], ...(mark ? [["HGET", key, mark]] : [])]), mark ? 2 : 1);
  } catch {
    return "unknown";
  }
  if (!replies) return "unknown";
  const exists = countOf(replies[0]);
  if (exists !== 0 && exists !== 1) return "unknown";
  if (!mark) return exists === 0 ? { blocked: false } : "unknown";
  // With a mark, the row read is authoritative even if the list did not exist at the earlier EXISTS.
  if (replies[1] === null) return { blocked: false };
  const entry = parseEntry(replies[1]);
  return entry ? { blocked: true, ...entry } : "unknown";
}

/** Whether a person may write to the store: false when blocked, and when that cannot be read. */
export async function mayWrite(store: Pick<Store, "sid">, email: string): Promise<boolean> {
  const state = await blockedState(store, email);
  return state !== "unknown" && !state.blocked;
}

export type BlockOutcome = "blocked" | "already" | "many" | "full" | "error";

/**
 * The entry is written only while the list has room and the person is not on
 * it, in one step, so two blocks at once never pass MAX_BLOCKED.
 * KEYS[1] the list; ARGV the mark, the entry, MAX_BLOCKED.
 * 1 written, 0 already there, -1 the list is full.
 */
export const BLOCK_LUA = `-- marktmorgen:buyer-block:v1
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

/**
 * Removes one block and its fixed data-room charge in the same Redis step.
 * That keeps the charge exact when the script applies but its reply is lost:
 * a retry sees no block and does not subtract it twice.
 */
export const UNBLOCK_LUA = `-- marktmorgen:buyer-unblock:v1
if redis.call('HEXISTS', KEYS[1], ARGV[1]) ~= 1 then return 0 end
local old = tonumber(redis.call('HGET', KEYS[2], ARGV[2]) or '0')
local total = tonumber(redis.call('HGET', KEYS[2], '#') or '0')
local bytes = tonumber(ARGV[3])
if not old or not total or not bytes or bytes < 0 then return -1 end
redis.call('HDEL', KEYS[1], ARGV[1])
local next = math.max(0, old - bytes)
local delta = next - old
if old > 0 and next == 0 then delta = delta - 64 end
if next > 0 then redis.call('HSET', KEYS[2], ARGV[2], next) else redis.call('HDEL', KEYS[2], ARGV[2]) end
redis.call('HSET', KEYS[2], '#', math.max(0, total + delta))
return 1
`;

/** Blocks a person in the store's messages, with the creator's reason. */
export async function blockPerson(store: BlockStore, email: string, reasonRaw: unknown, now = Date.now()): Promise<BlockOutcome> {
  if (!store.sid || !isRedisConfigured()) return "error";
  const mark = personMark(email);
  if (!mark) return "error";
  const key = blockKey(store.sid);
  // The room first, at the entry's largest size; given back when nothing was written.
  const room = await takeData(store, [{ slot: BLOCK_SLOT, bytes: BLOCK_ENTRY_BYTES }], now);
  if (!room.ok) return room.reason === "full" ? "full" : "error";
  let written: unknown[] | null;
  try {
    written = repliesFor(await redisPipeline([["EVAL", BLOCK_LUA, 1, key, mark, JSON.stringify({ r: blockReason(reasonRaw), at: now }), MAX_BLOCKED]]), 1);
  } catch {
    // Not known whether it was written: the room stays taken, as the entry may be there.
    return "error";
  }
  const made = written ? written[0] : undefined;
  if (made === 1) return "blocked";
  if (made === 0 || made === -1) {
    await giveData(store, [{ slot: BLOCK_SLOT, bytes: BLOCK_ENTRY_BYTES }], now);
    return made === 0 ? "already" : "many";
  }
  return "error";
}

/** Lets a person write to the store again. true when an entry was removed, false when there was none. */
export async function unblockPerson(store: BlockStore, email: string): Promise<boolean | "error"> {
  if (!store.sid || !isRedisConfigured()) return "error";
  const mark = personMark(email);
  const room = dataKey(store);
  if (!mark || !room) return "error";
  let removed: unknown[] | null;
  try {
    removed = repliesFor(await redisPipeline([["EVAL", UNBLOCK_LUA, 2, blockKey(store.sid), room, mark, BLOCK_SLOT, BLOCK_ENTRY_BYTES]]), 1);
  } catch {
    return "error";
  }
  const count = removed ? countOf(removed[0]) : null;
  if (count === null || count > 1) return "error";
  return count === 1;
}

/**
 * Erases the reason of one block and keeps the block with its own date, in one step, only while the entry is the one
 * read: a block lifted or made again meanwhile is never written over. The entry is no larger than before, so the data
 * room's charge stays as it was.
 * KEYS[1] the list; ARGV the mark, the entry with no reason, the entry as read. 1 erased, 0 changed meanwhile.
 */
export const FORGET_REASON_LUA = `-- marktmorgen:buyer-block-forget:v1
local old = redis.call('HGET', KEYS[1], ARGV[1])
if old ~= ARGV[3] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

/**
 * Deleting a person (lib/person-erasure.ts): the creator's reason for blocking them in this store is erased and the
 * block itself stays, with the date it was made, as a one-way mark of the address (Codex X6 on #3839): it is the
 * creator's protection, and a person could otherwise lift it by asking to be deleted; the date is kept so their copy
 * still says since when (Claude 6 on #3839). 1 when a reason was erased, 0 when there was none or the entry changed
 * meanwhile. Throws on an unknown reply.
 */
export async function forgetBlockedPerson(store: BlockStore, email: string): Promise<number> {
  if (!store.sid || !isRedisConfigured()) return 0;
  const mark = personMark(email);
  if (!mark) throw new Error("the erasure of a block's reason was not confirmed: there is no key to find the person");
  const key = blockKey(store.sid);
  let read: unknown[] | null;
  try {
    read = repliesFor(await redisPipeline([["HGET", key, mark]]), 1);
  } catch {
    throw new Error("the erasure of a block's reason was not confirmed");
  }
  if (!read) throw new Error("the erasure of a block's reason was not confirmed");
  const raw = read[0];
  if (raw === null) return 0;
  const entry = parseEntry(raw);
  if (!entry || typeof raw !== "string") throw new Error("the erasure of a block's reason was not confirmed");
  // Already erased: nothing to write.
  if (entry.reason === "") return 0;
  let replies: unknown[] | null;
  try {
    replies = repliesFor(await redisPipeline([["EVAL", FORGET_REASON_LUA, 1, key, mark, JSON.stringify({ r: "", at: entry.at }), raw]]), 1);
  } catch {
    throw new Error("the erasure of a block's reason was not confirmed");
  }
  const count = replies ? countOf(replies[0]) : null;
  if (count === null || count > 1) throw new Error("the erasure of a block's reason was not confirmed");
  return count;
}

/**
 * The person's copy of their data (lib/person-copy.ts): whether this store blocked them from writing, since when, and
 * the reason the creator wrote, which is a note about them (GDPR art. 15). Throws on an unknown reply.
 */
export async function blockForCopy(store: Pick<Store, "sid">, email: string): Promise<{ blocked: string; reason: string }[]> {
  const state = await blockedState(store, email);
  if (state === "unknown") throw new UnknownReplyError("whether the store blocked this person");
  return state.blocked ? [{ blocked: new Date(state.at).toISOString(), reason: state.reason }] : [];
}
