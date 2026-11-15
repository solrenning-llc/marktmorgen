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
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

export const MAX_NOTES = 200;
export const MAX_NOTE_LENGTH = 80;

export type StatsNote = { id: string; day: string; text: string };

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

/** The notes from the stored hash (id → JSON), oldest day first, at most MAX_NOTES. */
export function parseNotes(raw: unknown): StatsNote[] {
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const out: StatsNote[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const id = flat[i];
    if (!ID.test(id)) continue;
    let value: unknown;
    try {
      value = JSON.parse(flat[i + 1]);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const { day, text } = value as Record<string, unknown>;
    if (typeof day !== "string" || !DAY.test(day)) continue;
    const words = noteText(text);
    if (words) out.push({ id, day, text: words });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id)).slice(-MAX_NOTES);
}

export async function readNotes(statsId: string | null): Promise<StatsNote[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HGETALL", key(statsId)]]);
  return parseNotes(raw);
}

/**
 * Adds a note: one field of its own, so two people adding at once both keep
 * theirs. When the list is over MAX_NOTES, the oldest go. Kept as long as the
 * days of visits are, from the last note added. Null when the day or the
 * words are not ones a note can have.
 */
export async function addNote(statsId: string, dayRaw: unknown, textRaw: unknown, now = Date.now()): Promise<StatsNote[] | null> {
  const day = noteDay(dayRaw, now);
  const text = noteText(textRaw);
  if (!day || !text || !isRedisConfigured()) return null;
  const id = randomBytes(4).toString("hex");
  await redisPipeline([
    ["HSET", key(statsId), id, JSON.stringify({ day, text })],
    ["EXPIRE", key(statsId), KEEP_SECONDS],
  ]);
  const notes = await readNotes(statsId);
  const [raw] = await redisPipeline([["HLEN", key(statsId)]]);
  if (Number(raw) > MAX_NOTES) {
    const keep = new Set(notes.map((note) => note.id));
    const [all] = await redisPipeline([["HKEYS", key(statsId)]]);
    const drop = (Array.isArray(all) ? (all as unknown[]).map(String) : []).filter((field) => !keep.has(field));
    if (drop.length) await redisPipeline([["HDEL", key(statsId), ...drop]]);
  }
  return notes;
}

/** Takes a note away by its id; the list as it is after. */
export async function removeNote(statsId: string, id: unknown): Promise<StatsNote[]> {
  if (typeof id === "string" && ID.test(id) && isRedisConfigured()) await redisPipeline([["HDEL", key(statsId), id]]);
  return readNotes(statsId);
}
