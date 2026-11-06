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
import { DATA_STEP_BYTES, ENTRY_BYTES, dataBytes } from "@/lib/store-data-rules";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";
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
/**
 * What a comment was charged: it is written visible, and hiding it later adds
 * a mark that was never charged, so the room it gives back is always the
 * visible one.
 */
const commentBytes = (comment: LessonComment) => dataBytes([serializeComment({ ...comment, hidden: false })], 4);
/** The room the comments a script really took out give back. */
const takenBytes = (raws: unknown) => commentsFrom(Array.isArray(raws) ? raws : []).reduce((sum, c) => sum + commentBytes(c), 0);

/** The studio's list keeps this many of a course's newest comments. */
const RECENT_KEPT = 1_000;
/** The most comments of every kind one lesson keeps. */
const LESSON_KEPT = MAX_LESSON_THREADS * 4;
/** The largest lesson index admitted by the existing thread and reply caps. */
const LESSON_INDEX_KEPT = LESSON_KEPT * (MAX_REPLIES + 1);

function commentsFrom(raw: unknown): LessonComment[] {
  return Array.isArray(raw) ? raw.map(parseComment).filter((c): c is LessonComment => c !== null) : [];
}

const unreadableComments = () => new Error("Lesson comments could not be read. Try again.");

function dataSlot(array: unknown[], index: number): unknown {
  const slot = Object.getOwnPropertyDescriptor(array, String(index));
  if (!slot || !Object.hasOwn(slot, "value")) throw unreadableComments();
  return slot.value;
}

function oneReply(reply: unknown): unknown {
  if (!Array.isArray(reply) || reply.length !== 1) throw unreadableComments();
  return dataSlot(reply, 0);
}

function confirmedCommentWrite(reply: unknown, hasParent: boolean): boolean {
  const expected = 5;
  if (!Array.isArray(reply) || reply.length !== expected) return false;
  const values: number[] = [];
  try {
    for (let index = 0; index < expected; index += 1) {
      const value = dataSlot(reply, index);
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return false;
      values.push(value);
    }
  } catch {
    return false;
  }
  return values[0] === 1
    && values[1] === 1
    && values[2] === 1
    && (hasParent ? values[4] >= 1 : values[4] === 0);
}

function confirmedCommentRefusal(reply: unknown): "parent" | "replies" | "full" | null {
  if (!Array.isArray(reply) || reply.length !== 5) return null;
  try {
    const code = dataSlot(reply, 0);
    if (![1, 2, 4].includes(typeof code === "number" ? code : 0)) return null;
    for (let index = 1; index < 5; index += 1) if (dataSlot(reply, index) !== 0) return null;
    return code === 1 ? "parent" : code === 2 ? "replies" : "full";
  } catch {
    return null;
  }
}

/**
 * Writes a comment with an exact receipt. A reply is admitted only while its
 * canonical root parent is still under this lesson and below its answer cap;
 * a root is admitted only while the lesson is below its own cap. Exact
 * positive refusal codes mean that nothing was written: 1 parent gone, 2
 * replies full, 4 lesson full. Every other non-write receipt is unknown.
 */
export const ADD_LESSON_COMMENT = `-- marktmorgen:lesson-comments-add:v2
local parentId = ARGV[1]
local lessonId = ARGV[2]
local replies = 0
if parentId ~= "" then
  local raw = redis.call("HGET", KEYS[1], parentId)
  if not raw then return {1, 0, 0, 0, 0} end
  local ok, parent = pcall(cjson.decode, raw)
  if not ok or type(parent) ~= "table" or parent.id ~= parentId or parent.l ~= lessonId or (parent.r ~= nil and parent.r ~= cjson.null) then return {3, 0, 0, 0, 0} end
  replies = tonumber(redis.call("HGET", KEYS[4], parentId) or "0")
  local mostReplies = tonumber(ARGV[6])
  if not replies or replies < 0 or not mostReplies or mostReplies < 1 then return {3, 0, 0, 0, 0} end
  if replies >= mostReplies then return {2, 0, 0, 0, 0} end
else
  local lessonCount = tonumber(redis.call("ZCARD", KEYS[2]))
  local mostLesson = tonumber(ARGV[8])
  if not lessonCount or lessonCount < 0 or not mostLesson or mostLesson < 1 then return {3, 0, 0, 0, 0} end
  if lessonCount >= mostLesson then return {4, 0, 0, 0, 0} end
end
local kept = redis.call("HSET", KEYS[1], ARGV[3], ARGV[4])
local lesson = redis.call("ZADD", KEYS[2], ARGV[5], ARGV[3])
local newest = redis.call("ZADD", KEYS[3], ARGV[5], ARGV[3])
local trimmed = redis.call("ZREMRANGEBYRANK", KEYS[3], 0, -tonumber(ARGV[7]) - 1)
local count = 0
if parentId ~= "" then count = redis.call("HINCRBY", KEYS[4], parentId, 1) end
return {kept, lesson, newest, trimmed, count}`;

/**
 * Deletes one reply, or a parent and every reply visible in its bounded
 * lesson index, in one Redis turn. It returns only the confirmed count and
 * the exact room bytes represented by the stored canonical JSON. A malformed
 * link or index returns unknown before any mutation.
 */
const DELETE_THREAD = `-- marktmorgen:lesson-comment-thread-delete:v1
local target = ARGV[1]
local lesson = ARGV[2]
local most = tonumber(ARGV[3])
local entry = tonumber(ARGV[4])
local step = tonumber(ARGV[5])
local function validId(value)
  return type(value) == "string" and string.len(value) == 12 and string.match(value, "^[a-z0-9]+$") ~= nil
end
local function parsed(raw, expected)
  local ok, comment = pcall(cjson.decode, raw)
  if not ok or type(comment) ~= "table" or comment.id ~= expected or comment.l ~= lesson or type(comment.b) ~= "string" or type(comment.t) ~= "string" then return nil, false, false end
  local parent = comment.r
  if parent == cjson.null then parent = nil end
  if parent ~= nil and not validId(parent) then return nil, false, false end
  return parent, comment.h == true, true
end
local raw = redis.call("HGET", KEYS[1], target)
if not raw then return {0, 0} end
local parent, hidden, ok = parsed(raw, target)
if not ok then return {-1, 0} end
local gone = {{target, raw, hidden}}
local known = {[target] = true}
if parent == nil then
  local listed = redis.call("ZRANGE", KEYS[2], 0, most)
  if #listed > most then return {-1, 0} end
  local listedRows = {}
  for first = 1, #listed, 1000 do
    local ids = {}
    local last = math.min(first + 999, #listed)
    for index = first, last do table.insert(ids, listed[index]) end
    local rows = redis.call("HMGET", KEYS[1], unpack(ids))
    if #rows ~= #ids then return {-1, 0} end
    for _, row in ipairs(rows) do table.insert(listedRows, row) end
  end
  if #listedRows ~= #listed then return {-1, 0} end
  for index, id in ipairs(listed) do
    local row = listedRows[index]
    if not row then return {-1, 0} end
    local linked, rowHidden, rowOk = parsed(row, id)
    if not rowOk then return {-1, 0} end
    if linked == target and not known[id] then
      known[id] = true
      table.insert(gone, {id, row, rowHidden})
    end
  end
else
  local count = tonumber(redis.call("HGET", KEYS[4], parent) or "")
  if not count or count < 1 then return {-1, 0} end
end
local freed = 0
for _, row in ipairs(gone) do
  local bytes = string.len(row[2])
  if row[3] then bytes = bytes - string.len(',"h":true') end
  freed = freed + math.floor((bytes + entry * 4 + step - 1) / step) * step
end
for _, row in ipairs(gone) do
  redis.call("HDEL", KEYS[1], row[1])
  redis.call("ZREM", KEYS[2], row[1])
  redis.call("ZREM", KEYS[3], row[1])
  redis.call("HDEL", KEYS[4], row[1])
end
if parent ~= nil then redis.call("HINCRBY", KEYS[4], parent, -1) end
return {#gone, freed}`;

function deletionComment(raw: unknown, expectedId: string): LessonComment | null {
  const comment = parseComment(raw);
  if (!comment || comment.id !== expectedId || typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.r !== undefined && value.r !== null && (typeof value.r !== "string" || !COMMENT_ID_PATTERN.test(value.r))) return null;
    return comment;
  } catch {
    return null;
  }
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
  const ids = oneReply(await redisPipeline([["ZREVRANGE", lessonKey(courseId, lessonId), 0, LESSON_KEPT - 1]]));
  if (!Array.isArray(ids) || ids.length > LESSON_KEPT) throw unreadableComments();
  const list: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 1) {
    const id = dataSlot(ids, i);
    if (typeof id !== "string" || !COMMENT_ID_PATTERN.test(id) || seen.has(id)) throw unreadableComments();
    seen.add(id);
    list.push(id);
  }
  if (!list.length) return [];
  const rows = oneReply(await redisPipeline([["HMGET", commentsKey(courseId), ...list]]));
  if (!Array.isArray(rows) || rows.length !== list.length) throw unreadableComments();
  const comments: LessonComment[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = dataSlot(rows, i);
    if (raw === null) continue;
    const comment = parseComment(raw);
    if (!comment || comment.id !== list[i] || comment.lesson !== lessonId) throw unreadableComments();
    comments.push(comment);
  }
  return comments;
}

export async function readComment(courseId: string, id: string): Promise<LessonComment | null> {
  if (!isRedisConfigured() || !COMMENT_ID_PATTERN.test(id)) return null;
  const raw = oneReply(await redisPipeline([["HGET", commentsKey(courseId), id]]));
  if (raw === null) return null;
  const comment = parseComment(raw);
  if (!comment || comment.id !== id) throw unreadableComments();
  return comment;
}

export type AddResult =
  | { ok: true; comment: LessonComment; parent: LessonComment | null }
  | { ok: false; reason: "empty" | "name" | "parent" | "replies" | "full" | "unknown" };

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
  const charged = [{ slot: COMMENTS_SLOT(input.courseId), bytes: commentBytes(comment) }];
  await needData(input.room, charged);
  const written = oneReply(await redisPipeline([[
    "EVAL",
    ADD_LESSON_COMMENT,
    4,
    commentsKey(input.courseId),
    lessonKey(input.courseId, input.lessonId),
    allKey(input.courseId),
    repliesKey(input.courseId),
    parent?.id ?? "",
    input.lessonId,
    comment.id,
    serializeComment(comment),
    now,
    MAX_REPLIES,
    RECENT_KEPT,
    LESSON_KEPT,
  ]]));
  const refusal = confirmedCommentRefusal(written);
  if (refusal) {
    await giveData(input.room, charged);
    return { ok: false, reason: refusal };
  }
  if (!confirmedCommentWrite(written, parent !== null)) return { ok: false, reason: "unknown" };
  return { ok: true, comment, parent };
}

/**
 * Writes a comment only while it is still kept, so hiding a comment that was
 * just deleted (by its author, the creator or a person's erasure) never
 * writes it back. KEYS: the comments; ARGV: its id, what it now is. Answers 1
 * when it was written.
 */
export const HIDE_LESSON_COMMENT = `-- marktmorgen:lesson-comments-hide:v1
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

export async function setHidden(courseId: string, id: string, hidden: boolean): Promise<LessonComment | null> {
  const comment = await readComment(courseId, id);
  if (!comment) return null;
  const next = { ...comment, hidden };
  const [written] = await redisPipeline([["EVAL", HIDE_LESSON_COMMENT, 1, commentsKey(courseId), id, serializeComment(next)]]);
  return Number(written) === 1 ? next : null;
}

/**
 * Takes comments out, on the Redis side, and answers the raw of each one it
 * really took, so that only the one who took a comment gives its room back,
 * however many deletions run at once. A comment with no parent takes the
 * answers under it that its lessons' lists hold. With "drop" it takes every
 * comment its lessons' lists hold and deletes those lists, in the same step.
 * KEYS: the comments, the newest, the answer counts, then any lessons'
 * comments; ARGV: "drop" or "ids", then the ids.
 */
export const TAKE_LESSON_COMMENTS = `-- marktmorgen:lesson-comments-take:v2
local drop = ARGV[1] == "drop"
local ids = {}
if drop then
  for k = 4, #KEYS do
    for _, id in ipairs(redis.call("ZRANGE", KEYS[k], 0, -1)) do table.insert(ids, id) end
  end
else
  for i = 2, #ARGV do table.insert(ids, ARGV[i]) end
end
local taken = {}
local gone = {}
local asked = {}
for _, id in ipairs(ids) do asked[id] = true end
local tops = {}
for _, id in ipairs(ids) do
  if not taken[id] then
    local raw = redis.call("HGET", KEYS[1], id)
    redis.call("ZREM", KEYS[2], id)
    redis.call("HDEL", KEYS[3], id)
    for k = 4, #KEYS do redis.call("ZREM", KEYS[k], id) end
    if raw then
      taken[id] = true
      redis.call("HDEL", KEYS[1], id)
      table.insert(gone, raw)
      local ok, c = pcall(cjson.decode, raw)
      if ok and type(c) == "table" then
        local parent = c.r
        if parent == cjson.null then parent = nil end
        if parent == nil then
          tops[id] = true
        elseif not asked[parent] and not taken[parent] and redis.call("HEXISTS", KEYS[1], parent) == 1 then
          redis.call("HINCRBY", KEYS[3], parent, -1)
        end
      end
    end
  end
end
if next(tops) ~= nil then
  for k = 4, #KEYS do
    for _, id in ipairs(redis.call("ZRANGE", KEYS[k], 0, -1)) do
      local raw = redis.call("HGET", KEYS[1], id)
      if raw then
        local ok, c = pcall(cjson.decode, raw)
        if ok and type(c) == "table" and type(c.r) == "string" and tops[c.r] then
          redis.call("HDEL", KEYS[1], id)
          redis.call("HDEL", KEYS[3], id)
          redis.call("ZREM", KEYS[2], id)
          redis.call("ZREM", KEYS[k], id)
          table.insert(gone, raw)
        end
      end
    end
  end
end
if drop then
  for k = 4, #KEYS do redis.call("DEL", KEYS[k]) end
end
return gone`;

/** Takes `ids` out, or, with "drop", every comment of `lessonIds` with their lists. */
async function takeComments(courseId: string, ids: string[] | "drop", lessonIds: string[]): Promise<unknown[]> {
  if (ids !== "drop" && !ids.length) return [];
  const [reply] = await redisPipeline([
    [
      "EVAL",
      TAKE_LESSON_COMMENTS,
      3 + lessonIds.length,
      commentsKey(courseId),
      allKey(courseId),
      repliesKey(courseId),
      ...lessonIds.map((l) => lessonKey(courseId, l)),
      ...(ids === "drop" ? ["drop"] : ["ids", ...ids]),
    ],
  ]);
  return Array.isArray(reply) ? reply : [];
}

/**
 * Deletes a comment, and the answers under it, and gives back the room of
 * what this deletion really took out (a comment another deletion took first
 * is not given back twice). Returns how many went.
 */
export async function deleteComment(courseId: string, id: string, room: DataStore): Promise<number> {
  if (!isRedisConfigured() || !COMMENT_ID_PATTERN.test(id)) return 0;
  const raw = oneReply(await redisPipeline([["HGET", commentsKey(courseId), id]]));
  if (raw === null) return 0;
  const comment = deletionComment(raw, id);
  if (!comment) throw unreadableComments();
  const receipt = oneReply(await redisPipeline([["EVAL", DELETE_THREAD, 4, commentsKey(courseId), lessonKey(courseId, comment.lesson), allKey(courseId), repliesKey(courseId), id, comment.lesson, LESSON_INDEX_KEPT, ENTRY_BYTES, DATA_STEP_BYTES]]));
  if (!Array.isArray(receipt) || receipt.length !== 2) throw unreadableComments();
  const count = dataSlot(receipt, 0), freed = dataSlot(receipt, 1);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || typeof freed !== "number" || !Number.isSafeInteger(freed)) throw unreadableComments();
  if (count === 0 && freed === 0) return 0;
  if (count < 1 || count > MAX_REPLIES + 1 || freed < 1) throw unreadableComments();
  await giveData(room, [{ slot: COMMENTS_SLOT(courseId), bytes: freed }]);
  return count;
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
  const what = "the deletion of a course's lesson comments";
  const commands = [
    ...[commentsKey, allKey, repliesKey, namesKey, offKey, seenKey].map((k) => ["DEL", k(courseId)]),
    ...lessonIds.map((l) => ["DEL", lessonKey(courseId, l)]),
  ];
  const receipts = exactReplies(await redisPipeline(commands), commands.length, what);
  if (receipts.some((receipt) => replyCount(receipt, what) > 1)) throw new UnknownReply(what);
  await giveData(room, [{ slot: COMMENTS_SLOT(courseId), bytes: 0, set: true }]);
}

/**
 * Removes the bounded lesson indexes that can still be identified after the
 * course record is already gone. Confirmed course absence must not make its
 * product impossible to remove, while an incomplete index or comment read is
 * still unknown and leaves the product for a later try.
 */
export async function dropCommentsAfterCourseGone(courseId: string, room: DataStore): Promise<void> {
  if (!isRedisConfigured()) return;
  const what = "the missing course's lesson comment index";
  const [rawIds] = exactReplies(
    await redisPipeline([["ZREVRANGE", allKey(courseId), 0, RECENT_KEPT - 1]]),
    1,
    what,
  );
  const ids = plainList(rawIds);
  if (!ids || ids.some((id) => typeof id !== "string" || !COMMENT_ID_PATTERN.test(id))) {
    throw new UnknownReply(what);
  }
  const commentIds = ids as string[];
  const lessonIds = new Set<string>();
  if (commentIds.length) {
    const [rawRows] = exactReplies(
      await redisPipeline([["HMGET", commentsKey(courseId), ...commentIds]]),
      1,
      what,
    );
    const rows = plainList(rawRows);
    if (!rows || rows.length !== commentIds.length) throw new UnknownReply(what);
    rows.forEach((raw, index) => {
      const comment = parseComment(raw);
      if (!comment || comment.id !== commentIds[index] || !COMMENT_ID_PATTERN.test(comment.lesson)) {
        throw new UnknownReply(what);
      }
      lessonIds.add(comment.lesson);
    });
  }
  await dropComments(courseId, [...lessonIds], room);
}

/** Takes away every comment under lessons that are gone from the course. */
export async function dropLessonComments(courseId: string, lessonIds: string[], room: DataStore): Promise<void> {
  if (!isRedisConfigured() || !lessonIds.length) return;
  // One step reads the lessons' lists, takes what they hold and deletes them;
  // only what it really removed comes back to the store's data room.
  const gone = await takeComments(courseId, "drop", lessonIds);
  const freed = takenBytes(gone);
  if (freed) await giveData(room, [{ slot: COMMENTS_SLOT(courseId), bytes: freed }]);
}

/**
 * Takes one student's comments out of a course, on the Redis side, with the
 * answers under their own comments, as deleting a comment does, and the name
 * they chose. KEYS: the comments, the newest, the answer counts, the names,
 * then each lesson's comments; ARGV: the student's key, then each lesson's
 * id in the same order. Answers how many comments went.
 */
export const FORGET_LESSON_COMMENTS = `-- marktmorgen:lesson-comments-forget:v2
local who = ARGV[1]
local lessons = {}
for i = 5, #KEYS do lessons[ARGV[i - 3]] = KEYS[i] end
local flat = redis.call("HGETALL", KEYS[1])
local all = {}
local flat_raw = {}
local tops = {}
for i = 1, #flat, 2 do
  local ok, c = pcall(cjson.decode, flat[i + 1])
  if ok and type(c) == "table" then
    all[flat[i]] = c
    flat_raw[flat[i]] = flat[i + 1]
    if c.b == who and (c.r == nil or c.r == cjson.null) then tops[flat[i]] = true end
  end
end
local gone = {}
for id, c in pairs(all) do
  local parent = c.r
  if parent == cjson.null then parent = nil end
  if c.b == who or (parent ~= nil and tops[parent]) then
    redis.call("HDEL", KEYS[1], id)
    redis.call("ZREM", KEYS[2], id)
    redis.call("HDEL", KEYS[3], id)
    if lessons[c.l] then redis.call("ZREM", lessons[c.l], id) end
    if parent ~= nil and not tops[parent] and all[parent] then redis.call("HINCRBY", KEYS[3], parent, -1) end
    table.insert(gone, flat_raw[id])
  end
end
local name = redis.call("HGET", KEYS[4], who)
redis.call("HDEL", KEYS[4], who)
return {name or "", gone}`;

/**
 * Deletes one student's comments in a course (and the answers under their
 * own comments) and the name they chose (lib/person-erasure.ts). `who` is
 * lib/learn.ts emailKey. What they took goes back to `room` as the other
 * deletions here give it back: each comment at commentBytes, and the name
 * kept once (a name typed again was charged again; that part is not known,
 * so it stays counted, never less than kept). A reply that is not exactly
 * what was asked for throws UnknownReply (lib/redis-exact.ts).
 */
export async function forgetLessonCommentsPerson(courseId: string, lessonIds: string[], who: string, room?: DataStore): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const what = "the deletion of a student's lesson comments";
  const [reply] = exactReplies(
    await redisPipeline([
      ["EVAL", FORGET_LESSON_COMMENTS, 4 + lessonIds.length, commentsKey(courseId), allKey(courseId), repliesKey(courseId), namesKey(courseId), ...lessonIds.map((l) => lessonKey(courseId, l)), who, ...lessonIds],
    ]),
    1,
    what,
  );
  // Exactly {the name ("" for none), the comments taken}: any other shape
  // leaves the deletion unknown (UnknownReply), and nothing is given back.
  const [name, raws] = exactReplies(reply, 2, what);
  const gone = plainList(raws);
  if (typeof name !== "string" || !gone || !gone.every((raw) => typeof raw === "string")) throw new UnknownReply(what);
  if (room) {
    const freed = takenBytes(gone) + (typeof name === "string" && name ? dataBytes([who, name], 1) : 0);
    if (freed > 0) await giveData(room, [{ slot: COMMENTS_SLOT(courseId), bytes: freed }]);
  }
  return gone.length;
}
