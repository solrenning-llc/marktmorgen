/**
 * A store's learning paths, kept (249 [ST2], unit 2): the list the creator
 * saves, read and written whole. The rules are lib/learning-path-rules.ts;
 * nothing here shows, sells or opens a path yet.
 *
 *   nl:paths:<statsId>        the list, as JSON, counted in the store's data room ("paths")
 *   nl:paths:lock:<statsId>   held while the list is saved, 60 seconds at most
 *
 * The list is bounded by the rules (MAX_PATHS paths of at most
 * MAX_PATH_COURSES courses and a MAX_PATH_NAME name) and, before that, by
 * the store's data room: its room is set to the new list's size before it is
 * written, and a list that does not fit is refused, never kept past it. A
 * list that cannot be read is an error, never an empty list, and a save is
 * refused rather than write over it, so a path is never lost by being
 * overwritten (rule 24).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, LockBusyError, releaseLock, setIfHeldOnly, takeLock } from "@/lib/redis-lock";
import { type DataStore, giveData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { MAX_PATHS, type PathsProblem, type StoredPath, parseStoredPaths, readPathsInput } from "@/lib/learning-path-rules";

export { MAX_PATHS };

const STATS_ID = /^[0-9a-f]{32}$/;
const LOCK_SECONDS = 60;
/** The list's slot in the store's data room: set to its size at each save. */
export const PATHS_SLOT = "paths";

const pathsKey = (statsId: string) => `nl:paths:${statsId}`;
const lockKey = (statsId: string) => `nl:paths:lock:${statsId}`;

/** The list could not be read: never taken for an empty one. */
export class PathsUnreadable extends Error {
  constructor() {
    super("the store's learning paths could not be read");
    this.name = "PathsUnreadable";
  }
}

/** The store's paths, in the creator's order. Throws PathsUnreadable when they cannot be read exactly. */
export async function readPaths(statsId: string): Promise<StoredPath[]> {
  return (await readExact(statsId)).paths;
}

/** The list and the text it was kept as ("" for none yet). */
async function readExact(statsId: string): Promise<{ paths: StoredPath[]; json: string }> {
  if (!STATS_ID.test(statsId) || !isRedisConfigured()) throw new PathsUnreadable();
  let reply: unknown;
  try {
    reply = await redisPipeline([["GET", pathsKey(statsId)]]);
  } catch {
    throw new PathsUnreadable();
  }
  // Exactly one answer, a text or null (no paths yet): [] or [7] is not "no paths".
  if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== null && typeof reply[0] !== "string")) throw new PathsUnreadable();
  if (reply[0] === null) return { paths: [], json: "" };
  const paths = parseStoredPaths(reply[0]);
  if (!paths) throw new PathsUnreadable();
  return { paths, json: reply[0] };
}

export type SavePaths =
  | { state: "saved"; paths: StoredPath[] }
  | { state: "refused"; problem: PathsProblem; index: number }
  | { state: "full"; message: string }
  /** Another save holds the list: nothing read or written. */
  | { state: "busy" }
  /** The list, the room or the write could not be read exactly: nothing said as saved; try again. */
  | { state: "unknown" };

/**
 * Saves every path of the store at once (readPathsInput), under the store's
 * lock: the current list is read exactly, the new one is checked against it
 * and the store's courses, its room is taken, and then it is written. Any
 * step that does not answer exactly stops there, with nothing said as saved.
 */
export async function savePaths(store: DataStore & { statsId: string }, raw: unknown, storeCourses: ReadonlySet<string>, now = Date.now()): Promise<SavePaths> {
  if (!STATS_ID.test(store.statsId) || !isRedisConfigured()) return { state: "unknown" };
  let held: Held;
  try {
    held = await takeLock(lockKey(store.statsId), LOCK_SECONDS, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return { state: "busy" };
    return { state: "unknown" };
  }
  try {
    let current: { paths: StoredPath[]; json: string };
    try {
      current = await readExact(store.statsId);
    } catch {
      return { state: "unknown" };
    }
    const read = readPathsInput(raw, current.paths, storeCourses);
    if (!read.ok) return { state: "refused", problem: read.problem, index: read.index };
    const json = JSON.stringify(read.paths);
    const size = dataBytes([json], 1);
    const kept = current.json ? dataBytes([current.json], 1) : 0;
    const taken = await takeData(store, [{ slot: PATHS_SLOT, bytes: size, set: true }], now);
    if (!taken.ok) return taken.reason === "full" ? { state: "full", message: taken.message } : { state: "unknown" };
    // Written only while this save still holds the lock, in one script (lib/redis-lock.ts): a save whose lock ran out
    // never writes over another's list. Anything but the exact 1 (the lock lost, or an answer not read) is not said as
    // saved, and the slot keeps the larger of the two lists, so what the store keeps is never counted as less than it is.
    if (await setIfHeldOnly(held, pathsKey(store.statsId), json)) return { state: "saved", paths: read.paths };
    if (kept > size) await giveData(store, [{ slot: PATHS_SLOT, bytes: kept, set: true }], now);
    return { state: "unknown" };
  } finally {
    await releaseLock(held).catch(() => undefined);
  }
}
