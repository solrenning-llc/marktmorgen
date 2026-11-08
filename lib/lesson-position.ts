/**
 * The key a student's places in a course's videos are kept under on their
 * own device (650 [WG10], lib/lesson-position-rules.ts): a keyed hash of the
 * course and the address, made on the server with a key only the server
 * holds, so nobody who knows someone's address can work out from a shared
 * computer whether that person watched a course there (Revisor 1 on #2728).
 * Different for each course. Nothing about it is kept on our side.
 *
 * Null where this deployment has no key to make it from: then no place is
 * kept, and the video plays as before.
 */
import { createHmac } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { deriveKey } from "@/lib/secret-box";

export function devicePlaceKey(courseId: string, email: string): string | null {
  const key = deriveKey("lesson-place");
  if (!key || !courseId || !email) return null;
  return createHmac("sha256", key).update(`${courseId}\n${normaliseEmail(email)}`).digest("hex").slice(0, 32);
}
