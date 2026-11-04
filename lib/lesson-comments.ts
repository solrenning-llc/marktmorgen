/**
 * Comments under a course's lessons, kept (the rules are in
 * lib/lesson-comments-rules.ts).
 *
 *   nl:lc:<course>:c            hash   comment id → the comment
 *   nl:lc:<course>:l:<lesson>   zset   the lesson's comments, by when
 *   nl:lc:<course>:all          zset   the course's newest comments, for the studio
 *   nl:lc:<course>:r            hash   comment id → how many answers it has
 *   nl:lc:<course>:names        hash   a student's key → the name they chose
 *   nl:lc:<course>:off          string present when the creator switched comments off
 *   nl:lc:<course>:seen         string when the studio last showed the creator the comments
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { newItemId } from "@/lib/course";
import { cleanLine, cleanText } from "@/lib/community-text";
import {
  COMMENT_ID_PATTERN,
  CREATOR_AUTHOR,
  type LessonComment,
  MAX_COMMENTER_NAME,
  MAX_LESSON_COMMENT,
  MAX_LESSON_THREADS,
  MAX_REPLIES,
  parseComment,
  serializeComment,
} from "@/lib/lesson-comments-rules";

const commentsKey = (course: string) => `nl:lc:${course}:c`;
const lessonKey = (course: string, lesson: string) => `nl:lc:${course}:l:${lesson}`;
const allKey = (course: string) => `nl:lc:${course}:all`;
const repliesKey = (course: string) => `nl:lc:${course}:r`;
const namesKey = (course: string) => `nl:lc:${course}:names`;
const offKey = (course: string) => `nl:lc:${course}:off`;
const seenKey = (course: string) => `nl:lc:${course}:seen`;

/**
 * Where a course's comments are counted in the store's data room
 * (lib/store-data.ts): one slot a course, each comment as its record, its
 * place under its lesson, in the studio's list and its count of answers.
 */
const COMMENTS_SLOT = (course: string) => `lc:${course}`;
const commentBytes = (comment: LessonComment) => dataBytes([serializeComment(comment)], 4);

/** The studio's list keeps this many of a course's newest comments. */
const RECENT_KEPT = 1_000;
/** The most comments of every kind one lesson keeps. */
const LESSON_KEPT = MAX_LESSON_THREADS * 4;

function commentsFrom(raw: unknown): LessonComment[] {
  return Array.isArray(raw) ? raw.map(parseComment).filter((c): c is LessonComment => c !== null) : [];
}

export async function commentsOn(courseId: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const [off] = await redisPipeline([["GET", offKey(courseId)]]);
  return off === null || off === undefined;
}

export async function setCommentsOn(courseId: string, on: boolean): Promise<void> {
  await redisPipeline([on ? ["DEL", offKey(courseId)] : ["SET", offKey(courseId), "1"]]);
}

/** The name a student shows, or "" if they have not chosen one yet. */
export async function commenterName(courseId: string, key: string): Promise<string> {
  if (!isRedisConfigured()) return "";
  const [raw] = await redisPipeline([["HGET", namesKey(courseId), key]]);
  return typeof raw === "string" ? raw : "";
}

/** Every comment kept under one lesson, newest first. */
export async function lessonComments(courseId: string, lessonId: string): Promise<LessonComment[]> {
  if (!isRedisConfigured()) return [];
  const [ids] = await redisPipeline([["ZREVRANGE", lessonKey(courseId, lessonId), 0, LESSON_KEPT - 1]]);
  const list = Array.isArray(ids) ? (ids as string[]) : [];
  if (!list.length) return [];
  const [rows] = await redisPipeline([["HMGET", commentsKey(courseId), ...list]]);
  return commentsFrom(rows);
}

export async function readComment(courseId: string, id: string): Promise<LessonComment | null> {
  if (!isRedisConfigured() || !COMMENT_ID_PATTERN.test(id)) return null;
  const [raw] = await redisPipeline([["HGET", commentsKey(courseId), id]]);
  return parseComment(raw);
}

export type AddResult =
  | { ok: true; comment: LessonComment; parent: LessonComment | null }
  | { ok: false; reason: "empty" | "name" | "parent" | "replies" | "full" };

/**
 * Writes a comment. A student's name is the one they give now, or the one
 * they gave before; without either, nothing is written and "name" says why.
 */
export async function addComment(input: {
  courseId: string;
  lessonId: string;
  by: string;
  text: unknown;
  name?: unknown;
  parent?: string | null;
  now?: number;
  /** The store whose data room it takes from (DataRoomError when it does not fit). */
  room: DataStore;
}): Promise<AddResult> {
  const text = cleanText(input.text, MAX_LESSON_COMMENT);
  if (!text) return { ok: false, reason: "empty" };
  const now = input.now ?? Math.floor(Date.now() / 1000);

  let name = "";
  if (input.by !== CREATOR_AUTHOR) {
    const given = cleanLine(input.name, MAX_COMMENTER_NAME);
    name = given || (await commenterName(input.courseId, input.by));
    if (!name) return { ok: false, reason: "name" };
    if (given) {
      await needData(input.room, [{ slot: COMMENTS_SLOT(input.courseId), bytes: dataBytes([input.by, given], 1) }]);
      await redisPipeline([["HSET", namesKey(input.courseId), input.by, given]]);
    }
  }

  let parent: LessonComment | null = null;
  if (input.parent) {
    parent = await readComment(input.courseId, input.parent);
    // One level of answers, under a comment of this same lesson.
    if (!parent || parent.lesson !== input.lessonId || parent.parent !== null) return { ok: false, reason: "parent" };
    const [count] = await redisPipeline([["HGET", repliesKey(input.courseId), parent.id]]);
    if (Number(count) >= MAX_REPLIES) return { ok: false, reason: "replies" };
  } else {
    const [count] = await redisPipeline([["ZCARD", lessonKey(input.courseId, input.lessonId)]]);
    if (Number(count) >= LESSON_KEPT) return { ok: false, reason: "full" };
  }

  const comment: LessonComment = {
    id: newItemId(),
    lesson: input.lessonId,
    by: input.by,
    name,
    text,
    at: now,
    parent: parent ? parent.id : null,
    hidden: false,
  };
  await needData(input.room, [{ slot: COMMENTS_SLOT(input.courseId), bytes: commentBytes(comment) }]);
  await redisPipeline([
    ["HSET", commentsKey(input.courseId), comment.id, serializeComment(comment)],
    ["ZADD", lessonKey(input.courseId, input.lessonId), now, comment.id],
    ["ZADD", allKey(input.courseId), now, comment.id],
    ["ZREMRANGEBYRANK", allKey(input.courseId), 0, -RECENT_KEPT - 1],
    ...(parent ? [["HINCRBY", repliesKey(input.courseId), parent.id, 1] as (string | number)[]] : []),
  ]);
  return { ok: true, comment, parent };
}

export async function setHidden(courseId: string, id: string, hidden: boolean): Promise<LessonComment | null> {
  const comment = await readComment(courseId, id);
  if (!comment) return null;
  const next = { ...comment, hidden };
  await redisPipeline([["HSET", commentsKey(courseId), id, serializeComment(next)]]);
  return next;
}

/** Deletes a comment, and the answers under it, and gives back their room. Returns how many went. */
export async function deleteComment(courseId: string, id: string, room: DataStore): Promise<number> {
  const comment = await readComment(courseId, id);
  if (!comment) return 0;
  const gone = [comment.id];
  let freed = commentBytes(comment);
  if (comment.parent === null) {
    for (const other of await lessonComments(courseId, comment.lesson)) {
      if (other.parent === comment.id) {
        gone.push(other.id);
        freed += commentBytes(other);
      }
    }
  }
  await redisPipeline([
    ["HDEL", commentsKey(courseId), ...gone],
    ["ZREM", lessonKey(courseId, comment.lesson), ...gone],
    ["ZREM", allKey(courseId), ...gone],
    ["HDEL", repliesKey(courseId), comment.id],
    ...(comment.parent ? [["HINCRBY", repliesKey(courseId), comment.parent, -1] as (string | number)[]] : []),
  ]);
  await giveData(room, [{ slot: COMMENTS_SLOT(courseId), bytes: freed }]);
  return gone.length;
}

/** The course's newest comments, for the studio, and how many came since it last looked. */
export async function recentComments(courseId: string, limit = 50): Promise<{ comments: LessonComment[]; fresh: number; seen: number }> {
  if (!isRedisConfigured()) return { comments: [], fresh: 0, seen: 0 };
  const [ids, seenRaw] = await redisPipeline([
    ["ZREVRANGE", allKey(courseId), 0, limit - 1],
    ["GET", seenKey(courseId)],
  ]);
  const seen = Number(seenRaw) || 0;
  const list = Array.isArray(ids) ? (ids as string[]) : [];
  const [fresh, rows] = await redisPipeline([
    ["ZCOUNT", allKey(courseId), `(${seen}`, "+inf"],
    ...(list.length ? [["HMGET", commentsKey(courseId), ...list]] : []),
  ]);
  return { comments: commentsFrom(rows), fresh: Number(fresh) || 0, seen };
}

/** How many comments came on each course since the studio last showed them. */
export async function freshCounts(courseIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!isRedisConfigured() || !courseIds.length) return counts;
  const seen = await redisPipeline(courseIds.map((id) => ["GET", seenKey(id)]));
  const fresh = await redisPipeline(courseIds.map((id, i) => ["ZCOUNT", allKey(id), `(${Number(seen[i]) || 0}`, "+inf"]));
  courseIds.forEach((id, i) => counts.set(id, Number(fresh[i]) || 0));
  return counts;
}

export async function markSeen(courseId: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await redisPipeline([["SET", seenKey(courseId), String(now)]]);
}

/** Takes every comment of a course away, with the course, and gives back their room. */
export async function dropComments(courseId: string, lessonIds: string[], room: DataStore): Promise<void> {
  if (!isRedisConfigured()) return;
  await redisPipeline([
    ...[commentsKey, allKey, repliesKey, namesKey, offKey, seenKey].map((k) => ["DEL", k(courseId)]),
    ...lessonIds.map((l) => ["DEL", lessonKey(courseId, l)]),
  ]);
  await giveData(room, [{ slot: COMMENTS_SLOT(courseId), bytes: 0, set: true }]);
}

/** Takes away every comment under lessons that are gone from the course. */
export async function dropLessonComments(courseId: string, lessonIds: string[], room: DataStore): Promise<void> {
  if (!isRedisConfigured() || !lessonIds.length) return;
  const rows = await redisPipeline(lessonIds.map((l) => ["ZREVRANGE", lessonKey(courseId, l), 0, -1]));
  const ids = rows.flatMap((r) => (Array.isArray(r) ? (r as string[]) : []));
  // What they weighed, read before they go, comes back to the store's data room.
  const [held] = ids.length ? await redisPipeline([["HMGET", commentsKey(courseId), ...ids]]) : [[]];
  const freed = commentsFrom(held).reduce((sum, c) => sum + commentBytes(c), 0);
  await redisPipeline([
    ...(ids.length
      ? [
          ["HDEL", commentsKey(courseId), ...ids],
          ["ZREM", allKey(courseId), ...ids],
          ["HDEL", repliesKey(courseId), ...ids],
        ]
      : []),
    ...lessonIds.map((l) => ["DEL", lessonKey(courseId, l)]),
  ]);
  if (freed) await giveData(room, [{ slot: COMMENTS_SLOT(courseId), bytes: freed }]);
}

/**
 * Takes one student's comments out of a course, on the Redis side, with the
 * answers under their own comments, as deleting a comment does, and the name
 * they chose. KEYS: the comments, the newest, the answer counts, the names,
 * then each lesson's comments; ARGV: the student's key, then each lesson's
 * id in the same order. Answers how many comments went.
 */
export const FORGET_LESSON_COMMENTS = `-- marktmorgen:lesson-comments-forget:v1
local who = ARGV[1]
local lessons = {}
for i = 5, #KEYS do lessons[ARGV[i - 3]] = KEYS[i] end
local flat = redis.call("HGETALL", KEYS[1])
local all = {}
local tops = {}
for i = 1, #flat, 2 do
  local ok, c = pcall(cjson.decode, flat[i + 1])
  if ok and type(c) == "table" then
    all[flat[i]] = c
    if c.b == who and (c.r == nil or c.r == cjson.null) then tops[flat[i]] = true end
  end
end
local gone = 0
for id, c in pairs(all) do
  local parent = c.r
  if parent == cjson.null then parent = nil end
  if c.b == who or (parent ~= nil and tops[parent]) then
    redis.call("HDEL", KEYS[1], id)
    redis.call("ZREM", KEYS[2], id)
    redis.call("HDEL", KEYS[3], id)
    if lessons[c.l] then redis.call("ZREM", lessons[c.l], id) end
    if parent ~= nil and not tops[parent] and all[parent] then redis.call("HINCRBY", KEYS[3], parent, -1) end
    gone = gone + 1
  end
end
redis.call("HDEL", KEYS[4], who)
return gone`;

/** Deletes one student's comments in a course and the name they chose (lib/person-erasure.ts). `who` is lib/learn.ts emailKey. */
export async function forgetLessonCommentsPerson(courseId: string, lessonIds: string[], who: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([
    ["EVAL", FORGET_LESSON_COMMENTS, 4 + lessonIds.length, commentsKey(courseId), allKey(courseId), repliesKey(courseId), namesKey(courseId), ...lessonIds.map((l) => lessonKey(courseId, l)), who, ...lessonIds],
  ]);
  return Number(gone) || 0;
}
