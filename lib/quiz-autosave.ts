/**
 * A quiz's answers kept while the student picks them (queue item 297 [SQ8]):
 * the rules behind components/quiz-autosave.tsx, pure so
 * tests/sq8-quiz-autosave.test.ts checks them.
 *
 * What it is for: a student who leaves the lesson, closes the browser or
 * loses the connection halfway through a quiz finds their picks again when
 * they come back, instead of answering every question a second time.
 *
 * Where they are kept: in the student's own browser only, under
 * `mm-quiz:<store>:<course>:<lesson>`. Nothing is sent to the server for it
 * and no supplier is called, so it costs nothing per student and holds no
 * personal data on our side. What is kept is only the position of each
 * checked choice (`q_<question id>` = `0`…), never a hidden field, a name or
 * an email address. That is why it is on by itself here, while a store's
 * long form (components/form-keep.tsx), whose answers can be anything the
 * visitor typed, waits for the visitor to check a box.
 *
 * When they go: once the server says the try was marked, when the questions
 * are not the ones kept for (the creator changed them, or a bank drew
 * another try), when the quiz is shut (passed, out of tries, waiting), after
 * QUIZ_KEEP_DAYS, and when the student presses "Clear these answers".
 */

/** How long picks kept in a browser are kept, at most. */
export const QUIZ_KEEP_DAYS = 30;
const KEEP_MS = QUIZ_KEEP_DAYS * 86_400_000;
/** A kept time this far ahead of the browser's clock is not believed. */
const CLOCK_SLACK_MS = 60_000;

/** The most picks kept: every choice of every question of the largest quiz (20 × 6), with room. */
export const MAX_KEPT_PICKS = 200;

/** Where a lesson's quiz picks are kept in this browser, and only there. */
export const QUIZ_KEEP_PREFIX = "mm-quiz:";
export const quizKeepKey = (handle: string, product: string, lesson: string) => `${QUIZ_KEEP_PREFIX}${handle}:${product}:${lesson}`;

/** What one browser keeps for one lesson's quiz. */
export type QuizKept = {
  /** When it was last kept (ms). */
  at: number;
  /** quizFit of the questions it was kept for. */
  fit: string;
  /** The checked choices, as the form sends them. */
  answers: [string, string][];
  /** When the student pressed the button, while the server has not said it was marked. */
  sent?: number;
};

const PICK_NAME = /^q_[A-Za-z0-9_-]{1,64}$/;
const PICK_VALUE = /^(0|[1-9]\d{0,2})$/;
const isPick = (name: unknown, value: unknown): name is string => typeof name === "string" && typeof value === "string" && PICK_NAME.test(name) && PICK_VALUE.test(value);

/** What is kept from the form: the questions' own picks (q_…), never the hidden fields. */
export function keptQuizAnswers(entries: Iterable<[string, unknown]>): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of entries) {
    if (out.length >= MAX_KEPT_PICKS) break;
    if (isPick(name, value)) out.push([name, value as string]);
  }
  return out;
}

/**
 * A short fingerprint of the questions a page shows, in the order shown:
 * their ids, kinds and choices. Kept picks are put back only onto the very
 * questions they were picked for, never onto a changed choice or another
 * try's draw. FNV-1a, 32 bits: a check that nothing moved, not a secret.
 */
export function quizFit(questions: readonly { id: string; kind: string; choices: readonly string[] }[]): string {
  const text = questions.map((x) => [x.id, x.kind, ...x.choices].join("\u0001")).join("\u0002");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${questions.length}-${hash.toString(16).padStart(8, "0")}`;
}

const FIT = /^\d{1,3}-[0-9a-f]{8}$/;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** What a browser kept, read back: null when nothing, unreadable, malformed, too old or from the future. */
export function parseQuizKept(raw: string | null | undefined, now: number): QuizKept | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { at, fit, answers, sent } = value as Record<string, unknown>;
  if (!isTime(at) || at > now + CLOCK_SLACK_MS || now - at > KEEP_MS) return null;
  if (typeof fit !== "string" || !FIT.test(fit)) return null;
  if (sent !== undefined && !isTime(sent)) return null;
  if (!Array.isArray(answers) || answers.length > MAX_KEPT_PICKS) return null;
  const picks: [string, string][] = [];
  for (const entry of answers) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isPick(entry[0], entry[1])) return null;
    picks.push([entry[0], entry[1] as string]);
  }
  return { at, fit, answers: picks, ...(sent !== undefined ? { sent } : {}) };
}

/** What to do with what this browser kept, as the lesson's page opens. */
export type QuizLoad =
  | { kind: "none" }
  | { kind: "forget" }
  /** Put these picks back; `resave`, when given, is kept again in their place (the sent mark taken off). */
  | { kind: "restore"; answers: [string, string][]; resave: QuizKept | null };

export function onQuizLoad(
  raw: string | null | undefined,
  page: { fit: string; open: boolean; marked: boolean; now: number },
): QuizLoad {
  if (!raw) return { kind: "none" };
  const kept = parseQuizKept(raw, page.now);
  if (!kept || !page.open || kept.fit !== page.fit || kept.answers.length === 0) return { kind: "forget" };
  // Sent, and the server said the try was marked: those picks are the try's now.
  if (kept.sent !== undefined && page.marked) return { kind: "forget" };
  // Sent, but the page never came back marked (the connection dropped, or the
  // student went back): nothing was counted, so the picks come back.
  const resave = kept.sent !== undefined ? { at: kept.at, fit: kept.fit, answers: kept.answers } : null;
  return { kind: "restore", answers: kept.answers, resave };
}

/** What is kept when the student presses the button: the same picks, marked as sent. */
export function sentKept(raw: string | null | undefined, now: number): QuizKept | null {
  const kept = parseQuizKept(raw, now);
  return kept ? { ...kept, sent: now } : null;
}

/** Whether a choice is checked in the kept picks: each kept pick checked, every other choice not. */
export function pickedIn(answers: readonly [string, string][], name: string, value: string): boolean {
  return answers.some(([n, v]) => n === name && v === value);
}
