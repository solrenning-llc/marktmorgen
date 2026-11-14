/**
 * Where the store's own task list is kept (IA2, TODOS-94, unit 2; the rules are lib/business-tasks-rules.ts).
 *
 *   nl:biztasks:<statsId>      the store's tasks, one JSON list, at most MAX_BUSINESS_TASKS
 *   nl:biztasklock:<statsId>   one change of the list at a time, BUSINESS_TASKS_LOCK_SECONDS at the most
 *
 * Counted in the store's data room (slot BUSINESS_TASKS_SLOT) by what each change adds or takes away, never by
 * setting the slot, so two writers can never overwrite each other's count (Codex G and Codex U on #3562): a list
 * that grows takes its growth before it is written; one that shrinks gives back the difference only once the write
 * is known done. A full room is said, and nothing is written. An empty list is deleted, and its weight given back.
 *
 * The write itself is fenced: it lands only while the store's lock is still this change's, in one script
 * (lib/redis-lock.ts, setIfHeldExact and deleteIfHeldExact). A lock lost meanwhile writes nothing: the growth taken is
 * given back and the change is answered as busy. A write whose answer is not exact (a lost reply, an error) may
 * have landed: it is BusinessTasksWriteUnconfirmed, the growth stays counted (never less kept than counted), and
 * nobody is told nothing changed.
 *
 * Read whole or not at all (CX-123 rule 24): a reply missing or of another shape, or a list that is not one in its
 * shape (parseBusinessTasks), throws BusinessTasksUnreadable, never "no tasks", and a change on it writes nothing.
 * A change that waited while the store was deleted writes nothing back. The list goes with the store: erased in its
 * closing (lib/data-families.ts, CLOSING "nl:biztasks:") and written into its data copy (lib/store-export.ts).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { LockBusyError, deleteIfHeldExact, setIfHeldExact, withLock } from "@/lib/redis-lock";
import { repliesFor } from "@/lib/redis-reply";
import { type DataStore, giveData, takeData } from "@/lib/store-data";
import { dataBytes, dataBytesOfLength, utf8Length } from "@/lib/store-data-rules";
import { STORE_ID_PATTERN, storeIdExists } from "@/lib/store";
import { type BusinessTask, type BusinessTaskResult, parseBusinessTasks } from "@/lib/business-tasks-rules";

const tasksKey = (statsId: string) => `nl:biztasks:${statsId}`;
const lockKey = (statsId: string) => `nl:biztasklock:${statsId}`;

/** The store's data room slot the list is counted in (lib/store-data.ts). */
export const BUSINESS_TASKS_SLOT = "biztasks";
export const BUSINESS_TASKS_LOCK_SECONDS = 10;
export const BUSINESS_TASKS_LOCK_WAIT_MS = 2_000;

/** The list could not be read whole: never "no tasks". */
export class BusinessTasksUnreadable extends Error {
  constructor(what: string) {
    super(`the store's tasks could not be read whole: ${what}`);
    this.name = "BusinessTasksUnreadable";
  }
}

/** A write whose answer is not known: it may have been made. */
export class BusinessTasksWriteUnconfirmed extends Error {
  constructor() {
    super("a change of the store's tasks could not be confirmed");
    this.name = "BusinessTasksWriteUnconfirmed";
  }
}

type Kept = { tasks: BusinessTask[]; bytes: number };

async function readKept(statsId: string): Promise<Kept> {
  const replies = repliesFor(await redisPipeline([["GET", tasksKey(statsId)]]), 1);
  if (!replies) throw new BusinessTasksUnreadable("a reply missing or of another shape");
  const raw: unknown = replies[0];
  if (raw === null) return { tasks: [], bytes: 0 };
  if (typeof raw !== "string") throw new BusinessTasksUnreadable("a value that is not text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BusinessTasksUnreadable("a value that is not JSON");
  }
  const tasks = parseBusinessTasks(parsed);
  if (tasks === null) throw new BusinessTasksUnreadable("a list not in its shape");
  return { tasks, bytes: dataBytesOfLength(utf8Length(tasksKey(statsId)) + utf8Length(raw), 1) };
}

/** The store's tasks, read whole; an empty list for a store that keeps none. Throws BusinessTasksUnreadable. */
export async function readBusinessTasks(statsId: string | null | undefined): Promise<BusinessTask[]> {
  if (!statsId) return [];
  if (!isRedisConfigured()) throw new BusinessTasksUnreadable("no database");
  return (await readKept(statsId)).tasks;
}

export type BusinessTasksChange = BusinessTaskResult | { ok: false; error: "store_full"; message: string };

/**
 * One change of the list, under the store's lock: read whole, changed by `change` (the rules), counted in the room,
 * written. Throws BusinessTasksUnreadable, BusinessTasksWriteUnconfirmed, or LockBusyError (lib/redis-lock.ts).
 */
export async function changeBusinessTasks(store: DataStore & { statsId?: string | null }, change: (tasks: BusinessTask[]) => BusinessTaskResult): Promise<BusinessTasksChange> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) throw new BusinessTasksUnreadable("no store or no database");
  return withLock(lockKey(statsId), BUSINESS_TASKS_LOCK_SECONDS, BUSINESS_TASKS_LOCK_WAIT_MS, async (held) => {
    // A change that waited while the store was deleted writes nothing back: its tasks went with it.
    if (store.sid && STORE_ID_PATTERN.test(store.sid) && !(await storeIdExists(store.sid))) return { ok: false, error: "unknown" };
    const kept = await readKept(statsId);
    const result = change(kept.tasks);
    if (!result.ok) return result;
    const key = tasksKey(statsId);
    if (!result.tasks.length) {
      const gone = await deleteIfHeldExact(held, [key]);
      if (gone === "lost") throw new LockBusyError("the store's tasks lock was lost before the list was deleted");
      if (gone === "unknown") throw new BusinessTasksWriteUnconfirmed();
      if (kept.bytes > 0) await giveData(store, [{ slot: BUSINESS_TASKS_SLOT, bytes: kept.bytes }]);
      return result;
    }
    const raw = JSON.stringify(result.tasks);
    const grows = dataBytes([key, raw], 1) - kept.bytes;
    if (grows > 0) {
      const taken = await takeData(store, [{ slot: BUSINESS_TASKS_SLOT, bytes: grows }]);
      if (!taken.ok) {
        if (taken.reason === "full") return { ok: false, error: "store_full", message: taken.message };
        throw new BusinessTasksUnreadable("the store's data room could not be counted");
      }
    }
    const written = await setIfHeldExact(held, key, raw);
    if (written === "lost") {
      // Nothing was written: the growth taken for it goes back, and the change is answered as busy.
      if (grows > 0) await giveData(store, [{ slot: BUSINESS_TASKS_SLOT, bytes: grows }]);
      throw new LockBusyError("the store's tasks lock was lost before the list was written");
    }
    // It may have landed: the growth stays counted, and nobody is told nothing changed.
    if (written === "unknown") throw new BusinessTasksWriteUnconfirmed();
    if (grows < 0) await giveData(store, [{ slot: BUSINESS_TASKS_SLOT, bytes: -grows }]);
    return result;
  });
}
