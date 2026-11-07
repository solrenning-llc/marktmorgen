/**
 * A student's quick rating of a lesson, kept (296 [SQ7]; the rules are in
 * lib/lesson-rating-rules.ts).
 *
 *   nl:lr:<course>:l:<lesson>   hash   student's key (lib/learn.ts emailKey) → their rating
 *   nl:lr:<course>:ls           set    the lessons that hold at least one rating
 *
 * The set lets a person's deletion and their copy find every rating they
 * gave, a lesson the creator removed since included. A lesson leaves it in the
 * same step that takes its last rating out, or with all its ratings when the
 * creator removes it (dropLessonRatings). A person's deletion is priced at
 * every lesson in it (ratedLessonCount, lib/person-erasure.ts erasureSize).
 *
 * Every rating takes RATING_ROOM_BYTES of the store's data room before it is
 * written, once per student and lesson; a change takes nothing more. A
 * deletion gives the room back in the same script that deletes (the data
 * room's own steps, TAKE_DATA, run first inside it), so a give-back is never
 * lost after the ratings went, and a room that cannot be counted deletes
 * nothing. A reply that is not exactly what was asked for leaves the outcome
 * unknown: the charge stays (never less than what may be kept) and the
 * caller is told.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, TAKE_DATA, dataKey, giveData, monthOf, needData } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import { UnknownReply, exactReplies, plainList } from "@/lib/redis-exact";
import { ITEM_ID_PATTERN } from "@/lib/course";
import {
  type LessonRating,
  MAX_LESSON_RATINGS,
  RATING_ROOM_BYTES,
  cleanNote,
  parseRating,
  parseScore,
  serializeRating,
} from "@/lib/lesson-rating-rules";

const lessonKey = (course: string, lesson: string) => `nl:lr:${course}:l:${lesson}`;
const indexKey = (course: string) => `nl:lr:${course}:ls`;
/** Where a course's ratings are counted in the store's data room. */
const RATINGS_SLOT = (course: string) => `lr:${course}`;

const unreadable = () => new Error("Lesson ratings could not be read. Try again.");

/**
 * The data room's own steps (TAKE_DATA) for a course's slot, grown or shrunk
 * by `bytes`, inside a script whose KEYS[1] is the room. Its own name, so it
 * never meets lib/course-survey.ts's helper of the same shape.
 */
const RATINGS_ROOM = `local function ratingsRoom(limit, month, slot, bytes)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, '1', month, 'a', slot, bytes}
${TAKE_DATA}
end`;

/**
 * Keeps one student's rating of a lesson. KEYS: the lesson's ratings, the
 * course's rated lessons; ARGV: the student's key, the record, the most
 * raters, the lesson. Answers 1 when it is a new rating, 2 when it changed
 * one already kept, 4 when the lesson is full and nothing was written, 0 when
 * its own limits could not be read and nothing was written.
 */
export const SET_LESSON_RATING = `-- marktmorgen:lesson-rating-set:v1
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 1 then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
  return 2
end
local count = tonumber(redis.call("HLEN", KEYS[1]))
local most = tonumber(ARGV[3])
if not count or not most or most < 1 then return 0 end
if count >= most then return 4 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("SADD", KEYS[2], ARGV[4])
return 1`;

/**
 * Takes one student's ratings out of the lessons named, each lesson out of
 * the course's rated lessons when it was its last, and gives back their room
 * in the same step. KEYS: the store's data room, the course's rated lessons,
 * then each lesson's ratings; ARGV: the room's limit, this month, the
 * course's slot, the bytes a rating is charged at, the student's key, then
 * each lesson (in KEYS' order). The room's step comes first: when it cannot
 * be made ({-1, total, 0}) nothing is taken out. Answers {1, total, how many
 * went}, {1, 0, 0} when there was none. Modelled by lib/redis-memory.ts.
 */
export const DROP_LESSON_RATING = `-- marktmorgen:lesson-rating-drop:v2
${RATINGS_ROOM}
local each = tonumber(ARGV[4])
if not each or each < 0 or #KEYS < 3 or #KEYS - 2 ~= #ARGV - 5 then return {-1, 0, 0} end
local held = 0
for i = 3, #KEYS do
  if redis.call("HEXISTS", KEYS[i], ARGV[5]) == 1 then held = held + 1 end
end
if held == 0 then
  for i = 3, #KEYS do
    if redis.call("HLEN", KEYS[i]) == 0 then redis.call("SREM", KEYS[2], ARGV[i + 3]) end
  end
  return {1, 0, 0}
end
local taken = ratingsRoom(ARGV[1], ARGV[2], ARGV[3], -held * each)
if taken[1] ~= 1 then return {taken[1], taken[2], 0} end
for i = 3, #KEYS do
  redis.call("HDEL", KEYS[i], ARGV[5])
  if redis.call("HLEN", KEYS[i]) == 0 then redis.call("SREM", KEYS[2], ARGV[i + 3]) end
end
return {1, taken[2], held}`;

/**
 * Takes every rating of the lessons the creator removed, each lesson out of
 * the course's rated lessons, and gives back their room in the same step.
 * KEYS: the store's data room, the course's rated lessons, then each lesson's
 * ratings; ARGV: the room's limit, this month, the course's slot, the bytes a
 * rating is charged at, then each lesson (in KEYS' order). The room's step
 * comes first: when it cannot be made ({-1, total, 0}) nothing is deleted.
 * Answers {1, total, how many went}. Modelled by lib/redis-memory.ts.
 */
export const DROP_LESSON_RATINGS = `-- marktmorgen:lesson-ratings-drop-lesson:v2
${RATINGS_ROOM}
local each = tonumber(ARGV[4])
if not each or each < 0 or #KEYS < 3 or #KEYS - 2 ~= #ARGV - 4 then return {-1, 0, 0} end
local count = 0
for i = 3, #KEYS do count = count + redis.call("HLEN", KEYS[i]) end
local taken = ratingsRoom(ARGV[1], ARGV[2], ARGV[3], -count * each)
if taken[1] ~= 1 then return {taken[1], taken[2], 0} end
for i = 3, #KEYS do
  redis.call("DEL", KEYS[i])
  redis.call("SREM", KEYS[2], ARGV[i + 2])
end
return {1, taken[2], count}`;

/**
 * Reads every rating of a lesson, only while there are no more than were paid
 * for. KEYS: the lesson's ratings; ARGV: the most. Answers {1, flat field and
 * value list}, or {0, the count} without reading them.
 */
export const READ_LESSON_RATINGS = `-- marktmorgen:lesson-rating-read:v1
local count = redis.call("HLEN", KEYS[1])
if count > tonumber(ARGV[1]) then return {0, count} end
return {1, redis.call("HGETALL", KEYS[1])}`;

/**
 * Runs one of the scripts that delete ratings with their room
 * (DROP_LESSON_RATING, DROP_LESSON_RATINGS) over these lessons and answers
 * how many went. A store with no room to count in, a room that cannot be
 * counted, or a reply that is not exactly the script's throws UnknownReply:
 * nothing is deleted for none, and nothing is given back that was not.
 */
async function dropWithRoom(script: string, courseId: string, lessons: readonly string[], room: DataStore, who: string[], what: string): Promise<number> {
  const key = dataKey(room);
  if (!key) throw new UnknownReply(what);
  // A lesson named twice would be counted twice before it went, and give back room it never took.
  lessons = [...new Set(lessons)];
  const now = Date.now();
  const [reply] = exactReplies(
    await redisPipeline([[
      "EVAL",
      script,
      2 + lessons.length,
      key,
      indexKey(courseId),
      ...lessons.map((lesson) => lessonKey(courseId, lesson)),
      contentRoomFor(room, now / 1000),
      monthOf(now),
      RATINGS_SLOT(courseId),
      RATING_ROOM_BYTES,
      ...who,
      ...lessons,
    ]]),
    1,
    what,
  );
  const [state, , gone] = exactReplies(reply, 3, what);
  if (state !== 1 || typeof gone !== "number" || !Number.isSafeInteger(gone) || gone < 0) throw new UnknownReply(what);
  return gone;
}

/** The student's own rating of a lesson, or null when they gave none. */
export async function readMyRating(courseId: string, lessonId: string, who: string): Promise<LessonRating | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = exactReplies(await redisPipeline([["HGET", lessonKey(courseId, lessonId), who]]), 1, "a lesson rating");
  if (raw === null) return null;
  const rating = parseRating(raw);
  if (!rating) throw unreadable();
  return rating;
}

/** How many students rated a lesson. */
export async function lessonRatingCount(courseId: string, lessonId: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [count] = exactReplies(await redisPipeline([["HLEN", lessonKey(courseId, lessonId)]]), 1, "a lesson's rating count");
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw unreadable();
  return count;
}

export type RateResult = { ok: true; changed: boolean } | { ok: false; reason: "score" | "full" | "unknown" };

/**
 * Keeps a student's rating of a lesson, or changes the one they gave. The
 * room is taken first (DataRoomError when the store has none left), and
 * given back when the rating was a change or the lesson was full.
 */
export async function rateLesson(input: {
  courseId: string;
  lessonId: string;
  /** lib/learn.ts emailKey of the student. */
  who: string;
  score: unknown;
  note: unknown;
  now?: number;
  room: DataStore;
}): Promise<RateResult> {
  const score = parseScore(input.score);
  if (score === null) return { ok: false, reason: "score" };
  if (!isRedisConfigured()) return { ok: false, reason: "unknown" };
  const rating: LessonRating = { score, note: cleanNote(input.note), at: input.now ?? Math.floor(Date.now() / 1000) };
  const charge = [{ slot: RATINGS_SLOT(input.courseId), bytes: RATING_ROOM_BYTES }];
  await needData(input.room, charge);
  let written: unknown;
  try {
    [written] = exactReplies(
      await redisPipeline([[
        "EVAL",
        SET_LESSON_RATING,
        2,
        lessonKey(input.courseId, input.lessonId),
        indexKey(input.courseId),
        input.who,
        serializeRating(rating),
        MAX_LESSON_RATINGS,
        input.lessonId,
      ]]),
      1,
      "a lesson rating's write",
    );
  } catch {
    // Not known whether it was written: the charge stays.
    return { ok: false, reason: "unknown" };
  }
  if (written === 1) return { ok: true, changed: false };
  if (written === 2) {
    await giveData(input.room, charge);
    return { ok: true, changed: true };
  }
  if (written === 4 || written === 0) {
    await giveData(input.room, charge);
    return { ok: false, reason: written === 4 ? "full" : "unknown" };
  }
  return { ok: false, reason: "unknown" };
}

/**
 * Takes a student's rating of a lesson out; true when one went, its room back
 * in the same step. A reply that is not exactly the script's throws UnknownReply.
 */
export async function removeMyRating(courseId: string, lessonId: string, who: string, room: DataStore): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const what = "a lesson rating's removal";
  const gone = await dropWithRoom(DROP_LESSON_RATING, courseId, [lessonId], room, [who], what);
  if (gone !== 0 && gone !== 1) throw new UnknownReply(what);
  return gone === 1;
}

/**
 * Every rating of a lesson, without whose it is, while there are at most
 * `most`; otherwise how many there are, nothing read. The caller pays for
 * `most` before (lib/lesson-rating-rules.ts ratingReadUnits).
 */
export async function readLessonRatings(
  courseId: string,
  lessonId: string,
  most: number,
): Promise<{ ok: true; ratings: LessonRating[] } | { ok: false; count: number }> {
  if (!isRedisConfigured()) return { ok: true, ratings: [] };
  const what = "a lesson's ratings";
  const [reply] = exactReplies(await redisPipeline([["EVAL", READ_LESSON_RATINGS, 1, lessonKey(courseId, lessonId), Math.max(0, Math.floor(most))]]), 1, what);
  const [state, body] = exactReplies(reply, 2, what);
  if (state === 0) {
    if (typeof body !== "number" || !Number.isSafeInteger(body) || body < 0) throw new UnknownReply(what);
    return { ok: false, count: body };
  }
  const flat = plainList(body);
  if (state !== 1 || !flat || flat.length % 2 !== 0 || flat.length / 2 > Math.max(0, most)) throw new UnknownReply(what);
  const ratings: LessonRating[] = [];
  // Only the values: whose rating it is never leaves this function.
  for (let i = 1; i < flat.length; i += 2) {
    const rating = parseRating(flat[i]);
    if (!rating) throw unreadable();
    ratings.push(rating);
  }
  return { ok: true, ratings };
}

/** The lessons of a course that hold at least one rating. */
async function ratedLessons(courseId: string): Promise<string[]> {
  const what = "a course's rated lessons";
  const [raw] = exactReplies(await redisPipeline([["SMEMBERS", indexKey(courseId)]]), 1, what);
  const list = plainList(raw);
  if (!list || !list.every((id): id is string => typeof id === "string")) throw new UnknownReply(what);
  return list;
}

/** One person's ratings in a course, for the copy of their data (lib/person-copy.ts). */
export async function ratingsOfPerson(courseId: string, who: string): Promise<{ lesson: string; rating: LessonRating }[]> {
  if (!isRedisConfigured()) return [];
  const lessons = await ratedLessons(courseId);
  if (!lessons.length) return [];
  const raws = exactReplies(await redisPipeline(lessons.map((lesson) => ["HGET", lessonKey(courseId, lesson), who])), lessons.length, "a person's lesson ratings");
  const out: { lesson: string; rating: LessonRating }[] = [];
  raws.forEach((raw, i) => {
    if (raw === null) return;
    const rating = parseRating(raw);
    if (!rating) throw unreadable();
    out.push({ lesson: lessons[i], rating });
  });
  return out;
}

/**
 * Deletes one person's ratings from every lesson of a course they rated
 * (lib/person-erasure.ts), a lesson no longer in the course too, and gives
 * back their room in the same step (DROP_LESSON_RATING, one script for every
 * lesson). Answers how many went; a room that cannot be counted deletes
 * nothing, and a reply that is not exactly the script's throws UnknownReply.
 */
export async function forgetLessonRatingsPerson(courseId: string, who: string, room: DataStore): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const lessons = await ratedLessons(courseId);
  if (!lessons.length) return 0;
  const what = "the deletion of a person's lesson ratings";
  const gone = await dropWithRoom(DROP_LESSON_RATING, courseId, lessons, room, [who], what);
  if (gone > lessons.length) throw new UnknownReply(what);
  return gone;
}

/**
 * Takes away every rating of lessons gone from a course (the creator removed
 * the lesson or its module), with each lesson's place in the course's rated
 * lessons, and gives back their room in the same step (DROP_LESSON_RATINGS,
 * one script for every lesson). Answers how many went; a room that cannot be
 * counted deletes nothing, and a reply that is not exactly the script's
 * throws UnknownReply.
 */
export async function dropLessonRatings(courseId: string, lessonIds: readonly string[], room: DataStore): Promise<number> {
  if (!isRedisConfigured() || !lessonIds.length) return 0;
  return dropWithRoom(DROP_LESSON_RATINGS, courseId, lessonIds, room, [], "the deletion of a removed lesson's ratings");
}

/**
 * How many lessons of these courses hold a rating, a lesson no longer in its
 * course too: what a person's deletion walks (forgetLessonRatingsPerson), so
 * its price counts them (lib/person-erasure.ts erasureSize). A reply that is
 * not a count throws UnknownReply: never taken for none.
 */
export async function ratedLessonCount(courseIds: readonly string[]): Promise<number> {
  if (!isRedisConfigured() || !courseIds.length) return 0;
  const what = "the count of a course's rated lessons";
  const replies = exactReplies(await redisPipeline(courseIds.map((course) => ["SCARD", indexKey(course)])), courseIds.length, what);
  let sum = 0;
  for (const reply of replies) {
    if (typeof reply !== "number" || !Number.isSafeInteger(reply) || reply < 0) throw new UnknownReply(what);
    sum += reply;
  }
  return sum;
}

/**
 * Takes away every rating of a course the creator removes or turns off, a
 * lesson no longer in it too, found by the course's index, and gives back
 * their room in the same step as each drop. Answers how many went.
 *
 * Each lesson leaves the index in the same step its ratings go
 * (DROP_LESSON_RATINGS), so the index is gone once it is empty: there is no
 * separate DEL, which could drop the place of a rating written in between
 * and leave it out of reach. A pass that finds the index still holding
 * lessons reads it again, a few times at the most; one it cannot empty, or
 * an entry that is not a lesson id, throws UnknownReply with nothing of
 * that entry taken, so the caller can refuse the removal and it can be
 * asked again.
 */
export async function dropCourseRatings(courseId: string, room: DataStore): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const what = "a removed course's rated lessons";
  let gone = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const lessons = await ratedLessons(courseId);
    if (!lessons.length) return gone;
    if (!lessons.every((lesson) => ITEM_ID_PATTERN.test(lesson))) throw new UnknownReply(what);
    gone += await dropLessonRatings(courseId, lessons, room);
  }
  if ((await ratedLessons(courseId)).length) throw new UnknownReply(what);
  return gone;
}
