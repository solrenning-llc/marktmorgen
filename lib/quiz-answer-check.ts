import type { Answers, Quiz } from "@/lib/quiz";
import { MAX_QUESTIONS } from "@/lib/quiz";

/**
 * The questions of a quiz try left blank (WCAG 2.2 3.3.4 and 3.3.6: a test
 * response is checked before it counts). Every question has at least one
 * right answer (lib/quiz.ts), so a blank is never an answer: a try with one
 * is sent back, nothing counted, rather than using one of the student's
 * limited tries on a slip.
 *
 * In the order the page showed them (`shown`), or the quiz's own order when
 * the page sent none; an id the quiz does not hold is never named.
 */
export function blankQuestions(quiz: Pick<Quiz, "questions">, answers: Answers, shown: string[]): string[] {
  const known = new Set(quiz.questions.map((q) => q.id));
  const order = shown.length ? shown : quiz.questions.map((q) => q.id);
  return [...new Set(order)].filter((id) => known.has(id) && !(answers[id]?.length));
}

/** The blank questions named in the lesson's address (`blank=a.b`), kept to this quiz's own ids. */
export function blankFromQuery(raw: unknown, quiz: Pick<Quiz, "questions">): string[] {
  if (typeof raw !== "string" || !raw) return [];
  const known = new Set(quiz.questions.map((q) => q.id));
  return [...new Set(raw.split(".").slice(0, MAX_QUESTIONS))].filter((id) => known.has(id));
}
