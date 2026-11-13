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
import { createHmac } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { deriveKey } from "@/lib/secret-box";

export function deviceQuizKey(courseId: string, email: string): string | null {
  const key = deriveKey("quiz-draft");
  if (!key || !courseId || !email) return null;
  return createHmac("sha256", key).update(`${courseId}\n${normaliseEmail(email)}`).digest("hex").slice(0, 32);
}
