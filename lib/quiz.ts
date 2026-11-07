/**
 * Quizzes: a few questions at the end of a lesson, marked here.
 *
 * A creator can put one quiz on any lesson: up to twenty questions, each with
 * one right answer or several, and a line of explanation the student reads
 * once they have answered. The creator sets the mark that counts as a pass,
 * how many tries a student gets, and whether the lessons after it stay shut
 * until the quiz is passed.
 *
 * Marking happens on the server and only there. The page a student answers
 * on carries the questions and the choices and nothing else: which choice is
 * right, and the explanation that would give it away, never reach the
 * browser until the student has answered. Revealing them is decided here too:
 * after each try the student sees which questions they got right, and the
 * explanations of those; the answers to the rest are shown once they pass or
 * run out of tries, so a try is never spent just to read the answer sheet.
 *
 * The questions live in a record of their own, one per lesson, because a
 * course with two hundred lessons and a quiz on each would otherwise make the
 * outline — read on every page of the course — heavy for nothing. The lesson
 * carries only the four numbers the outline needs (lib/course.ts).
 *
 * What a student did is kept per student and per quiz: how many tries they
 * used, their last answers, their best mark, and whether they passed. Passing
 * also marks the lesson done, which is what a certificate counts
 * (lib/certificate.ts).
 *
 * Pure rules at the top, storage at the bottom.
 */
import { reserveQuizSubmission } from "@/lib/quiz-usage";
import { MAX_WAIT_MINUTES, drawn, trySeed, waitLeft } from "@/lib/quiz-bank-rules";
import { QUIZ_USAGE_POLICY } from "@/lib/quiz-usage-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { SET_AND_VALUES_TAKE } from "@/lib/redis-take";
import { UnknownReply, exactReplies, plainList } from "@/lib/redis-exact";
import { dataBytes } from "@/lib/store-data-rules";
import { type Course, ITEM_ID_PATTERN, lessonsInOrder, newItemId } from "@/lib/course";

export const MAX_QUESTIONS = 20;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 6;
export const MAX_QUESTION_LENGTH = 300;
export const MAX_CHOICE_LENGTH = 160;
export const MAX_EXPLANATION_LENGTH = 600;
/** The mark a student needs, in percent. */
export const MIN_PASS_PERCENT = 1;
export const MAX_PASS_PERCENT = 100;
export const DEFAULT_PASS_PERCENT = 70;
/** New quizzes always have a finite attempt limit. Stored legacy zero remains readable. */
export const MAX_ATTEMPTS = 10;
export const DEFAULT_ATTEMPTS = 3;

export type QuestionKind = "single" | "multiple";

export type Question = {
  id: string;
  text: string;
  /** "single": one right choice. "multiple": every right choice, and no other. */
  kind: QuestionKind;
  choices: string[];
  /** The positions of the right choices. Never sent to a student's browser. */
  correct: number[];
  /** Shown once the student has answered. May be empty. */
  explanation: string;
};

/** The whole quiz, as stored for one lesson. */
export type Quiz = {
  usagePolicy?: typeof QUIZ_USAGE_POLICY;
  passPercent: number;
  /** Tries a student gets; 0 is no limit. */
  attempts: number;
  /** Whether the lessons after this one stay shut until it is passed. */
  required: boolean;
  questions: Question[];
  /** Questions each try draws from the bank (630 [HN6](7)); absent or 0 is every question. */
  draw?: number;
  /** Whether each try shows its questions in an order of its own. */
  shuffle?: boolean;
  /** Minutes a student waits after a try before the next; absent is none. */
  waitMinutes?: number;
};

/** The bank's three settings as kept: only what is set, within bounds. */
function bankOf(value: Record<string, unknown>, total: number): Pick<Quiz, "draw" | "shuffle" | "waitMinutes"> {
  const draw = wholeIn(value.draw, 1, Math.max(1, total - 1));
  const wait = wholeIn(value.waitMinutes, 1, MAX_WAIT_MINUTES);
  return { ...(draw !== null ? { draw } : {}), ...(value.shuffle === true ? { shuffle: true } : {}), ...(wait !== null ? { waitMinutes: wait } : {}) };
}

/** The part of a quiz the lesson carries, so the outline needs no second read. */
export type QuizSetup = {
  usagePolicy?: typeof QUIZ_USAGE_POLICY;
  questions: number;
  passPercent: number;
  attempts: number;
  required: boolean;
};

export function setupOf(quiz: Quiz): QuizSetup {
  return {
    ...(quiz.usagePolicy ? { usagePolicy: quiz.usagePolicy } : {}),
    questions: quiz.questions.length,
    passPercent: quiz.passPercent,
    attempts: quiz.attempts,
    required: quiz.required,
  };
}

function wholeIn(raw: unknown, min: number, max: number): number | null {
  const n = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function cleanLine(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanParagraph(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export function parseSetup(raw: unknown): QuizSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const questions = wholeIn(value.questions, 1, MAX_QUESTIONS);
  const passPercent = wholeIn(value.passPercent, MIN_PASS_PERCENT, MAX_PASS_PERCENT);
  const attempts = wholeIn(value.attempts, 0, MAX_ATTEMPTS);
  if (questions === null || passPercent === null || attempts === null) return null;
  if (value.usagePolicy !== undefined && value.usagePolicy !== QUIZ_USAGE_POLICY) return null;
  return { questions, passPercent, attempts, required: value.required === true, ...(value.usagePolicy === QUIZ_USAGE_POLICY ? { usagePolicy: QUIZ_USAGE_POLICY } : {}) };
}

function parseQuestion(raw: unknown): Question | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ITEM_ID_PATTERN.test(value.id)) return null;
  const text = cleanParagraph(value.text, MAX_QUESTION_LENGTH);
  const choices = Array.isArray(value.choices)
    ? value.choices.map((c) => cleanLine(c, MAX_CHOICE_LENGTH)).slice(0, MAX_CHOICES)
    : [];
  if (!text || choices.length < MIN_CHOICES || choices.some((c) => !c)) return null;
  const kind: QuestionKind = value.kind === "multiple" ? "multiple" : "single";
  const correct = Array.isArray(value.correct)
    ? [...new Set(value.correct.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < choices.length))].sort((a, b) => a - b)
    : [];
  if (correct.length === 0 || (kind === "single" && correct.length !== 1)) return null;
  return { id: value.id, text, kind, choices, correct, explanation: cleanParagraph(value.explanation, MAX_EXPLANATION_LENGTH) };
}

export function parseQuiz(raw: unknown): Quiz | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!Array.isArray(value.questions)) return null;
    const questions: Question[] = [];
    for (const raw of value.questions) {
      const question = parseQuestion(raw);
      if (!question) return null;
      if (questions.length < MAX_QUESTIONS) questions.push(question);
    }
    const attempts = wholeIn(value.attempts, 0, MAX_ATTEMPTS);
    if (questions.length === 0 || attempts === null || (value.usagePolicy !== undefined && value.usagePolicy !== QUIZ_USAGE_POLICY)) return null;
    return {
      ...(value.usagePolicy === QUIZ_USAGE_POLICY ? { usagePolicy: QUIZ_USAGE_POLICY } : {}),
      passPercent: wholeIn(value.passPercent, MIN_PASS_PERCENT, MAX_PASS_PERCENT) ?? DEFAULT_PASS_PERCENT,
      attempts,
      required: value.required === true,
      questions,
      ...bankOf(value, questions.length),
    };
  } catch {
    return null;
  }
}

export type QuizProblem =
  | { reason: "empty" | "too_many" | "pass" | "attempts" }
  | { reason: "question" | "choices" | "choice" | "correct" | "single"; at: number };

/**
 * Reads a quiz as the studio sends it, and says exactly what is wrong when it
 * cannot be kept: which question, and why, so the creator is taken to it
 * rather than told "invalid".
 */
export function readQuiz(raw: unknown, existing: Quiz | null = null): { ok: true; quiz: Quiz } | ({ ok: false } & QuizProblem) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "empty" };
  const value = raw as Record<string, unknown>;
  const passPercent = wholeIn(value.passPercent, MIN_PASS_PERCENT, MAX_PASS_PERCENT);
  if (passPercent === null) return { ok: false, reason: "pass" };
  // Only a persisted legacy quiz can keep zero. Client input cannot grant it.
  const rawAttempts =
    value.attempts === undefined || value.attempts === null || (typeof value.attempts === "string" && value.attempts.trim() === "")
      ? (existing?.attempts === 0 ? 0 : DEFAULT_ATTEMPTS)
      : value.attempts;
  const attempts = wholeIn(rawAttempts, existing?.attempts === 0 ? 0 : 1, MAX_ATTEMPTS);
  if (attempts === null) return { ok: false, reason: "attempts" };
  const list = Array.isArray(value.questions) ? value.questions : [];
  if (list.length === 0) return { ok: false, reason: "empty" };
  if (list.length > MAX_QUESTIONS) return { ok: false, reason: "too_many" };

  const questions: Question[] = [];
  const seen = new Set<string>();
  for (let at = 0; at < list.length; at += 1) {
    const entry = (list[at] && typeof list[at] === "object" ? list[at] : {}) as Record<string, unknown>;
    const text = cleanParagraph(entry.text, MAX_QUESTION_LENGTH);
    if (!text) return { ok: false, reason: "question", at };
    const rawChoices = Array.isArray(entry.choices) ? entry.choices : [];
    // Empty rows the creator left at the end of the list are simply dropped.
    const choices = rawChoices.map((c) => cleanLine(c, MAX_CHOICE_LENGTH));
    const kept: number[] = [];
    choices.forEach((c, i) => {
      if (c) kept.push(i);
    });
    if (kept.length < MIN_CHOICES || kept.length > MAX_CHOICES) return { ok: false, reason: "choices", at };
    if (new Set(kept.map((i) => choices[i].toLowerCase())).size !== kept.length) return { ok: false, reason: "choice", at };
    const marked = Array.isArray(entry.correct) ? entry.correct.map(Number) : [];
    const correct = kept.map((original, index) => (marked.includes(original) ? index : -1)).filter((i) => i >= 0);
    const kind: QuestionKind = entry.kind === "multiple" ? "multiple" : "single";
    if (correct.length === 0) return { ok: false, reason: "correct", at };
    if (kind === "single" && correct.length !== 1) return { ok: false, reason: "single", at };
    const id = typeof entry.id === "string" && ITEM_ID_PATTERN.test(entry.id) && !seen.has(entry.id) ? entry.id : newItemId();
    seen.add(id);
    questions.push({
      id,
      text,
      kind,
      choices: kept.map((i) => choices[i]),
      correct,
      explanation: cleanParagraph(entry.explanation, MAX_EXPLANATION_LENGTH),
    });
  }
  return { ok: true, quiz: { passPercent, attempts, required: value.required === true, questions, ...bankOf(value, questions.length),
    ...(!existing || existing.usagePolicy === QUIZ_USAGE_POLICY ? { usagePolicy: QUIZ_USAGE_POLICY } : {}),
  } };
}

/** What a student picked, question by question, as positions of choices. */
export type Answers = Record<string, number[]>;

/** Reads the answer form: `q_<question id>` fields, one per ticked choice. */
export function readAnswers(quiz: Quiz, form: { getAll(name: string): unknown[] }): Answers {
  const answers: Answers = {};
  for (const question of quiz.questions) {
    const picked = form
      .getAll(`q_${question.id}`)
      .map((v) => Number(v))
      .filter((i) => Number.isInteger(i) && i >= 0 && i < question.choices.length);
    const unique = [...new Set(picked)].sort((a, b) => a - b);
    // A single-answer question counts one pick; anything else is not an answer.
    answers[question.id] = question.kind === "single" ? unique.slice(0, 1) : unique;
  }
  return answers;
}

export type Grade = {
  right: number;
  total: number;
  percent: number;
  passed: boolean;
  /** Per question id: whether it was answered right. */
  marks: Record<string, boolean>;
};

/**
 * Marks one try. A question with several right answers counts only when the
 * student picked all of them and nothing else: half a set is not the answer.
 * The percentage is rounded down, so a mark shown as 70% is never really 69.5.
 */
export function gradeQuiz(quiz: Quiz, answers: Answers): Grade {
  const marks: Record<string, boolean> = {};
  let right = 0;
  for (const question of quiz.questions) {
    const picked = answers[question.id] ?? [];
    const ok = picked.length === question.correct.length && question.correct.every((i) => picked.includes(i));
    marks[question.id] = ok;
    if (ok) right += 1;
  }
  const total = quiz.questions.length;
  const percent = total ? Math.floor((right / total) * 100) : 0;
  return { right, total, percent, passed: percent >= quiz.passPercent, marks };
}

/** Tries left, or null when there is no limit. */
export function triesLeft(quiz: Pick<Quiz, "attempts">, used: number): number | null {
  return quiz.attempts === 0 ? null : Math.max(0, quiz.attempts - used);
}

/**
 * The quiz as one try of one student shows it (630 [HN6](7)): the questions
 * the bank draws for that try, in the quiz's order or shuffled. `attempt`
 * counts from 1. Without a draw or a shuffle it is the whole quiz.
 */
export function quizForTry(quiz: Quiz, courseId: string, lessonId: string, who: string, attempt: number): Quiz {
  if (!quiz.draw && !quiz.shuffle) return quiz;
  const picks = drawn(quiz.questions.length, quiz.draw ?? 0, quiz.shuffle === true, trySeed(courseId, lessonId, who, attempt));
  return { ...quiz, questions: picks.map((i) => quiz.questions[i]) };
}

/** How many questions one try shows. */
export function questionsPerTry(quiz: Pick<Quiz, "questions" | "draw">): number {
  const total = quiz.questions.length;
  return quiz.draw && quiz.draw < total ? quiz.draw : total;
}

/** Seconds this student still waits before the next try; 0 when they may try now. */
export function quizWait(quiz: Pick<Quiz, "waitMinutes">, attempt: Pick<Attempt, "last"> | null, now: number): number {
  return waitLeft(quiz.waitMinutes ?? 0, attempt?.last ? attempt.last.at * 1000 : null, now);
}

/**
 * What a student's lesson shows: the next try's questions while they may try
 * now; otherwise (passed, out of tries, or waiting) the last try's, so a wait
 * never shows the next questions early. `wait` is the seconds left.
 */
export function studentQuiz(quiz: Quiz, courseId: string, lessonId: string, who: string, attempt: Attempt, now: number = Date.now()): { quiz: Quiz; wait: number } {
  const open = !attempt.passed && triesLeft(quiz, attempt.used) !== 0;
  const wait = open ? quizWait(quiz, attempt, now) : 0;
  const next = open && wait === 0;
  return { quiz: quizForTry(quiz, courseId, lessonId, who, next ? attempt.used + 1 : Math.max(1, attempt.used)), wait };
}

/** Whether the questions a student answered are the ones their try draws, in any order. */
function sameQuestions(shown: string[] | null, quiz: Quiz): boolean {
  if (!shown) return false;
  const want = quiz.questions.map((q) => q.id).sort();
  const got = [...new Set(shown)].sort();
  return want.length === got.length && want.every((id, i) => id === got[i]);
}

/**
 * Which lessons a required quiz is still holding shut for this student: each
 * lesson after an unpassed required quiz maps to that quiz's lesson. The quiz
 * lesson itself stays open, since it is where the quiz is taken.
 */
export function heldBack(course: Course, passed: Set<string>): Map<string, string> {
  const held = new Map<string, string>();
  let blocker: string | null = null;
  for (const { lesson } of lessonsInOrder(course)) {
    if (blocker) held.set(lesson.id, blocker);
    // A required quiz, or an assignment that holds the rest shut (lib/assignment-rules.ts),
    // not yet passed: an assignment done is written down beside the quizzes passed.
    if (!blocker && (lesson.quiz?.required || lesson.task?.gate) && !passed.has(lesson.id)) blocker = lesson.id;
  }
  return held;
}

/** Every lesson whose quiz must be passed, in order. */
export function requiredQuizLessons(course: Course): string[] {
  return lessonsInOrder(course)
    .filter(({ lesson }) => lesson.quiz?.required)
    .map(({ lesson }) => lesson.id);
}

// ---------------------------------------------------------------- storage

const quizKey = (courseId: string, lessonId: string) => `nl:course:${courseId}:quiz:${lessonId}`;
const triesKey = (courseId: string, lessonId: string, who: string) => `nl:course:${courseId}:quiz:${lessonId}:tries:${who}`;
const resultKey = (courseId: string, lessonId: string, who: string) => `nl:course:${courseId}:quiz:${lessonId}:result:${who}`;
const passedKey = (courseId: string, who: string) => `nl:course:${courseId}:passed:${who}`;

export async function readQuizFor(courseId: string, lessonId: string): Promise<Quiz | null> {
  if (!isRedisConfigured() || !ITEM_ID_PATTERN.test(lessonId)) return null;
  const [raw] = await redisPipeline([["GET", quizKey(courseId, lessonId)]]);
  return parseQuiz(raw);
}

/**
 * Where a course's quizzes are counted in the store's data room
 * (lib/store-data.ts): the quizzes the creator writes, and what students'
 * tries leave (their last answers and marks, their count, what they passed).
 */
const QUIZZES_SLOT = (courseId: string) => `cq:${courseId}`;
const TRIES_SLOT = (courseId: string) => `ct:${courseId}`;
const kept = (raw: unknown) => (typeof raw === "string" && raw ? dataBytes([raw], 1) : 0);

export async function saveQuiz(courseId: string, lessonId: string, quiz: Quiz, room: DataStore): Promise<void> {
  const json = JSON.stringify(quiz);
  const [before] = await redisPipeline([["GET", quizKey(courseId, lessonId)]]);
  const grown = dataBytes([json], 1) - kept(before);
  if (grown > 0) await needData(room, [{ slot: QUIZZES_SLOT(courseId), bytes: grown }]);
  await redisPipeline([["SET", quizKey(courseId, lessonId), json]]);
  if (grown < 0) await giveData(room, [{ slot: QUIZZES_SLOT(courseId), bytes: -grown }]);
}

export async function dropQuiz(courseId: string, lessonId: string, room: DataStore): Promise<void> {
  const [before] = await redisPipeline([["GET", quizKey(courseId, lessonId)]]);
  await redisPipeline([["DEL", quizKey(courseId, lessonId)]]);
  if (kept(before)) await giveData(room, [{ slot: QUIZZES_SLOT(courseId), bytes: kept(before) }]);
}

/** The keys a course's quizzes are kept under, so they go when it goes. */
export function quizKeys(course: Course): string[] {
  return lessonsInOrder(course)
    .filter(({ lesson }) => lesson.quiz)
    .map(({ lesson }) => quizKey(course.id, lesson.id));
}

/** A student's last try, as kept to show them how it went. */
export type Attempt = {
  /** Tries used so far. */
  used: number;
  /** The last try's answers and marks; null before the first. */
  last: { answers: Answers; grade: Grade; at: number } | null;
  best: number;
  passed: boolean;
};

const NO_ATTEMPT: Attempt = { used: 0, last: null, best: 0, passed: false };

class QuizAttemptReadError extends Error {
  constructor() {
    super("Quiz attempt evidence is unavailable");
    this.name = "QuizAttemptReadError";
  }
}

function exactAttemptReply(reply: unknown): [string | null, string | null] {
  if (!Array.isArray(reply)) throw new QuizAttemptReadError();
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  const raw = Object.getOwnPropertyDescriptor(reply, "0");
  const used = Object.getOwnPropertyDescriptor(reply, "1");
  if (!length || !Object.hasOwn(length, "value") || length.value !== 2 ||
      !raw || !Object.hasOwn(raw, "value") || !used || !Object.hasOwn(used, "value") ||
      (raw.value !== null && typeof raw.value !== "string") ||
      (used.value !== null && typeof used.value !== "string")) {
    throw new QuizAttemptReadError();
  }
  return [raw.value, used.value];
}

function storedCount(raw: string | null): number {
  if (raw === null) return 0;
  if (!/^[1-9]\d*$/.test(raw)) throw new QuizAttemptReadError();
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) throw new QuizAttemptReadError();
  return count;
}

function storedRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === "object" && !Array.isArray(raw);
}

function storedAnswers(raw: unknown): raw is Answers {
  return storedRecord(raw) && Object.values(raw).every(
    (picked) => Array.isArray(picked) && picked.every((choice) => Number.isSafeInteger(choice) && choice >= 0),
  );
}

function storedGrade(raw: unknown): raw is Grade {
  if (!storedRecord(raw) || !Number.isSafeInteger(raw.right) || !Number.isSafeInteger(raw.total) ||
      !Number.isSafeInteger(raw.percent) || typeof raw.passed !== "boolean" || !storedRecord(raw.marks)) return false;
  if ((raw.right as number) < 0 || (raw.total as number) < 0 || (raw.right as number) > (raw.total as number) ||
      (raw.percent as number) < 0 || (raw.percent as number) > 100) return false;
  return Object.values(raw.marks).every((mark) => typeof mark === "boolean");
}

function storedLast(raw: unknown): raw is Attempt["last"] {
  if (raw === null) return true;
  if (!storedRecord(raw) || !storedAnswers(raw.answers) || !storedGrade(raw.grade)) return false;
  return Number.isSafeInteger(raw.at) && (raw.at as number) >= 0;
}

function parseAttempt(raw: string | null, used: string | null): Attempt {
  const tries = storedCount(used);
  if (raw === null) return { ...NO_ATTEMPT, used: tries };
  if (!raw || used === null) throw new QuizAttemptReadError();
  try {
    const value = JSON.parse(raw) as unknown;
    if (!storedRecord(value) || !Number.isSafeInteger(value.used) || (value.used as number) < 1 ||
        !storedLast(value.last) || !Number.isSafeInteger(value.best) || (value.best as number) < 0 ||
        (value.best as number) > 100 || typeof value.passed !== "boolean") throw new QuizAttemptReadError();
    return {
      used: tries,
      last: value.last,
      best: value.best as number,
      passed: value.passed,
    };
  } catch (error) {
    if (error instanceof QuizAttemptReadError) throw error;
    throw new QuizAttemptReadError();
  }
}

/** How this student has done on this quiz. `who` is lib/learn.ts emailKey. */
export async function attemptOf(courseId: string, lessonId: string, who: string): Promise<Attempt> {
  if (!isRedisConfigured()) return NO_ATTEMPT;
  const reply = await redisPipeline([
    ["GET", resultKey(courseId, lessonId, who)],
    ["GET", triesKey(courseId, lessonId, who)],
  ]);
  const [raw, used] = exactAttemptReply(reply);
  return parseAttempt(raw, used);
}

export type SubmitResult =
  | { ok: true; grade: Grade; attempt: Attempt }
  | { ok: false; reason: "no_tries" | "passed" | "usage_limit" | "unavailable" | "wait" | "stale" };

/**
 * Marks a try and keeps it.
 *
 * The try is counted first, with one atomic increment, and only then marked:
 * two answers sent at the same moment from two tabs both count, so a limit
 * of three tries is three and never four. A student who has passed is not
 * marked again, so a pass can never be undone by a worse try afterward.
 *
 * With a question bank (630 [HN6](7)) the try is marked on the questions it
 * draws, worked out again here from the student and the try's number, never
 * taken from the form. `shown` is the question ids the page showed: when the
 * quiz draws and they are not this try's (another tab tried first, or the
 * creator changed the questions), nothing is counted ("stale"). A try before
 * the creator's wait is over is refused ("wait"). Two answers sent at the very
 * same moment both pass the wait; each still counts as a try.
 */
export async function submitQuiz(
  courseId: string,
  lessonId: string,
  who: string,
  quiz: Quiz,
  answers: Answers,
  storeSid: string | undefined,
  /** The store's allowance window (lib/allowance-window.ts); null refuses a counted submission. */
  window: string | null | undefined,
  /** The store whose data room the try takes from (DataRoomError when it does not fit). */
  room: DataStore,
  /** The question ids the page showed; needed when the quiz draws from a bank. */
  shown: string[] | null = null,
): Promise<SubmitResult> {
  let before: Attempt;
  try {
    before = await attemptOf(courseId, lessonId, who);
  } catch (error) {
    if (error instanceof QuizAttemptReadError) return { ok: false, reason: "unavailable" };
    throw error;
  }
  if (before.passed) return { ok: false, reason: "passed" };
  if (quiz.attempts > 0 && before.used >= quiz.attempts) return { ok: false, reason: "no_tries" };
  if (quizWait(quiz, before, Date.now()) > 0) return { ok: false, reason: "wait" };
  const asked = quizForTry(quiz, courseId, lessonId, who, before.used + 1);
  if (quiz.draw && !sameQuestions(shown, asked)) return { ok: false, reason: "stale" };
  const mine: Answers = Object.fromEntries(asked.questions.map((q) => [q.id, answers[q.id] ?? []]));
  // What the try leaves takes room first, at the most it can weigh: its
  // answers and marks rewritten over the last, its count the first time, and
  // its pass. Nothing is counted against the store's quizzes without it.
  // What it really left is all that resetTries or a deletion gives back: the
  // rest of this reservation (the draft's worst case, a pass not made) stays
  // counted, the room erring fuller. Settling it here would need the try's
  // write and its room in one script, and is not done.
  const last = await redisPipeline([["GET", resultKey(courseId, lessonId, who)]]);
  const draft = JSON.stringify({ used: 9_999, last: { answers: mine, grade: gradeQuiz(asked, mine), at: Math.floor(Date.now() / 1000) }, best: 100, passed: true });
  const grown = dataBytes([draft], 1) - kept(last[0]) + (before.used ? 0 : dataBytes(["9999"], 1)) + dataBytes([lessonId], 1);
  if (grown > 0) await needData(room, [{ slot: TRIES_SLOT(courseId), bytes: grown }]);
  if (quiz.usagePolicy === QUIZ_USAGE_POLICY) {
    const reserved = await reserveQuizSubmission(storeSid ?? "", Date.now(), window);
    if (reserved !== "ok") return { ok: false, reason: reserved };
  }
  const [count] = await redisPipeline([["INCR", triesKey(courseId, lessonId, who)]]);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return { ok: false, reason: "unavailable" };
  const used = count;
  if (quiz.attempts > 0 && used > quiz.attempts) {
    await redisPipeline([["DECR", triesKey(courseId, lessonId, who)]]);
    return { ok: false, reason: "no_tries" };
  }
  const grade = gradeQuiz(asked, mine);
  const attempt: Attempt = {
    used,
    last: { answers: mine, grade, at: Math.floor(Date.now() / 1000) },
    best: Math.max(before.best, grade.percent),
    passed: grade.passed,
  };
  await redisPipeline([
    ["SET", resultKey(courseId, lessonId, who), JSON.stringify(attempt)],
    ...(grade.passed ? [["SADD", passedKey(courseId, who), lessonId]] : []),
  ]);
  return { ok: true, grade, attempt };
}

/**
 * Writes a lesson down as passed for a student without a quiz: an assignment
 * done (lib/assignment.ts), which holds later lessons shut as a quiz does.
 */
export async function markPassed(courseId: string, who: string, lessonId: string, room: DataStore): Promise<void> {
  if (!isRedisConfigured()) return;
  const [added] = await redisPipeline([["SADD", passedKey(courseId, who), lessonId]]);
  // Never refused: it follows work already handed in and taken.
  if (Number(added) === 1) await noteData(room, [{ slot: TRIES_SLOT(courseId), bytes: dataBytes([lessonId], 1) }]);
}

/** The lessons whose quizzes this student has passed, and the assignments they have done. */
export async function passedQuizzes(courseId: string, who: string): Promise<Set<string>> {
  if (!isRedisConfigured()) return new Set();
  const [raw] = await redisPipeline([["SMEMBERS", passedKey(courseId, who)]]);
  return new Set(Array.isArray(raw) ? (raw as string[]) : []);
}

/** Several students at once, for the studio's list. */
export async function passedFor(courseId: string, who: string[]): Promise<Set<string>[]> {
  if (!isRedisConfigured() || who.length === 0) return who.map(() => new Set());
  const rows = await redisPipeline(who.map((w) => ["SMEMBERS", passedKey(courseId, w)]));
  return rows.map((raw) => new Set(Array.isArray(raw) ? (raw as string[]) : []));
}

/**
 * Gives a student their tries back on every quiz of a course. What they
 * already passed stays passed: this is for someone stuck, not a penalty.
 */
export async function resetTries(course: Course, who: string, room: DataStore): Promise<void> {
  const passed = await passedQuizzes(course.id, who);
  const lessons = lessonsInOrder(course).filter(({ lesson }) => lesson.quiz && !passed.has(lesson.id));
  if (lessons.length === 0) return;
  // Each read and deleted in one step (GETDEL), so what the tries weighed comes
  // back to the store's data room once, even beside a deletion of the student.
  const held = await redisPipeline(lessons.flatMap(({ lesson }) => [["GETDEL", resultKey(course.id, lesson.id, who)], ["GETDEL", triesKey(course.id, lesson.id, who)]]));
  const freed = held.reduce((sum: number, raw) => sum + kept(typeof raw === "number" ? String(raw) : raw), 0);
  if (freed) await giveData(room, [{ slot: TRIES_SLOT(course.id), bytes: freed }]);
}

/**
 * Deletes one student's tries, results and passes in these courses' quizzes
 * (lib/person-erasure.ts). `who` is lib/learn.ts emailKey. Each course's are
 * read and deleted in one step, and what they weighed (each try's count and
 * result as resetTries gives them back, each lesson passed as markPassed
 * counts it) goes back to `room`, when it is given, once.
 */
export async function forgetQuizPerson(courses: { courseId: string; lessonIds: string[] }[], who: string, room?: DataStore): Promise<number> {
  if (!courses.length || !isRedisConfigured()) return 0;
  const what = "the deletion of a student's quiz tries";
  const replies = exactReplies(
    await redisPipeline(
      courses.map((c) => {
        const keys = [passedKey(c.courseId, who), ...c.lessonIds.flatMap((l) => [triesKey(c.courseId, l, who), resultKey(c.courseId, l, who)])];
        return ["EVAL", SET_AND_VALUES_TAKE, keys.length, ...keys];
      }),
    ),
    courses.length,
    what,
  );
  let records = 0;
  let unknown = false;
  const freed: { slot: string; bytes: number }[] = [];
  courses.forEach((c, i) => {
    // Exactly {the passes, one value per lesson key, how many keys went}; any
    // other shape leaves this course's deletion unknown, and its room kept.
    // Every level read as a plain list (lib/redis-exact.ts plainList): no hole, no getter, read once (Codex G on #2576).
    const outer = plainList(replies[i]);
    const [passedRaw, valuesRaw, gone] = outer && outer.length === 3 ? outer : [];
    const passed = plainList(passedRaw);
    const values = plainList(valuesRaw);
    if (
      !passed ||
      !passed.every((lessonId) => typeof lessonId === "string") ||
      !values ||
      values.length !== c.lessonIds.length * 2 ||
      !values.every((raw) => raw === null || typeof raw === "string" || typeof raw === "number") ||
      typeof gone !== "number" ||
      !Number.isSafeInteger(gone) ||
      // The same DEL took exactly the keys this reply says were there (Codex G on #2576): the passes' set when it held
      // any, and each value that was not none. Any other count is a reply that contradicts itself: unknown.
      gone !== (passed.length > 0 ? 1 : 0) + values.filter((raw) => raw !== null).length
    ) {
      unknown = true;
      return;
    }
    records += gone;
    const bytes =
      passed.reduce((sum: number, lessonId) => sum + dataBytes([lessonId as string], 1), 0) +
      values.reduce((sum: number, raw) => sum + kept(typeof raw === "number" ? String(raw) : raw), 0);
    if (bytes > 0) freed.push({ slot: TRIES_SLOT(c.courseId), bytes });
  });
  // What was confirmed taken comes back; a course whose reply is unknown keeps its room.
  if (room && freed.length) await giveData(room, freed);
  if (unknown) throw new UnknownReply(what);
  return records;
}
