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
/** All students' notes in one store take at most one part in this many of the store's content room; the rest always stays the creator's. */
export const NOTES_ROOM_PARTS = 5;

/** How much of a store's content room (lib/store-data-rules.ts contentRoomFor) its students' notes may take together, in bytes. */
export function notesRoomFor(contentRoom: number): number {
  return Number.isFinite(contentRoom) && contentRoom > 0 ? Math.floor(contentRoom / NOTES_ROOM_PARTS) : 0;
}

/**
 * The store's public requests one download of a student's notes takes,
 * before it reads them (Codex J's review of #3031, M3): one for the request
 * itself, and one for each 64 KiB it may read, the bytes one public request
 * pays for reading (lib/public-read-rules.ts AFFILIATE_LOAD_BYTES_PER_UNIT).
 * It reads at most what one student keeps (MAX_NOTES_BYTES_PER_STUDENT, or
 * the read is refused), and Redis's JSON answer may escape each byte of a
 * note's stored JSON once more: twice that, at the most.
 */
export const NOTE_DOWNLOAD_BYTES_PER_UNIT = 65_536;
export const NOTE_DOWNLOAD_UNITS = 1 + Math.ceil((2 * MAX_NOTES_BYTES_PER_STUDENT) / NOTE_DOWNLOAD_BYTES_PER_UNIT);

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
