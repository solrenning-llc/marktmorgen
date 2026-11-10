/**
 * Where the store's own task list is kept (IA2, TODOS-94, unit 2; the rules are lib/business-tasks-rules.ts).
 *
 *   nl:biztasks:<statsId>      the store's tasks, one JSON list, at most MAX_BUSINESS_TASKS
 *   nl:biztasklock:<statsId>   one change of the list at a time, BUSINESS_TASKS_LOCK_SECONDS at the most
 *
 * Counted in the store's data room (slot BUSINESS_TASKS_SLOT) before it is written: the room is taken at the larger
 * of what the list weighed and what it will weigh, so a write whose answer is not known never leaves more kept than
 * counted, and comes down to the new weight only once Redis said exactly "OK". A full room is said, and nothing is
 * written. An empty list is deleted, and its room given back.
 *
 * Read whole or not at all (CX-123 rule 24): a reply missing or of another shape, or a list that is not one in its
 * shape (parseBusinessTasks), throws BusinessTasksUnreadable, never "no tasks", and a change on it writes nothing.
 * A change that waited while the store was deleted writes nothing back. The list goes with the store: erased in its
 * closing (lib/data-families.ts, CLOSING "nl:biztasks:") and written into its data copy (lib/store-export.ts).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { holdLock, withLock } from "@/lib/redis-lock";
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
      if (!(await holdLock(held))) throw new BusinessTasksWriteUnconfirmed();
      const gone = repliesFor(await redisPipeline([["DEL", key]]), 1)?.[0];
      if (gone !== 0 && gone !== 1) throw new BusinessTasksWriteUnconfirmed();
      await giveData(store, [{ slot: BUSINESS_TASKS_SLOT, bytes: 0, set: true }]);
      return result;
    }
    const raw = JSON.stringify(result.tasks);
    const after = dataBytes([key, raw], 1);
    const taken = await takeData(store, [{ slot: BUSINESS_TASKS_SLOT, bytes: Math.max(after, kept.bytes), set: true }]);
    if (!taken.ok) {
      if (taken.reason === "full") return { ok: false, error: "store_full", message: taken.message };
      throw new BusinessTasksUnreadable("the store's data room could not be counted");
    }
    if (!(await holdLock(held))) throw new BusinessTasksWriteUnconfirmed();
    const written = repliesFor(await redisPipeline([["SET", key, raw]]), 1)?.[0];
    if (written !== "OK") throw new BusinessTasksWriteUnconfirmed();
    if (after < kept.bytes) await giveData(store, [{ slot: BUSINESS_TASKS_SLOT, bytes: after, set: true }]);
    return result;
  });
}
