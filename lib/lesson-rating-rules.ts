/**
 * A quick rating of each lesson: 296 [SQ7], unit 1 (11 November 2026). Pure
 * and browser-safe: the rules only. Nothing reads or writes the store, and
 * nothing calls these yet; the kept ratings (bounded, in the store's data
 * room), the box at the end of a lesson and the creator's view beside the
 * lesson drop-off map (96 [D2-LESSON-DROPOFF]) are later units.
 *
 *   - A rating is a whole number from 1 to 5; a comment is optional, at most
 *     MAX_RATING_COMMENT characters, line breaks allowed, no other control
 *     character, never cut (longer is refused).
 *   - One rating per student per lesson, which they may change: the kept
 *     record is { r, c, at } and nothing else (no address, no name).
 *   - The creator sees, per lesson, how many, the average to one decimal,
 *     the spread from 1 to 5 and the comments with their rating, newest
 *     first. With no rating there is no average, never 0.
 *   - Never public (RATING_PUBLIC): never shown to other students and never
 *     used as social proof.
 *   - Rule 24: a kept record that cannot be read is not counted, and the
 *     summary says how many were left out.
 */

/** The longest comment, in characters. */
export const MAX_RATING_COMMENT = 500;
/** Ratings are never shown to other students or as social proof. */
export const RATING_PUBLIC = false;

/** A rating 1 to 5, or null. */
export function readRating(raw: unknown): number | null {
  const n = typeof raw === "string" && /^\d$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

// Control characters other than the line feed.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/** The comment as kept: "" when none, trimmed; null when it is not one this module keeps. */
export function readComment(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (CONTROL.test(text) || text.length > MAX_RATING_COMMENT) return null;
  return text;
}

export type KeptRating = { rating: number; comment: string; at: number };

/** A kept record, whole or null. */
export function readKeptRating(raw: unknown): KeptRating | null {
  if (typeof raw !== "string" || raw.length > MAX_RATING_COMMENT * 6 + 64) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !["r", "c", "at"].every((k) => keys.includes(k))) return null;
  const rating = readRating(record.r);
  const comment = typeof record.c === "string" ? readComment(record.c) : null;
  const at = record.at;
  if (rating === null || record.r !== rating || comment === null || comment !== record.c) return null;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return null;
  return { rating, comment, at };
}

export type RatingSummary = {
  count: number;
  /** One decimal; null when there is no rating. */
  average: number | null;
  /** How many of each rating, 1 to 5. */
  spread: [number, number, number, number, number];
  /** The comments with their rating, newest first. */
  comments: { rating: number; comment: string }[];
  /** Kept records that could not be read, left out. */
  unreadable: number;
};

/** The creator's summary of one lesson's kept ratings. */
export function ratingSummary(kept: readonly unknown[]): RatingSummary {
  const spread: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const read: KeptRating[] = [];
  let unreadable = 0;
  for (const raw of kept) {
    const record = readKeptRating(raw);
    if (!record) {
      unreadable += 1;
      continue;
    }
    read.push(record);
    spread[record.rating - 1] += 1;
  }
  const total = read.reduce((sum, r) => sum + r.rating, 0);
  return {
    count: read.length,
    average: read.length ? Math.round((total / read.length) * 10) / 10 : null,
    spread,
    comments: read.filter((r) => r.comment).sort((a, b) => b.at - a.at).map((r) => ({ rating: r.rating, comment: r.comment })),
    unreadable,
  };
}
