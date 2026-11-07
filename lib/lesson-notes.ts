/**
 * A student's private notes on a course's lessons (290 [SQ1]).
 *
 *   nl:lnote:<store statsId>:<student key>   hash   "<course>:<lesson>" → {"t": text, "at": seconds}
 *
 * Only the student who wrote a note reads it: the hash is named by their own
 * key (lib/learn.ts emailKey, made from the address of the session that
 * opened the course, never from anything the browser sends), and nothing in
 * the studio or anywhere a creator or another student looks reads it. The
 * student can download the notes of a course as a text file
 * (app/api/store/course/note), and deleting the person deletes them all
 * (lib/person-erasure.ts); their data copy holds them (lib/person-copy.ts).
 * The hash is named by the store's statsId, one of the ids a closed store's
 * keys are erased by (lib/closed-store-data.ts).
 *
 * Caps, checked before anything is written: a note holds at most
 * MAX_NOTE_CHARS characters, and one student keeps at most
 * MAX_NOTES_PER_STUDENT notes in one store. Every note takes its room in the
 * store's data room (lib/store-data.ts), one slot a note set to what it
 * weighs, so storage is paid by the plan's room and an emptied note gives all
 * of it back.
 *
 * Unknown is closed. A note whose stored value is not one as saved, or a
 * reply of another shape, reads as "unknown": the lesson page then says the
 * note could not be loaded and gives no box to type over it, and a save is
 * refused. A save also names the note it started from (`was`) and is refused
 * as "changed" when that is no longer what is kept, so a tab opened earlier
 * never overwrites a newer note.
 *
 * One step (SAVE_NOTE, reviews of #3031): the check that the note is still
 * the one read, the count of the student's notes, the note's room and its
 * write happen in one script, so two saves of one note never both pass, two
 * new notes never share the last place, and a note is never written without
 * its slot. Deleting the person (FORGET_NOTES) deletes the hash and empties
 * every slot in one script too, so a save that read the note before it
 * never writes it back after it.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, TAKE_DATA, dataKey, dataTakenOf, monthOf } from "@/lib/store-data";
import { contentRoomFor, dataBytes } from "@/lib/store-data-rules";
import { UnknownReply, exactReplies, plainList } from "@/lib/redis-exact";
import { COURSE_ID_PATTERN, ITEM_ID_PATTERN } from "@/lib/course";
import { emailKey } from "@/lib/learn";
import type { LessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import { MAX_NOTE_CHARS, MAX_NOTES_PER_STUDENT, cleanNote, noteLength } from "@/lib/lesson-notes-rules";

export { MAX_NOTE_CHARS, MAX_NOTES_PER_STUDENT, cleanNote, noteLength };

const STATS_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const LEARNER_PATTERN = /^[0-9a-f]{32}$/;
const FIELD_PATTERN = /^([0-9a-f]{32}):([a-z0-9]{12})$/;

const notesKey = (statsId: string, learner: string) => `nl:lnote:${statsId}:${learner}`;
const fieldOf = (courseId: string, lessonId: string) => `${courseId}:${lessonId}`;
/** A note's slot in the store's data room. */
const slotOf = (learner: string, field: string) => `ln:${learner}:${field}`;

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

export type SaveRefusal = "invalid" | "too_long" | "too_many" | "changed" | "full" | "unknown";
export type SaveResult = { ok: true; text: string } | { ok: false; reason: SaveRefusal; message?: string };

/**
 * Saves (or, with empty text, deletes) one student's note on one lesson,
 * starting from `was`, the note as the student's page last read it ("" for
 * none). Its size and the student's count are checked, and its room taken,
 * before it is written.
 */
export async function saveNote(input: {
  statsId: string;
  learner: string;
  courseId: string;
  lessonId: string;
  text: unknown;
  was: unknown;
  room: DataStore;
  now?: number;
}): Promise<SaveResult> {
  const { statsId, learner, courseId, lessonId, room } = input;
  if (!validIds(statsId, learner, courseId, lessonId) || typeof input.was !== "string") return { ok: false, reason: "invalid" };
  const text = cleanNote(input.text);
  if (text === null) return { ok: false, reason: "invalid" };
  if (noteLength(text) > MAX_NOTE_CHARS) return { ok: false, reason: "too_long" };
  if (!isRedisConfigured()) return { ok: false, reason: "unknown" };
  const key = notesKey(statsId, learner);
  const field = fieldOf(courseId, lessonId);
  const slot = slotOf(learner, field);
  const now = input.now ?? Date.now();
  const roomKey = dataKey(room);
  if (!roomKey) return { ok: false, reason: "unknown" };
  try {
    const [raw] = exactReplies(await redisPipeline([["HGET", key, field]]), 1, "a student's note");
    if (raw !== null && typeof raw !== "string") return { ok: false, reason: "unknown" };
    const current = raw === null ? null : parseKept(raw);
    // A value that is not a note as saved is never written over: what it held is unknown.
    if (raw !== null && !current) return { ok: false, reason: "unknown" };
    if ((current?.t ?? "") !== input.was) return { ok: false, reason: "changed" };
    if (text === (current?.t ?? "")) return { ok: true, text };
    const json = text === "" ? "" : JSON.stringify({ t: text, at: Math.floor(now / 1000) });
    const size = text === "" ? 0 : dataBytes([field, json], 1);
    // The note is written (or deleted) only while it is still exactly the one read here, in the same step as its room.
    const [reply] = await redisPipeline([[
      "EVAL", SAVE_NOTE, 2, roomKey, key,
      contentRoomFor(room, now / 1000), monthOf(now), field, slot, size, raw === null ? "0" : "1", raw ?? "", json, MAX_NOTES_PER_STUDENT,
    ]]);
    if (Array.isArray(reply) && reply.length === 2 && reply[1] === 0 && (reply[0] === 2 || reply[0] === 3)) {
      return { ok: false, reason: reply[0] === 2 ? "changed" : "too_many" };
    }
    const taken = dataTakenOf(room, reply, now / 1000);
    if (taken.ok) return { ok: true, text };
    return taken.reason === "full" && text !== "" ? { ok: false, reason: "full", message: taken.message } : { ok: false, reason: "unknown" };
  } catch (error) {
    if (!(error instanceof UnknownReply)) console.error("could not save a lesson note", error);
    return { ok: false, reason: "unknown" };
  }
}

/** The data room's own steps (TAKE_DATA) for one slot set to `size`, inside a script whose KEYS[1] is the room. */
const NOTE_ROOM = `local function noteRoom(limit, always, month, changes)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, always, month}
  for _, v in ipairs(changes) do ARGV[#ARGV + 1] = v end
${TAKE_DATA}
end`;

/**
 * KEYS[1] the store's room, KEYS[2] the student's notes. ARGV[1] how far the
 * room may grow, ARGV[2] this month, ARGV[3] the note's field, ARGV[4] its
 * slot, ARGV[5] its size, ARGV[6] "1" when a note was read and "0" for none,
 * ARGV[7] the value read, ARGV[8] the new value ("" deletes the note),
 * ARGV[9] the most notes a student keeps. Answers {2, 0} when the note is no
 * longer the one read, {3, 0} when a new note would pass the most, or the
 * room's answer: {1, total} written, {0, total} full (nothing written),
 * {-1, total} unknown. Modelled by lib/redis-memory.ts.
 */
export const SAVE_NOTE = `-- marktmorgen:lesson-note-save:v1
${NOTE_ROOM}
local held = redis.call('HGET', KEYS[2], ARGV[3])
if ARGV[6] == '1' then
  if held ~= ARGV[7] then return {2, 0} end
elseif held then
  return {2, 0}
end
if ARGV[8] == '' then
  if held then redis.call('HDEL', KEYS[2], ARGV[3]) end
  return noteRoom(ARGV[1], '1', ARGV[2], {'s', ARGV[4], '0'})
end
if not held and redis.call('HLEN', KEYS[2]) >= tonumber(ARGV[9]) then return {3, 0} end
local taken = noteRoom(ARGV[1], '0', ARGV[2], {'s', ARGV[4], ARGV[5]})
if taken[1] ~= 1 then return taken end
redis.call('HSET', KEYS[2], ARGV[3], ARGV[8])
return taken`;

/**
 * KEYS[1] the store's room, KEYS[2] the student's notes. ARGV[1] how far the
 * room may grow, ARGV[2] this month, ARGV[3] the start of the student's
 * slots ("ln:<student>:"). Deletes the notes and sets the slot of every note
 * named as this file names them to nothing, in one step. Answers {notes
 * deleted, then the room's answer}. Modelled by lib/redis-memory.ts.
 */
export const FORGET_NOTES = `-- marktmorgen:lesson-note-forget:v1
${NOTE_ROOM}
local fields = redis.call('HKEYS', KEYS[2])
if #fields == 0 then return {0, 1, 0} end
redis.call('DEL', KEYS[2])
local changes = {}
for _, f in ipairs(fields) do
  if #f == 45 and string.match(f, '^[0-9a-f]+:[a-z0-9]+$') and string.sub(f, 33, 33) == ':' then
    changes[#changes + 1] = 's'
    changes[#changes + 1] = ARGV[3] .. f
    changes[#changes + 1] = '0'
  end
end
local taken = {1, 0}
if #changes > 0 then taken = noteRoom(ARGV[1], '1', ARGV[2], changes) end
return {#fields, taken[1], taken[2]}`;

/** A field name a student's hash holds, read exactly: every one a string, or UnknownReply. */
function fieldsOf(reply: unknown): string[] {
  const list = plainList(reply);
  if (!list || list.some((field) => typeof field !== "string")) throw new UnknownReply("a student's notes");
  return list as string[];
}

export type KeptNote = { course: string; lesson: string; text: string; at: number };

/** The notes of the fields listed, fifty to a command; a field deleted since it was listed is left out. */
async function notesAt(key: string, fields: string[]): Promise<KeptNote[]> {
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
 * Every note one student keeps in one store, for their data copy. Throws
 * UnknownReply when a reply is not exactly what was asked.
 */
export async function notesOf(statsId: string, learner: string): Promise<KeptNote[]> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner)) return [];
  if (!isRedisConfigured()) throw new UnknownReply("a student's notes");
  const key = notesKey(statsId, learner);
  return notesAt(key, fieldsOf(exactReplies(await redisPipeline([["HKEYS", key]]), 1, "a student's notes")[0]));
}

/**
 * The most bytes one note's value is kept at: each character at six (a lone
 * surrogate, which JSON writes as \uXXXX, is the longest), and its time.
 */
export const MAX_NOTE_VALUE_BYTES = MAX_NOTE_CHARS * 6 + 64;
/**
 * Notes of a course one of the store's public requests pays for in a
 * download, each read at MAX_NOTE_VALUE_BYTES and sent with its lesson's
 * titles, with the list of the student's notes read first
 * (tests/sq1-lesson-notes-review.test.ts prices it with the registry's rates).
 */
export const NOTES_PER_READ_UNIT = 16;

/** The public requests a download of `notes` notes takes, on top of the route's own, before their values are read; one at the least, for the list. */
export function noteReadUnits(notes: number): number {
  return Math.max(1, Math.ceil(Math.max(0, Math.floor(notes)) / NOTES_PER_READ_UNIT));
}

/**
 * One student's notes on one course, for their download: the list of their
 * notes is read, then `admit` is asked for noteReadUnits of the course's
 * notes before any of them is read; null when it says no. Throws
 * UnknownReply when a reply is not exactly what was asked.
 */
export async function courseNotesOf(statsId: string, learner: string, courseId: string, admit: (units: number) => Promise<boolean>): Promise<KeptNote[] | null> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner) || !COURSE_ID_PATTERN.test(courseId)) return [];
  if (!isRedisConfigured()) throw new UnknownReply("a student's notes");
  const key = notesKey(statsId, learner);
  const fields = fieldsOf(exactReplies(await redisPipeline([["HKEYS", key]]), 1, "a student's notes")[0]).filter((field) => FIELD_PATTERN.exec(field)?.[1] === courseId);
  if (!(await admit(noteReadUnits(fields.length)))) return null;
  return notesAt(key, fields);
}

/**
 * Whose notes a download may read: the student signed in with the address
 * they took the course with (or to Marktmorgen with it), whether or not the
 * course is still open to them (a refund, an ended membership); never the
 * creator, never a visitor. Their own notes only, by their own key.
 */
export function noteReaderOf(access: { state: string; learner: { email: string; scope: "all" | string[]; owner: boolean } | null }, courseId: string): string | null {
  const learner = access.learner;
  if (!learner || learner.owner || access.state === "preview") return null;
  if (learner.scope !== "all" && !learner.scope.includes(courseId)) return null;
  return emailKey(learner.email);
}

/**
 * Deletes every note one student keeps in one store, and gives back their
 * room, in one step (FORGET_NOTES); how many there were. Throws UnknownReply
 * when a reply is not exactly what was asked: then nothing is taken for gone.
 */
export async function forgetLessonNotesPerson(statsId: string, learner: string, room: DataStore): Promise<number> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner)) return 0;
  const roomKey = dataKey(room);
  if (!isRedisConfigured() || !roomKey) throw new UnknownReply("a student's notes");
  const key = notesKey(statsId, learner);
  const fields = fieldsOf(exactReplies(await redisPipeline([["HKEYS", key]]), 1, "a student's notes")[0]);
  if (fields.length === 0) return 0;
  const now = Date.now();
  const [reply] = exactReplies(await redisPipeline([["EVAL", FORGET_NOTES, 2, roomKey, key, contentRoomFor(room, now / 1000), monthOf(now), slotOf(learner, "")]]), 1, "deleted notes");
  // {notes deleted, 1, total}: a room that always takes a deletion answers 1; anything else is not a receipt.
  const exact = Array.isArray(reply) && reply.length === 3 && reply.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) && reply[1] === 1;
  if (!exact) throw new UnknownReply("deleted notes");
  return reply[0] as number;
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
