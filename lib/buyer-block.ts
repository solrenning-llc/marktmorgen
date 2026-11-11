/**
 * A creator blocks a person in their own store's messages (567 [GD1] (f),
 * unit 1): the chat, the contact form and a question the store assistant
 * hands over. The reason is kept for the creator alone.
 *
 *   nl:blk:<sid>   hash: HMAC of the person's address → {"r": reason, "at": ms}
 *
 * Only an HMAC of the address is kept (deriveKey("buyer-block")), never the
 * address itself, and no other store can read it: there is no list shared
 * between stores. At most MAX_BLOCKED a store; each entry's bytes are counted
 * in the store's data room before it is written and given back when it is
 * removed (giveData). The limit is held in one Lua step (BLOCK_LUA). Deleting a person removes their entry (lib/person-erasure.ts);
 * closing a store removes the whole list (lib/closed-store-data.ts).
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
import { countOf, repliesFor } from "@/lib/redis-reply";
import { giveData, takeData } from "@/lib/store-data";
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

/** The HMAC of an address, or null when there is no key to make it with. */
export function personMark(email: string): string | null {
  const key = deriveKey("buyer-block");
  if (!key) return null;
  return createHmac("sha256", key).update(normaliseEmail(email)).digest("hex");
}

/** A reason as kept: one line, at most BLOCK_REASON_MAX characters. */
export function blockReason(raw: unknown): string {
  return typeof raw === "string"
    ? raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, BLOCK_REASON_MAX)
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
 * Whether a person is blocked in a store; "unknown" when it cannot be read
 * exactly. A store with no list blocks nobody, which needs no key to say.
 */
export async function blockedState(store: Pick<Store, "sid">, email: string): Promise<BlockState> {
  if (!store.sid || !isRedisConfigured()) return "unknown";
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
  if (exists === 0) return { blocked: false };
  if (exists !== 1 || !mark) return "unknown";
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
export async function unblockPerson(store: BlockStore, email: string, now = Date.now()): Promise<boolean | "error"> {
  if (!store.sid || !isRedisConfigured()) return "error";
  const mark = personMark(email);
  if (!mark) return "error";
  let removed: unknown[] | null;
  try {
    removed = repliesFor(await redisPipeline([["HDEL", blockKey(store.sid), mark]]), 1);
  } catch {
    return "error";
  }
  const count = removed ? countOf(removed[0]) : null;
  if (count === null || count > 1) return "error";
  if (count === 1) await giveData(store, [{ slot: BLOCK_SLOT, bytes: BLOCK_ENTRY_BYTES }], now);
  return count === 1;
}

/** Deleting a person (lib/person-erasure.ts): their entry in this store's list, if any. Throws on an unknown reply. */
export async function forgetBlockedPerson(store: BlockStore, email: string): Promise<number> {
  if (!store.sid || !isRedisConfigured()) return 0;
  const removed = await unblockPerson(store, email);
  if (removed === "error") throw new Error("the removal of a person from a store's block list was not confirmed");
  return removed ? 1 : 0;
}
