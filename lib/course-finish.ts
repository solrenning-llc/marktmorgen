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
 * lesson marked undone and done again does not start anything twice.
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

/** How long a moment's mark lives once its sequences started: a student opens and finishes a course once. */
const KEPT_SECONDS = 400 * 86_400;
/**
 * How long a mark lives while its sequences are being started. It becomes KEPT_SECONDS only once enroll went through,
 * so a start that failed and whose cleanup DEL was lost or answered in an unknown shape holds the moment for an hour
 * at the most, never 400 days (Codex G and X5 on #4301). Starting again after it is safe: a start is claimed per
 * person and sequence (lib/flows.ts startFlows).
 */
const CLAIM_SECONDS = 3_600;

/**
 * Takes a moment's mark for this invocation, starts its sequences and keeps the mark for good only when they started.
 * When starting failed, the mark goes; if that DEL is not confirmed, the short claim lets the mark lapse within the hour.
 */
async function claimAndStart(key: string, start: () => Promise<boolean>): Promise<boolean> {
  const claim = await redisPipeline([["SET", key, "1", "NX", "EX", CLAIM_SECONDS]]);
  if (!confirmedClaim(claim)) return false;
  // Starting the sequences failed on its way (enroll logged it): the mark goes, so the moment can start them when it
  // comes again; a start is claimed per person and sequence, never twice (lib/flows.ts startFlows).
  if (!(await start())) {
    await redisPipeline([["DEL", key]]);
    return false;
  }
  // The sequences started: the mark is kept 400 days. An unconfirmed reply leaves the hour-long claim, after which the
  // same moment finds every sequence already claimed for this person and starts nothing twice.
  await redisPipeline([["EXPIRE", key, KEPT_SECONDS]]);
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
    return await claimAndStart(openedKey(courseId, email), () => enroll(store, email, { joined: false, started: productId }));
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
    return await claimAndStart(finishedKey(courseId, email), () => enroll(store, email, { joined: false, finished: productId }));
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
