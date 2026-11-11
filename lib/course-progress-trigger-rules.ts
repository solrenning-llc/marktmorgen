/**
 * An automation that starts when a student reaches a share of a course:
 * 287 [H4-1], unit 1 (11 November 2026). Pure and browser-safe: the rules
 * only. Nothing reads or writes the store and nothing calls these yet; the
 * trigger in lib/flow-rules.ts and lib/flows.ts, with the course's measured
 * progress (lib/learn.ts; coordinated with 102 [E2-COURSE-COMPLIANCE], which
 * measures lesson order and video watched on the server), is a later unit.
 *
 *   - The creator picks a share, a whole percent from 1 to 100 (for example
 *     80%, to offer mentoring to who got that far).
 *   - The share done is only progress measured on the server: lessons
 *     marked done, quizzes and assignments passed, over all the course
 *     counts, rounded down, so it never says more than was done.
 *   - Reached once: from under the share to at or over it. Progress going
 *     back (a lesson unmarked) is not a crossing, and a student fires each
 *     share once per course (progressOnceName, from the contact's own key,
 *     never the address).
 *   - Unknown never fires (rule 24).
 */

/** The creator's share, 1 to 100, or null. */
export function readTriggerShare(raw: unknown): number | null {
  const n = typeof raw === "string" && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The share done, 0 to 100, rounded down; null when the counts cannot be read. */
export function progressShare(done: number, total: number): number | null {
  if (!isCount(done) || !isCount(total) || total === 0 || done > total) return null;
  return Math.floor((done * 100) / total);
}

/** Whether progress moving from `before` to `after` (shares done) reaches the creator's `share`. */
export function reachedShare(before: number | null, after: number | null, share: number): "yes" | "no" | "unknown" {
  if (readTriggerShare(share) !== share) return "unknown";
  const ok = (n: number | null) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100;
  if (!ok(before) || !ok(after)) return "unknown";
  return (before as number) < share && (after as number) >= share ? "yes" : "no";
}

const PART = /^[A-Za-z0-9_-]{1,128}$/;

/** The name of the once-per-student-per-course-per-share mark; null when a part is not one. */
export function progressOnceName(flowId: string, courseId: string, contactKey: string, share: number): string | null {
  if (![flowId, courseId, contactKey].every((p) => PART.test(p)) || readTriggerShare(share) !== share) return null;
  return `${flowId}:${courseId}:${contactKey}:${share}`;
}
