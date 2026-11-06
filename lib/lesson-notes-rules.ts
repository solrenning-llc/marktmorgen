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
