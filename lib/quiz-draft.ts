/**
 * A lesson's quiz drafted with AI (added 10 October 2026): the rules, which
 * the studio's browser reads too. The part that asks the model is in
 * lib/ai.ts (writeQuiz); the quiz itself is lib/quiz.ts.
 *
 * Measured before it was built: Thinkific and Kajabi draft quiz questions
 * from a lesson; Stan has no quizzes at all. Here a creator presses one
 * button under a lesson and gets questions to read, change and save, or not.
 *
 * What makes a drafted quiz worth saving rather than a chore to fix:
 *
 *   - It is drawn from the lesson only: its text, and what the creator types
 *     about it. A question the lesson does not answer is unfair to a student.
 *   - The right answer is not where a student would guess it. The model is
 *     told to keep every answer the same length, and the order is shuffled
 *     here, so the right one moves around and is never in the same place
 *     two questions in a row.
 *   - Nothing is saved. The questions land in the editor beside any the
 *     creator already has, and Save the quiz is still theirs to press.
 */
import { MAX_CHOICES, MAX_CHOICE_LENGTH, MAX_EXPLANATION_LENGTH, MAX_QUESTIONS, MAX_QUESTION_LENGTH, MIN_CHOICES, type QuestionKind } from "@/lib/quiz";

/** How many questions a creator may ask for at once, and the default. */
export const QUIZ_DRAFT_COUNTS = [3, 5, 8, 10] as const;
export const DEFAULT_QUIZ_DRAFT = 5;
/** The most of a lesson's text the writer reads. A long lesson is read from its start. */
export const MAX_QUIZ_SOURCE = 24_000;

export type DraftedQuestion = {
  text: string;
  kind: QuestionKind;
  choices: string[];
  correct: number[];
  explanation: string;
};

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * What the model sent, made into questions the editor can hold, or none of
 * it: a question without its text, with an empty answer, with answers repeated
 * or too few, or with a right answer that is not among them is left out, never
 * repaired by guess. Empty answers are not removed because that would change
 * the positions the model used in `correct`.
 */
export function readDrafted(raw: unknown, count: number): DraftedQuestion[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: DraftedQuestion[] = [];
  for (const item of list) {
    if (out.length >= Math.min(count, MAX_QUESTIONS)) break;
    const value = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const text = clean(value.text, MAX_QUESTION_LENGTH);
    const choices = (Array.isArray(value.choices) ? value.choices : []).slice(0, MAX_CHOICES).map((c) => clean(c, MAX_CHOICE_LENGTH));
    if (!text || choices.length < MIN_CHOICES || choices.some((choice) => !choice)) continue;
    if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) continue;
    const rawCorrect = Array.isArray(value.correct) ? value.correct : [];
    if (rawCorrect.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0 || n >= choices.length)) continue;
    const correct = [...new Set(rawCorrect as number[])].sort((a, b) => a - b);
    if (correct.length === 0 || correct.length === choices.length) continue;
    const kind: QuestionKind = correct.length > 1 ? "multiple" : "single";
    out.push({ text, kind, choices, correct, explanation: clean(value.explanation, MAX_EXPLANATION_LENGTH) });
  }
  return out;
}

/**
 * The answers of each question put in a new order, so the right one moves
 * around: for a question with one right answer, never where the question
 * before had its own. `random` is Math.random unless a test gives its own.
 */
export function shuffleAnswers(questions: DraftedQuestion[], random: () => number = Math.random): DraftedQuestion[] {
  let before = -1;
  return questions.map((question) => {
    const n = question.choices.length;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // order[newPlace] = oldPlace. One right answer that landed where the last one was moves on by one.
    if (question.kind === "single") {
      const at = order.indexOf(question.correct[0]);
      if (at === before) {
        const next = (at + 1) % n;
        [order[at], order[next]] = [order[next], order[at]];
      }
    }
    const choices = order.map((old) => question.choices[old]);
    const correct = order.flatMap((old, place) => (question.correct.includes(old) ? [place] : [])).sort((a, b) => a - b);
    if (question.kind === "single") before = correct[0];
    return { ...question, choices, correct };
  });
}
