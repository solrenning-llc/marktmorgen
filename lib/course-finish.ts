/**
 * A student finishing a course (added 12 October 2026): the moment the last
 * lesson of it is marked done, by a button, a quiz passed or work approved.
 *
 * It is the best moment a course has to offer the next thing — Kajabi and
 * Teachable both start automations on it — and until now nothing happened
 * then. Now the sequences that start "when someone finishes" a course
 * (lib/flows.ts, trigger "finished") start for that student, if they agreed
 * to hear from the creator; nobody else is written to.
 *
 * A student finishes once: a flag kept for 400 days says it happened, so a
 * lesson marked undone and done again does not start anything twice. The flag
 * is first taken for CLAIM_SECONDS only and made the 400-day one once the
 * sequences started; a start that failed lets it go, and if even that reply is
 * lost the short claim runs out on its own, so a failure never keeps a
 * student's sequence from starting for 400 days. A start is claimed per person
 * and sequence (lib/flows.ts startFlows), so a second try never starts twice.
 *
 * Opening a course for the first time (added 17 October 2026) starts the
 * sequences that start "when someone opens" it, in the same way and once,
 * which is the welcome into a course that Kajabi and Teachable send.
 *
 *   nl:course:<courseId>:fin:<student>   "1", 400 days
 *   nl:course:<courseId>:open:<student>  "1", 400 days
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { doneLessons, emailKey } from "@/lib/learn";
import { lessonsInOrder, readCourse } from "@/lib/course";
import { enroll } from "@/lib/flows";
import { exactReplies, UnknownReply } from "@/lib/redis-exact";
import type { Store } from "@/lib/store";

const finishedKey = (courseId: string, email: string) => `nl:course:${courseId}:fin:${emailKey(email)}`;
const openedKey = (courseId: string, email: string) => `nl:course:${courseId}:open:${emailKey(email)}`;

/** How long a claim not yet confirmed by a started sequence holds: minutes, far beyond one enroll, never 400 days. */
const CLAIM_SECONDS = 600;
const KEPT_SECONDS = 400 * 86_400;

/**
 * Takes the moment for this invocation, starts its sequences and keeps the mark 400 days once they started (XX: a
 * mark erased with the person meanwhile is never written again). When starting failed the claim is let go; an
 * unconfirmed reply to either write leaves only the short claim, which runs out by itself.
 */
async function claimAndEnroll(key: string, start: () => Promise<boolean>): Promise<boolean> {
  const claim = await redisPipeline([["SET", key, "1", "NX", "EX", CLAIM_SECONDS]]);
  if (!confirmedClaim(claim)) return false;
  // Starting the sequences failed on its way (enroll logged it): the mark goes, so the moment can start them when it
  // comes again; a start is claimed per person and sequence, never twice (lib/flows.ts startFlows).
  if (!(await start())) {
    await redisPipeline([["DEL", key]]);
    return false;
  }
  await redisPipeline([["SET", key, "1", "XX", "EX", KEPT_SECONDS]]);
  return true;
}

/** Only a complete, own acknowledgement confirms this invocation took the claim. */
function confirmedClaim(reply: unknown): boolean {
  if (!Array.isArray(reply) || reply.length !== 1) return false;
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  return slot !== undefined && Object.hasOwn(slot, "value") && slot.value === "OK";
}

/**
 * After a student opens a course: the first time, starts what opening it
 * starts (lib/flows.ts, trigger "started"). Never throws: opening a lesson
 * must never fail on what comes after it.
 */
export async function noteIfOpened(store: Store, productId: string, courseId: string, email: string): Promise<boolean> {
  try {
    if (!email || !isRedisConfigured()) return false;
    return await claimAndEnroll(openedKey(courseId, email), () => enroll(store, email, { joined: false, started: productId }));
  } catch (error) {
    console.error("noting an opened course failed", error);
    return false;
  }
}

/**
 * After a lesson is marked done: whether that finished the course for this
 * student, the first time, and if so starts what finishing starts. Never
 * throws: a lesson marked done must never fail on what comes after it.
 */
export async function noteIfFinished(store: Store, productId: string, courseId: string, email: string): Promise<boolean> {
  try {
    if (!email || !isRedisConfigured()) return false;
    const course = await readCourse(courseId);
    const lessons = course ? lessonsInOrder(course).map(({ lesson }) => lesson.id) : [];
    if (!lessons.length) return false;
    const done = await doneLessons(courseId, email);
    if (!lessons.every((id) => done.has(id))) return false;
    return await claimAndEnroll(finishedKey(courseId, email), () => enroll(store, email, { joined: false, finished: productId }));
  } catch (error) {
    console.error("noting a finished course failed", error);
    return false;
  }
}

/** Forgets the marks that one person opened and finished these courses (lib/person-erasure.ts). */
export async function forgetFinishPerson(courseIds: string[], email: string): Promise<number> {
  if (!courseIds.length || !isRedisConfigured()) return 0;
  const what = "the deletion of a person's course opening and finishing marks";
  const keys = [...new Set(courseIds.flatMap((courseId) => [finishedKey(courseId, email), openedKey(courseId, email)]))];
  const [gone] = exactReplies(
    await redisPipeline([["DEL", ...keys]]),
    1,
    what,
  );
  if (typeof gone !== "number" || !Number.isSafeInteger(gone) || gone < 0 || gone > keys.length) throw new UnknownReply(what);
  return gone;
}
