/**
 * A student's private notes on a course's lessons (290 [SQ1]).
 *
 *   nl:lnote:<store statsId>:<student key>   hash   "<course>:<lesson>" → {"t": text, "at": seconds};
 *                                                   "#" → what that student's notes weigh, in bytes
 *
 * Only the student who wrote a note reads it: the hash is named by their own
 * key (lib/learn.ts emailKey, made from the address of the session that
 * opened the course, never from anything the browser sends), and nothing in
 * the studio or anywhere a creator or another student looks reads it. The
 * student can download their notes of a course as a text file
 * (app/api/store/course/note), and deleting the person deletes them all
 * (lib/person-erasure.ts); their data copy holds them (lib/person-copy.ts).
 * The keys are named by the store's statsId, one of the ids a closed store's
 * keys are erased by (lib/closed-store-data.ts).
 *
 * Caps, checked in the same step that writes (NOTE_SAVE): a note holds at
 * most MAX_NOTE_CHARS characters; one student keeps at most
 * MAX_NOTES_PER_STUDENT notes in one store, weighing at most
 * MAX_NOTES_BYTES_PER_STUDENT together; and all students' notes in one store
 * take at most notesRoomFor of its content room, one slot (NOTES_SLOT) in the
 * store's data room (lib/store-data.ts). The rest of the room always stays
 * the creator's, who can neither see nor delete students' notes (Claude 2's
 * review of #3031, ALTO). An emptied note gives all of its room back.
 *
 * One step, never two. A save names the note it started from (`was`); the
 * script writes only while the note kept is exactly the one the save read,
 * checks the count and the weights, takes the room and writes, all at once.
 * Two saves of one note from the same original: one is kept, the other is
 * "changed" (Codex J M1); two new notes for the last place: one is kept
 * (Codex J M2). Deleting the person writes their print first
 * (lib/person-erasure.ts, lib/suppression.ts), then deletes the hash and
 * gives its room back in one step (NOTE_FORGET); a save still on its way
 * finds either its note gone (changed) or, for a first note, the print made
 * after it started, and writes nothing (Claude 2 M3).
 *
 * Unknown is closed. A note whose stored value is not one as saved, or a
 * reply of another shape, reads as "unknown": the lesson page then says the
 * note could not be loaded and gives no box to type over it, and a save is
 * refused.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, TAKE_DATA, dataKey, monthOf } from "@/lib/store-data";
import { contentRoomFor, dataBytes } from "@/lib/store-data-rules";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";
import { COURSE_ID_PATTERN, ITEM_ID_PATTERN } from "@/lib/course";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import type { LessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import {
  MAX_NOTE_CHARS,
  MAX_NOTES_BYTES_PER_STUDENT,
  MAX_NOTES_PER_STUDENT,
  cleanNote,
  noteLength,
  notesRoomFor,
} from "@/lib/lesson-notes-rules";

export { MAX_NOTE_CHARS, MAX_NOTES_BYTES_PER_STUDENT, MAX_NOTES_PER_STUDENT, cleanNote, noteLength, notesRoomFor };

const STATS_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const LEARNER_PATTERN = /^[0-9a-f]{32}$/;
const FIELD_PATTERN = /^([0-9a-f]{32}):([a-z0-9]{12})$/;

const notesKey = (statsId: string, learner: string) => `nl:lnote:${statsId}:${learner}`;
const fieldOf = (courseId: string, lessonId: string) => `${courseId}:${lessonId}`;
/** The field of a student's hash that holds what their notes weigh. */
const TALLY = "#";
/** The one slot of the store's data room every student's notes are counted in, with each student's tally. */
export const NOTES_SLOT = "lnote";
/** What a student's tally field takes, counted while they keep a note. */
export const TALLY_BYTES = dataBytes([TALLY, "9999999999"], 1);
/** What one note weighs in the data room: its field, its stored value and its entry. */
const noteBytes = (field: string, value: string) => dataBytes([field, value], 1);

/** The data room's own steps (TAKE_DATA) for the notes' slot, grown or shrunk by `bytes`, inside a script whose KEYS[1] is the room. */
const NOTE_ROOM = `local function noteRoom(limit, always, month, bytes)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, always, month, 'a', '${NOTES_SLOT}', bytes}
${TAKE_DATA}
end`;

/**
 * KEYS: the room, the student's notes, the store's prints of deleted people
 * (lib/suppression.ts). ARGV: the room's limit, the month, the field, the
 * value the save read ("" for none), the value to write ("" to delete), what
 * each weighs, the most notes, the most one student's notes weigh, the most
 * all students' notes take, the tally's own weight, the student's print (""
 * for none) and the second the save started. Answers {1, total} written;
 * {0, total} the room is full; {2, 0} changed, or the person deleted since a
 * second before the save started; {3, 0} one note too many;
 * {4, 0} the student's own weight passed; {5, 0} the notes' share of the room
 * full; {-1, 0} what it cannot read. Modelled by lib/redis-memory.ts.
 */
export const NOTE_SAVE = `-- marktmorgen:lesson-note-save:v1
${NOTE_ROOM}
if #KEYS ~= 3 or #ARGV ~= 13 then return {-1, 0} end
local field, seen, json = ARGV[3], ARGV[4], ARGV[5]
local oldB, newB, most, mine, share, tally, start = tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10]), tonumber(ARGV[11]), tonumber(ARGV[13])
if not (oldB and newB and most and mine and share and tally and start) or field == '${TALLY}' or field == '' then return {-1, 0} end
if ARGV[12] ~= '' then
  local erased = redis.call('HGET', KEYS[3], ARGV[12])
  if erased then
    local at = tonumber(erased)
    if not at or at >= start - 1 then return {2, 0} end
  end
end
local held = redis.call('HGET', KEYS[2], field)
if (held or '') ~= seen then return {2, 0} end
if not held and json == '' then return {1, 0} end
local sum = redis.call('HGET', KEYS[2], '${TALLY}')
local had = 0
if sum then
  had = tonumber(sum)
  if not had or had < 0 or had ~= math.floor(had) then return {-1, 0} end
elseif held then
  return {-1, 0}
end
if not held then
  local count = redis.call('HLEN', KEYS[2])
  if sum then count = count - 1 end
  if count >= most then return {3, 0} end
end
local now = had - oldB + newB
if now < 0 then return {-1, 0} end
local delta = newB - oldB
if had == 0 and now > 0 then delta = delta + tally elseif had > 0 and now == 0 then delta = delta - tally end
if delta > 0 then
  if now > mine then return {4, 0} end
  local all = tonumber(redis.call('HGET', KEYS[1], '${NOTES_SLOT}') or '0')
  if not all then return {-1, 0} end
  if all + delta > share then return {5, 0} end
end
local taken = noteRoom(ARGV[1], '0', ARGV[2], tostring(delta))
if taken[1] ~= 1 then return taken end
if json == '' then redis.call('HDEL', KEYS[2], field) else redis.call('HSET', KEYS[2], field, json) end
if now > 0 then redis.call('HSET', KEYS[2], '${TALLY}', tostring(now)) else redis.call('HDEL', KEYS[2], '${TALLY}') end
return taken`;

/**
 * KEYS: the room, the student's notes. ARGV: the room's limit, the month, the
 * tally's own weight. Deletes every note and gives their weight back to the
 * room, in one step. Answers {notes deleted, the room's answer}, or {-1, 0}
 * for what it cannot read (nothing deleted). Modelled by lib/redis-memory.ts.
 */
export const NOTE_FORGET = `-- marktmorgen:lesson-note-forget:v1
${NOTE_ROOM}
if #KEYS ~= 2 or #ARGV ~= 3 then return {-1, 0} end
local tally = tonumber(ARGV[3])
if not tally then return {-1, 0} end
local sum = redis.call('HGET', KEYS[2], '${TALLY}')
local had = 0
if sum then
  had = tonumber(sum)
  if not had or had < 0 or had ~= math.floor(had) then return {-1, 0} end
end
local n = redis.call('HLEN', KEYS[2])
if sum then n = n - 1 end
redis.call('DEL', KEYS[2])
if had == 0 then return {n, 1} end
local taken = noteRoom(ARGV[1], '1', ARGV[2], tostring(-(had + tally)))
return {n, taken[1]}`;

type Kept = { t: string; at: number };

function parseKept(raw: string): Kept | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.t !== "string" || typeof record.at !== "number" || !Number.isSafeInteger(record.at) || record.at < 0) return null;
  return { t: record.t, at: record.at };
}

export type NoteRead = { state: "none" } | { state: "kept"; text: string; at: number } | { state: "unknown" };

const validIds = (statsId: string, learner: string, courseId: string, lessonId: string) =>
  STATS_PATTERN.test(statsId) && LEARNER_PATTERN.test(learner) && COURSE_ID_PATTERN.test(courseId) && ITEM_ID_PATTERN.test(lessonId);

/** One student's note on one lesson. Never throws: what cannot be read is "unknown". */
export async function readNote(statsId: string, learner: string, courseId: string, lessonId: string): Promise<NoteRead> {
  if (!validIds(statsId, learner, courseId, lessonId) || !isRedisConfigured()) return { state: "unknown" };
  try {
    const [raw] = exactReplies(await redisPipeline([["HGET", notesKey(statsId, learner), fieldOf(courseId, lessonId)]]), 1, "a lesson note");
    if (raw === null) return { state: "none" };
    if (typeof raw !== "string") return { state: "unknown" };
    const kept = parseKept(raw);
    return kept ? { state: "kept", text: kept.t, at: kept.at } : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export type SaveRefusal = "invalid" | "too_long" | "too_many" | "mine" | "changed" | "full" | "unknown";
export type SaveResult = { ok: true; text: string } | { ok: false; reason: SaveRefusal };

/** A script's answer {code, n}: two whole numbers, or UnknownReply. */
function scriptAnswer(reply: unknown, what: string): [number, number] {
  const list = plainList(reply);
  if (!list || list.length !== 2 || !list.every((n) => typeof n === "number" && Number.isInteger(n))) throw new UnknownReply(what);
  return [list[0] as number, list[1] as number];
}

/**
 * Saves (or, with empty text, deletes) one student's note on one lesson,
 * starting from `was`, the note as the student's page last read it ("" for
 * none). The note is read once, then NOTE_SAVE writes it only while what is
 * kept is still exactly what was read, with the count, the weights and the
 * room checked and taken in the same step.
 */
export async function saveNote(input: {
  statsId: string;
  learner: string;
  courseId: string;
  lessonId: string;
  text: unknown;
  was: unknown;
  room: DataStore;
  /**
   * The store's list and the student's address, so a save on its way while the person is deleted finds their print
   * (lib/suppression.ts) and writes nothing. The route always gives it; without it, only a note already kept is
   * protected (the save then finds it changed).
   */
  erasure?: { listId: string | null | undefined; email: string };
  now?: number;
}): Promise<SaveResult> {
  const { statsId, learner, courseId, lessonId, room } = input;
  if (!validIds(statsId, learner, courseId, lessonId) || typeof input.was !== "string") return { ok: false, reason: "invalid" };
  const text = cleanNote(input.text);
  if (text === null) return { ok: false, reason: "invalid" };
  if (noteLength(text) > MAX_NOTE_CHARS) return { ok: false, reason: "too_long" };
  const roomKey = dataKey(room);
  if (!isRedisConfigured() || !roomKey) return { ok: false, reason: "unknown" };
  const key = notesKey(statsId, learner);
  const field = fieldOf(courseId, lessonId);
  const now = input.now ?? Date.now();
  try {
    const [raw] = exactReplies(await redisPipeline([["HGET", key, field]]), 1, "a student's note");
    if (raw !== null && typeof raw !== "string") return { ok: false, reason: "unknown" };
    const current = raw === null ? null : parseKept(raw);
    // A value that is not a note as saved is never written over: what it held is unknown.
    if (raw !== null && !current) return { ok: false, reason: "unknown" };
    if ((current?.t ?? "") !== input.was) return { ok: false, reason: "changed" };
    if (text === (current?.t ?? "")) return { ok: true, text };
    const json = text === "" ? "" : JSON.stringify({ t: text, at: Math.floor(now / 1000) });
    const content = contentRoomFor(room, now / 1000);
    const [code] = scriptAnswer(
      exactReplies(
        await redisPipeline([
          [
            "EVAL",
            NOTE_SAVE,
            3,
            roomKey,
            key,
            // Without a list, no print is asked for (ARGV[12] ""), and the notes' own key stands in for it.
            input.erasure?.listId ? suppressedKey(input.erasure.listId) : key,
            content,
            monthOf(now),
            field,
            raw ?? "",
            json,
            raw === null ? 0 : noteBytes(field, raw),
            json === "" ? 0 : noteBytes(field, json),
            MAX_NOTES_PER_STUDENT,
            MAX_NOTES_BYTES_PER_STUDENT,
            notesRoomFor(content),
            TALLY_BYTES,
            input.erasure?.listId ? suppressionPrint(input.erasure.listId, input.erasure.email) : "",
            Math.floor(now / 1000),
          ],
        ]),
        1,
        "a saved lesson note",
      )[0],
      "a saved lesson note",
    );
    if (code === 1) return { ok: true, text };
    if (code === 2) return { ok: false, reason: "changed" };
    if (code === 3) return { ok: false, reason: "too_many" };
    if (code === 4) return { ok: false, reason: "mine" };
    if (code === 0 || code === 5) return { ok: false, reason: "full" };
    return { ok: false, reason: "unknown" };
  } catch (error) {
    if (!(error instanceof UnknownReply)) console.error("could not save a lesson note", error);
    return { ok: false, reason: "unknown" };
  }
}

/** A field name a student's hash holds, read exactly: every one a string, or UnknownReply. */
function fieldsOf(reply: unknown): string[] {
  const list = plainList(reply);
  if (!list || list.some((field) => typeof field !== "string")) throw new UnknownReply("a student's notes");
  return list as string[];
}

export type KeptNote = { course: string; lesson: string; text: string; at: number };

/**
 * Every note one student keeps in one store, for their download and their
 * data copy. Throws UnknownReply when a reply is not exactly what was asked,
 * and when the notes weigh more than one student may keep (more than the
 * download paid for: Codex J's review of #3031, M3): nothing past that is
 * read.
 */
export async function notesOf(statsId: string, learner: string): Promise<KeptNote[]> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner)) return [];
  if (!isRedisConfigured()) throw new UnknownReply("a student's notes");
  const key = notesKey(statsId, learner);
  const [listed, tally] = exactReplies(await redisPipeline([["HKEYS", key], ["HGET", key, TALLY]]), 2, "a student's notes");
  const fields = fieldsOf(listed).filter((field) => field !== TALLY);
  const weight = tally === null ? 0 : typeof tally === "string" && /^\d{1,15}$/.test(tally) ? Number(tally) : -1;
  if (weight < 0 || weight > MAX_NOTES_BYTES_PER_STUDENT || fields.length > MAX_NOTES_PER_STUDENT) throw new UnknownReply("a student's notes");
  const out: KeptNote[] = [];
  for (let i = 0; i < fields.length; i += 50) {
    const some = fields.slice(i, i + 50);
    const values = plainList(exactReplies(await redisPipeline([["HMGET", key, ...some]]), 1, "a student's notes")[0]);
    if (!values || values.length !== some.length) throw new UnknownReply("a student's notes");
    some.forEach((field, n) => {
      const raw = values[n];
      // Deleted since the fields were listed.
      if (raw === null) return;
      if (typeof raw !== "string") throw new UnknownReply("a student's notes");
      const match = FIELD_PATTERN.exec(field);
      const kept = parseKept(raw);
      // A value not as saved is still theirs: it is given as it is.
      out.push({ course: match?.[1] ?? field, lesson: match?.[2] ?? "", text: kept?.t ?? raw, at: kept?.at ?? 0 });
    });
  }
  return out;
}

/**
 * Deletes every note one student keeps in one store and gives their weight
 * back to the room, in one step (NOTE_FORGET); how many notes there were.
 * lib/person-erasure.ts writes the person's print before (a save still on
 * its way then writes nothing). Throws
 * UnknownReply when the reply is not exactly what was asked: then nothing is
 * taken for gone.
 */
export async function forgetLessonNotesPerson(statsId: string, learner: string, room: DataStore): Promise<number> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner)) return 0;
  const roomKey = dataKey(room);
  if (!isRedisConfigured() || !roomKey) throw new UnknownReply("a student's notes");
  const now = Date.now();
  const [count, taken] = scriptAnswer(
    exactReplies(
      await redisPipeline([["EVAL", NOTE_FORGET, 2, roomKey, notesKey(statsId, learner), contentRoomFor(room, now / 1000), monthOf(now), TALLY_BYTES]]),
      1,
      "deleted notes",
    )[0],
    "deleted notes",
  );
  // A room whose total could not be read keeps the notes' weight counted: fuller than it is, never storage unpaid.
  if (count < 0 || (taken !== 1 && taken !== -1)) throw new UnknownReply("deleted notes");
  return replyCount(count, "deleted notes");
}

/**
 * A course's notes as the text file a student downloads: the course, the
 * store and the day, then each lesson with a note in the course's order, and
 * last the notes of lessons since taken out of the course.
 */
export function notesAsText(input: {
  words: LessonNotesWords;
  courseTitle: string;
  storeName: string;
  day: string;
  lessons: { id: string; title: string; module: string }[];
  notes: { lesson: string; text: string; at: number }[];
}): string {
  const { words } = input;
  const head = `${words.fileTitle(input.courseTitle)}\n${input.storeName}\n${words.downloaded(input.day)}\n`;
  const byLesson = new Map(input.notes.map((note) => [note.lesson, note]));
  const parts: string[] = [];
  for (const lesson of input.lessons) {
    const note = byLesson.get(lesson.id);
    if (!note) continue;
    byLesson.delete(lesson.id);
    parts.push(`${lesson.module} — ${lesson.title}\n\n${note.text}`);
  }
  for (const note of byLesson.values()) parts.push(`${words.goneLesson}\n\n${note.text}`);
  if (parts.length === 0) return `${head}\n${words.none}\n`;
  return `${head}\n${parts.join("\n\n----------\n\n")}\n`;
}
