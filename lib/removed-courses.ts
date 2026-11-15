/**
 * The courses a store has dropped (lib/course.ts dropCourse: its product removed, or its course turned off), so that
 * a person's records kept under one of them after the outline is gone (the student row with their address, lessons
 * done, quiz tries and results, passes, finish marks, a certificate with their name) are still reached by their
 * erasure (lib/person-erasure.ts erasureScope), which otherwise walks only the courses the store's products hold now
 * (C7 courses hunt: before, the erasure answered done with all of them kept, the certificate still verifiable).
 *
 *   nl:coursegone:<statsId>               hash    a dropped course's id -> {"p": product id}
 *   nl:coursegone:<statsId>:c:<courseId>  string  that course's {"l": lesson ids, "m": module ids}
 *
 * Noted before the outline is deleted, so a drop is never written without it; a note that is not confirmed refuses
 * the drop and keeps the outline. At most MAX_REMOVED_COURSES, as many as a catalog holds, so an erasure's size stays
 * bounded, and no course is ever dropped from it while the store is open: a drop that would need room the list does
 * not have is refused ("full"). Courses dropped before this list existed are not on it.
 * Read and written exactly (rule 24): an unknown reply throws, never "none".
 *
 * An erasure takes only the dropped courses where the person has a record (lib/person-erasure.ts droppedCoursesOf: their
 * student row, the lessons they finished, the quizzes they passed, their certificate or their start and finish marks,
 * DROPPED_PROBES commands a
 * course, each asked of the module that keeps it), so a store
 * with many dropped courses never makes one person's erasure cost what all of them would, and never pushes a deletion
 * the law requires past the studio's window (Codex X3 on #4436).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";

/** The most dropped courses remembered for a store: as many as its catalog may hold. */
export const MAX_REMOVED_COURSES = MAX_PRODUCTS;


const removedKey = (statsId: string) => `nl:coursegone:${statsId}`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One dropped course, as the erasure needs it. */
export type RemovedCourse = { productId: string; courseId: string; lessonIds: string[]; moduleIds: string[] };

/**
 * The most lessons and modules one noted course keeps: a course outline's own ceilings (lib/course.ts MAX_LESSONS and
 * MAX_MODULES, held equal by tests/erasure-dropped-list-budget.test.ts; not imported, since lib/course.ts imports this
 * file). A drop past them is refused, never noted cut short, so a record never outgrows REMOVED_COURSE_RECORD_BYTES.
 */
export const MAX_NOTED_LESSONS = 200;
export const MAX_NOTED_MODULES = 30;

/**
 * The most bytes one course's record holds (its lesson and module ids, 64 characters at most, quoted, with a comma):
 * read only for a course where the person has something (lib/person-erasure.ts), counted per course read
 * (lib/erasure-rules.ts ERASE_PER.droppedRecords).
 */
export const REMOVED_COURSE_RECORD_BYTES = 32 + 67 * (MAX_NOTED_LESSONS + MAX_NOTED_MODULES);

/** One course's lessons and modules, kept beside the list so that reading the list never reads them (#4542 review). */
const recordKey = (statsId: string, courseId: string) => `nl:coursegone:${statsId}:c:${courseId}`;

/**
 * In one step, as Redis runs a script: the list (KEYS[1]) keeps each dropped course's id and its product's id, and the
 * course's own key (KEYS[2]) its lessons and modules, written together. A course already on the list has both
 * replaced; a new one is added only while the list has room, never by dropping another. 1 added, 0 replaced, -1 full.
 */
export const NOTE_REMOVED_COURSE = `-- marktmorgen:removed-course-note:v2
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 1 then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
  redis.call("SET", KEYS[2], ARGV[3])
  return 0
end
if redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[4]) then return -1 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("SET", KEYS[2], ARGV[3])
return 1`;

/**
 * Notes a course as dropped, with its lessons and modules, before its outline is deleted: "noted", or "full" when the
 * list has no room for a course not on it yet (nothing written). Throws when neither is confirmed, or when the course
 * holds more lessons or modules than an outline can.
 */
export async function noteRemovedCourse(statsId: string | null | undefined, course: RemovedCourse): Promise<"noted" | "full"> {
  if (!statsId || !isRedisConfigured()) return "noted";
  const ids = [course.courseId, ...course.lessonIds, ...course.moduleIds];
  if (!ID.test(course.courseId) || (course.productId && !ID.test(course.productId)) || !ids.every((id) => ID.test(id))) throw new UnknownReplyError("a dropped course's ids");
  if (course.lessonIds.length > MAX_NOTED_LESSONS || course.moduleIds.length > MAX_NOTED_MODULES) throw new UnknownReplyError("a dropped course larger than an outline");
  const entry = JSON.stringify({ p: course.productId });
  const record = JSON.stringify({ l: course.lessonIds, m: course.moduleIds });
  const replies = repliesFor(await redisPipeline([["EVAL", NOTE_REMOVED_COURSE, 2, removedKey(statsId), recordKey(statsId, course.courseId), course.courseId, entry, record, MAX_REMOVED_COURSES]]), 1);
  const answer = replies ? replies[0] : null;
  if (answer === 1 || answer === 0) return "noted";
  if (answer === -1) return "full";
  throw new UnknownReplyError("noting a dropped course");
}

const idList = (value: unknown, most: number): string[] | null => (Array.isArray(value) && value.length <= most && value.every((id) => typeof id === "string" && ID.test(id)) ? (value as string[]) : null);

/** One dropped course on the list, without its lessons and modules. */
export type DroppedCourse = { courseId: string; productId: string };

/**
 * The courses this store dropped, by id and product only: the list read whole, at most MAX_REMOVED_COURSES entries of
 * a few dozen bytes each. An unknown reply, or an entry in another shape, throws, never "none".
 */
export async function droppedCourseIds(statsId: string | null | undefined): Promise<DroppedCourse[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["HGETALL", removedKey(statsId)]]), 1);
  const pairs = replies ? stringList(replies[0]) : null;
  if (!pairs || pairs.length % 2 || pairs.length / 2 > MAX_REMOVED_COURSES) throw new UnknownReplyError("a store's dropped courses");
  const out: DroppedCourse[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    let entry: { p?: unknown } | null;
    try {
      entry = JSON.parse(pairs[i + 1]) as { p?: unknown } | null;
    } catch {
      entry = null;
    }
    const productId = entry?.p;
    if (!ID.test(pairs[i]) || typeof productId !== "string") throw new UnknownReplyError("a store's dropped courses");
    out.push({ courseId: pairs[i], productId });
  }
  return out;
}

/**
 * The lessons and modules of the given dropped courses, one GET each, read exactly: a record missing or in another
 * shape throws (a noted course always has one, written in the same step), never "no lessons".
 */
export async function droppedCourseRecords(statsId: string, courses: DroppedCourse[]): Promise<RemovedCourse[]> {
  if (!courses.length) return [];
  const replies = repliesFor(await redisPipeline(courses.map((c) => ["GET", recordKey(statsId, c.courseId)])), courses.length);
  if (!replies) throw new UnknownReplyError("a dropped course's lessons");
  return courses.map((c, i) => {
    let record: { l?: unknown; m?: unknown } | null;
    try {
      record = typeof replies[i] === "string" ? (JSON.parse(replies[i] as string) as { l?: unknown; m?: unknown } | null) : null;
    } catch {
      record = null;
    }
    const lessonIds = idList(record?.l, MAX_NOTED_LESSONS);
    const moduleIds = idList(record?.m, MAX_NOTED_MODULES);
    if (!lessonIds || !moduleIds) throw new UnknownReplyError("a dropped course's lessons");
    return { ...c, lessonIds, moduleIds };
  });
}

/** The courses this store dropped, each with its lessons and modules. */
export async function removedCourses(statsId: string | null | undefined): Promise<RemovedCourse[]> {
  if (!statsId) return [];
  return droppedCourseRecords(statsId, await droppedCourseIds(statsId));
}

/** The commands an erasure sends for each dropped course, to learn whether the person has a record in it. */
export const DROPPED_PROBES = 6;

