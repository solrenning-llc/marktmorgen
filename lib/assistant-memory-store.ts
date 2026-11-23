/**
 * Where the creator's assistant keeps the creator's own notes: 639 [GL7](40),
 * unit 2. lib/assistant-memory-rules.ts says what a note may be (short, the
 * creator's words, never anyone's details); this keeps a store's notes.
 *
 *   nl:amem:<statsId>      -> the store's notes, as JSON: a list of MemoryNote,
 *                             at most MAX_MEMORY_NOTES
 *   nl:amem:lock:<statsId> -> a change being made, ten seconds at the most
 *
 * Only the studio writes here, for the creator or their team; the assistant
 * never does by itself. Every change reads, changes and writes the whole
 * record, so it takes the store's lock first (lib/redis-lock.ts): two notes
 * saved at the same instant are both kept, or the second waits up to two
 * seconds and is then refused as busy, never quietly undone. A record that is
 * there but cannot be read is never written over: the change is refused and
 * the record stays as it is, so one bad read cannot cost the creator every
 * note. The record takes room in the store's data room (lib/store-data.ts)
 * before it is written, once per change and inside the lock, so a save that
 * does not fit is refused and the notes stay as they were. Whatever is read
 * back is checked again (parseMemory), and everything can be forgotten at
 * once (forgetMemory). It goes with the store; the lock expires by itself.
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { MAX_MEMORY_NOTE, MAX_MEMORY_NOTES, type MemoryNote, type MemoryResult, addNote, editNote, parseMemory, removeNote } from "@/lib/assistant-memory-rules";
import { type Held, LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import type { StoreLiveFence } from "@/lib/live-fence";
import type { Store } from "@/lib/store";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { storeLiveFence } from "@/lib/store-live-cache";
import { dataBytes, dataBytesOfLength } from "@/lib/store-data-rules";

const memoryKey = (statsId: string) => `nl:amem:${statsId}`;
const lockKey = (statsId: string) => `nl:amem:lock:${statsId}`;
const MEMORY_SLOT = "amem";
const LOCK_SECONDS = 10;
/** How long a change waits for another one to finish before it is refused as busy. */
export const MEMORY_LOCK_WAIT_MS = 2_000;

/** The longest record a store's notes can make, with room for JSON's quoting. */
export const MAX_STORED_MEMORY_BYTES = MAX_MEMORY_NOTES * (MAX_MEMORY_NOTE * 6 + 128) + 1_024;

/** Why the store refused a change the rules allowed. */
export type MemoryStoreRefusal = "busy" | "unreadable";

/** What each of the store's refusals says to the creator, in plain US English. */
export const MEMORY_STORE_REFUSALS: Readonly<Record<MemoryStoreRefusal, string>> = {
  busy: "Someone else is changing these notes right now. Try again in a moment.",
  unreadable: "Your assistant's notes could not be read just now, so nothing was changed. Try again in a moment.",
};

/** A change's answer: the notes as they are now, or the rules' or the store's refusal. */
export type MemoryChange = MemoryResult | { ok: false; error: MemoryStoreRefusal };

/** The record as read: no record is no notes; a record that is there but cannot be read is said so. */
export type MemoryRead = { ok: true; notes: MemoryNote[] } | { ok: false; error: "unreadable" };

/** The record as read; `whole` when every note in it reads back, so a change may write the list over it. */
type StoredRecord = { ok: true; notes: MemoryNote[]; bytes: number; whole: boolean } | { ok: false; error: "unreadable" };

function recordOf(raw: unknown): StoredRecord {
  // Only Redis's own null is no record: anything else that is not the record's text is not known (Codex G2 on #1949).
  if (raw === null) return { ok: true, notes: [], bytes: 0, whole: true };
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_MEMORY_BYTES) return { ok: false, error: "unreadable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "unreadable" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "unreadable" };
  const notes = parseMemory(parsed);
  // A note left out (one with someone's details, a kind of a later version) is shown nowhere, but it is kept: a
  // change never writes the list over it (Codex G2 on #1949).
  return { ok: true, notes, bytes: dataBytes([raw], 1), whole: notes.length === parsed.length };
}

async function readRecord(statsId: string): Promise<StoredRecord> {
  const reply: unknown = await redisPipeline([["GET", memoryKey(statsId)]]);
  if (!Array.isArray(reply) || reply.length !== 1) return { ok: false, error: "unreadable" };
  return recordOf(reply[0]);
}

/**
 * Writes the notes (or deletes them, with an empty ARGV[2]) only while the
 * lock KEYS[1] is still the change's own (ARGV[1]): 1 when written, 0 when
 * the lock was gone and nothing was. Modelled by lib/redis-memory.ts.
 */
export const MEMORY_WRITE = `-- marktmorgen:amem-write:v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[2]) else redis.call('SET', KEYS[2], ARGV[2]) end
return 1`;
/**
 * MEMORY_WRITE, done only while the notes' store is still live (Codex P-20261120-0045, #5010 row 44): a change holds
 * only the notes' own lock, which the store's erasure does not take, so a change that read the notes before the
 * erasure and wrote after the closing walk passed nl:amem: would leave the creator's notes under the erased statsId,
 * with no expiry. The fence is lib/store-live-cache.ts storeLiveFence, as in funnel-save-live:v3
 * (lib/page-funnel-store.ts): the erasing mark (KEYS[4], field ARGV[3]) absent and, for a store with an id, its id key
 * (KEYS[3]) still holding this store's ref (ARGV[5]); for one from before ids, its owner's record still this store's
 * own (its statsId, ARGV[4]). Answers 1 written, 0 the lock gone, -4 the store gone or being erased, -5 its id key
 * holding another ref (moved; the erasing mark under the new ref is not checked here), -3 its owner's record
 * unreadable; nothing is
 * written on any answer but 1. Two more commands than MEMORY_WRITE (the HGET and the GET). Modelled by
 * lib/redis-memory.ts.
 */
export const MEMORY_WRITE_LIVE = `-- marktmorgen:amem-write-live:v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[4], ARGV[3]) then return -4 end
if ARGV[4] == '' then
  local held = redis.call('GET', KEYS[3])
  if not held then return -4 end
  if held ~= ARGV[5] then return -5 end
else
  local raw = redis.call('GET', KEYS[3])
  if not raw then return -4 end
  local parsed, record = pcall(cjson.decode, raw)
  if not parsed or type(record) ~= 'table' then return -3 end
  if record['statsId'] ~= ARGV[4] then return -4 end
end
if ARGV[2] == '' then redis.call('DEL', KEYS[2]) else redis.call('SET', KEYS[2], ARGV[2]) end
return 1`;
/** Commands MEMORY_WRITE_LIVE adds to MEMORY_WRITE: the erasing mark's HGET and the store key's GET. */
export const MEMORY_LIVE_GUARD_COMMANDS = 2;
/**
 * Forgets the notes and makes the lock the forgetting's own (ARGV[1], for
 * ARGV[2] seconds) in the same step: a change still in flight finds its lock
 * gone and writes nothing back (Codex G2 on #1949), and no new change can
 * start until the forgetting has let go (Codex J on #1951). Answers {records
 * deleted (0 or 1), the length of the record deleted}, measured in the same
 * step, so the room given back is only what it removed, however late that
 * comes (Codex G2 on #1949: a note kept after its lock ran out keeps its room).
 * Modelled by lib/redis-memory.ts.
 */
export const MEMORY_FORGET = `-- marktmorgen:amem-forget:v3
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
local length = redis.call('STRLEN', KEYS[2])
return {redis.call('DEL', KEYS[2]), length}`;

/** A change of the notes whose answer was not Redis's own: it may or may not have been written. */
export class MemoryWriteUnconfirmed extends Error {
  constructor() {
    super("The assistant's notes may or may not have changed");
    this.name = "MemoryWriteUnconfirmed";
  }
}

/**
 * The notes' store is gone, being erased or no longer the store this change read: nothing was written, and nothing
 * is given back to its room. On -4 (gone or being erased) giving back would write its room's key again; on -5 (its id
 * key moved to another ref) the script cannot check the erasing mark under the new ref (its field is a hash the Lua
 * cannot compute), so giving back could do the same after an erasure under that ref began (Claude 1 on #5112). The
 * room keeps what the change took: an over-count that only refuses more.
 */
export class MemoryStoreGoneError extends Error {
  constructor() {
    super("This store is gone or being closed, so the assistant's notes were not changed.");
    this.name = "MemoryStoreGoneError";
  }
}

/** A store's notes, oldest first, or that they could not be read: for the studio, which must not show "no notes" then. */
export async function readMemoryState(statsId: string | null): Promise<MemoryRead> {
  if (!statsId || !isRedisConfigured()) return { ok: true, notes: [] };
  const read = await readRecord(statsId);
  if (!read.ok) return read;
  // The studio shows every note it keeps, so a list with a note the rules leave out is not shown as if it were the
  // whole list: unreadable, said so, never a shorter list (Codex G2 on #1949/#1951).
  return read.whole ? { ok: true, notes: read.notes } : { ok: false, error: "unreadable" };
}

/**
 * A store's notes, oldest first, for the assistant, which only reads: the ones the rules let through (a note left
 * out is never sent to the model), or none when the record cannot be read.
 */
export async function readMemory(statsId: string | null): Promise<MemoryNote[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const read = await readRecord(statsId);
  return read.ok ? read.notes : [];
}

/**
 * Writes the notes while the lock is still ours, in one script with its own
 * answer (MEMORY_WRITE). The room moves by what the write changes, never set
 * to a total (Codex G2 on #1949: a total set by a change whose lock ran out
 * cut a newer note's room). While the lock is ours no other change writes, so
 * what it replaces is the record read. Taken first when it grows: a save that
 * does not fit throws DataRoomError and nothing is written. Written: a shrink
 * is given back. The lock gone: nothing was written, only what this change
 * took goes back, refused as busy. An answer that is not Redis's own:
 * unconfirmed, what it took kept.
 */
async function writeMemory(held: Held, statsId: string, notes: MemoryNote[], wasBytes: number, room: DataStore, live: Store | null): Promise<void> {
  const json = notes.length ? JSON.stringify(notes) : "";
  const bytes = notes.length ? dataBytes([json], 1) : 0;
  const grown = bytes - wasBytes;
  if (grown > 0) await needData(room, [{ slot: MEMORY_SLOT, bytes: grown }]);
  let reply: unknown;
  try {
    const fence: StoreLiveFence | null = live ? await storeLiveFence(live) : null;
    reply = await redisPipeline([
      fence
        ? ["EVAL", MEMORY_WRITE_LIVE, 4, held.key, memoryKey(statsId), fence.live, fence.erasing, held.token, json, fence.field, fence.statsId === "" ? "" : statsId, fence.ref]
        : ["EVAL", MEMORY_WRITE, 2, held.key, memoryKey(statsId), held.token, json],
    ]);
  } catch {
    throw new MemoryWriteUnconfirmed();
  }
  const answer = Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
  if (answer === 1) {
    if (grown < 0) await giveData(room, [{ slot: MEMORY_SLOT, bytes: -grown }]);
    return;
  }
  // A store known gone or being erased (-4), or moved to a ref whose erasing mark the script cannot check (-5): giving
  // the room back could write its room's key again after the erasure removed it, so nothing is given back.
  if (live && (answer === -4 || answer === -5)) throw new MemoryStoreGoneError();
  if (answer === 0 || (live && answer === -3)) {
    if (grown > 0) await giveData(room, [{ slot: MEMORY_SLOT, bytes: grown }]);
    if (answer === -3) throw new MemoryWriteUnconfirmed();
    throw new LockBusyError();
  }
  throw new MemoryWriteUnconfirmed();
}

/**
 * One change under the store's lock: the record read as it is now, `change`
 * handed its notes, and what it returns written, once. A change that returns
 * the very list it was handed writes nothing. Refused as busy when another
 * change held the lock too long, and as unreadable when the record is there
 * but cannot be read, with nothing written either way.
 */
async function changeMemory(statsId: string, room: DataStore, change: (notes: MemoryNote[]) => MemoryResult, live: Store | null = null): Promise<MemoryChange> {
  let held: Held;
  try {
    held = await takeLock(lockKey(statsId), LOCK_SECONDS, MEMORY_LOCK_WAIT_MS);
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, error: "busy" };
    throw error;
  }
  try {
    const read = await readRecord(statsId);
    if (!read.ok) return read;
    // A note the rules leave out is kept: the list is never written over it (Codex G2 on #1949).
    if (!read.whole) return { ok: false, error: "unreadable" };
    const result = change(read.notes);
    if (result.ok && result.notes !== read.notes) await writeMemory(held, statsId, result.notes, read.bytes, room, live);
    return result;
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, error: "busy" };
    throw error;
  } finally {
    await releaseLock(held);
  }
}

/** A note id made by the store (NOTE_ID): ten lowercase hex characters. */
export const newNoteId = () => randomBytes(5).toString("hex");

/** Keeps a new note, last in the list; refused with the rule's or the store's reason. */
export async function keepNote(statsId: string, input: { kind: unknown; text: unknown }, room: DataStore, nowSeconds = Date.now() / 1000): Promise<MemoryChange> {
  const id = newNoteId();
  return changeMemory(statsId, room, (notes) => addNote(notes, input, id, nowSeconds));
}

/** Changes a note in place; refused with the rule's or the store's reason. */
export async function changeNote(statsId: string, id: string, input: { kind?: unknown; text?: unknown }, room: DataStore, nowSeconds = Date.now() / 1000): Promise<MemoryChange> {
  return changeMemory(statsId, room, (notes) => editNote(notes, id, input, nowSeconds));
}

/** Forgets one note; forgetting one that is gone is not an error. Refused only with the store's reason. */
export async function dropNote(statsId: string, id: string, room: DataStore): Promise<MemoryChange> {
  return changeMemory(statsId, room, (notes) => {
    const next = removeNote(notes, id);
    return { ok: true, notes: next.length === notes.length ? notes : next };
  });
}

/**
 * The same changes, written only while `store` is still live (MEMORY_WRITE_LIVE): MemoryStoreGoneError when it is
 * gone, being erased or moved, and nothing is written. Every studio change goes through these
 * (tests/assistant-memory-erasure-fence.test.ts); the bare ones above are for the rules' own tests. A store without a
 * statsId has no notes to change.
 */
function liveStatsId(store: Store): string {
  if (!store.statsId) throw new MemoryWriteUnconfirmed();
  return store.statsId;
}

/** keepNote, only while `store` is live. */
export async function keepStoreNote(store: Store, input: { kind: unknown; text: unknown }, nowSeconds = Date.now() / 1000): Promise<MemoryChange> {
  const id = newNoteId();
  return changeMemory(liveStatsId(store), store, (notes) => addNote(notes, input, id, nowSeconds), store);
}

/** changeNote, only while `store` is live. */
export async function changeStoreNote(store: Store, id: string, input: { kind?: unknown; text?: unknown }, nowSeconds = Date.now() / 1000): Promise<MemoryChange> {
  return changeMemory(liveStatsId(store), store, (notes) => editNote(notes, id, input, nowSeconds), store);
}

/** dropNote, only while `store` is live. */
export async function dropStoreNote(store: Store, id: string): Promise<MemoryChange> {
  return changeMemory(liveStatsId(store), store, (notes) => {
    const next = removeNote(notes, id);
    return { ok: true, notes: next.length === notes.length ? notes : next };
  }, store);
}

/** Tries at the lock while waiting `waitMs` (lib/redis-lock.ts takeLock: one SET each, waits of 20 ms doubling up to 250 ms). */
function lockTries(waitMs: number): number {
  let tries = 1;
  for (let wait = 20, waited = 0; waited + wait <= waitMs; wait = Math.min(wait * 2, 250)) {
    waited += wait;
    tries += 1;
  }
  return tries;
}

/**
 * The most Redis commands forgetMemory sends: every try at the lock while it
 * waits, the deletion, the room given back, and the lock let go (its script,
 * or GET and DEL when the script cannot run). Counted in a deleted store's
 * forget line (lib/store-forget-retry.ts FORGET_TRY_COMMANDS).
 */
export const MEMORY_FORGET_COMMANDS = lockTries(MEMORY_LOCK_WAIT_MS) + 1 + 1 + 3;

/**
 * Forgets every note at once, and gives back their room. It waits for a
 * change being made to finish, so that change cannot write the notes back
 * after them; a lock held past the wait does not stop the forgetting.
 */
export async function forgetMemory(statsId: string | null, room: DataStore): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const waited = await takeLock(lockKey(statsId), LOCK_SECONDS, MEMORY_LOCK_WAIT_MS).catch(() => null);
  // Its own lock, or one it takes over in the same step as the deletion when another change held it too long.
  const held: Held = waited ?? { key: lockKey(statsId), token: crypto.randomUUID(), ttlSeconds: LOCK_SECONDS };
  try {
    const reply: unknown = await redisPipeline([["EVAL", MEMORY_FORGET, 2, held.key, memoryKey(statsId), held.token, LOCK_SECONDS]]);
    // Room is given back only once Redis says the record is gone, and only what it removed, by difference; an answer
    // that is not its own keeps it counted.
    const answer = Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
    if (!Array.isArray(answer) || answer.length !== 2) throw new MemoryWriteUnconfirmed();
    const [deleted, length] = answer;
    if ((deleted !== 0 && deleted !== 1) || typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || (deleted === 0 && length !== 0)) throw new MemoryWriteUnconfirmed();
    if (deleted === 1) await giveData(room, [{ slot: MEMORY_SLOT, bytes: dataBytesOfLength(length, 1) }]);
  } finally {
    await releaseLock(held);
  }
}
