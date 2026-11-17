/**
 * A quick rating of each lesson (296 [SQ7], unit 1; added 12 November 2026):
 * at the end of a lesson a student may give it 1 to 5 and, if they like, a
 * comment; the creator sees, per lesson, the average, how the ratings spread
 * and the comments. Pure rules, with no storage and no page yet: what a rating
 * is, how one is cleaned, what the creator is shown, and the most one rating
 * can take to keep, for the plan's worst case.
 *
 *   - One rating per student per lesson: a newer one replaces the older
 *     (`latestPerStudent`), so a student can change their mind.
 *   - Private: the summary is for the store's own team. It holds no name or
 *     address, and nothing here is ever shown to other students or used as
 *     social proof (the item forbids both).
 *   - The comment is cleaned like every text a student sends
 *     (lib/community-text.ts, cleanText), and cut at RATING_COMMENT_MAX.
 */
import { cleanText } from "@/lib/community-text";

export const RATING_MIN = 1;
export const RATING_MAX = 5;
/** The longest comment kept with a rating, in UTF-16 code units. */
export const RATING_COMMENT_MAX = 500;
/** The most comments the summary lists for one lesson, newest first; the rest are counted. */
export const RATING_COMMENTS_SHOWN = 50;

/** One student's rating of one lesson. `who` is the course's own key for the student (never their address); `at` is in seconds. */
export type LessonRating = { who: string; score: number; comment: string; at: number };

/** A rating as the student sent it, cleaned; null when the score is not a whole number from RATING_MIN to RATING_MAX. */
export function cleanRating(score: unknown, comment: unknown): { score: number; comment: string } | null {
  const n = typeof score === "string" && /^\d$/.test(score.trim()) ? Number(score.trim()) : score;
  if (typeof n !== "number" || !Number.isInteger(n) || n < RATING_MIN || n > RATING_MAX) return null;
  // A lone half of a surrogate pair is not text, and JSON would keep it as six bytes: it becomes U+FFFD.
  return { score: n, comment: cleanText(comment, RATING_COMMENT_MAX).toWellFormed() };
}

/** Each student's latest rating only, so changing one's mind replaces, never adds. */
export function latestPerStudent(ratings: readonly LessonRating[]): LessonRating[] {
  const latest = new Map<string, LessonRating>();
  for (const r of ratings) {
    const kept = latest.get(r.who);
    if (!kept || r.at >= kept.at) latest.set(r.who, r);
  }
  return [...latest.values()];
}

export type RatingSummary = {
  count: number;
  /** The average to one decimal, or null with no rating. */
  average: number | null;
  /** How many gave 1, 2, 3, 4 and 5, in that order. */
  spread: [number, number, number, number, number];
  /** Comments, newest first, at most RATING_COMMENTS_SHOWN, each with its score and time and nothing about who wrote it. */
  comments: { score: number; comment: string; at: number }[];
  /** Comments not listed. */
  moreComments: number;
};

/** What the creator is shown for one lesson. */
export function ratingSummary(ratings: readonly LessonRating[]): RatingSummary {
  const latest = latestPerStudent(ratings).filter((r) => Number.isInteger(r.score) && r.score >= RATING_MIN && r.score <= RATING_MAX);
  const spread: RatingSummary["spread"] = [0, 0, 0, 0, 0];
  for (const r of latest) spread[r.score - 1] += 1;
  const total = latest.reduce((sum, r) => sum + r.score, 0);
  const written = latest.filter((r) => r.comment.trim()).sort((a, b) => b.at - a.at);
  return {
    count: latest.length,
    average: latest.length ? Math.round((total / latest.length) * 10) / 10 : null,
    spread,
    comments: written.slice(0, RATING_COMMENTS_SHOWN).map(({ score, comment, at }) => ({ score, comment, at })),
    moreComments: Math.max(0, written.length - RATING_COMMENTS_SHOWN),
  };
}

/**
 * The most bytes one rating can take to keep, as JSON in UTF-8. A comment is
 * well formed (cleanRating), so each of its UTF-16 code units costs at most
 * three bytes: a character from U+0800 to U+FFFF, such as "€", is three bytes
 * for one unit; a quotation mark or a backslash, escaped, two; a character
 * past U+FFFF, four bytes for two units. Then the longest key and the largest
 * numbers. The plan's worst case multiplies this by its students and lessons;
 * the storage that unit adds must stay inside it.
 */
export function ratingRecordMaxBytes(whoMax: number): number {
  const record: LessonRating = { who: "w".repeat(whoMax), score: RATING_MAX, comment: "", at: 9_999_999_999 };
  return new TextEncoder().encode(JSON.stringify(record)).length + RATING_COMMENT_MAX * 3;
}
