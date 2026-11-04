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
import { type Held, LockBusyError, holdLock, releaseLock, setIfHeld, takeLock } from "@/lib/redis-lock";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

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

type StoredRecord = { ok: true; notes: MemoryNote[]; bytes: number } | { ok: false; error: "unreadable" };

function recordOf(raw: unknown): StoredRecord {
  if (raw === null || raw === undefined) return { ok: true, notes: [], bytes: 0 };
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_MEMORY_BYTES) return { ok: false, error: "unreadable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "unreadable" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "unreadable" };
  return { ok: true, notes: parseMemory(parsed), bytes: dataBytes([raw], 1) };
}

async function readRecord(statsId: string): Promise<StoredRecord> {
  const [raw] = await redisPipeline([["GET", memoryKey(statsId)]]);
  return recordOf(raw);
}

/** A store's notes, oldest first, or that they could not be read: for the studio, which must not show "no notes" then. */
export async function readMemoryState(statsId: string | null): Promise<MemoryRead> {
  if (!statsId || !isRedisConfigured()) return { ok: true, notes: [] };
  const read = await readRecord(statsId);
  return read.ok ? { ok: true, notes: read.notes } : read;
}

/** A store's notes, oldest first, or none when it has none (or they cannot be read): for the assistant, which only reads. */
export async function readMemory(statsId: string | null): Promise<MemoryNote[]> {
  const read = await readMemoryState(statsId);
  return read.ok ? read.notes : [];
}

/**
 * Writes the notes while the lock is still ours. Room is set first: a save
 * that does not fit throws DataRoomError and nothing is written. When the
 * write does not land (the lock ran out, or Redis failed), the room is set
 * back to the record that is still there.
 */
async function writeMemory(held: Held, statsId: string, notes: MemoryNote[], wasBytes: number, room: DataStore): Promise<void> {
  const json = JSON.stringify(notes);
  await needData(room, [{ slot: MEMORY_SLOT, bytes: notes.length ? dataBytes([json], 1) : 0, set: true }]);
  let landed = false;
  try {
    if (notes.length) landed = await setIfHeld(held, memoryKey(statsId), json);
    else if (await holdLock(held)) {
      await redisPipeline([["DEL", memoryKey(statsId)]]);
      landed = true;
    }
  } finally {
    if (!landed) await noteData(room, [{ slot: MEMORY_SLOT, bytes: wasBytes, set: true }]);
  }
  if (!landed) throw new LockBusyError();
}

/**
 * One change under the store's lock: the record read as it is now, `change`
 * handed its notes, and what it returns written, once. A change that returns
 * the very list it was handed writes nothing. Refused as busy when another
 * change held the lock too long, and as unreadable when the record is there
 * but cannot be read, with nothing written either way.
 */
async function changeMemory(statsId: string, room: DataStore, change: (notes: MemoryNote[]) => MemoryResult): Promise<MemoryChange> {
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
    const result = change(read.notes);
    if (result.ok && result.notes !== read.notes) await writeMemory(held, statsId, result.notes, read.bytes, room);
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
 * Forgets every note at once, and gives back their room. It waits for a
 * change being made to finish, so that change cannot write the notes back
 * after them; a lock held past the wait does not stop the forgetting.
 */
export async function forgetMemory(statsId: string | null, room: DataStore): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const held = await takeLock(lockKey(statsId), LOCK_SECONDS, MEMORY_LOCK_WAIT_MS).catch(() => null);
  try {
    await redisPipeline([["DEL", memoryKey(statsId)]]);
    await giveData(room, [{ slot: MEMORY_SLOT, bytes: 0, set: true }]);
  } finally {
    if (held) await releaseLock(held);
  }
}
