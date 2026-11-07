/**
 * A short survey when a student finishes a course (285 [SX1]), as rules the
 * browser can read too. The part that keeps the answers is
 * lib/course-survey.ts.
 *
 * Once every lesson of a course is done (and every quiz that has to be
 * passed is passed: lib/certificate.ts hasFinished), the course's own page
 * asks one question, word for word SURVEY_QUESTION, with a score from 0 to 10
 * and a comment if the student wants. It is optional. Each student answers
 * each course once and can change or remove the answer. Answers are private:
 * only the store's owner sees them, as an average, the count of each score
 * and the comments, without names or addresses. They are never shown to
 * other students or on any public page, so they are never social proof, and
 * nothing about a review depends on them.
 */
import { cleanText } from "@/lib/community-text";
import { dataBytesOfLength } from "@/lib/store-data-rules";

/** The question, exactly as the public page asks it in English. */
export const SURVEY_QUESTION = "How likely are you to recommend this course to a friend?";

export type SurveyScore = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export const SURVEY_SCORES: readonly SurveyScore[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** The longest comment with an answer, in characters. */
export const MAX_SURVEY_NOTE = 500;
/** Students one course keeps an answer from; past it a new one is refused, a change is not. */
export const MAX_COURSE_ANSWERS = 2_000;
/** Answers (and removals) one person may send in a minute, and in a day, on one store. */
export const SURVEYS_PER_MINUTE = 5;
export const SURVEYS_PER_DAY = 30;

/** A student's key (lib/learn.ts emailKey), at its longest. */
const WHO_BYTES = 32;
/** `{"s":10,"t":"","a":}` and a time in seconds of up to twelve digits. */
const RECORD_FRAME_BYTES = 32;
/**
 * The most bytes one kept answer can be, its student's key and its record:
 * each character of a comment is at most three bytes once lone halves of a
 * character are dropped (cleanSurveyNote), an escaped quote or line break two.
 */
export const SURVEY_ENTRY_MAX_BYTES = WHO_BYTES + RECORD_FRAME_BYTES + 3 * MAX_SURVEY_NOTE;
/**
 * What the store's data room (lib/store-data.ts) is charged for one answer,
 * whatever its size: its field in the course's hash. Charged before it is
 * written, once per student and course; a change is not charged again.
 */
export const SURVEY_ROOM_BYTES = dataBytesOfLength(SURVEY_ENTRY_MAX_BYTES, 1);

/**
 * The bytes of answers one studio request pays for (lib/studio-route.ts
 * countStudio): less than the 50 KB a studio request is priced with
 * (tests/plan-cost-registry.ts, UNIT_COST.studio), so the read's own frame fits.
 */
export const SURVEY_READ_BYTES_PER_UNIT = 40_000;
/** Answers that may come in between counting them and reading them; past it the read is refused. */
export const SURVEY_READ_SLACK = 20;

/** The studio requests that reading `count` answers at their largest takes. */
export function surveyReadUnits(count: number): number {
  const n = Math.max(0, Math.min(MAX_COURSE_ANSWERS, Math.floor(count)));
  return Math.max(1, Math.ceil((n * SURVEY_ENTRY_MAX_BYTES) / SURVEY_READ_BYTES_PER_UNIT));
}

export type SurveyAnswer = { score: SurveyScore; note: string; /** Seconds. */ at: number };

/** A score from a form or a stored record, or null when it is not a whole 0 to 10. */
export function parseSurveyScore(raw: unknown): SurveyScore | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^(?:10|[0-9])$/.test(text)) return null;
  return Number(text) as SurveyScore;
}

/** Lone halves of a character: JSON writes each as six bytes, and they draw nothing. */
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A comment as it is kept: clean text, at most MAX_SURVEY_NOTE characters, no lone halves. */
export function cleanSurveyNote(raw: unknown): string {
  return cleanText(raw, MAX_SURVEY_NOTE).replace(LONE_HALF, "").trim();
}

export function serializeAnswer(answer: SurveyAnswer): string {
  return JSON.stringify({ s: answer.score, t: answer.note, a: answer.at });
}

/** Reads one kept answer, or null when it is not one. */
export function parseAnswer(raw: unknown): SurveyAnswer | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const record = v as Record<string, unknown>;
    if (!Object.hasOwn(record, "s") || typeof record.s !== "number") return null;
    const score = parseSurveyScore(record.s);
    if (score === null) return null;
    if (!Object.hasOwn(record, "t") || typeof record.t !== "string" || record.t.length > MAX_SURVEY_NOTE) return null;
    if (!Object.hasOwn(record, "a") || typeof record.a !== "number" || !Number.isSafeInteger(record.a) || record.a < 0) return null;
    return { score, note: record.t, at: record.a };
  } catch {
    return null;
  }
}

export type SurveySummary = {
  count: number;
  /** The mean score, or null with no answers. */
  average: number | null;
  /** How many gave 0, 1, … 10, in that order. */
  counts: number[];
  /** The answers that came with a comment, newest first. No names: answers are kept by a one-way key. */
  notes: SurveyAnswer[];
};

export function summarizeSurvey(answers: SurveyAnswer[]): SurveySummary {
  const counts = SURVEY_SCORES.map(() => 0);
  let sum = 0;
  for (const answer of answers) {
    counts[answer.score] += 1;
    sum += answer.score;
  }
  return {
    count: answers.length,
    average: answers.length ? sum / answers.length : null,
    counts,
    notes: answers.filter((answer) => answer.note).sort((a, b) => b.at - a.at),
  };
}

/** Comments the owner's summary shows, newest first. */
export const SHOWN_SURVEY_NOTES = 100;
