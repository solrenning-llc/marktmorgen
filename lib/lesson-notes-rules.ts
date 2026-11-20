/**
 * The caps of a student's private lesson notes (290 [SQ1]) and how a note
 * is counted and cleaned, with nothing the browser cannot load: the box on
 * the lesson page (components/lesson-notes.tsx) and the server
 * (lib/lesson-notes.ts) count the same way.
 */

/** The most characters one note holds (as people count them: an emoji is one). */
export const MAX_NOTE_CHARS = 4_000;
/** The most notes one student keeps in one store, across its courses. */
export const MAX_NOTES_PER_STUDENT = 300;
/**
 * The most one student's notes in one store weigh together, as the store's
 * data room counts them (lib/store-data-rules.ts dataBytes: each note's
 * lesson, text and time, and its entry): 256 KiB, about sixty full notes of
 * plain text, or three hundred of some eight hundred characters. A store's
 * room is the creator's (Claude 2's review of #3031, ALTO): no student may
 * take more than a sliver of it.
 */
export const MAX_NOTES_BYTES_PER_STUDENT = 262_144;
/*
 * All students' notes in one store take at most a tenth of its data room
 * (lib/store-data-rules.ts studentNotesRoomFor, decision
 * C1-20261107-1453-TODOS-9); the rest always stays the creator's. That tenth
 * replaced the fifth of the content room this file first held: on every
 * plan it is the smaller.
 */

/**
 * The store's public requests one download of a student's notes takes,
 * before it reads them (Codex J's review of #3031, M3): one for the request
 * itself, and one for each 64 KiB it may read, the bytes one public request
 * pays for reading (lib/public-read-rules.ts AFFILIATE_LOAD_BYTES_PER_UNIT).
 *
 * The notes are read in one HGETALL, asked for in base64 (lib/redis.ts
 * redisPipelineBase64), so how the reply's text could be escaped no longer
 * matters (third review of #3031, M3: an encoder escaping < > & as \u003c
 * made each byte six): every string crosses as base64, 4 bytes for each 3,
 * at most NOTE_BASE64_ROOM more for its padding, its quotes and its comma.
 * One HGETALL is one snapshot, and every save keeps what a student's notes
 * weigh (each note's lesson and stored value, counted by the tally) at most
 * MAX_NOTES_BYTES_PER_STUDENT; it holds at most MAX_NOTES_PER_STUDENT notes
 * and the tally, two strings each. NOTE_DOWNLOAD_FIXED_BYTES holds the
 * tally's own field and value, the count read before it and every reply's
 * brackets.
 */
export const NOTE_DOWNLOAD_BYTES_PER_UNIT = 65_536;
export const NOTE_BASE64_ROOM = 6;
export const NOTE_DOWNLOAD_FIXED_BYTES = 1_024;
export const NOTE_DOWNLOAD_READ_BYTES =
  Math.ceil((4 * MAX_NOTES_BYTES_PER_STUDENT) / 3) + 2 * (MAX_NOTES_PER_STUDENT + 1) * NOTE_BASE64_ROOM + NOTE_DOWNLOAD_FIXED_BYTES;
export const NOTE_DOWNLOAD_UNITS = 1 + Math.ceil(NOTE_DOWNLOAD_READ_BYTES / NOTE_DOWNLOAD_BYTES_PER_UNIT);

/**
 * Whether a student may change their note on a lesson: write it only while
 * the lesson is open to them, empty it at any time, also once their access
 * has ended, since their notes still count against the store's caps (third
 * review of #3031, M2). Never writes without access.
 */
export function mayChangeNote(lessonOpen: boolean, text: string): boolean {
  return lessonOpen || text === "";
}

/** Characters as people count them: code points, so "é🙂a" is three. */
export function noteLength(text: string): number {
  return Array.from(text).length;
}

/** A note as kept: line breaks as "\n", no control characters but tabs and line breaks, nothing trailing. */
export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+$/, "");
}
