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
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { storeLiveFence } from "@/lib/store-live-cache";

export const MAX_NOTES = 200;
export const MAX_NOTE_LENGTH = 80;

export type StatsNote = { id: string; day: string; text: string };

const key = (statsId: string) => `nl:stats:${statsId}:notes`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-f0-9]{8}$/;
const KEEP_SECONDS = 400 * 86_400;

/** What addNote needs of a store: its statistics and what its fence reads (lib/store-live-cache.ts). */
export type NoteStore = Pick<Store, "statsId" | "email" | "sid" | "extra">;

/**
 * A chart note and its list's expiry, written only while its store is live, by the rule of lib/live-fence.ts: the
 * store's erasing mark absent, and its id key still holding this very store's ref (ARGV[2] ""), or, for a store from
 * before ids, its owner's record still carrying its statsId (ARGV[2]). KEYS: the live key, the erasing hash, the notes.
 * 1: written; 0: the store is gone, moved or being erased, and nothing was written; -1: the owner's record does not
 * parse (unknown). Billed as the EVAL and its HGET, GET, HSET and EXPIRE (ADD_NOTE_COMMANDS).
 */
const ADD_NOTE_IF_LIVE = `-- marktmorgen:stats-note-add-live:v1
if redis.call("HGET", KEYS[2], ARGV[1]) then return 0 end
if ARGV[2] == "" then
  if redis.call("GET", KEYS[1]) ~= ARGV[3] then return 0 end
else
  local raw = redis.call("GET", KEYS[1])
  if not raw then return 0 end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= "table" then return -1 end
  if record["statsId"] ~= ARGV[2] then return 0 end
end
redis.call("HSET", KEYS[3], ARGV[4], ARGV[5])
redis.call("EXPIRE", KEYS[3], ARGV[6])
return 1`;

/** Billed for one note added: the EVAL and its HGET, GET, HSET and EXPIRE, where the plain write was two commands. */
export const ADD_NOTE_COMMANDS = 5;

/** A note's words as they are kept: one line, trimmed, at most MAX_NOTE_LENGTH characters. */
export function noteText(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_LENGTH).trimEnd() : "";
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
    const words = noteText(text);
    // The previous writer could cut its final word immediately after one
    // normalized space. Keep that exact 80-character stored form readable.
    const legacyBoundary = typeof text === "string" && text.length === MAX_NOTE_LENGTH && text === words + " ";
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== day || typeof text !== "string" || !words || (words !== text && !legacyBoundary)) throw new Error("Chart notes could not be read");
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
export async function addNote(store: NoteStore, dayRaw: unknown, textRaw: unknown, now = Date.now()): Promise<StatsNote[] | null> {
  const day = noteDay(dayRaw, now);
  const text = noteText(textRaw);
  if (!day || !text || !isRedisConfigured()) return null;
  const statsId = store.statsId;
  if (!statsId) return null;
  const id = randomBytes(4).toString("hex");
  // Written only while the store is live, in one step with its fence (Codex L-20261119-1516, #5010 row 128): a note in
  // flight while the store is erased never puts its private notes back with a 400-day expiry. A store gone or being
  // erased refuses the note; any other answer is unknown (CX-123 rule 24); neither falls back to a plain HSET.
  const fence = await storeLiveFence(store);
  if (fence.statsId === null) throw new UnknownReplyError("a chart note kept");
  // One command answers once (rule 24; Claude 1's NIT on #5251): any other count of replies is unknown, never "kept".
  const reply = repliesFor(await redisPipeline([[
    "EVAL", ADD_NOTE_IF_LIVE, 3, fence.live, fence.erasing, key(statsId),
    fence.field, fence.statsId, fence.ref, id, JSON.stringify({ day, text }), KEEP_SECONDS,
  ]]), 1)?.[0];
  if (reply === 0) throw new Error("the store is gone or being erased: no note kept");
  if (reply !== 1) throw new UnknownReplyError("a chart note kept");
  const complete = await readAllNotes(statsId);
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
}

/** Takes a note away by its id; the list as it is after. */
export async function removeNote(statsId: string, id: unknown): Promise<StatsNote[]> {
  if (typeof id === "string" && ID.test(id) && isRedisConfigured()) await redisPipeline([["HDEL", key(statsId), id]]);
  return readNotes(statsId);
}
