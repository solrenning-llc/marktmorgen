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
import { ensureListId, storeRef, type Store } from "@/lib/store";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";

const finishedKey = (courseId: string, email: string) => `nl:course:${courseId}:fin:${emailKey(email)}`;
const openedKey = (courseId: string, email: string) => `nl:course:${courseId}:open:${emailKey(email)}`;
const MOMENT_SECONDS = 400 * 86_400;

/**
 * Claims an opening or finishing marker only while the address has not been
 * erased from this store (#4418). The suppression check and the SET NX are
 * one Redis turn, so an erasure lands wholly before this claim (refused) or
 * after it (its DEL takes the marker). KEYS: the marker, the store's
 * suppression fingerprints; ARGV: this address's fingerprint, the seconds.
 */
export const CLAIM_COURSE_MOMENT = `-- marktmorgen:course-moment:v1
if redis.call("HEXISTS", KEYS[2], ARGV[1]) == 1 then return nil end
return redis.call("SET", KEYS[1], "1", "NX", "EX", ARGV[2])`;

/** Only a complete, own acknowledgement confirms this invocation took the claim. */
function confirmedClaim(reply: unknown): boolean {
  if (!Array.isArray(reply) || reply.length !== 1) return false;
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  return slot !== undefined && Object.hasOwn(slot, "value") && slot.value === "OK";
}

async function claimMoment(store: Store, key: string, email: string): Promise<boolean> {
  // An erasure gives a store without a list one; reading or giving it here
  // first makes both use the same permanent suppression key, even when this
  // Store was read before that erasure.
  const listId = store.listId ?? (await ensureListId(storeRef(store)))?.listId;
  if (!listId) return false;
  const claim = await redisPipeline([[
    "EVAL",
    CLAIM_COURSE_MOMENT,
    2,
    key,
    suppressedKey(listId),
    suppressionPrint(listId, email),
    MOMENT_SECONDS,
  ]]);
  return confirmedClaim(claim);
}

/**
 * After a student opens a course: the first time, starts what opening it
 * starts (lib/flows.ts, trigger "started"). Never throws: opening a lesson
 * must never fail on what comes after it.
 */
export async function noteIfOpened(store: Store, productId: string, courseId: string, email: string): Promise<boolean> {
  try {
    if (!email || !isRedisConfigured()) return false;
    if (!(await claimMoment(store, openedKey(courseId, email), email))) return false;
    await enroll(store, email, { joined: false, started: productId });
    return true;
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
    if (!(await claimMoment(store, finishedKey(courseId, email), email))) return false;
    await enroll(store, email, { joined: false, finished: productId });
    return true;
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
