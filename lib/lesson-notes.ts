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
 * take at most a tenth of its data room (lib/store-data-rules.ts
 * studentNotesRoomFor; decision C1-20261107-1453-TODOS-9 on Claude 2's ALTO
 * on #3031), one slot (NOTES_SLOT, the room's NOTES_TOTAL_FIELD, which the
 * studio reads) in the store's data room (lib/store-data.ts). Past it a new or
 * longer note is refused as "notes_full" and the notes already kept stay; a
 * shorter or emptied note is always taken, and gives its room back. The rest
 * of the room always stays the creator's, who can neither see nor delete
 * students' notes. A count that cannot be read refuses a new or longer note
 * and never blocks an emptying, and nothing is given back to it: it stays as
 * it is, so it keeps refusing growth (Claude 6's MÉDIO N1 on #3031).
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
import { isRedisConfigured, redisPipeline, redisPipelineBase64 } from "@/lib/redis";
import { type DataStore, NOTES_TOTAL_FIELD, TAKE_DATA, dataKey, monthOf } from "@/lib/store-data";
import { DATA_STEP_BYTES, ENTRY_BYTES, contentRoomFor, dataBytes, studentNotesRoomFor } from "@/lib/store-data-rules";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";
import { COURSE_ID_PATTERN, ITEM_ID_PATTERN } from "@/lib/course";
import { emailKey } from "@/lib/learn";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import type { LessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import {
  MAX_NOTE_CHARS,
  MAX_NOTES_BYTES_PER_STUDENT,
  MAX_NOTES_PER_STUDENT,
  NOTE_DOWNLOAD_UNITS,
  cleanNote,
  noteLength,
} from "@/lib/lesson-notes-rules";

export { MAX_NOTE_CHARS, MAX_NOTES_BYTES_PER_STUDENT, MAX_NOTES_PER_STUDENT, cleanNote, noteLength };

const STATS_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const LEARNER_PATTERN = /^[0-9a-f]{32}$/;
const FIELD_PATTERN = /^([0-9a-f]{32}):([a-z0-9]{12})$/;

const notesKey = (statsId: string, learner: string) => `nl:lnote:${statsId}:${learner}`;
const fieldOf = (courseId: string, lessonId: string) => `${courseId}:${lessonId}`;
/** The field of a student's hash that holds what their notes weigh. */
const TALLY = "#";
/**
 * The one slot of the store's data room every student's notes are counted in, with each student's tally: the room's
 * NOTES_TOTAL_FIELD, which the studio reads as what the students' notes take (lib/store-data.ts dataUsed).
 */
export const NOTES_SLOT = NOTES_TOTAL_FIELD;
/** What a student's tally field takes, counted while they keep a note. */
export const TALLY_BYTES = dataBytes([TALLY, "9999999999"], 1);
/** What one note weighs in the data room: its field, its stored value and its entry. */
const noteBytes = (field: string, value: string) => dataBytes([field, value], 1);

/**
 * The data room's own steps (TAKE_DATA) for the notes' slot, grown or shrunk by `bytes`, inside a script whose KEYS[1]
 * is the room; and the notes' count in it read exactly (noteCount): absent is 0, anything but a whole number is nil.
 * TAKE_DATA reads a slot it cannot read as 0 and deletes it once shrunk to 0, so a count that cannot be read is never
 * given to it: a shortened, emptied or deleted note then gives nothing back, and the count stays as it is, refusing
 * growth (Claude 6's MÉDIO N1 on #3031, comment 6732128148).
 */
const NOTE_ROOM = `local function noteRoom(limit, always, month, bytes)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, always, month, 'a', '${NOTES_SLOT}', bytes}
${TAKE_DATA}
end
local function noteCount()
  local raw = redis.call('HGET', KEYS[1], '${NOTES_SLOT}')
  if not raw then return 0 end
  if raw ~= '0' and not string.match(raw, '^[1-9]%d*$') then return nil end
  return tonumber(raw)
end`;

/**
 * KEYS: the room, the student's notes, the store's prints of deleted people
 * (lib/suppression.ts). ARGV: the room's limit, the month, the field, the
 * value the save read ("" for none), the value to write ("" to delete), what
 * each weighs, the most notes, the most one student's notes weigh, the most
 * all students' notes take, the tally's own weight, the student's print (""
 * for none) and the whole seconds since the save began reading. The second
 * the save started is taken on Redis's own clock (TIME, less those seconds,
 * measured on the instance's monotonic clock), never on an instance's wall
 * clock, which may run ahead (third review of #3031, L1a); the print's own
 * second is on that clock too (lib/suppression.ts ERASED_PRINT, N2b). Answers {1, total}
 * written; {0, total} the room is full; {2, 0} changed, or the person deleted
 * since a second before the save started; {3, 0} one note too many;
 * {4, 0} the student's own weight passed; {5, 0} the notes' share of the room
 * full ("notes_full"); {-1, 0} what it cannot read, the notes' count in the
 * room among it (absent is none yet; anything but a whole number is unknown,
 * never zero). A shorter or emptied note under a count that cannot be read is
 * still written, gives nothing back and leaves the count as it is (it keeps
 * refusing growth; N1): {1, the room's total}. Modelled by lib/redis-memory.ts.
 */
export const NOTE_SAVE = `-- marktmorgen:lesson-note-save:v1
${NOTE_ROOM}
if #KEYS ~= 3 or #ARGV ~= 13 then return {-1, 0} end
local field, seen, json = ARGV[3], ARGV[4], ARGV[5]
local oldB, newB, most, mine, share, tally, since = tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10]), tonumber(ARGV[11]), tonumber(ARGV[13])
if not (oldB and newB and most and mine and share and tally and since) or since < 0 or field == '${TALLY}' or field == '' then return {-1, 0} end
if ARGV[12] ~= '' then
  local erased = redis.call('HGET', KEYS[3], ARGV[12])
  if erased then
    local at = tonumber(erased)
    local start = tonumber(redis.call('TIME')[1]) - since
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
local all = noteCount()
if delta > 0 then
  if now > mine then return {4, 0} end
  if not all then return {-1, 0} end
  if all + delta > share then return {5, 0} end
end
local taken
if all then
  taken = noteRoom(ARGV[1], '0', ARGV[2], tostring(delta))
  if taken[1] ~= 1 then return taken end
else
  taken = {1, tonumber(redis.call('HGET', KEYS[1], '#') or '0') or 0}
end
if json == '' then redis.call('HDEL', KEYS[2], field) else redis.call('HSET', KEYS[2], field, json) end
if now > 0 then redis.call('HSET', KEYS[2], '${TALLY}', tostring(now)) else redis.call('HDEL', KEYS[2], '${TALLY}') end
return taken`;

/**
 * KEYS: the room, the student's notes. ARGV: the room's limit, the month, the
 * tally's own weight. Deletes every note and gives their weight back to the
 * room, in one step. The notes are always deleted: only giving their weight
 * back depends on the tally, and a tally that cannot be read gives nothing
 * back (the room stays fuller than it is, never storage unpaid; third review
 * of #3031, M1), and so does a notes' count in the room that cannot be read,
 * left as it is (N1). Answers {notes deleted, the room's answer, -1 for a weight
 * not given back}, or {-1, 0} for arguments it cannot read (nothing deleted).
 * Modelled by lib/redis-memory.ts.
 */
export const NOTE_FORGET = `-- marktmorgen:lesson-note-forget:v2
${NOTE_ROOM}
if #KEYS ~= 2 or #ARGV ~= 3 then return {-1, 0} end
local tally = tonumber(ARGV[3])
if not tally then return {-1, 0} end
local sum = redis.call('HGET', KEYS[2], '${TALLY}')
local n = redis.call('HLEN', KEYS[2])
if sum then n = n - 1 end
redis.call('DEL', KEYS[2])
if not sum then return {n, 1} end
local had = tonumber(sum)
if not had or had < 0 or had ~= math.floor(had) then return {n, -1} end
if had == 0 then return {n, 1} end
if not noteCount() then return {n, -1} end
local taken = noteRoom(ARGV[1], '1', ARGV[2], tostring(-(had + tally)))
return {n, taken[1]}`;

/**
 * KEYS: the room, the student's notes. ARGV: the room's limit, the month, the
 * course's prefix ("<course>:"), the tally's own weight, and the data room's
 * ENTRY_BYTES and DATA_STEP_BYTES (lib/store-data-rules.ts). Deletes every
 * note the student keeps on that course and gives their weight back, each
 * counted as the save counted it (dataBytes of its field and value; Lua's #
 * counts UTF-8 bytes), in one step: a student may empty their notes also once
 * their access has ended (third review of #3031, M2). The notes are always
 * deleted; their weight is given back only when the tally can be read and
 * holds it, and the notes' count in the room can be read (else the room stays
 * fuller and the count is left as it is, N1). Answers {notes deleted, the room's
 * answer, -1 for a weight not given back}, or {-1, 0} for arguments it cannot
 * read (nothing deleted). Modelled by lib/redis-memory.ts.
 */
export const NOTE_CLEAR = `-- marktmorgen:lesson-note-clear:v1
${NOTE_ROOM}
if #KEYS ~= 2 or #ARGV ~= 6 then return {-1, 0} end
local prefix, tally, entry, step = ARGV[3], tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
if not (tally and entry and step) or step <= 0 or prefix == '' then return {-1, 0} end
local all = redis.call('HGETALL', KEYS[2])
local gone, freed = {}, 0
for i = 1, #all, 2 do
  local f, v = all[i], all[i + 1]
  if f ~= '${TALLY}' and string.sub(f, 1, #prefix) == prefix then
    gone[#gone + 1] = f
    freed = freed + math.ceil((entry + #f + #v) / step) * step
  end
end
if #gone == 0 then return {0, 1} end
for i = 1, #gone, 100 do redis.call('HDEL', KEYS[2], unpack(gone, i, math.min(i + 99, #gone))) end
local sum = redis.call('HGET', KEYS[2], '${TALLY}')
local had = sum and tonumber(sum)
if not had or had < 0 or had ~= math.floor(had) or freed > had then return {#gone, -1} end
local left = had - freed
local back = freed
if left == 0 then
  back = back + tally
  redis.call('HDEL', KEYS[2], '${TALLY}')
else
  redis.call('HSET', KEYS[2], '${TALLY}', tostring(left))
end
if not noteCount() then return {#gone, -1} end
local taken = noteRoom(ARGV[1], '1', ARGV[2], tostring(-back))
return {#gone, taken[1]}`;

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

export type SaveRefusal = "invalid" | "too_long" | "too_many" | "mine" | "notes_full" | "changed" | "full" | "unknown";
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
  // How long the save has been on its way is measured on this instance's monotonic clock; when it started is then
  // read on Redis's own clock, in the script (third review of #3031, L1a).
  const began = performance.now();
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
            studentNotesRoomFor(room, now / 1000),
            TALLY_BYTES,
            input.erasure?.listId ? suppressionPrint(input.erasure.listId, input.erasure.email) : "",
            Math.max(0, Math.ceil((performance.now() - began) / 1000)),
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
    // The students' notes have reached their share of the room (a tenth), or the room itself is full.
    if (code === 5) return { ok: false, reason: "notes_full" };
    if (code === 0) return { ok: false, reason: "full" };
    return { ok: false, reason: "unknown" };
  } catch (error) {
    if (!(error instanceof UnknownReply)) console.error("could not save a lesson note", error);
    return { ok: false, reason: "unknown" };
  }
}

/** A string as redisPipelineBase64 answers it, decoded; UnknownReply for anything that is not base64 text. */
function fromBase64(value: unknown): string {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new UnknownReply("a student's notes");
  return Buffer.from(value, "base64").toString("utf8");
}

const tallyOf = (raw: unknown) => (raw === null || raw === undefined ? 0 : typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : -1);

export type KeptNote = { course: string; lesson: string; text: string; at: number };

/**
 * Every note one student keeps in one store, for their download and their
 * data copy. Throws UnknownReply when a reply is not exactly what was asked,
 * and when the notes weigh more than one student may keep (more than the
 * download paid for: Codex J's review of #3031, M3): nothing past that is
 * read. The notes are read in one HGETALL, one snapshot, asked for in base64,
 * so what crosses is bounded however their text could be escaped
 * (lib/lesson-notes-rules.ts NOTE_DOWNLOAD_READ_BYTES; third review, M3).
 */
export async function notesOf(statsId: string, learner: string): Promise<KeptNote[]> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner)) return [];
  if (!isRedisConfigured()) throw new UnknownReply("a student's notes");
  const key = notesKey(statsId, learner);
  const [count, tally] = exactReplies(await redisPipeline([["HLEN", key], ["HGET", key, TALLY]]), 2, "a student's notes");
  const weight = tallyOf(tally);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new UnknownReply("a student's notes");
  if (weight < 0 || weight > MAX_NOTES_BYTES_PER_STUDENT || count > MAX_NOTES_PER_STUDENT + 1) throw new UnknownReply("a student's notes");
  if (count === 0) return [];
  const flat = plainList(exactReplies(await redisPipelineBase64([["HGETALL", key]]), 1, "a student's notes")[0]);
  if (!flat || flat.length % 2 !== 0 || flat.length > 2 * (MAX_NOTES_PER_STUDENT + 1)) throw new UnknownReply("a student's notes");
  const out: KeptNote[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const field = fromBase64(flat[i]);
    const raw = fromBase64(flat[i + 1]);
    if (field === TALLY) {
      // The snapshot's own tally, read again: a weight past the cap is never taken as read.
      const held = tallyOf(raw);
      if (held < 0 || held > MAX_NOTES_BYTES_PER_STUDENT) throw new UnknownReply("a student's notes");
      continue;
    }
    const match = FIELD_PATTERN.exec(field);
    const kept = parseKept(raw);
    // A value not as saved is still theirs: it is given as it is.
    out.push({ course: match?.[1] ?? field, lesson: match?.[2] ?? "", text: kept?.t ?? raw, at: kept?.at ?? 0 });
  }
  return out;
}

/**
 * The store's public requests a download of a student's notes takes on top
 * of the route's own, before any note is read: the same for any count of
 * notes, since what one student keeps weighs at most
 * MAX_NOTES_BYTES_PER_STUDENT and is read as base64 (lib/lesson-notes-rules.ts
 * NOTE_DOWNLOAD_UNITS, which counts the route's own request too).
 */
export function noteReadUnits(_notes?: number): number {
  return NOTE_DOWNLOAD_UNITS - 1;
}

/**
 * One student's notes on one course, for their download: `admit` is asked
 * for noteReadUnits before anything is read, and nothing is read when it
 * says no (null). The notes are read as notesOf reads them, one snapshot in
 * base64, and the course's kept. Throws UnknownReply when a reply is not
 * exactly what was asked.
 */
export async function courseNotesOf(statsId: string, learner: string, courseId: string, admit: (units: number) => Promise<boolean>): Promise<KeptNote[] | null> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner) || !COURSE_ID_PATTERN.test(courseId)) return [];
  if (!isRedisConfigured()) throw new UnknownReply("a student's notes");
  if (!(await admit(noteReadUnits()))) return null;
  return (await notesOf(statsId, learner)).filter((note) => note.course === courseId);
}

/**
 * How many notes one student keeps on one course (their names only, one
 * HKEYS; no value read). Throws UnknownReply when a reply is not exactly a
 * list of names.
 */
export async function courseNoteCount(statsId: string, learner: string, courseId: string): Promise<number> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner) || !COURSE_ID_PATTERN.test(courseId)) return 0;
  if (!isRedisConfigured()) throw new UnknownReply("a student's notes");
  const list = plainList(exactReplies(await redisPipeline([["HKEYS", notesKey(statsId, learner)]]), 1, "a student's notes")[0]);
  // At most every note and the tally: a longer list is not one a save wrote.
  if (!list || list.length > MAX_NOTES_PER_STUDENT + 1 || list.some((field) => typeof field !== "string")) throw new UnknownReply("a student's notes");
  return (list as string[]).filter((field) => FIELD_PATTERN.exec(field)?.[1] === courseId).length;
}

type NoteAccess = { state: string; learner: { email: string; scope: "all" | string[]; owner: boolean } | null };

/**
 * Whether a course's own page offers the student's kept notes (download, and
 * delete: components/lesson-notes-kept.tsx) once the course is no longer open
 * to them (a refund, an ended membership), where no lesson's box is there to
 * give them: for the student noteReaderOf names, while they keep notes on the
 * course (Claude 4's focal return on #3031, C4-2), so a signed-in visitor who
 * never wrote one there is offered nothing (third review, M4). Counting them
 * is one of the store's public requests, asked by `admit` before anything is
 * read. When it is refused or the count cannot be read, they are offered:
 * not knowing is not "no notes", and the download says so itself if it
 * cannot read them.
 */
export async function notesDownloadAfterAccess(statsId: string, access: NoteAccess, courseId: string, admit: () => Promise<boolean>): Promise<boolean> {
  if (access.state === "open") return false;
  const who = noteReaderOf(access, courseId);
  if (!who) return false;
  if (!(await admit())) return true;
  try {
    return (await courseNoteCount(statsId, who, courseId)) > 0;
  } catch {
    return true;
  }
}

/**
 * Whose notes a download or a course's deletion may touch: the student signed
 * in with the address they took the course with (or to Marktmorgen with it),
 * whether or not the course is still open to them (a refund, an ended
 * membership); never the creator, never a visitor, never during a preview.
 * Their own notes only, by their own key.
 */
export function noteReaderOf(access: NoteAccess, courseId: string): string | null {
  const learner = access.learner;
  if (!learner || learner.owner || access.state === "preview") return null;
  if (learner.scope !== "all" && !learner.scope.includes(courseId)) return null;
  return emailKey(learner.email);
}

/**
 * Deletes every note one student keeps on one course and gives their weight
 * back to the room, in one step (NOTE_CLEAR): what a student whose access to
 * the course ended can still do, as they can still download them (third
 * review of #3031, M2). How many notes were deleted. Throws UnknownReply when
 * the reply is not exactly what was asked: then nothing is taken for gone.
 */
export async function clearCourseNotes(statsId: string, learner: string, courseId: string, room: DataStore): Promise<number> {
  if (!STATS_PATTERN.test(statsId) || !LEARNER_PATTERN.test(learner) || !COURSE_ID_PATTERN.test(courseId)) return 0;
  const roomKey = dataKey(room);
  if (!isRedisConfigured() || !roomKey) throw new UnknownReply("a course's notes");
  const now = Date.now();
  const [count, taken] = scriptAnswer(
    exactReplies(
      await redisPipeline([
        [
          "EVAL",
          NOTE_CLEAR,
          2,
          roomKey,
          notesKey(statsId, learner),
          contentRoomFor(room, now / 1000),
          monthOf(now),
          `${courseId}:`,
          TALLY_BYTES,
          ENTRY_BYTES,
          DATA_STEP_BYTES,
        ],
      ]),
      1,
      "a course's deleted notes",
    )[0],
    "a course's deleted notes",
  );
  // A weight that could not be read or given back stays counted: fuller than it is, never storage unpaid.
  if (count < 0 || (taken !== 1 && taken !== -1)) throw new UnknownReply("a course's deleted notes");
  return replyCount(count, "a course's deleted notes");
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
  // A room whose total, or a tally that, could not be read keeps the notes' weight counted: fuller than it is, never
  // storage unpaid. The notes themselves are deleted either way (third review of #3031, M1).
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
