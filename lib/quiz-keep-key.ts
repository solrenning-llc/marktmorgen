/**
 * The code a student's quiz drafts are kept under on their own device
 * (297 [SQ8], lib/quiz-keep-rules.ts; review of #4324): a keyed hash of the
 * course and the address, made on the server with a key only the server
 * holds, as lib/lesson-position.ts does for a video's place. So on a shared
 * browser one student's draft is never put back for another, and nobody who
 * knows someone's address can tell from that computer whether they answered
 * a quiz there. Its own derived key, so it never equals a place key. Nothing
 * about it is kept on our side.
 *
 * Null where this deployment has no key to make it from: then no draft is
 * kept, and the quiz is the plain form it always was.
 */
import { createHash, createHmac } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { deriveKey } from "@/lib/secret-box";
import type { Question } from "@/lib/quiz";

export function deviceQuizKey(courseId: string, email: string): string | null {
  const key = deriveKey("quiz-draft");
  if (!key || !courseId || !email) return null;
  return createHmac("sha256", key).update(`${courseId}\n${normaliseEmail(email)}`).digest("hex").slice(0, 32);
}

/**
 * The code for a try's questions as the student sees them (review of #4324): each question's id, kind, words and
 * choices in their order, never which choice is right, the questions taken by id so a shuffled try has the same one.
 * Kept with the draft (lib/quiz-keep-rules.ts), so a quiz the creator changed since, a choice reordered above all,
 * never gets an old draft's marks.
 */
export function quizVersion(questions: readonly Pick<Question, "id" | "kind" | "text" | "choices">[]): string {
  const seen = [...questions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((q) => [q.id, q.kind, q.text, q.choices]);
  return createHash("sha256").update(JSON.stringify(seen)).digest("hex").slice(0, 16);
}
