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
import { readListing } from "@/lib/catalog";
import { emitEvent } from "@/lib/webhooks";
import { exactReplies, UnknownReply } from "@/lib/redis-exact";
import type { Store } from "@/lib/store";

const finishedKeyOf = (courseId: string, learner: string) => `nl:course:${courseId}:fin:${learner}`;
const openedKeyOf = (courseId: string, learner: string) => `nl:course:${courseId}:open:${learner}`;
const finishedKey = (courseId: string, email: string) => finishedKeyOf(courseId, emailKey(email));
const openedKey = (courseId: string, email: string) => openedKeyOf(courseId, emailKey(email));
/**
 * The commands answering 1 when this learner (lib/learn.ts emailKey) has a start or a finish mark in a course: two of a
 * dropped course's probes (lib/person-erasure.ts), since both marks are written with no student row (#4542 review).
 */
export const finishMarkProbes = (courseId: string, learner: string): (string | number)[][] => [["EXISTS", openedKeyOf(courseId, learner)], ["EXISTS", finishedKeyOf(courseId, learner)]];

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
    const claim = await redisPipeline([["SET", openedKey(courseId, email), "1", "NX", "EX", 400 * 86_400]]);
    if (!confirmedClaim(claim)) return false;
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
 *
 * `lessonId`, the lesson just marked done, sends course.lesson_completed to
 * the creator's webhooks first (378 [TB4] complement WG (a)): only when the
 * course has that lesson and it reads as done, once per student and lesson
 * (its seed), whatever the finish check says after it.
 */
export async function noteIfFinished(store: Store, productId: string, courseId: string, email: string, lessonId?: string): Promise<boolean> {
  try {
    if (!email || !isRedisConfigured()) return false;
    const course = await readCourse(courseId);
    const ordered = course ? lessonsInOrder(course) : [];
    const lessons = ordered.map(({ lesson }) => lesson.id);
    if (!lessons.length) return false;
    const done = await doneLessons(courseId, email);
    let listing: Awaited<ReturnType<typeof readListing>> | undefined;
    const title = async () => {
      if (listing === undefined) listing = await readListing(store, productId).catch(() => null);
      return listing?.title ?? null;
    };
    const lesson = lessonId ? ordered.find((l) => l.lesson.id === lessonId)?.lesson : undefined;
    if (lesson && done.has(lesson.id)) {
      await emitEvent(store, "course.lesson_completed", `lesson|${courseId}|${emailKey(email)}|${lesson.id}`, {
        email,
        product: { id: productId, title: await title() },
        lesson: { id: lesson.id, title: lesson.title },
        lessons_done: lessons.filter((id) => done.has(id)).length,
        lessons: lessons.length,
        completed_at: new Date().toISOString(),
      }).catch((error) => console.error("queueing the course.lesson_completed webhook failed", error));
    }
    if (!lessons.every((id) => done.has(id))) return false;
    const claim = await redisPipeline([["SET", finishedKey(courseId, email), "1", "NX", "EX", 400 * 86_400]]);
    if (!confirmedClaim(claim)) return false;
    // The creator's webhooks hear of it once, under the same once-only claim (378 [TB4] complement WG (a)); a failure
    // to queue it is said and never stops the sequences below.
    await emitEvent(store, "course.completed", `course|${courseId}|${emailKey(email)}`, {
      email,
      product: { id: productId, title: await title() },
      lessons: lessons.length,
      completed_at: new Date().toISOString(),
    }).catch((error) => console.error("queueing the course.completed webhook failed", error));
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
