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
 * The mark is written first and the line second, so the purchases switch
 * at the line's one write: before it the old address has them, after it the
 * new one does, and there is no moment when neither does. A crash between
 * the two leaves a mark alone, which moves nothing, and the next try
 * finishes it: every write is the same on a second run (the mark taken with
 * the same value, the line set to the same id), and the move is claimed
 * once (claimPurchaseMove), so it is never written for two requests.
 *
 * Kept for as long as the purchases are, so counted in the store's data
 * room before it is written (lib/store-data.ts, slot "pm:<id>"), erased with
 * a store that closes (lib/data-families.ts), and taken out, both lines of
 * the move, when the store deletes either address (lib/person-erasure.ts,
 * forgetMovedPerson). An address the store deleted is never written here.
 * A reply that is not exactly what was asked for is unknown, never "not
 * moved" (rule 24).
 *
 * An address holds the purchases of at most MAX_MOVED_INTO old ones, and
 * one that holds any does not move again ("holds-moved"): a reader asks
 * the creator's Stripe account about each old address directly, one step,
 * so a second step would lose what came over in the first.
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { claimMark } from "@/lib/claim-mark";
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
/**
 * The most old addresses whose purchases one address may hold at a store. Each
 * reader asks about each of them (one more reading of the creator's Stripe
 * account each, unit 4b onward), so the index never holds more: a move into an
 * address that already holds this many is refused ("too-many").
 */
export const MAX_MOVED_INTO = 5;
const print = (sid: string, address: string) => createHash("sha256").update(`nimbus-pm-moved:${sid}:${normaliseEmail(address)}`).digest("hex").slice(0, 32);
const movedKey = (sid: string, address: string) => `nl:pm:moved:${sid}:${print(sid, address)}`;
const intoKey = (sid: string, address: string) => `nl:pm:into:${sid}:${print(sid, address)}`;
const slot = (id: string) => `pm:${id}`;

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
  const asks: (string | number)[][] = [...(mark ? [["HGET", intoKey(sid, mark.to), address]] : []), ...olds.map((old) => ["GET", movedKey(sid, old)])];
  if (!asks.length) return { movedTo: null, movedFrom: [] };
  const second = repliesFor(await redisPipeline(asks), asks.length);
  if (!second) throw new UnknownReplyError(what);
  let movedTo: string | null = null;
  if (mark) {
    const back = second[0];
    if (back !== null && typeof back !== "string") throw new UnknownReplyError(what);
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
  | { state: "not-ready" | "expired" | "gone" | "deleted" | "already-moved" | "too-many" | "holds-moved" | "full" | "unknown"; told: null };

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
    const held = repliesFor(
      await redisPipeline([["GET", movedKey(store.sid, from)], ["HLEN", intoKey(store.sid, from)], ["HLEN", intoKey(store.sid, to)], ["HEXISTS", intoKey(store.sid, to), from]]),
      4,
    );
    if (!held) return stop("unknown");
    const before = markOf(held[0], "a moved address's mark");
    const [holding, holdingTo, already] = held.slice(1).map((reply) => countOf(reply));
    if (holding === null || holdingTo === null || (already !== 0 && already !== 1)) return stop("unknown");
    if (before && before.id !== id) return stop("already-moved");
    // One step only: an address that holds moved purchases keeps them where they are.
    if (holding > 0) return stop("holds-moved");
    // A second try of this move is already counted among them.
    if (already === 0 && holdingTo >= MAX_MOVED_INTO) return stop("too-many");

    // The room first: what the two lines keep, for as long as they are kept. Set, not added, so a second try takes nothing more.
    const bytes = dataBytes([movedKey(store.sid, from), text, intoKey(store.sid, to), from, id], 2);
    const room = await takeData(store, [{ slot: slot(id), bytes, set: true }], now);
    if (!room.ok) return stop(room.reason === "full" ? "full" : "unknown");

    // The old address's mark, then the new address's line: the purchases switch at the second write.
    const marked = await claimMark(movedKey(store.sid, from), null, text);
    if (marked === "unknown") return stop("unknown");
    if (marked === "taken") {
      const again = repliesFor(await redisPipeline([["GET", movedKey(store.sid, from)]]), 1);
      const theirs = again ? markOf(again[0], "a moved address's mark") : undefined;
      if (theirs === undefined) return stop("unknown");
      if (!theirs || theirs.id !== id) {
        // Another move of this address got there first: its room goes back.
        await giveData(store, [{ slot: slot(id), bytes: 0, set: true }], now);
        return stop("already-moved");
      }
    }
    const lined = repliesFor(await redisPipeline([["HSET", intoKey(store.sid, to), from, id]]), 1);
    if (!lined || (lined[0] !== 0 && lined[0] !== 1)) return stop("unknown");
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
  const ids = new Set<string>();
  if (mark) {
    commands.push(["DEL", movedKey(sid, address)], ["HDEL", intoKey(sid, mark.to), address]);
    ids.add(mark.id);
  }
  if (lines.size) {
    commands.push(["DEL", intoKey(sid, address)]);
    for (const [old, id] of lines) {
      commands.push(["DEL", movedKey(sid, old)]);
      ids.add(id);
    }
  }
  if (!commands.length) return 0;
  const done = repliesFor(await redisPipeline(commands), commands.length);
  if (!done || done.some((reply) => typeof reply !== "number")) throw new UnknownReplyError(what);
  await giveData(store, [...ids].map((id) => ({ slot: slot(id), bytes: 0, set: true })));
  return (mark ? 2 : 0) + (lines.size ? 1 + lines.size : 0);
}
