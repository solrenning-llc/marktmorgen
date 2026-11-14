/**
 * The courses a store has dropped (lib/course.ts dropCourse: its product removed, or its course turned off), so that
 * a person's records kept under one of them after the outline is gone (the student row with their address, lessons
 * done, quiz tries and results, passes, finish marks, a certificate with their name) are still reached by their
 * erasure (lib/person-erasure.ts erasureScope), which otherwise walks only the courses the store's products hold now
 * (C7 courses hunt: before, the erasure answered done with all of them kept, the certificate still verifiable).
 *
 *   nl:coursegone:<statsId>   hash   a dropped course's id -> {"p": product id, "l": lesson ids, "m": module ids}
 *
 * Noted before the outline is deleted, so a drop is never written without it; a note that is not confirmed refuses
 * the drop and keeps the outline. At most MAX_REMOVED_COURSES, as many as a catalog holds, so an erasure's size stays
 * bounded, and no course is ever dropped from it while the store is open: a drop that would need room the list does
 * not have is refused ("full"). Courses dropped before this list existed are not on it.
 * Read and written exactly (rule 24): an unknown reply throws, never "none".
 *
 * An erasure takes only the dropped courses where the person has a record (lib/person-erasure.ts droppedCoursesOf: their
 * student row, the lessons they finished, the quizzes they passed or their certificate, DROPPED_PROBES commands a
 * course, each asked of the module that keeps it), so a store
 * with many dropped courses never makes one person's erasure cost what all of them would, and never pushes a deletion
 * the law requires past the studio's window (Codex X3 on #4436).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";

/** The most dropped courses remembered for a store: as many as its catalog may hold. */
export const MAX_REMOVED_COURSES = MAX_PRODUCTS;

/** The most lessons or modules noted per course: a course outline's own ceiling is far below. */
const MAX_IDS = 5_000;

const removedKey = (statsId: string) => `nl:coursegone:${statsId}`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One dropped course, as the erasure needs it. */
export type RemovedCourse = { productId: string; courseId: string; lessonIds: string[]; moduleIds: string[] };

/**
 * In one step, as Redis runs a script: a course already on the list has its record replaced; a new one is added only
 * while the list has room, never by dropping another. 1 added, 0 replaced, -1 full.
 */
export const NOTE_REMOVED_COURSE = `-- marktmorgen:removed-course-note:v1
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 1 then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
  return 0
end
if redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/**
 * Notes a course as dropped, with its lessons and modules, before its outline is deleted: "noted", or "full" when the
 * list has no room for a course not on it yet (nothing written). Throws when neither is confirmed.
 */
export async function noteRemovedCourse(statsId: string | null | undefined, course: RemovedCourse): Promise<"noted" | "full"> {
  if (!statsId || !isRedisConfigured()) return "noted";
  const ids = [course.courseId, ...course.lessonIds, ...course.moduleIds];
  if (!ID.test(course.courseId) || (course.productId && !ID.test(course.productId)) || !ids.every((id) => ID.test(id))) throw new UnknownReplyError("a dropped course's ids");
  const record = JSON.stringify({ p: course.productId, l: course.lessonIds.slice(0, MAX_IDS), m: course.moduleIds.slice(0, MAX_IDS) });
  const replies = repliesFor(await redisPipeline([["EVAL", NOTE_REMOVED_COURSE, 1, removedKey(statsId), course.courseId, record, MAX_REMOVED_COURSES]]), 1);
  const answer = replies ? replies[0] : null;
  if (answer === 1 || answer === 0) return "noted";
  if (answer === -1) return "full";
  throw new UnknownReplyError("noting a dropped course");
}

const idList = (value: unknown): string[] | null => (Array.isArray(value) && value.length <= MAX_IDS && value.every((id) => typeof id === "string" && ID.test(id)) ? (value as string[]) : null);

/** The courses this store dropped; an unknown reply, or a record in another shape, throws, never "none". */
export async function removedCourses(statsId: string | null | undefined): Promise<RemovedCourse[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["HGETALL", removedKey(statsId)]]), 1);
  const pairs = replies ? stringList(replies[0]) : null;
  if (!pairs || pairs.length % 2 || pairs.length / 2 > MAX_REMOVED_COURSES) throw new UnknownReplyError("a store's dropped courses");
  const out: RemovedCourse[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    let record: { p?: unknown; l?: unknown; m?: unknown } | null;
    try {
      record = JSON.parse(pairs[i + 1]) as { p?: unknown; l?: unknown; m?: unknown } | null;
    } catch {
      record = null;
    }
    const lessonIds = idList(record?.l);
    const moduleIds = idList(record?.m);
    const productId = record?.p;
    if (!ID.test(pairs[i]) || !lessonIds || !moduleIds || typeof productId !== "string") throw new UnknownReplyError("a store's dropped courses");
    out.push({ courseId: pairs[i], productId, lessonIds, moduleIds });
  }
  return out;
}

/** The commands an erasure sends for each dropped course, to learn whether the person has a record in it. */
export const DROPPED_PROBES = 4;

