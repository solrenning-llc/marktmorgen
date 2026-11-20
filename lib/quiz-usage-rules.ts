/** Fixed terms for newly created quizzes; legacy quizzes have no version. */
export const QUIZ_USAGE_POLICY = "monthly-v1" as const;
export const QUIZ_MONTHLY_SUBMISSIONS = 1_000;
export const QUIZ_USAGE_RETENTION_SECONDS = 93 * 86_400;
/**
 * Tries sent to one store's quizzes from one connection in a minute, counted
 * before the student's access is read (a classroom behind one address fits).
 */
export const QUIZ_TRIES_PER_CONNECTION_MINUTE = 60;
/**
 * Tries one student sends to one store's quizzes in an hour, counted before
 * the quiz is read: ten tries on six quizzes.
 */
export const QUIZ_TRIES_PER_STUDENT_HOUR = 60;
/**
 * The store's public requests on the buyers' side (lib/buyer-actions.ts,
 * takeBuyerRead) one try takes, after the per-connection limit and before the
 * listing, the student's access or the course is read: every try, marked or
 * not, and from anyone. A try sends at most two later pages' commands to Redis
 * (tests/quiz-try-admission.test.ts), and 1,000 tries at two each fit inside a
 * free trial's and every plan's requests, so the submissions the quiz editor
 * promises are never held back by them. A try never takes one of the store's
 * buyer actions, which a Store plan has 200 of a month (#3466).
 */
export const QUIZ_TRY_UNITS = 2;
/**
 * The key a store's submissions are counted under. `window` is the store's
 * allowance window by its name (lib/allowance-window.ts): its billing month
 * when it pays us, so one payment buys one month of submissions; the
 * calendar month (UTC) when none is given. Null refuses.
 */
export function quizUsageKey(sid: string, now = Date.now(), window?: string | null): string | null {
  if (!/^[0-9a-f]{32}$/.test(sid) || !Number.isFinite(now)) return null;
  if (window === null) return null;
  if (window !== undefined) return /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(window) ? `nl:quiz:usage:${sid}:${window}` : null;
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  return `nl:quiz:usage:${sid}:${date.toISOString().slice(0, 7)}`;
}
