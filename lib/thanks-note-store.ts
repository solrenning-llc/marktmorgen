/**
 * Where a product's note after paying is kept (lib/thanks-note.ts): its own
 * small record, read only by the thank-you page and the confirmation email of
 * a product marked as having one, as a long description is
 * (lib/product-about.ts).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { type DataStore, giveData, needData } from "@/lib/store-data";
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

/** Writes a note, or forgets it (null), after taking its room in the store's data room (DataRoomError when it does not fit). */
export async function writeThanksNote(statsId: string, productId: string, note: ThanksNote | null, room: DataStore): Promise<void> {
  const json = note ? JSON.stringify(note) : "";
  await needData(room, [{ slot: `tn:${productId}`, bytes: json ? dataBytes([json], 1) : 0, set: true }]);
  await redisPipeline([note ? ["SET", noteKey(statsId, productId), json] : ["DEL", noteKey(statsId, productId)]]);
}

/** Forgets the note of a product that is gone, and gives back its room. */
export async function dropThanksNote(statsId: string | null, productId: string, room: DataStore): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["DEL", noteKey(statsId, productId)]]);
  await giveData(room, [{ slot: `tn:${productId}`, bytes: 0, set: true }]);
}
