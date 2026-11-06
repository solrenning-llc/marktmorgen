/**
 * Notes on the numbers (added 11 October 2026): the creator marks a day —
 * "posted the October reel", "launched the course", "price down to $29" — and
 * the mark sits on the chart of visitors a day, so a rise or a fall has its
 * reason beside it the next time anybody looks.
 *
 * Google Analytics, Plausible, Fathom and Matomo all have them, under the
 * names annotations or milestones, for the same reason: a number nobody
 * remembers the cause of is a number nobody can act on.
 *
 * Kept as one short list on the store's statistics, at most MAX_NOTES of
 * them, the oldest let go first; each is a day and a few words, typed by the
 * creator or their team and shown only to them. Kept as long as the days of
 * visits are, counted from the last note added.
 *
 *   nl:stats:<statsId>:notes   hash: <id> → JSON { day, text }
 */
import { randomBytes } from "node:crypto";
import { types } from "node:util";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

export const MAX_NOTES = 200;
export const MAX_NOTE_LENGTH = 80;

export type StatsNote = { id: string; day: string; text: string };

export class StatsNoteAttemptConflict extends Error {}

const key = (statsId: string) => `nl:stats:${statsId}:notes`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-f0-9]{8}$/;
const KEEP_SECONDS = 400 * 86_400;

/** A note's words as they are kept: one line, trimmed, at most MAX_NOTE_LENGTH characters. */
export function noteText(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_LENGTH) : "";
}

/** A day a note can be put on: a real date, not in the future, not before the days kept. */
export function noteDay(raw: unknown, now = Date.now()): string {
  if (typeof raw !== "string" || !DAY.test(raw)) return "";
  const at = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== raw) return "";
  if (!Number.isFinite(now) || at > now || at < now - 400 * 86_400_000) return "";
  return raw;
}

/** Snapshot a complete inert Redis array without converting values or executing accessors. */
function exactArray(raw: unknown, length?: number): unknown[] {
  if (types.isProxy(raw) || !Array.isArray(raw) || (length !== undefined && raw.length !== length)) throw new Error("Chart notes could not be read");
  const out: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!slot || !Object.hasOwn(slot, "value")) throw new Error("Chart notes could not be read");
    out.push(slot.value);
  }
  return out;
}

/** Validate every stored field before choosing the most recent notes. */
function allNotes(raw: unknown): StatsNote[] {
  const flat = exactArray(raw);
  if (flat.length % 2 !== 0) throw new Error("Chart notes could not be read");
  const out: StatsNote[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const id = flat[i];
    const stored = flat[i + 1];
    if (typeof id !== "string" || !ID.test(id) || seen.has(id) || typeof stored !== "string") throw new Error("Chart notes could not be read");
    seen.add(id);
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "day") || !Object.hasOwn(value, "text")) throw new Error("Chart notes could not be read");
    const { day, text } = value as Record<string, unknown>;
    const date = typeof day === "string" && DAY.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== day || typeof text !== "string" || !text || noteText(text) !== text) throw new Error("Chart notes could not be read");
    // The sole writer uses this canonical representation. Parsing alone would
    // silently choose the last of conflicting duplicate day/text members.
    if (stored !== JSON.stringify({ day, text })) throw new Error("Chart notes could not be read");
    out.push({ id, day: day as string, text });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

/** The confirmed notes, oldest day first, at most MAX_NOTES; unknown fields fail the whole reading. */
export function parseNotes(raw: unknown): StatsNote[] {
  return allNotes(raw).slice(-MAX_NOTES);
}

async function readAllNotes(statsId: string): Promise<StatsNote[]> {
  const [raw] = exactArray(await redisPipeline([["HGETALL", key(statsId)]]), 1);
  return allNotes(raw);
}

/**
 * A write may have landed before a later read became unavailable. One exact
 * HLEN contains that failure: keep the sole recoverable note, but remove this
 * attempt when it would grow an existing or already retried unknown history.
 */
async function containUnconfirmedAddition(statsId: string, id: string): Promise<void> {
  const [raw] = exactArray(await redisPipeline([["HLEN", key(statsId)]]), 1);
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new Error("Chart notes could not be counted");
  if (raw <= 1) return;
  const [removed] = exactArray(await redisPipeline([["HDEL", key(statsId), id]]), 1);
  if (removed !== 0 && removed !== 1) throw new Error("Chart note cleanup could not be confirmed");
}

export async function readNotes(statsId: string | null): Promise<StatsNote[]> {
  if (!statsId || !isRedisConfigured()) return [];
  return (await readAllNotes(statsId)).slice(-MAX_NOTES);
}

/**
 * Adds a note: one field of its own, so two people adding at once both keep
 * theirs. When the list is over MAX_NOTES, the oldest go. Kept as long as the
 * days of visits are, from the last note added. Null when the day or the
 * words are not ones a note can have.
 */
export async function addNote(
  statsId: string,
  dayRaw: unknown,
  textRaw: unknown,
  now = Date.now(),
  attemptRaw?: unknown,
): Promise<StatsNote[] | null> {
  const day = noteDay(dayRaw, now);
  const text = noteText(textRaw);
  if (!day || !text || !isRedisConfigured()) return null;
  const id = attemptRaw === undefined ? randomBytes(4).toString("hex") : typeof attemptRaw === "string" && ID.test(attemptRaw) ? attemptRaw : "";
  if (!id) return null;
  const stored = JSON.stringify({ day, text });
  const [created, expiry] = exactArray(
    await redisPipeline([
      ["HSETNX", key(statsId), id, stored],
      ["EXPIRE", key(statsId), KEEP_SECONDS],
    ]),
    2,
  );
  if ((created !== 0 && created !== 1) || expiry !== 1) throw new Error("Chart note write could not be confirmed");
  try {
    const complete = await readAllNotes(statsId);
    const own = complete.find((note) => note.id === id);
    if (!own || own.day !== day || own.text !== text) throw new StatsNoteAttemptConflict("Chart note attempt belongs to another addition");
    const notes = complete.slice(-MAX_NOTES);
    const [raw] = exactArray(await redisPipeline([["HLEN", key(statsId)]]), 1);
    if (Number(raw) > MAX_NOTES) {
      // A short read or a concurrent change cannot choose which history to delete.
      if (Number(raw) !== complete.length) throw new Error("Chart notes changed while being read");
      const keep = new Set(notes.map((note) => note.id));
      const [rawKeys] = exactArray(await redisPipeline([["HKEYS", key(statsId)]]), 1);
      const all = exactArray(rawKeys);
      const known = new Set(complete.map(note => note.id));
      if (all.length !== known.size || all.some(field => typeof field !== "string" || !known.has(field)) || new Set(all).size !== all.length) throw new Error("Chart notes changed while being read");
      const drop = (all as string[]).filter((field) => !keep.has(field));
      if (drop.length) await redisPipeline([["HDEL", key(statsId), ...drop]]);
    }
    return notes;
  } catch (error) {
    if (created === 1) await containUnconfirmedAddition(statsId, id);
    throw error;
  }
}

/** Takes a note away by its id; the list as it is after. */
export async function removeNote(statsId: string, id: unknown): Promise<StatsNote[]> {
  if (typeof id === "string" && ID.test(id) && isRedisConfigured()) await redisPipeline([["HDEL", key(statsId), id]]);
  return readNotes(statsId);
}
