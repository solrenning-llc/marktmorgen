/**
 * "Find a lesson" on a course's page (291 [SQ2], unit 1; added 12 November
 * 2026): the student types and the course's outline keeps only the lessons
 * whose title, or whose module's title, holds every word typed. It reads only
 * what the page already drew, so it costs no request and no index; titles are
 * already public on the course page. Pure rules, used by the outline (each
 * lesson's words) and by the box (the match).
 *
 * Matching ignores letter case, accents and punctuation, so "Lecon" finds
 * "Leçon 2" and "q&a" finds "Q & A". Searching inside lessons' words and
 * transcripts, and jumping to a moment in a video, are later units of SQ2.
 */

/** The box is offered from this many lessons: in a shorter course the outline is read at a glance. */
export const FIND_MIN_LESSONS = 8;
/** The longest query read; anything after it is ignored. */
export const FIND_MAX_CHARS = 80;

/** Text reduced to what matching compares: lower case, no accents, letters and digits split by single spaces. */
export function findKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The words of a query, at most FIND_MAX_CHARS of it. */
export const queryWords = (query: string) => findKey(query.slice(0, FIND_MAX_CHARS)).split(" ").filter(Boolean);

/** Whether a lesson's words (already findKey'd) hold every word of the query, each as the start of a word. */
export function lessonMatches(words: readonly string[], key: string): boolean {
  if (!words.length) return true;
  const parts = key.split(" ");
  return words.every((word) => parts.some((part) => part.startsWith(word)));
}
