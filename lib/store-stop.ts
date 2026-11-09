/**
 * A creator's "stop", kept by the store's own id (finding 5 of Claude 5's
 * handles audit, 9 November 2026).
 *
 * Two of the company's sets say a creator stopped something for their store:
 * the numbers emails (nl:weekly:off, lib/stats-report.ts) and the "Where did
 * you hear about us?" question (nl:heard:off, lib/heard.ts). They used to hold
 * the store's address, so renaming the store lost the stop: the weekly,
 * busy-day and quiet-sales emails came back without the creator asking, and
 * buyers were asked again.
 *
 * A stop is now written as "sid:<the store's id>". An address never holds a
 * ":" (HANDLE_PATTERN), so the member can never be read as one, and the
 * closing walk takes it out with the store (lib/closed-store-data.ts,
 * namesStore reads the id after the ":").
 *
 * A stop written before, under an address, is still read: under the store's
 * address and every address it used before and still owns (previousHandles),
 * in the same one command. Never under an address it let go of
 * (releasedHandles): that one may be another store's by now. So, before an
 * address is let go, its stop is carried to the id (carryStops), and the
 * address's own member is taken out, so the next store to take the address
 * does not inherit it. "Start again" takes out the id and every address the
 * store owns.
 *
 * A store made before there were several has no id until its owner next opens
 * the studio (ensureStoreId); its stop goes under its address meanwhile, which
 * is read through renames as above and carried before that address is let go.
 */
import { redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, UnknownReplyError } from "@/lib/redis-reply";
import { STORE_ID_PATTERN, type Store } from "@/lib/store";

/** What names a store for its stops: its id, its address and the addresses it still owns. */
export type StopOwner = Pick<Store, "sid" | "handle" | "previousHandles">;

const byId = (sid: string) => `sid:${sid}`;

const idOf = (store: StopOwner): string | null => (typeof store.sid === "string" && STORE_ID_PATTERN.test(store.sid) ? store.sid : null);

/**
 * Every member a stop of this store may be under: its id when it has one, then
 * its address and the addresses it still owns, at most the 20 it keeps
 * (renameHandle), never one it let go of.
 */
export function stopMembers(store: StopOwner): string[] {
  const sid = idOf(store);
  const owned = [store.handle, ...(Array.isArray(store.previousHandles) ? store.previousHandles : [])].filter((h) => typeof h === "string" && h !== "");
  return [...new Set([...(sid ? [byId(sid)] : []), ...owned])];
}

/**
 * Whether the store is in `set`, in one SMISMEMBER: true when any of its
 * members is there, false only when Redis answered 0 for every one of them,
 * "unknown" on an answer of any other shape (CX-123 rule 24).
 */
export async function readStop(set: string, store: StopOwner): Promise<boolean | "unknown"> {
  const members = stopMembers(store);
  if (!members.length) return "unknown";
  const replies = repliesFor(await redisPipeline([["SMISMEMBER", set, ...members]]), 1);
  const flags = replies ? repliesFor(replies[0], members.length) : null;
  if (!flags) return "unknown";
  const read = flags.map(countOf);
  if (read.some((flag) => flag === 1)) return true;
  return read.every((flag) => flag === 0) ? false : "unknown";
}

/**
 * The one command that stops (under the store's id, or its address while it
 * has none) or starts again (taking out the id and every address it owns).
 */
export function stopCommand(set: string, store: StopOwner, off: boolean): string[] {
  const sid = idOf(store);
  return off ? ["SADD", set, sid ? byId(sid) : store.handle] : ["SREM", set, ...stopMembers(store)];
}

/**
 * Before the store lets go of `handle` (lib/store.ts releaseHandle): a stop
 * still under that address, in any of `sets`, moves to the store's id (or its
 * current address while it has no id), and the address's member is taken out.
 * One SISMEMBER a set, then, for the sets it was in, the SADDs and, only once
 * every one is confirmed, the SREMs: a pipeline is not atomic, and Redis may
 * refuse a SADD (memory) and still run a SREM, which in one batch would leave
 * the stop under neither member. An answer of any other shape throws
 * UnknownReplyError, so the caller lets nothing go on it.
 */
export async function carryStops(sets: readonly string[], store: StopOwner, handle: string): Promise<void> {
  if (!sets.length || handle === store.handle || !(store.previousHandles ?? []).includes(handle)) return;
  const replies = repliesFor(await redisPipeline(sets.map((set) => ["SISMEMBER", set, handle])), sets.length);
  const flags = replies?.map(countOf);
  if (!flags || flags.some((flag) => flag !== 0 && flag !== 1)) throw new UnknownReplyError("a stop under an address about to be let go (SISMEMBER)");
  const sid = idOf(store);
  const carried = sets.filter((_, i) => flags[i] === 1);
  if (!carried.length) return;
  const exact = async (commands: string[][], what: string) => {
    const written = repliesFor(await redisPipeline(commands), commands.length);
    if (!written || written.some((reply) => reply !== 0 && reply !== 1)) throw new UnknownReplyError(what);
  };
  await exact(carried.map((set) => ["SADD", set, sid ? byId(sid) : store.handle]), "a stop carried to the store's id (SADD)");
  await exact(carried.map((set) => ["SREM", set, handle]), "a stop's old address taken out (SREM)");
}
