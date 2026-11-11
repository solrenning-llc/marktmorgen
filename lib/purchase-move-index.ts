/**
 * The index of moved addresses (611 [WP10], unit 4a, 10 November 2026):
 * what a buyer's move of their purchases to another email leaves, once both
 * addresses confirmed it (lib/purchase-moves.ts), for the readers of a
 * buyer's purchases to follow.
 *
 * Every purchase is read from the creator's own Stripe account by the
 * address it was paid with, and a past checkout's address cannot be
 * changed. So nothing on Stripe moves: each reader of what an address may
 * open (its orders, courses, community, membership, downloads, podcast,
 * newsletter, imported purchases, library) will ask this index which
 * addresses' purchases it now holds, and whether its own moved away. No
 * reader asks yet: that is unit 4b onward, one reader at a time, and until
 * every one does lib/purchase-move-open.ts keeps the whole move closed, so
 * nothing is written here in production.
 *
 *   nl:pm:moved:<sid>:<print(old)>  string  the old address moved: {"id","to","at"}, as JSON.stringify writes it
 *   nl:pm:into:<sid>:<print(new)>   hash    the old addresses whose purchases the new one holds -> the move's id
 *
 * The two agree or nothing moved (readMovedIndex): an old address has moved
 * away, and its purchases are the new one's, only when its mark names the
 * new address and the new address's line names it back with the same move.
 * The mark and the line are written together, in one script (MOVE_APPLY),
 * so the purchases switch at that one step: before it the old address has
 * them, after it the new one does, and no moment leaves neither with them.
 * A crash or a lost answer leaves both or neither, never a mark alone
 * (Claude 3 on #3625): a mark alone would say "already moved" to the buyer
 * asking again, and keep the new address where erasing it cannot reach.
 * The script is the same on a second run (a mark with the same value is the
 * move already written), and the move is claimed once (claimPurchaseMove),
 * so it is never written for two requests.
 *
 * Kept for as long as the purchases are, so counted in the store's data
 * room before it is written (lib/store-data.ts, slot "pm:<print(old)>",
 * one per old address, the same for every request from it), erased with
 * a store that closes (lib/data-families.ts), and taken out, both lines of
 * the move, when the store deletes either address (lib/person-erasure.ts,
 * forgetMovedPerson). An address the store deleted is never written here.
 * A reply that is not exactly what was asked for is unknown, never "not
 * moved" (rule 24).
 */
import { createHash } from "node:crypto";
import { MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import type { MoveRequest } from "@/lib/purchase-move-rules";
import { claimPurchaseMove, readPurchaseMove } from "@/lib/purchase-moves";
import { type Told, tellCreatorOfMove } from "@/lib/purchase-move-notice";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { dataBytes } from "@/lib/store-data-rules";
import { giveData, takeData } from "@/lib/store-data";
import type { Store } from "@/lib/store";
import { suppressedAmong } from "@/lib/suppression";

const ID = /^[0-9a-f]{32}$/;
/** Existing one-step reader capacity; moves never increase this bound. */
export const MAX_MOVED_INTO = 5;
const print = (sid: string, address: string) => createHash("sha256").update(`nimbus-pm-moved:${sid}:${normaliseEmail(address)}`).digest("hex").slice(0, 32);
const movedKey = (sid: string, address: string) => `nl:pm:moved:${sid}:${print(sid, address)}`;
const intoKey = (sid: string, address: string) => `nl:pm:into:${sid}:${print(sid, address)}`;
/**
 * The data room's slot for a move from this address: one per old address, since an address moves once. A request
 * that stopped with its answer unknown leaves its room there, and the next request from the same address sets the
 * same slot again rather than leaving a second one (Claude 3 on #3625).
 */
export const movedRoomSlot = (sid: string, from: string) => `pm:${print(sid, from)}`;
/** What a move from this address keeps, its new address counted at the longest an address may be, so every request from it sets the same room. */
const roomOf = (sid: string, from: string, id: string, at: number) =>
  dataBytes([movedKey(sid, from), markText({ id, to: "x".repeat(MAX_EMAIL_LENGTH), at }), intoKey(sid, from), from, id], 2);

/**
 * The old address's mark and the new address's line, in one step, as Redis runs a script whole: "moved" when written
 * now or by an earlier try of the same move (its mark already there with the same value), "elsewhere" when the old
 * address's mark is another move's, and nothing written then. The line goes first: a line on a key that is not a hash
 * stops the script before anything is written. Destination movement, source holdings and the existing destination
 * capacity are rechecked in that same atomic step. At most eight commands including EVAL, both GETs, both HLENs,
 * HGET, HSET and SET; an idempotent retry verifies the matching line. lib/redis-memory.ts models it for tests.
 */
export const MOVE_APPLY = `-- marktmorgen:purchase-move-apply:v2
local held = redis.call('GET', KEYS[1])
if held then
  if held ~= ARGV[1] then return 'elsewhere' end
  if redis.call('HGET', KEYS[2], ARGV[2]) == ARGV[3] then return 'moved' end
  return 'unknown'
end
if redis.call('GET', KEYS[4]) then return 'destination-moved' end
if redis.call('HLEN', KEYS[3]) > 0 then return 'holds-moved' end
local total = redis.call('HLEN', KEYS[2])
local line = redis.call('HGET', KEYS[2], ARGV[2])
if line and line ~= ARGV[3] then return 'unknown' end
if not line and total >= tonumber(ARGV[4]) then return 'too-many' end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
redis.call('SET', KEYS[1], ARGV[1])
return 'moved'`;

type Mark = { id: string; to: string; at: number };

/** A mark exactly as markText writes it; null for anything else. */
function parseMark(raw: string): Mark | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, to, at } = value as Record<string, unknown>;
  if (typeof id !== "string" || !ID.test(id) || typeof to !== "string" || !to || typeof at !== "number" || !Number.isSafeInteger(at)) return null;
  const mark: Mark = { id, to, at };
  return markText(mark) === raw ? mark : null;
}
const markText = (mark: Mark) => JSON.stringify({ id: mark.id, to: mark.to, at: mark.at });

/** A GET's reply: null when there is no mark; throws when it is not exactly a mark. */
function markOf(reply: unknown, what: string): Mark | null {
  if (reply === null) return null;
  const mark = typeof reply === "string" ? parseMark(reply) : null;
  if (!mark) throw new UnknownReplyError(what);
  return mark;
}

/** An HGETALL's reply as old address -> move id; throws when it is not exactly that. */
function linesOf(reply: unknown, what: string): Map<string, string> {
  const flat = stringList(reply);
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError(what);
  const lines = new Map<string, string>();
  for (let i = 0; i < flat.length; i += 2) {
    if (!ID.test(flat[i + 1])) throw new UnknownReplyError(what);
    lines.set(flat[i], flat[i + 1]);
  }
  return lines;
}

/**
 * Only whether this address moved its purchases away, and where to: the
 * cheaper half of readMovedIndex, for a reader that asks it every time (a
 * podcast feed, tests/traffic-cost.ts COMMANDS.feed): one GET, and one HGET
 * only when there is a mark. The same agreement as readMovedIndex: moved only
 * when the mark names the new address and its line names it back. Throws
 * UnknownReplyError when either cannot be read.
 */
export async function movedAwayTo(sid: string, raw: string): Promise<string | null> {
  const address = normaliseEmail(raw);
  if (!isRedisConfigured()) return null;
  const what = "a store's moved addresses";
  const first = repliesFor(await redisPipeline([["GET", movedKey(sid, address)]]), 1);
  if (!first) throw new UnknownReplyError(what);
  const mark = markOf(first[0], what);
  if (!mark) return null;
  const second = repliesFor(await redisPipeline([["HGET", intoKey(sid, mark.to), address]]), 1);
  if (!second) throw new UnknownReplyError(what);
  const back = second[0];
  if (back !== null && typeof back !== "string") throw new UnknownReplyError(what);
  return back === mark.id ? mark.to : null;
}

/**
 * Where an address's purchases at a store stand, as the readers will ask
 * (unit 4b onward): the address they moved to, and the addresses whose
 * purchases it holds, each only where the mark and the line agree. Throws
 * UnknownReplyError when any part cannot be read.
 */
export async function readMovedIndex(sid: string, raw: string): Promise<{ movedTo: string | null; movedFrom: string[] }> {
  const address = normaliseEmail(raw);
  if (!isRedisConfigured()) return { movedTo: null, movedFrom: [] };
  const what = "a store's moved addresses";
  const first = repliesFor(await redisPipeline([["GET", movedKey(sid, address)], ["HGETALL", intoKey(sid, address)]]), 2);
  if (!first) throw new UnknownReplyError(what);
  const mark = markOf(first[0], what);
  const lines = linesOf(first[1], what);
  const olds = [...lines.keys()];
  if (olds.length > MAX_MOVED_INTO) throw new UnknownReplyError(what);
  const asks: (string | number)[][] = [...(mark ? [["HGET", intoKey(sid, mark.to), address]] : []), ...olds.map((old) => ["GET", movedKey(sid, old)])];
  if (!asks.length) return { movedTo: null, movedFrom: [] };
  const second = repliesFor(await redisPipeline(asks), asks.length);
  if (!second) throw new UnknownReplyError(what);
  let movedTo: string | null = null;
  if (mark) {
    const back = second[0];
    // A line is a move's id: anything else is unknown, never "not moved" (Claude 3 on #3625, LOW 4).
    if (back !== null && (typeof back !== "string" || !ID.test(back))) throw new UnknownReplyError(what);
    if (back === mark.id) movedTo = mark.to;
  }
  const movedFrom = olds.filter((old, i) => {
    const theirs = markOf(second[(mark ? 1 : 0) + i], what);
    return theirs !== null && theirs.to === address && theirs.id === lines.get(old);
  });
  return { movedTo, movedFrom };
}

export type MoveApplied =
  | { state: "moved"; told: Told }
  | { state: "not-ready" | "expired" | "gone" | "deleted" | "already-moved" | "destination-moved" | "too-many" | "holds-moved" | "full" | "unknown"; told: null };

const stop = (state: Exclude<MoveApplied["state"], "moved">): MoveApplied => ({ state, told: null });

/**
 * Writes a move into the index, once both addresses confirmed: claimed once
 * through claimPurchaseMove, and on a later try of the same move (its claim
 * already taken, its request still there) finished where it stopped. Then
 * the creator is told, once (lib/purchase-move-notice.ts).
 */
export async function applyPurchaseMove(store: Store, id: string, now = Date.now()): Promise<MoveApplied> {
  if (!ID.test(id)) return stop("gone");
  let request: MoveRequest | null;
  const claimed = await claimPurchaseMove(id, now);
  if (claimed.ok) request = claimed.request;
  else if (claimed.reason === "done") {
    // Claimed before: this is the same move, tried again. Finish it.
    try {
      request = await readPurchaseMove(id);
    } catch (error) {
      if (error instanceof UnknownReplyError) return stop("unknown");
      throw error;
    }
    if (!request) return stop("gone");
    if (request.appliedAt === null) return stop("unknown");
  } else return stop(claimed.reason);
  if (request.scope.kind !== "store" || request.scope.sid !== store.sid || request.appliedAt === null) return stop("gone");

  const { from, to } = request;
  try {
    if ((await suppressedAmong(store.listId, [from, to])).size > 0) return stop("deleted");
  } catch {
    return stop("unknown");
  }

  const mark: Mark = { id, to, at: request.appliedAt };
  const text = markText(mark);
  try {
    // An address that already moved, by another request, is not moved again: nothing is taken or written.
    const held = repliesFor(await redisPipeline([
      ["GET", movedKey(store.sid, from)], ["GET", movedKey(store.sid, to)],
      ["HLEN", intoKey(store.sid, from)], ["HLEN", intoKey(store.sid, to)],
      ["HGET", intoKey(store.sid, to), from],
    ]), 5);
    if (!held) return stop("unknown");
    const before = markOf(held[0], "a moved address's mark");
    if (before && before.id !== id) return stop("already-moved");
    const destination = markOf(held[1], "the destination's moved-address mark");
    const holding = countOf(held[2]);
    const total = countOf(held[3]);
    const line = held[4];
    if (holding === null || total === null || (line !== null && (typeof line !== "string" || !ID.test(line)))) return stop("unknown");
    // Early refusals avoid taking data room unnecessarily. The script repeats
    // every guard atomically, so a competing move cannot invalidate this ask.
    if (!before) {
      if (destination) return stop("destination-moved");
      if (holding > 0) return stop("holds-moved");
      if (line !== null && line !== id) return stop("unknown");
      if (line === null && total >= MAX_MOVED_INTO) return stop("too-many");
    }

    // The room first: what the two lines keep, for as long as they are kept. Set, not added, and the same for every
    // request from this address, so a second try, or a later request after one that stopped, takes nothing more.
    const room = await takeData(store, [{ slot: movedRoomSlot(store.sid, from), bytes: roomOf(store.sid, from, id, request.appliedAt), set: true }], now);
    if (!room.ok) return stop(room.reason === "full" ? "full" : "unknown");

    // The mark and the line in one step: the purchases switch there, and nothing is ever left half written.
    let written: unknown;
    try {
      const reply = repliesFor(await redisPipeline([["EVAL", MOVE_APPLY, 4, movedKey(store.sid, from), intoKey(store.sid, to), intoKey(store.sid, from), movedKey(store.sid, to), text, from, id, MAX_MOVED_INTO]]), 1);
      written = reply ? reply[0] : undefined;
    } catch {
      // Whether it ran is not known: unknown, and the next try finishes it or finds it done.
      return stop("unknown");
    }
    // Another move of this address got there first. Its room is this same slot, so it stays.
    if (written === "elsewhere") return stop("already-moved");
    if (written === "destination-moved" || written === "holds-moved" || written === "too-many") return stop(written);
    if (written !== "moved") return stop("unknown");
  } catch (error) {
    if (error instanceof UnknownReplyError) return stop("unknown");
    throw error;
  }
  return { state: "moved", told: await tellCreatorOfMove(store, id, { from, to }, now) };
}

/**
 * What the index keeps about this address, for the person's own copy of
 * their data (lib/person-copy.ts): the address it moved to and when, and the
 * addresses whose purchases moved to it. Throws UnknownReplyError when it
 * cannot be read whole, so the copy fails rather than leave it out.
 */
export async function copyMovedPerson(store: Store, raw: string): Promise<unknown[]> {
  if (!isRedisConfigured()) return [];
  const address = normaliseEmail(raw);
  const what = "a person's moved addresses";
  const read = repliesFor(await redisPipeline([["GET", movedKey(store.sid, address)], ["HGETALL", intoKey(store.sid, address)]]), 2);
  if (!read) throw new UnknownReplyError(what);
  const mark = markOf(read[0], what);
  const lines = linesOf(read[1], what);
  return [
    ...(mark ? [{ movedTo: mark.to, at: new Date(mark.at * 1000).toISOString() }] : []),
    ...[...lines.keys()].map((from) => ({ movedFrom: from })),
  ];
}

/**
 * The store deleted this address: every line of the index that names it
 * goes, the other side of each move with it, and each move's room is given
 * back. Answers how many lines went. Throws UnknownReplyError when what it
 * names cannot be read, so the erasure is tried again rather than left half.
 */
export async function forgetMovedPerson(store: Store, raw: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const address = normaliseEmail(raw);
  const sid = store.sid;
  const what = "a deleted person's moved addresses";
  const read = repliesFor(await redisPipeline([["GET", movedKey(sid, address)], ["HGETALL", intoKey(sid, address)]]), 2);
  if (!read) throw new UnknownReplyError(what);
  const mark = markOf(read[0], what);
  const lines = linesOf(read[1], what);
  const commands: (string | number)[][] = [];
  const olds = new Set<string>();
  if (mark) {
    commands.push(["DEL", movedKey(sid, address)], ["HDEL", intoKey(sid, mark.to), address]);
    olds.add(address);
  }
  if (lines.size) {
    commands.push(["DEL", intoKey(sid, address)]);
    for (const old of lines.keys()) {
      commands.push(["DEL", movedKey(sid, old)]);
      olds.add(old);
    }
  }
  if (!commands.length) return 0;
  const done = repliesFor(await redisPipeline(commands), commands.length);
  if (!done || done.some((reply) => typeof reply !== "number")) throw new UnknownReplyError(what);
  await giveData(store, [...olds].map((old) => ({ slot: movedRoomSlot(sid, old), bytes: 0, set: true })));
  return (mark ? 2 : 0) + (lines.size ? 1 + lines.size : 0);
}
