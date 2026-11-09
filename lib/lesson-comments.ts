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
import { DATA_ROOM_BYTES, DATA_STEP_BYTES, ENTRY_BYTES, NON_PAYING_DATA_ROOM_BYTES, dataBytes, utf8Length } from "@/lib/store-data-rules";
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

/** The name a student chose, read exactly for the copy of their data (lib/person-copy.ts): "" only when none is kept. */
export async function chosenName(courseId: string, key: string): Promise<string> {
  if (!isRedisConfigured()) return "";
  const raw = oneReply(await redisPipeline([["HGET", namesKey(courseId), key]]));
  if (raw !== null && typeof raw !== "string") throw unreadableComments();
  return raw ?? "";
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
 * How many fields one step of a walk over a course's record of comments asks
 * HSCAN for. COUNT is a hint: Redis visits at most ten times as many buckets
 * in one step and answers about this many fields, so what one call decodes,
 * how long it runs and what it answers have a ceiling whatever the course's
 * size, where HGETALL decoded the whole record in one call.
 */
export const COMMENT_SCAN_COUNT = 200;

/**
 * The largest data room any store has, paying or not (lib/store-data-rules.ts):
 * the most a store's comments can take, since every comment is charged to the
 * room before it is written, and a store on a smaller plan keeps what it has,
 * never more.
 */
const LARGEST_DATA_ROOM = Math.max(...Object.values(DATA_ROOM_BYTES), ...Object.values(NON_PAYING_DATA_ROOM_BYTES));

/** The most comments one course's record can hold: each is charged at least four entries of the room (commentBytes). */
export const MOST_COURSE_COMMENTS = Math.floor(LARGEST_DATA_ROOM / (4 * ENTRY_BYTES));

/**
 * The steps a walk over a record of `fields` fields may take: half a COUNT a
 * step at the least, as the store's other walks allow (lib/free.ts), and two
 * more for what is written while it walks. A walk not at its end by then is
 * unknown and throws, never handed over as whole.
 */
export function scanPagesFor(fields: number): number {
  return Math.ceil(Math.max(0, fields) / (COMMENT_SCAN_COUNT / 2)) + 2;
}

/** The steps a walk over the largest course may take, whatever Redis answers. */
export const COMMENT_SCAN_PAGES = scanPagesFor(MOST_COURSE_COMMENTS);

/**
 * One step of taking one student's comments out of a course, on the Redis
 * side, with the answers under their own comments, as deleting a comment
 * does. KEYS: the comments, the newest, the answer counts, then each lesson's
 * comments; ARGV: the student's key, the cursor, COMMENT_SCAN_COUNT, "free"
 * (their own threads go once no answer is left under them) or "all", the
 * room's ENTRY_BYTES and DATA_STEP_BYTES, then each lesson's id in the order
 * of KEYS. Answers are taken before threads, each counted off its thread,
 * so a thread whose answers sit in a later step waits for the next pass and
 * none is left without its thread. Answers {the next cursor, how many went,
 * the room they were charged (commentBytes, visible), how many of their
 * threads wait}: counts, never the words (they were all sent back until 9
 * November 2026, past what the erasure counts). The name they chose goes in
 * forgetLessonCommentsPerson.
 */
export const FORGET_LESSON_COMMENTS = `-- marktmorgen:lesson-comments-forget:v3
local who = ARGV[1]
local mode = ARGV[4]
local entry = tonumber(ARGV[5])
local step = tonumber(ARGV[6])
if (mode ~= "free" and mode ~= "all") or not entry or not step or step < 1 then return {"x"} end
local lessons = {}
for i = 4, #KEYS do lessons[ARGV[i + 3]] = KEYS[i] end
local page = redis.call("HSCAN", KEYS[1], ARGV[2], "COUNT", tonumber(ARGV[3]))
local flat = page[2]
local answers = {}
local parents = {}
local threads = {}
for i = 1, #flat, 2 do
  local ok, c = pcall(cjson.decode, flat[i + 1])
  if ok and type(c) == "table" then
    local parent = c.r
    if parent == cjson.null then parent = nil end
    if parent ~= nil then
      table.insert(answers, {flat[i], flat[i + 1], c, parent})
      table.insert(parents, parent)
    elseif c.b == who then
      table.insert(threads, {flat[i], flat[i + 1], c})
    end
  end
end
local function fields(key, names)
  local out = {}
  for first = 1, #names, 1000 do
    local chunk = {}
    for k = first, math.min(first + 999, #names) do table.insert(chunk, names[k]) end
    local got = redis.call("HMGET", key, unpack(chunk))
    for k = 1, #chunk do out[first + k - 1] = got[k] end
  end
  return out
end
local under = {}
local above = fields(KEYS[1], parents)
for k = 1, #parents do
  if above[k] then
    local ok, p = pcall(cjson.decode, above[k])
    if ok and type(p) == "table" and p.b == who then under[parents[k]] = true end
  end
end
local gone = 0
local freed = 0
local held = 0
local function take(id, raw, c, parent)
  if redis.call("HDEL", KEYS[1], id) ~= 1 then return end
  redis.call("ZREM", KEYS[2], id)
  redis.call("HDEL", KEYS[3], id)
  if type(c.l) == "string" and lessons[c.l] then redis.call("ZREM", lessons[c.l], id) end
  if parent ~= nil and redis.call("HEXISTS", KEYS[1], parent) == 1 then redis.call("HINCRBY", KEYS[3], parent, -1) end
  local bytes = string.len(raw)
  if c.h == true then bytes = bytes - string.len(',"h":true') end
  freed = freed + math.floor((bytes + entry * 4 + step - 1) / step) * step
  gone = gone + 1
end
for _, row in ipairs(answers) do
  if row[3].b == who or under[row[4]] then take(row[1], row[2], row[3], row[4]) end
end
if #threads > 0 then
  local ids = {}
  for k = 1, #threads do ids[k] = threads[k][1] end
  local left = fields(KEYS[3], ids)
  for k, row in ipairs(threads) do
    if mode == "all" or (tonumber(left[k]) or 0) <= 0 then take(row[1], row[2], row[3], nil) else held = held + 1 end
  end
end
return {page[1], gone, freed, held}`;

/**
 * The passes an erasure walks a course's record at the most: a thread of
 * theirs read before the answers under it waits for the next pass; the last
 * pass takes every one of theirs left, whatever its count of answers says.
 */
export const FORGET_PASSES = 3;

function forgetCommand(courseId: string, lessonIds: string[], who: string, cursor: string, mode: "free" | "all"): (string | number)[] {
  return ["EVAL", FORGET_LESSON_COMMENTS, 3 + lessonIds.length, commentsKey(courseId), allKey(courseId), repliesKey(courseId), ...lessonIds.map((l) => lessonKey(courseId, l)), who, cursor, COMMENT_SCAN_COUNT, mode, ENTRY_BYTES, DATA_STEP_BYTES, ...lessonIds];
}

/**
 * What one step of FORGET_LESSON_COMMENTS moves, for a course of these
 * lessons: four billed commands (the EVAL and, inside it, the HSCAN and two
 * HMGET of a step's fields; Upstash bills a script's inside too, docs/backup.md)
 * and the bytes of the command, at a cursor of twenty digits, and its answer
 * of four numbers. lib/erasure-rules.ts counts it in ERASE_PER (commentPages,
 * commentPageLessons), held over this in tests/lesson-comments-copy-erasure-bounds.test.ts.
 * The commands it runs for each comment it deletes are not in it.
 */
export function forgetPageWork(courseId: string, lessonIds: string[], who: string): { commands: number; bytes: number } {
  return { commands: 4, bytes: JSON.stringify(forgetCommand(courseId, lessonIds, who, "9".repeat(20), "free")).length + 64 };
}

/** How many fields a course's record of comments holds, each read exactly. */
async function commentFields(courseIds: string[], what: string): Promise<number[]> {
  if (!courseIds.length) return [];
  const replies = exactReplies(await redisPipeline(courseIds.map((c) => ["HLEN", commentsKey(c)])), courseIds.length, what);
  return replies.map((raw) => replyCount(raw, what));
}

/**
 * The steps deleting a person walks over these courses' comments, counted
 * before it runs (lib/person-erasure.ts, erasureSize): `pages`, each course's
 * scanPagesFor its record, and `lessonPages`, each of those steps times the
 * lessons it names. Each is walked FORGET_PASSES times at the most.
 */
export async function commentScanSize(courses: { courseId: string; lessonIds: string[] }[]): Promise<{ pages: number; lessonPages: number }> {
  if (!courses.length || !isRedisConfigured()) return { pages: 0, lessonPages: 0 };
  const counts = await commentFields(courses.map((c) => c.courseId), "the lesson comments counted for a person's erasure");
  let pages = 0;
  let lessonPages = 0;
  courses.forEach((course, k) => {
    const steps = scanPagesFor(counts[k]);
    pages += steps;
    lessonPages += steps * course.lessonIds.length;
  });
  return { pages, lessonPages };
}

/**
 * Deletes one student's comments in a course (and the answers under their
 * own comments) and the name they chose (lib/person-erasure.ts). `who` is
 * lib/learn.ts emailKey. The course's record is walked in steps of
 * COMMENT_SCAN_COUNT, at most scanPagesFor its size a pass and FORGET_PASSES
 * passes. What they took goes back to `room` as the other deletions here give
 * it back: each comment at commentBytes, and the name kept once (a name typed
 * again was charged again; that part is not known, so it stays counted, never
 * less than kept), also when a later step fails. A reply that is not exactly
 * what was asked for throws UnknownReply (lib/redis-exact.ts), and what that
 * step did is not given back.
 */
export async function forgetLessonCommentsPerson(courseId: string, lessonIds: string[], who: string, room?: DataStore): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const what = "the deletion of a student's lesson comments";
  const [fields] = await commentFields([courseId], what);
  const pages = scanPagesFor(fields);
  let gone = 0;
  let freed = 0;
  try {
    for (let pass = 0; pass < FORGET_PASSES; pass += 1) {
      const mode = pass === FORGET_PASSES - 1 ? "all" : "free";
      let cursor = "0";
      let held = 0;
      for (let page = 0; ; page += 1) {
        if (page >= pages) throw new UnknownReply(what);
        const [reply] = exactReplies(await redisPipeline([forgetCommand(courseId, lessonIds, who, cursor, mode)]), 1, what);
        // Exactly {the next cursor, how many went, their room, how many of their threads wait}: any other shape
        // leaves the step unknown (UnknownReply), and nothing of it is given back.
        const [next, taken, bytes, waiting] = exactReplies(reply, 4, what);
        if (typeof next !== "string" || !/^[0-9]+$/.test(next)) throw new UnknownReply(what);
        const count = replyCount(taken, what);
        const charged = replyCount(bytes, what);
        held += replyCount(waiting, what);
        if (charged < count * 4 * ENTRY_BYTES || (count === 0) !== (charged === 0)) throw new UnknownReply(what);
        gone += count;
        freed += charged;
        cursor = next;
        if (cursor === "0") break;
      }
      if (held === 0) break;
    }
    const [name, dropped] = exactReplies(await redisPipeline([["HGET", namesKey(courseId), who], ["HDEL", namesKey(courseId), who]]), 2, what);
    if ((name !== null && typeof name !== "string") || replyCount(dropped, what) > 1) throw new UnknownReply(what);
    if (typeof name === "string" && name && dropped === 1) freed += dataBytes([who, name], 1);
  } finally {
    if (room && freed > 0) await giveData(room, [{ slot: COMMENTS_SLOT(courseId), bytes: freed }]);
  }
  return gone;
}

/**
 * One step of finding every comment one student wrote in a course where the
 * erasure finds them (FORGET_LESSON_COMMENTS): the course's whole record of
 * comments, whatever their lesson or age, not a lesson's newest LESSON_KEPT,
 * which the answers under its threads can outgrow. Only reads, and answers
 * only theirs. KEYS: the comments; ARGV: the student's key, the cursor,
 * COMMENT_SCAN_COUNT. Answers {the next cursor, each of theirs in this step},
 * or {"x"} when a record does not read as a comment, since whose it is cannot
 * be known.
 */
export const LESSON_COMMENTS_OF = `-- marktmorgen:lesson-comments-of:v2
local page = redis.call("HSCAN", KEYS[1], ARGV[2], "COUNT", tonumber(ARGV[3]))
local flat = page[2]
local out = {page[1]}
for i = 1, #flat, 2 do
  local ok, c = pcall(cjson.decode, flat[i + 1])
  if not ok or type(c) ~= "table" or type(c.b) ~= "string" then return {"x"} end
  if c.b == ARGV[1] then table.insert(out, flat[i + 1]) end
end
return out`;

function copyCommand(courseId: string, who: string, cursor: string): (string | number)[] {
  return ["EVAL", LESSON_COMMENTS_OF, 1, commentsKey(courseId), who, cursor, COMMENT_SCAN_COUNT];
}

/**
 * The most the copy's read of one student's comments in a course moves, from
 * what is known before it runs and never from an answer: COMMENT_SCAN_PAGES
 * steps of two billed commands (the EVAL and the HSCAN inside it,
 * docs/backup.md), each the bytes of its command at a cursor of twenty digits
 * and its framing; and theirs, which the store's room bounds, each comment's
 * JSON written again as a string (every quote and backslash doubled, so at
 * most twice its bytes) with its quotes and comma: three times the largest
 * room holds them all. Not paid from anything yet (tests/plan-cost-registry.ts,
 * NOT_A_COST.PERSON_COPY_BUDGET).
 */
export function copyReadWork(courseId: string, who: string): { commands: number; bytes: number } {
  const step = JSON.stringify(copyCommand(courseId, who, "9".repeat(20))).length + 64;
  return { commands: 2 * COMMENT_SCAN_PAGES, bytes: COMMENT_SCAN_PAGES * step + 3 * LARGEST_DATA_ROOM };
}

/**
 * Every comment one student (`who`, lib/learn.ts emailKey) wrote in a course,
 * for the copy of what a store keeps about them (lib/person-copy.ts): read
 * whole, or not at all, in steps of COMMENT_SCAN_COUNT. Bounded by what is
 * known before, never by an answer: at most COMMENT_SCAN_PAGES steps, and at
 * most the largest data room of theirs (copyReadWork). A record that does not
 * read, an answer of another shape, a walk not at its end by then or theirs
 * past that room throws: the copy fails and says so, never leaves them out.
 * A comment HSCAN hands back twice is kept once.
 */
export async function studentComments(courseId: string, who: string): Promise<LessonComment[]> {
  if (!isRedisConfigured()) return [];
  const comments = new Map<string, LessonComment>();
  let bytes = 0;
  let cursor = "0";
  for (let page = 0; ; page += 1) {
    if (page >= COMMENT_SCAN_PAGES) throw unreadableComments();
    const reply = oneReply(await redisPipeline([copyCommand(courseId, who, cursor)]));
    if (!Array.isArray(reply) || reply.length < 1) throw unreadableComments();
    const next = dataSlot(reply, 0);
    if (typeof next !== "string" || !/^[0-9]+$/.test(next)) throw unreadableComments();
    for (let index = 1; index < reply.length; index += 1) {
      const raw = dataSlot(reply, index);
      const comment = parseComment(raw);
      if (typeof raw !== "string" || !comment || comment.by !== who) throw unreadableComments();
      bytes += utf8Length(raw);
      if (bytes > LARGEST_DATA_ROOM) throw unreadableComments();
      comments.set(comment.id, comment);
    }
    cursor = next;
    if (cursor === "0") return [...comments.values()];
  }
}
