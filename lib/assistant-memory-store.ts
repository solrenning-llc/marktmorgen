/**
 * Where the creator's assistant keeps the creator's own notes: 639 [GL7](40),
 * unit 2. lib/assistant-memory-rules.ts says what a note may be (short, the
 * creator's words, never anyone's details); this keeps a store's notes.
 *
 *   nl:amem:<statsId> -> the store's notes, as JSON: a list of MemoryNote,
 *                        at most MAX_MEMORY_NOTES
 *
 * Only the studio writes here, for the creator or their team; the assistant
 * never does by itself. The record takes room in the store's data room
 * (lib/store-data.ts) before it is written, so a save that does not fit is
 * refused and the notes stay as they were. Whatever is read back is checked
 * again (parseMemory), and everything can be forgotten at once (forgetMemory).
 * It goes with the store.
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { MAX_MEMORY_NOTE, MAX_MEMORY_NOTES, type MemoryNote, type MemoryResult, addNote, editNote, parseMemory, removeNote } from "@/lib/assistant-memory-rules";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

const memoryKey = (statsId: string) => `nl:amem:${statsId}`;
const MEMORY_SLOT = "amem";

/** The longest record a store's notes can make, with room for JSON's quoting. */
export const MAX_STORED_MEMORY_BYTES = MAX_MEMORY_NOTES * (MAX_MEMORY_NOTE * 6 + 128) + 1_024;

function notesOf(raw: unknown): MemoryNote[] {
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_MEMORY_BYTES) return [];
  try {
    return parseMemory(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** A store's notes, oldest first, or none when it has none (or they cannot be read). */
export async function readMemory(statsId: string | null): Promise<MemoryNote[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["GET", memoryKey(statsId)]]);
  return notesOf(raw);
}

async function writeMemory(statsId: string, notes: MemoryNote[], room: DataStore): Promise<void> {
  const json = JSON.stringify(notes);
  // Room first: a save that does not fit throws DataRoomError and nothing is written.
  await needData(room, [{ slot: MEMORY_SLOT, bytes: notes.length ? dataBytes([json], 1) : 0, set: true }]);
  await redisPipeline([notes.length ? ["SET", memoryKey(statsId), json] : ["DEL", memoryKey(statsId)]]);
}

/** A note id made by the store (NOTE_ID): ten lowercase hex characters. */
export const newNoteId = () => randomBytes(5).toString("hex");

/** Keeps a new note, last in the list; refused with the rule's reason. */
export async function keepNote(statsId: string, input: { kind: unknown; text: unknown }, room: DataStore, nowSeconds = Date.now() / 1000): Promise<MemoryResult> {
  const result = addNote(await readMemory(statsId), input, newNoteId(), nowSeconds);
  if (result.ok) await writeMemory(statsId, result.notes, room);
  return result;
}

/** Changes a note in place; refused with the rule's reason. */
export async function changeNote(statsId: string, id: string, input: { kind?: unknown; text?: unknown }, room: DataStore, nowSeconds = Date.now() / 1000): Promise<MemoryResult> {
  const result = editNote(await readMemory(statsId), id, input, nowSeconds);
  if (result.ok) await writeMemory(statsId, result.notes, room);
  return result;
}

/** Forgets one note; forgetting one that is gone is not an error. */
export async function dropNote(statsId: string, id: string, room: DataStore): Promise<MemoryNote[]> {
  const notes = await readMemory(statsId);
  const next = removeNote(notes, id);
  if (next.length !== notes.length) await writeMemory(statsId, next, room);
  return next;
}

/** Forgets every note at once, and gives back their room. */
export async function forgetMemory(statsId: string | null, room: DataStore): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["DEL", memoryKey(statsId)]]);
  await giveData(room, [{ slot: MEMORY_SLOT, bytes: 0, set: true }]);
}
