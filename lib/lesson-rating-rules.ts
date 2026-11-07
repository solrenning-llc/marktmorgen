/**
 * A student's quick rating of a lesson (296 [SQ7]), as rules the browser can
 * read too. The part that keeps them is lib/lesson-rating.ts.
 *
 * At the end of a lesson a student may give it 1 to 5, with a short comment
 * if they want. Each student rates each lesson once and can change or remove
 * it. Ratings are private: only the store's owner sees them, as an average,
 * the count of each score and the comments, without names or addresses. They
 * are never shown to other students or on any public page, so they are never
 * social proof.
 */
import { cleanText } from "@/lib/community-text";
import { dataBytesOfLength } from "@/lib/store-data-rules";

export type RatingScore = 1 | 2 | 3 | 4 | 5;
export const RATING_SCORES: readonly RatingScore[] = [1, 2, 3, 4, 5];

/** The longest comment with a rating, in characters. */
export const MAX_RATING_NOTE = 300;
/** Students one lesson keeps a rating from; past it a new one is refused, a change is not. */
export const MAX_LESSON_RATINGS = 1_000;
/** Ratings (and removals) one person may send in a minute, and in a day, on one store. */
export const RATINGS_PER_MINUTE = 5;
export const RATINGS_PER_DAY = 60;

/** A student's key (lib/learn.ts emailKey) and a lesson id, at their longest. */
const WHO_BYTES = 32;
const LESSON_BYTES = 20;
/** `{"s":5,"t":"","a":}` and a time in seconds of up to twelve digits. */
const RECORD_FRAME_BYTES = 31;
/**
 * The most bytes one kept rating can be, its student's key and its record:
 * each character of a comment is at most three bytes once lone halves of a
 * character are dropped (cleanNote), an escaped quote or line break two.
 */
export const RATING_ENTRY_MAX_BYTES = WHO_BYTES + RECORD_FRAME_BYTES + 3 * MAX_RATING_NOTE;
/**
 * What the store's data room (lib/store-data.ts) is charged for one rating,
 * whatever its size: the entry under the lesson and the lesson's place in the
 * course's list of rated lessons. Charged before it is written, once per
 * student and lesson; a change is not charged again.
 */
export const RATING_ROOM_BYTES = dataBytesOfLength(RATING_ENTRY_MAX_BYTES + LESSON_BYTES, 2);

/**
 * The bytes of ratings one studio request pays for (lib/studio-route.ts
 * countStudio): less than the 50 KB a studio request is priced with
 * (tests/plan-cost-registry.ts, UNIT_COST.studio), so the read's own frame fits.
 */
export const RATING_READ_BYTES_PER_UNIT = 40_000;
/** Ratings that may come in between counting them and reading them; past it the read is refused. */
export const RATING_READ_SLACK = 20;

/** The studio requests that reading `count` ratings at their largest takes. */
export function ratingReadUnits(count: number): number {
  const n = Math.max(0, Math.min(MAX_LESSON_RATINGS, Math.floor(count)));
  return Math.max(1, Math.ceil((n * RATING_ENTRY_MAX_BYTES) / RATING_READ_BYTES_PER_UNIT));
}

export type LessonRating = { score: RatingScore; note: string; /** Seconds. */ at: number };

/** A score from a form or a stored record, or null when it is not a whole 1 to 5. */
export function parseScore(raw: unknown): RatingScore | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^[1-5]$/.test(text)) return null;
  return Number(text) as RatingScore;
}

/** Lone halves of a character: JSON writes each as six bytes, and they draw nothing. */
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A comment as it is kept: clean text, at most MAX_RATING_NOTE characters, no lone halves. */
export function cleanNote(raw: unknown): string {
  return cleanText(raw, MAX_RATING_NOTE).replace(LONE_HALF, "").trim();
}

export function serializeRating(rating: LessonRating): string {
  return JSON.stringify({ s: rating.score, t: rating.note, a: rating.at });
}

/** Reads one kept rating, or null when it is not one. */
export function parseRating(raw: unknown): LessonRating | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const record = v as Record<string, unknown>;
    const score = Object.hasOwn(record, "s") ? parseScore(record.s) : null;
    if (score === null || typeof record.s !== "number") return null;
    if (!Object.hasOwn(record, "t") || typeof record.t !== "string" || record.t.length > MAX_RATING_NOTE) return null;
    if (!Object.hasOwn(record, "a") || typeof record.a !== "number" || !Number.isSafeInteger(record.a) || record.a < 0) return null;
    return { score, note: record.t, at: record.a };
  } catch {
    return null;
  }
}

export type RatingSummary = {
  count: number;
  /** The mean score, or null with no ratings. */
  average: number | null;
  /** How many gave 1, 2, 3, 4 and 5. */
  counts: [number, number, number, number, number];
  /** The ratings that came with a comment, newest first. No names: ratings are kept by a one-way key. */
  notes: LessonRating[];
};

export function summarize(ratings: LessonRating[]): RatingSummary {
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const rating of ratings) {
    counts[rating.score - 1] += 1;
    sum += rating.score;
  }
  return {
    count: ratings.length,
    average: ratings.length ? sum / ratings.length : null,
    counts,
    notes: ratings.filter((rating) => rating.note).sort((a, b) => b.at - a.at),
  };
}

/** Comments the owner's summary shows, newest first. */
export const SHOWN_RATING_NOTES = 100;
