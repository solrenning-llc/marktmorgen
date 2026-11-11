/**
 * A weekly progress email to a student: 289 [H4-3], unit 1 (11 November
 * 2026). Pure and server-safe: the rules only. Nothing reads or writes the
 * store and nothing calls these yet; the student's choice, the store's
 * switch, the email (lessons done this week, the next lesson, community
 * events ahead) and its weekly pass are later units, inside the plan's
 * emails checked before each send, with a one-click unsubscribe.
 *
 *   - Off unless the student chose it (exactly "yes") and the store allows
 *     it.
 *   - A week with no lesson done and no event ahead sends nothing.
 *   - At most one weekly message per person: never on top of another weekly
 *     message or a reminder to an idle member the same week (coordinated
 *     with 11 [D8], the creator's weekly summary, which goes to the creator).
 *   - The week is the store's: ISO weeks, in its time zone.
 *   - Unknown is never sent (rule 24).
 */
import { isTimeZone, partsIn } from "@/lib/call-setup";

export type WeeklyProgressInput = {
  /** The student's own choice, kept as given. */
  choice: unknown;
  storeAllows: boolean;
  lessonsDone: number;
  eventsAhead: number;
  /** Whether this person already got a weekly message or a reminder this week. */
  alreadyThisWeek: boolean;
};

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** "send", "skip", or "unknown" when anything cannot be read. */
export function shouldSendWeeklyProgress(input: WeeklyProgressInput): "send" | "skip" | "unknown" {
  const { choice, storeAllows, lessonsDone, eventsAhead, alreadyThisWeek } = input;
  if (typeof storeAllows !== "boolean" || typeof alreadyThisWeek !== "boolean") return "unknown";
  if (!isCount(lessonsDone) || !isCount(eventsAhead)) return "unknown";
  if (choice !== "yes" || !storeAllows || alreadyThisWeek) return "skip";
  return lessonsDone > 0 || eventsAhead > 0 ? "send" : "skip";
}

/** The store's ISO week of an instant, as "YYYY-Www"; null when it cannot be read. */
export function progressWeekOf(ms: number, tz: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || !isTimeZone(tz)) return null;
  const p = partsIn(ms, tz);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  // ISO 8601: the week holds its Thursday; the year is the Thursday's.
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}
