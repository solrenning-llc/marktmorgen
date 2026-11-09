/**
 * Community points for finishing a lesson (24 [E7], part 2).
 *
 * A store whose community is on can give the community's own points
 * (lib/community-points.ts: the same board, levels and rewards as a like)
 * for each lesson a member finishes in one of its courses. The creator sets
 * one number for every course, from 0 (the default: nothing changes unless
 * they choose) up to MAX_LESSON_POINTS (lib/community-text.ts).
 *
 * Who earns: only a current member of the store's community, read exactly
 * (a record that cannot be read throws, rule 24); not somebody who never came
 * into the community, and not one the creator took out. The callers mark the
 * lesson done first, for a learner whose access is open, and never for the
 * store's owner (app/api/store/course/progress and quiz).
 *
 * Each lesson gives its points once for good (awardLesson): two presses at
 * once, a lesson done again, or undone and done again, give them once.
 */
import type { Store } from "@/lib/store";
import { memberKey, readMember } from "@/lib/community";
import { awardLesson, readLessonPoints } from "@/lib/community-points";

export type LessonPoints = "off" | "none" | "not_member" | "already" | "given";

/**
 * Gives `email` the store's points for finishing `lessonId` of `courseId`,
 * once. "off" when the store has no community or it is switched off, "none"
 * when the creator set 0, "not_member" for somebody who is not a current
 * member. An unknown reply throws (rule 24): the caller logs it, and the
 * lesson stays done.
 */
export async function pointsForLessonDone(store: Store, courseId: string, lessonId: string, email: string, now = Date.now()): Promise<LessonPoints> {
  const community = store.community;
  if (!community?.id || !community.on) return "off";
  const n = await readLessonPoints(community.id);
  if (n === 0) return "none";
  const key = memberKey(email);
  const member = await readMember(community.id, key);
  if (!member || member.removed) return "not_member";
  return awardLesson(community.id, key, courseId, lessonId, n, store, now);
}
