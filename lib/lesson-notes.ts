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
 * never overwrites a newer note. Two saves of one note in the same instant
 * may still both pass that check; the later one is kept, and the room's slot
 * stays at most one note off until the next save sets it again.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";
import { COURSE_ID_PATTERN, ITEM_ID_PATTERN } from "@/lib/course";
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
  try {
    const [count, raw] = exactReplies(await redisPipeline([["HLEN", key], ["HGET", key, field]]), 2, "a student's notes");
    const kept = replyCount(count, "a student's note count");
    if (raw !== null && typeof raw !== "string") return { ok: false, reason: "unknown" };
    const current = raw === null ? null : parseKept(raw);
    // A value that is not a note as saved is never written over: what it held is unknown.
    if (raw !== null && !current) return { ok: false, reason: "unknown" };
    if ((current?.t ?? "") !== input.was) return { ok: false, reason: "changed" };
    if (text === (current?.t ?? "")) return { ok: true, text };
    if (text === "") {
      const [gone] = exactReplies(await redisPipeline([["HDEL", key, field]]), 1, "a deleted lesson note");
      replyCount(gone, "a deleted lesson note");
      await giveData(room, [{ slot, bytes: 0, set: true }], now);
      return { ok: true, text };
    }
    if (!current && kept >= MAX_NOTES_PER_STUDENT) return { ok: false, reason: "too_many" };
    const json = JSON.stringify({ t: text, at: Math.floor(now / 1000) });
    const taken = await takeData(room, [{ slot, bytes: dataBytes([field, json], 1), set: true }], now);
    if (!taken.ok) return taken.reason === "full" ? { ok: false, reason: "full", message: taken.message } : { ok: false, reason: "unknown" };
    const [written] = exactReplies(await redisPipeline([["HSET", key, field, json]]), 1, "a saved lesson note");
    // HSET answers how many fields it added: 1 for a new note, 0 for one changed.
    if (replyCount(written, "a saved lesson note") > 1) return { ok: false, reason: "unknown" };
    return { ok: true, text };
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
 * data copy. Throws UnknownReply when a reply is not exactly what was asked.
 */
export async function notesOf(statsId: string, learner: string): Promise<KeptNote[]> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner)) return [];
  if (!isRedisConfigured()) throw new UnknownReply("a student's notes");
  const key = notesKey(statsId, learner);
  const fields = fieldsOf(exactReplies(await redisPipeline([["HKEYS", key]]), 1, "a student's notes")[0]);
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
 * Deletes every note one student keeps in one store, and gives back their
 * room; how many there were. Throws UnknownReply when a reply is not exactly
 * what was asked: then nothing is taken for gone and no room is given back.
 */
export async function forgetLessonNotesPerson(statsId: string, learner: string, room: DataStore): Promise<number> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner)) return 0;
  if (!isRedisConfigured()) throw new UnknownReply("a student's notes");
  const key = notesKey(statsId, learner);
  const fields = fieldsOf(exactReplies(await redisPipeline([["HKEYS", key]]), 1, "a student's notes")[0]);
  if (fields.length === 0) return 0;
  replyCount(exactReplies(await redisPipeline([["DEL", key]]), 1, "deleted notes")[0], "deleted notes");
  // A field not named as this file names them never had a slot: nothing is given back for it.
  const slots = fields.filter((field) => FIELD_PATTERN.test(field)).map((field) => slotOf(learner, field));
  for (let i = 0; i < slots.length; i += 100) await giveData(room, slots.slice(i, i + 100).map((slot) => ({ slot, bytes: 0, set: true })));
  return fields.length;
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
