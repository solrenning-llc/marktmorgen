/**
 * Assignments: where they are kept, and what handing one in and reviewing it
 * do (lib/assignment-rules.ts says what they are).
 *
 *   nl:course:<course>:task:<lesson>              the prompt and its switches
 *   nl:course:<course>:task:<lesson>:sub:<who>    one student's work, and what came back
 *   nl:course:<course>:task:<lesson>:files        every file handed in for it, and its size, to delete with it
 *   nl:course:<course>:tasks:waiting              work waiting for the creator, oldest first
 *   nl:course:<course>:tasks:all                  all the work handed in, by when it last was
 *   nl:tasks:bytes:<store key>                    what the store's students keep handed in, in bytes
 *   nl:tasks:doors                                files a student was let upload, by when: handed in, or deleted after a day
 *   nl:course:<course>:tasks:told                 the creator was told of new work this hour
 *
 * Done is what the rest of the course already reads: the lesson marked done
 * (its progress, its certificate) and written down beside the quizzes passed,
 * which is what holds later lessons shut (lib/quiz.ts, heldBack). Handed in
 * on an assignment the creator does not review, it is done at once; on one
 * they review, when they approve it.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { ENTRY_BYTES, dataBytes } from "@/lib/store-data-rules";
import { markLesson } from "@/lib/learn";
import { markPassed } from "@/lib/quiz";
import { ITEM_ID_PATTERN } from "@/lib/course";
import {
  type HandedFile,
  MAX_ANSWER_TEXT,
  MAX_FEEDBACK,
  MAX_STORE_TASK_BYTES,
  type Submission,
  type Task,
  type TaskState,
  parseTaskSetup,
} from "@/lib/assignment-rules";

const taskKey = (courseId: string, lessonId: string) => `nl:course:${courseId}:task:${lessonId}`;
const subKey = (courseId: string, lessonId: string, who: string) => `nl:course:${courseId}:task:${lessonId}:sub:${who}`;
const filesKey = (courseId: string, lessonId: string) => `nl:course:${courseId}:task:${lessonId}:files`;
const waitingKey = (courseId: string) => `nl:course:${courseId}:tasks:waiting`;
const allKey = (courseId: string) => `nl:course:${courseId}:tasks:all`;
const bytesKey = (room: string) => `nl:tasks:bytes:${room}`;
const DOORS_KEY = "nl:tasks:doors";
/** A file uploaded and not handed in within this long is deleted. */
export const DOOR_SECONDS = 24 * 60 * 60;
const WHO = /^[0-9a-f]{16,64}$/;

function parse<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readTaskFor(courseId: string, lessonId: string): Promise<Task | null> {
  if (!isRedisConfigured() || !ITEM_ID_PATTERN.test(lessonId)) return null;
  const [raw] = await redisPipeline([["GET", taskKey(courseId, lessonId)]]);
  const value = parse<Record<string, unknown>>(raw);
  if (!value || typeof value.prompt !== "string" || !value.prompt) return null;
  return { ...(parseTaskSetup(value) as Task), prompt: value.prompt };
}

/**
 * Where a course's assignments are counted in the store's data room
 * (lib/store-data.ts): the prompts the creator writes, the work students hand
 * in and what comes back, with their places in the lists. A student's file is
 * counted apart, in bytes of its own (takeRoom).
 */
const TASKS_SLOT = (courseId: string) => `ca:${courseId}`;
const recordBytes = (raw: unknown, entries = 1) => (typeof raw === "string" && raw ? dataBytes([raw], entries) : 0);

export async function saveTask(courseId: string, lessonId: string, task: Task, data: DataStore): Promise<void> {
  const json = JSON.stringify(task);
  const [before] = await redisPipeline([["GET", taskKey(courseId, lessonId)]]);
  const grown = recordBytes(json) - recordBytes(before);
  if (grown > 0) await needData(data, [{ slot: TASKS_SLOT(courseId), bytes: grown }]);
  await redisPipeline([["SET", taskKey(courseId, lessonId), json]]);
  if (grown < 0) await giveData(data, [{ slot: TASKS_SLOT(courseId), bytes: -grown }]);
}

/** Forgets an assignment and all the work handed in for it. Returns the files to delete. */
export async function dropTask(courseId: string, lessonId: string, room: string | null, data: DataStore): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [flat] = await redisPipeline([["HGETALL", filesKey(courseId, lessonId)]]);
  const pairs = Array.isArray(flat) ? flat : [];
  const files: string[] = [];
  let bytes = 0;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    files.push(String(pairs[i]));
    bytes += Number(pairs[i + 1]) || 0;
  }
  // Each student's own record, found by the list of all the work handed in.
  const [waiting] = await redisPipeline([["ZRANGEBYSCORE", allKey(courseId), "-inf", "+inf"]]);
  const gone = (Array.isArray(waiting) ? waiting : []).filter((m): m is string => typeof m === "string" && m.startsWith(`${lessonId}|`));
  // What the prompt and the work weighed comes back to the store's data room.
  const held = await redisPipeline([["GET", taskKey(courseId, lessonId)], ...gone.map((member) => ["GET", subKey(courseId, lessonId, member.slice(lessonId.length + 1))])]);
  const freed = held.reduce((sum: number, raw, i) => sum + recordBytes(raw, i === 0 ? 1 : 3), 0) + files.length * ENTRY_BYTES;
  await redisPipeline([
    ["DEL", taskKey(courseId, lessonId), filesKey(courseId, lessonId)],
    ...gone.map((member) => ["DEL", subKey(courseId, lessonId, member.slice(lessonId.length + 1))]),
    ...(gone.length ? [["ZREM", waitingKey(courseId), ...gone], ["ZREM", allKey(courseId), ...gone]] : []),
  ]);
  if (room && bytes) await releaseBytes(room, bytes);
  if (freed) await giveData(data, [{ slot: TASKS_SLOT(courseId), bytes: freed }]);
  return files;
}

/** One student's work on one assignment, or null when they have handed nothing in. */
export async function submissionOf(courseId: string, lessonId: string, who: string): Promise<Submission | null> {
  if (!isRedisConfigured() || !WHO.test(who) || !ITEM_ID_PATTERN.test(lessonId)) return null;
  const [raw] = await redisPipeline([["GET", subKey(courseId, lessonId, who)]]);
  return parse<Submission>(raw);
}

/** Several students' work at once, in the order asked, null where there is none. */
export async function submissionsOf(courseId: string, rows: { lessonId: string; who: string }[]): Promise<(Submission | null)[]> {
  const asked = rows.filter((r) => WHO.test(r.who) && ITEM_ID_PATTERN.test(r.lessonId));
  if (!isRedisConfigured() || !asked.length) return rows.map(() => null);
  const raw = await redisPipeline(asked.map((r) => ["GET", subKey(courseId, r.lessonId, r.who)]));
  const found = new Map(asked.map((r, i) => [`${r.lessonId}|${r.who}`, parse<Submission>(raw[i])]));
  return rows.map((r) => found.get(`${r.lessonId}|${r.who}`) ?? null);
}

/**
 * Room for a file of this size in what this store's students keep: taken
 * now, given back when the file is no longer kept (releaseBytes). `limit`
 * is the store's own (lib/assignment-rules.ts, taskRoomFor).
 *
 * The total is read only in its exact shape (CX-123 rule 24): one reply, a
 * whole number at least the bytes just added. Anything else throws
 * UnknownReplyError, so the work is not handed in and the student is told
 * something went wrong (the route's "server_error"), never that the room is
 * full. Nothing is given back then: whether the INCRBY was applied is not
 * known, and a DECRBY of bytes that never entered would leave room for
 * more than the store's limit. Bytes that did enter stay counted, which
 * only ever refuses sooner (releaseBytes never takes the total below zero).
 */
export async function takeRoom(room: string, bytes: number, limit: number = MAX_STORE_TASK_BYTES): Promise<boolean> {
  if (!isRedisConfigured() || !Number.isFinite(bytes) || bytes <= 0 || !Number.isSafeInteger(limit) || limit <= 0) return false;
  const added = Math.ceil(bytes);
  const replies = repliesFor(await redisPipeline([["INCRBY", bytesKey(room), added]]), 1);
  const used = replies ? countOf(replies[0]) : null;
  if (used === null || used < added) throw new UnknownReplyError("the room taken by handed-in files");
  if (used > limit) {
    await redisPipeline([["DECRBY", bytesKey(room), added]]);
    return false;
  }
  return true;
}

/** Whether a file of this size would still fit, read without taking anything. */
export async function hasRoom(room: string, bytes: number, limit: number = MAX_STORE_TASK_BYTES): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const [used] = await redisPipeline([["GET", bytesKey(room)]]);
  return (Number(used) || 0) + bytes <= limit;
}

/** Gives back room taken for files that are no longer kept. */
export async function releaseBytes(room: string, bytes: number): Promise<void> {
  if (!isRedisConfigured() || !(bytes > 0)) return;
  const [left] = await redisPipeline([["DECRBY", bytesKey(room), Math.ceil(bytes)]]);
  if (Number(left) < 0) await redisPipeline([["SET", bytesKey(room), 0]]);
}

/** What handing in did: where the work stands, and the earlier file it replaced, with its size, to delete. */
export type HandIn = { state: TaskState; replaced: HandedFile | null };

/**
 * A student hands their work in, or hands it in again. What they handed in
 * before is replaced; its file, if this one has another, is returned to be
 * deleted. Done at once on an assignment nobody reviews.
 */
export async function handIn(input: {
  courseId: string;
  lessonId: string;
  who: string;
  email: string;
  task: Task;
  text: string;
  file: HandedFile | null;
  now?: number;
  /** The store whose data room the work takes from (DataRoomError when it does not fit). */
  data: DataStore;
}): Promise<HandIn> {
  const { courseId, lessonId, who, task } = input;
  const at = input.now ?? Math.floor(Date.now() / 1000);
  const before = await submissionOf(courseId, lessonId, who);
  const state: TaskState = task.review ? "waiting" : "approved";
  const kept: Submission = {
    text: input.text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_ANSWER_TEXT),
    file: input.file,
    at,
    state,
    feedback: "",
    reviewedAt: 0,
    tries: (before?.tries ?? 0) + 1,
  };
  const member = `${lessonId}|${who}`;
  // Its room first: what it weighs over what it replaces, its two places in the lists the first time, its file's entry.
  const grown = recordBytes(JSON.stringify(kept), 3) - (before ? recordBytes(JSON.stringify(before), 3) : 0) + (input.file ? ENTRY_BYTES : 0);
  if (grown > 0) await needData(input.data, [{ slot: TASKS_SLOT(courseId), bytes: grown }]);
  await redisPipeline([
    ["SET", subKey(courseId, lessonId, who), JSON.stringify(kept)],
    ...(input.file ? [["HSET", filesKey(courseId, lessonId), input.file.path, input.file.bytes]] : []),
    task.review ? ["ZADD", waitingKey(courseId), at, member] : ["ZREM", waitingKey(courseId), member],
    ["ZADD", allKey(courseId), at, member],
  ]);
  if (grown < 0) await giveData(input.data, [{ slot: TASKS_SLOT(courseId), bytes: -grown }]);
  if (!task.review) await finish(courseId, lessonId, who, input.email, input.data);
  const replaced = before?.file && before.file.path !== input.file?.path ? before.file : null;
  if (replaced) {
    await redisPipeline([["HDEL", filesKey(courseId, lessonId), replaced.path]]);
    await giveData(input.data, [{ slot: TASKS_SLOT(courseId), bytes: ENTRY_BYTES }]);
  }
  return { state, replaced };
}

/** The lesson done, for the outline, the progress and the certificate, and the lessons after it open. */
async function finish(courseId: string, lessonId: string, who: string, email: string, data: DataStore): Promise<void> {
  await markPassed(courseId, who, lessonId, data);
  if (email) await markLesson(courseId, email, lessonId, true, data, true);
}

export type Waiting = { lessonId: string; who: string; at: number };

/**
 * Work for the creator to read, and how much there is: what is waiting,
 * oldest first, or with `all` everything handed in, newest first.
 */
export async function waitingWork(courseId: string, limit = 50, all = false): Promise<{ rows: Waiting[]; total: number }> {
  if (!isRedisConfigured()) return { rows: [], total: 0 };
  const key = all ? allKey(courseId) : waitingKey(courseId);
  const [rows, total] = await redisPipeline([
    all ? ["ZREVRANGE", key, 0, limit - 1, "WITHSCORES"] : ["ZRANGEBYSCORE", key, "-inf", "+inf", "WITHSCORES", "LIMIT", 0, limit],
    ["ZCARD", key],
  ]);
  const flat = Array.isArray(rows) ? rows : [];
  const out: Waiting[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [lessonId, who] = String(flat[i]).split("|");
    if (lessonId && who) out.push({ lessonId, who, at: Number(flat[i + 1]) || 0 });
  }
  return { rows: out, total: Number(total) || 0 };
}

export type Review = { ok: true; submission: Submission } | { ok: false; reason: "unknown" | "state" };

/**
 * The creator approves a student's work, or asks for another try, with what
 * they wrote back. Only work that is waiting is reviewed; approving it marks
 * the lesson done for the student.
 */
export async function review(input: {
  courseId: string;
  lessonId: string;
  who: string;
  email: string;
  verdict: "approved" | "again";
  feedback: string;
  now?: number;
  /** The store whose data room what comes back takes from (DataRoomError when it does not fit). */
  data: DataStore;
}): Promise<Review> {
  const { courseId, lessonId, who } = input;
  const before = await submissionOf(courseId, lessonId, who);
  if (!before) return { ok: false, reason: "unknown" };
  if (before.state !== "waiting") return { ok: false, reason: "state" };
  const after: Submission = {
    ...before,
    state: input.verdict,
    feedback: input.feedback.replace(/\r\n?/g, "\n").trim().slice(0, MAX_FEEDBACK),
    reviewedAt: input.now ?? Math.floor(Date.now() / 1000),
  };
  const grown = recordBytes(JSON.stringify(after)) - recordBytes(JSON.stringify(before));
  if (grown > 0) await needData(input.data, [{ slot: TASKS_SLOT(courseId), bytes: grown }]);
  await redisPipeline([
    ["SET", subKey(courseId, lessonId, who), JSON.stringify(after)],
    ["ZREM", waitingKey(courseId), `${lessonId}|${who}`],
  ]);
  if (input.verdict === "approved") await finish(courseId, lessonId, who, input.email, input.data);
  return { ok: true, submission: after };
}

// ---------------------------------------------------------------- uploads

/** Notes a file a student was let upload, so one never handed in is deleted (sweepTaskUploads). */
export async function noteTaskUpload(path: string, now = Date.now()): Promise<void> {
  await redisPipeline([["ZADD", DOORS_KEY, Math.floor(now / 1000), path]]);
}

/** Whether this file was let in through the door and not handed in yet; it is then taken. */
export async function takeTaskUpload(path: string): Promise<boolean> {
  const [removed] = await redisPipeline([["ZREM", DOORS_KEY, path]]);
  return Number(removed) === 1;
}

/**
 * Files uploaded more than a day ago and never handed in, to delete: the
 * student closed the page, or chose another file. Taken off the list here;
 * the caller deletes them. A few hundred a run at most.
 */
export async function staleTaskUploads(now = Date.now(), limit = 300): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const before = Math.floor(now / 1000) - DOOR_SECONDS;
  const [paths] = await redisPipeline([["ZRANGEBYSCORE", DOORS_KEY, 0, before, "LIMIT", 0, limit]]);
  const out = (Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === "string");
  if (out.length) await redisPipeline([["ZREM", DOORS_KEY, ...out]]);
  return out;
}

/** Whether to tell the creator about new work now: once an hour per course at most. */
export async function tellCreatorNow(courseId: string): Promise<boolean> {
  const [fresh] = await redisPipeline([["SET", `nl:course:${courseId}:tasks:told`, "1", "NX", "EX", 3_600]]);
  return fresh !== null;
}

/** Forgets every assignment of a course that is going, and returns their files to delete. */
export async function dropCourseTasks(course: { id: string; modules: { lessons: { id: string; task?: unknown }[] }[] }, room: string | null, data: DataStore): Promise<string[]> {
  const files: string[] = [];
  for (const unit of course.modules) {
    for (const lesson of unit.lessons) {
      if (lesson.task) files.push(...(await dropTask(course.id, lesson.id, room, data)));
    }
  }
  if (files.length || course.modules.some((m) => m.lessons.some((l) => l.task))) {
    await redisPipeline([["DEL", waitingKey(course.id), allKey(course.id)]]);
  }
  return files;
}

/**
 * Deletes one student's work in a course's assignments (lib/person-erasure.ts):
 * each record of what they handed in and what came back, its place in the
 * creator's lists, and the room its files took. Returns the files to delete
 * from the file store, as dropTask does.
 */
export async function forgetTasksPerson(courseId: string, lessonIds: string[], who: string, room: string | null): Promise<{ records: number; files: string[] }> {
  if (!lessonIds.length || !WHO.test(who) || !isRedisConfigured()) return { records: 0, files: [] };
  const raws = await redisPipeline(lessonIds.map((l) => ["GET", subKey(courseId, l, who)]));
  const handed = lessonIds.map((l, i) => ({ lessonId: l, sub: parse<Submission>(raws[i]) })).filter((h) => h.sub !== null);
  if (!handed.length) return { records: 0, files: [] };
  const files = handed.flatMap((h) => (h.sub?.file?.path ? [{ lessonId: h.lessonId, path: h.sub.file.path, bytes: Number(h.sub.file.bytes) || 0 }] : []));
  const members = handed.map((h) => `${h.lessonId}|${who}`);
  await redisPipeline([
    ["DEL", ...handed.map((h) => subKey(courseId, h.lessonId, who))],
    ["ZREM", waitingKey(courseId), ...members],
    ["ZREM", allKey(courseId), ...members],
    ...files.map((f) => ["HDEL", filesKey(courseId, f.lessonId), f.path]),
  ]);
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  if (room && bytes) await releaseBytes(room, bytes);
  return { records: handed.length, files: files.map((f) => f.path) };
}
