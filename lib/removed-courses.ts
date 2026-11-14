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
 * bounded. A drop that would need room the list does not have first makes room by an entry whose erasure can no
 * longer be asked for (prunable below), and is refused ("full") when there is none. Courses dropped before this list
 * existed are not on it.
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
import { FINISH_KEEP_SECONDS } from "@/lib/course-finish-rules";
import { type DataStore, dataKey } from "@/lib/store-data";

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

/** The data-room slots (lib/store-data.ts) a course's people's records are counted under, each named `<prefix>:<course id>`: students and lessons done (lib/learn.ts), quiz tries and passes (lib/quiz.ts), certificates (lib/certificate.ts), tasks (lib/assignment.ts) and lesson comments (lib/lesson-comments.ts). */
export const PEOPLE_SLOT_PREFIXES = ["cd", "ct", "cc", "ca", "lc"] as const;

/** The most entries one script looks at: its keys stay bounded; a full drop asks in batches of this many. */
export const PRUNE_AT_MOST = 50;

/**
 * In one step, as Redis runs a script: each named entry leaves the list only if it is still exactly the record read
 * (not noted again since), the store's data room holds none of its people's slots and neither its students nor its
 * certificates are there any more. KEYS: the list, the data room, then each course's students and certificates.
 * ARGV: each course's id and record. Answers how many left.
 */
export const PRUNE_REMOVED_COURSES = `-- marktmorgen:removed-course-prune:v1
local left = 0
for i = 1, #ARGV, 2 do
  local id = ARGV[i]
  local k = 3 + (i - 1)
  local held = redis.call("HGET", KEYS[1], id) ~= ARGV[i + 1]
  for _, prefix in ipairs({"cd", "ct", "cc", "ca", "lc"}) do
    if not held and redis.call("HEXISTS", KEYS[2], prefix .. ":" .. id) == 1 then held = true end
  end
  if not held and (redis.call("EXISTS", KEYS[k]) == 1 or redis.call("EXISTS", KEYS[k + 1]) == 1) then held = true end
  if not held then
    redis.call("HDEL", KEYS[1], id)
    left = left + 1
  end
end
return left`;

/**
 * The entries whose erasure can no longer be asked for, and so may leave a full list: dropped at least
 * FINISH_KEEP_SECONDS ago (the keep of the course's start and finish marks, the only records of it the data room does
 * not count), oldest first. Whether anything of each is left is asked by the script.
 * An entry with no drop time (noted before it was kept) is never one of them.
 */
function prunable(pairs: string[], nowSeconds: number): { courseId: string; record: string }[] {
  const out: { courseId: string; record: string; t: number }[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    let t: unknown;
    try {
      t = (JSON.parse(pairs[i + 1]) as { t?: unknown } | null)?.t;
    } catch {
      t = undefined;
    }
    if (ID.test(pairs[i]) && Number.isSafeInteger(t) && (t as number) > 0 && (t as number) <= nowSeconds - FINISH_KEEP_SECONDS) out.push({ courseId: pairs[i], record: pairs[i + 1], t: t as number });
  }
  return out.sort((a, b) => a.t - b.t).map(({ courseId, record }) => ({ courseId, record }));
}

/**
 * A course's two indexes of people, given by the caller so this file imports no course module (lib/learn.ts and
 * lib/certificate.ts import lib/course.ts, which imports this file): its students (lib/learn.ts studentsIndexKey) and
 * its certificates (lib/certificate.ts allKey). lib/certificate.ts courseIndexes builds it.
 */
export type CourseIndexes = (courseId: string) => [students: string, certificates: string];

/**
 * Makes room in a full list by the entries that hold nothing any more: how many left. The candidates are asked in
 * batches of PRUNE_AT_MOST, oldest first, stopping at the first batch that made room, so a full drop sends at most one
 * HGETALL and MAX_REMOVED_COURSES / PRUNE_AT_MOST scripts. Throws when that is unknown.
 */
async function makeRoom(statsId: string, room: Pick<DataStore, "sid" | "statsId" | "handle">, indexes: CourseIndexes): Promise<number> {
  const roomKey = dataKey(room);
  if (!roomKey) return 0;
  const replies = repliesFor(await redisPipeline([["HGETALL", removedKey(statsId)]]), 1);
  const pairs = replies ? stringList(replies[0]) : null;
  if (!pairs || pairs.length % 2 || pairs.length / 2 > MAX_REMOVED_COURSES) throw new UnknownReplyError("a store's dropped courses");
  const candidates = prunable(pairs, Math.floor(Date.now() / 1000));
  if (candidates.length === 0) return 0;
  for (let at = 0; at < candidates.length; at += PRUNE_AT_MOST) {
    const batch = candidates.slice(at, at + PRUNE_AT_MOST);
    const keys = [removedKey(statsId), roomKey, ...batch.flatMap(({ courseId }) => { const [students, certificates] = indexes(courseId); return [students, certificates]; })];
    const args = batch.flatMap(({ courseId, record }) => [courseId, record]);
    const left = repliesFor(await redisPipeline([["EVAL", PRUNE_REMOVED_COURSES, keys.length, ...keys, ...args]]), 1)?.[0];
    if (!Number.isSafeInteger(left) || (left as number) < 0 || (left as number) > batch.length) throw new UnknownReplyError("making room in a store's dropped courses");
    if ((left as number) > 0) return left as number;
  }
  return 0;
}

/**
 * Notes a course as dropped, with its lessons, its modules and when, before its outline is deleted: "noted", or
 * "full" when the list has no room for a course not on it yet and none could be made (nothing written). With the
 * store's data room and the course's indexes of people, a full list first makes room by the entries whose erasure can no longer be asked for. Throws
 * when neither is confirmed.
 */
export async function noteRemovedCourse(statsId: string | null | undefined, course: RemovedCourse, room?: Pick<DataStore, "sid" | "statsId" | "handle">, indexes?: CourseIndexes): Promise<"noted" | "full"> {
  if (!statsId || !isRedisConfigured()) return "noted";
  const ids = [course.courseId, ...course.lessonIds, ...course.moduleIds];
  if (!ID.test(course.courseId) || (course.productId && !ID.test(course.productId)) || !ids.every((id) => ID.test(id))) throw new UnknownReplyError("a dropped course's ids");
  const record = JSON.stringify({ p: course.productId, l: course.lessonIds.slice(0, MAX_IDS), m: course.moduleIds.slice(0, MAX_IDS), t: Math.floor(Date.now() / 1000) });
  const note = async (): Promise<"noted" | "full"> => {
    const replies = repliesFor(await redisPipeline([["EVAL", NOTE_REMOVED_COURSE, 1, removedKey(statsId), course.courseId, record, MAX_REMOVED_COURSES]]), 1);
    const answer = replies ? replies[0] : null;
    if (answer === 1 || answer === 0) return "noted";
    if (answer === -1) return "full";
    throw new UnknownReplyError("noting a dropped course");
  };
  const first = await note();
  if (first === "noted" || !room || !indexes) return first;
  return (await makeRoom(statsId, room, indexes)) > 0 ? note() : "full";
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

