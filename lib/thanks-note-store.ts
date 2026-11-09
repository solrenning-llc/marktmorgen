/**
 * Where a product's note after paying is kept (lib/thanks-note.ts): its own
 * small record, read only by the thank-you page and the confirmation email of
 * a product marked as having one, as a long description is
 * (lib/product-about.ts).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { type DataStore, dataKey, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type ThanksNote, parseNote } from "@/lib/thanks-note";

const noteKey = (statsId: string, productId: string) => `nl:product:note:${statsId}:${productId}`;

/**
 * The note of one product, or null when Redis confirms it has none (a GET that
 * answers null). Any other answer (no reply, more than one, a slot that is not
 * a kept note) throws UnknownReplyError, so an export or a thank-you page never
 * says "no note" about one it could not read (CX-123 rule 24; Codex T's proof,
 * 46e2cc9). A failed request throws as before.
 */
export async function readThanksNote(statsId: string | null, productId: string): Promise<ThanksNote | null> {
  if (!statsId || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", noteKey(statsId, productId)]]), 1);
  if (!replies) throw new UnknownReplyError("a note read");
  return noteOf(replies[0]);
}

/**
 * Longer than any note writeThanksNote can store: a ThanksNote's JSON is at
 * most a 100-character heading, a 2,000-character body and a 40-character
 * label (each character at most six when escaped), a link of at most 2,000 and
 * a video id, well under this.
 */
const MAX_STORED_NOTE = 20_000;

/**
 * A kept note from its GET or MGET slot: null is "none kept"; a text that is
 * what writeThanksNote stores (JSON.stringify of a ThanksNote that says
 * something) is read by parseNote as before. Anything else throws
 * UnknownReplyError: not a text, longer than any stored note, not JSON, not a
 * ThanksNote's fields with their types, a video or a button kept that parseNote
 * cannot read, or a note that says nothing (Claude 4 team's L1 on c2376695).
 */
function noteOf(raw: unknown): ThanksNote | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length > MAX_STORED_NOTE) throw new UnknownReplyError("a kept note");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UnknownReplyError("a kept note");
  }
  if (!isKeptNote(value)) throw new UnknownReplyError("a kept note");
  const note = parseNote(value);
  if (!note || (value.video !== null && note.video === null) || (value.button !== null && note.button === null)) {
    throw new UnknownReplyError("a kept note");
  }
  return note;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A ThanksNote's fields with their types, as JSON.stringify keeps them. */
function isKeptNote(value: unknown): value is { video: unknown; button: unknown } {
  if (!isRecord(value) || typeof value.heading !== "string" || typeof value.body !== "string") return false;
  if (value.video !== null && !isRecord(value.video)) return false;
  return value.button === null || (isRecord(value.button) && typeof value.button.label === "string" && typeof value.button.url === "string");
}

/**
 * Values of many keys, a hundred at a command (MGET): what the whole export
 * reads (lib/store-export.ts). Each command must answer exactly one list with
 * one slot per key asked, or the whole read throws UnknownReplyError.
 */
async function readMany(keys: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const asked = keys.slice(i, i + 100);
    const replies = repliesFor(await redisPipeline([["MGET", ...asked]]), 1);
    const values = replies ? repliesFor(replies[0], asked.length) : null;
    if (!values) throw new UnknownReplyError("a batch of note reads");
    out.push(...values);
  }
  return out;
}

/** The notes of many products, in their order, a hundred at a command; throws like readThanksNote when any answer is unknown. */
export async function readThanksNotes(statsId: string | null, productIds: string[]): Promise<(ThanksNote | null)[]> {
  if (!statsId || !isRedisConfigured()) return productIds.map(() => null);
  return (await readMany(productIds.map((id) => noteKey(statsId, id)))).map(noteOf);
}

/**
 * Writes a note after taking its room in the store's data room (DataRoomError
 * when it does not fit), or forgets it (null) as dropThanksNote does. Done only
 * when Redis answers the SET exactly "OK"; any other reply throws
 * UnknownReplyError (CX-123 rule 24), so the studio never says saved, nor marks
 * the product, for a note that may not be kept.
 *
 * The room of the larger of the note kept and the new one is taken first, and
 * a note rewritten smaller is counted at its new size only after that "OK": on
 * any other reply the old, larger note may still be kept, so its room stays
 * counted (LOW 2 of Claude 2's review of #3304). The slot counted now is read
 * exactly (null is none, else a whole number as text); any other reply throws
 * UnknownReplyError before anything is written.
 */
export async function writeThanksNote(statsId: string, productId: string, note: ThanksNote | null, room: DataStore): Promise<void> {
  if (!note) return forgetNote(statsId, productId, room);
  const json = JSON.stringify(note);
  const slot = `tn:${productId}`;
  const bytes = dataBytes([json], 1);
  const held = await countedSlot(room, slot);
  await needData(room, [{ slot, bytes: Math.max(held, bytes), set: true }]);
  const replies = repliesFor(await redisPipeline([["SET", noteKey(statsId, productId), json]]), 1);
  if (!replies || replies[0] !== "OK") throw new UnknownReplyError("a note saved");
  if (held > bytes) await giveData(room, [{ slot, bytes, set: true }]);
}

/**
 * What a slot of the store's data room counts now: 0 when its HGET answers
 * null (or the room has no key, where needData refuses anyway), else the
 * whole number TAKE_DATA keeps as text. Any other reply throws
 * UnknownReplyError (CX-123 rule 24).
 */
async function countedSlot(room: DataStore, slot: string): Promise<number> {
  const key = dataKey(room);
  if (!key) return 0;
  const replies = repliesFor(await redisPipeline([["HGET", key, slot]]), 1);
  const raw = replies ? replies[0] : undefined;
  if (raw === null) return 0;
  const held = typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : null;
  if (held === null || !Number.isSafeInteger(held)) throw new UnknownReplyError("a note's counted room");
  return held;
}

/** Forgets the note of a product that is gone, and gives back its room. */
export async function dropThanksNote(statsId: string | null, productId: string, room: DataStore): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await forgetNote(statsId, productId, room);
}

/**
 * Deletes a note, and gives back its room only once Redis confirms the DEL (a
 * count of 0 or 1). Any other reply throws UnknownReplyError (CX-123 rule 24):
 * a note that may still be kept stays counted in the store's data room.
 */
async function forgetNote(statsId: string, productId: string, room: DataStore): Promise<void> {
  const replies = repliesFor(await redisPipeline([["DEL", noteKey(statsId, productId)]]), 1);
  const deleted = replies ? countOf(replies[0]) : null;
  if (deleted === null || deleted > 1) throw new UnknownReplyError("a note deleted");
  await giveData(room, [{ slot: `tn:${productId}`, bytes: 0, set: true }]);
}
