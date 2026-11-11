/**
 * A short satisfaction survey when a student finishes a course: 285 [SX1],
 * unit 1 (11 November 2026). Pure and browser-safe: the rules only. Nothing
 * reads or writes the store and nothing calls these yet; the survey on the
 * finish screen (lib/course-finish.ts, through lib/forms.ts), the kept
 * answers (bounded, in the store's data room), the email and the creator's
 * view are later units.
 *
 *   - The question is word for word SURVEY_QUESTION; the score is a whole
 *     number from 0 to 10; the comment is optional, at most
 *     MAX_SURVEY_COMMENT characters, line breaks only, never cut.
 *   - A kept answer is { s, c, at } and nothing else: no address, no name.
 *   - The creator sees, of their own students only, how many, the average to
 *     one decimal (none with no answer, never 0), the spread 0 to 10 and the
 *     comments with their score, newest first.
 *   - By email only to a contact whose news consent is exactly "yes", once
 *     per student per course (surveyOnceName, from the contact's own key).
 *   - Asking for a public review never depends on the score: no asking only
 *     high scorers, no filtering out low ones (REVIEW_ASK_DEPENDS_ON_SCORE).
 *     Scores are never published as social proof.
 *   - Rule 24: an answer that cannot be read is not counted, and the summary
 *     says how many were left out.
 */

export const SURVEY_QUESTION = "How likely are you to recommend this course to a friend?";
export const MAX_SURVEY_COMMENT = 500;
/** The public review ask is the same whatever the score. */
export const REVIEW_ASK_DEPENDS_ON_SCORE = false;

/** A score 0 to 10, or null. */
export function readScore(raw: unknown): number | null {
  const n = typeof raw === "string" && /^(?:\d|10)$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 10 ? n : null;
}

// Control characters other than the line feed.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/** The comment as kept: "" when none, trimmed; null when it is not one this module keeps. */
export function readSurveyComment(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return CONTROL.test(text) || text.length > MAX_SURVEY_COMMENT ? null : text;
}

export type KeptAnswer = { score: number; comment: string; at: number };

/** A kept answer, whole or null. */
export function readKeptAnswer(raw: unknown): KeptAnswer | null {
  if (typeof raw !== "string" || raw.length > MAX_SURVEY_COMMENT * 6 + 64) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !["s", "c", "at"].every((k) => keys.includes(k))) return null;
  const score = typeof record.s === "number" ? readScore(record.s) : null;
  const comment = typeof record.c === "string" ? readSurveyComment(record.c) : null;
  if (score === null || comment === null || comment !== record.c) return null;
  if (typeof record.at !== "number" || !Number.isSafeInteger(record.at) || record.at <= 0) return null;
  return { score, comment, at: record.at };
}

export type SurveySummary = {
  count: number;
  average: number | null;
  /** How many of each score, 0 to 10. */
  spread: number[];
  comments: { score: number; comment: string }[];
  unreadable: number;
};

/** The creator's summary of one course's kept answers. */
export function surveySummary(kept: readonly unknown[]): SurveySummary {
  const spread = Array.from({ length: 11 }, () => 0);
  const read: KeptAnswer[] = [];
  let unreadable = 0;
  for (const raw of kept) {
    const answer = readKeptAnswer(raw);
    if (!answer) {
      unreadable += 1;
      continue;
    }
    read.push(answer);
    spread[answer.score] += 1;
  }
  const total = read.reduce((sum, a) => sum + a.score, 0);
  return {
    count: read.length,
    average: read.length ? Math.round((total / read.length) * 10) / 10 : null,
    spread,
    comments: read.filter((a) => a.comment).sort((a, b) => b.at - a.at).map((a) => ({ score: a.score, comment: a.comment })),
    unreadable,
  };
}

/** Only a contact whose news consent is exactly "yes" is asked by email. */
export function mayEmailSurvey(news: unknown): boolean {
  return news === "yes";
}

const PART = /^[A-Za-z0-9_-]{1,128}$/;

/** The name of the once-per-student-per-course mark, from the contact's own key (never the address); null when a part is not one. */
export function surveyOnceName(storeId: string, courseId: string, contactKey: string): string | null {
  return [storeId, courseId, contactKey].every((p) => PART.test(p)) ? `${storeId}:${courseId}:${contactKey}` : null;
}
