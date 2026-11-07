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
 *   nl:tasks:taken:<hash of a file's path>        the bytes one file took of that room, for an hour (undoTakeRoom)
 *   nl:tasks:doors                                files a student was let upload, by when: handed in, or deleted after a day
 *   nl:course:<course>:tasks:told                 the creator was told of new work this hour
 *
 * Done is what the rest of the course already reads: the lesson marked done
 * (its progress, its certificate) and written down beside the quizzes passed,
 * which is what holds later lessons shut (lib/quiz.ts, heldBack). Handed in
 * on an assignment the creator does not review, it is done at once; on one
 * they review, when they approve it.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { signedOf } from "@/lib/redis-count";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
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
const takenKey = (path: string) => `nl:tasks:taken:${createHash("sha256").update(path).digest("hex").slice(0, 40)}`;
/** How long a file's mark of the room it took is kept: long enough for the route to give it back at once. */
const TAKEN_SECONDS = 60 * 60;
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

/** A handed-in file's size as handIn writes it in the files' hash: a whole number of bytes, as text. */
const FILE_BYTES_TEXT = /^(0|[1-9]\d{0,15})$/;

/** What removing an assignment will forget, read in full before anything is deleted (readTaskDrop). */
export type TaskDrop = { courseId: string; lessonId: string; files: string[]; bytes: number; gone: string[]; freed: number };

/**
 * Reads what removing an assignment will forget: its handed-in files and their sizes, the work handed in, and what
 * the records weigh. Every reply in its exact shape (CX-123 rules 24 and 30; Claude 4 after Codex P on #2655): a
 * files' hash, a list of work or a record that does not read throws UnknownReplyError. A caller reads this before it
 * takes the assignment out of the course (Revisor 1 on #2810), so a read that fails leaves everything findable.
 */
export async function readTaskDrop(courseId: string, lessonId: string): Promise<TaskDrop> {
  // HGETALL and ZRANGEBYSCORE answer a plain list of text: read from its own slots (stringList), so a Proxy, a hole,
  // a member that is not text or a reply that is not a list is unknown, never a list.
  const pairs = stringList(repliesFor(await redisPipeline([["HGETALL", filesKey(courseId, lessonId)]]), 1)?.[0]);
  if (!pairs || pairs.length % 2 !== 0) throw new UnknownReplyError("the files handed in for an assignment");
  const files: string[] = [];
  let bytes = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const [name, size] = [pairs[i], pairs[i + 1]];
    if (!name || !FILE_BYTES_TEXT.test(size)) throw new UnknownReplyError("the files handed in for an assignment");
    files.push(name);
    bytes += Number(size);
  }
  // Each student's own record, found by the list of all the work handed in.
  const waiting = stringList(repliesFor(await redisPipeline([["ZRANGEBYSCORE", allKey(courseId), "-inf", "+inf"]]), 1)?.[0]);
  if (!waiting) throw new UnknownReplyError("the work handed in for a course");
  const gone = waiting.filter((m) => m.startsWith(`${lessonId}|`));
  // What the prompt and the work weighed comes back to the store's data room.
  const held = repliesFor(
    await redisPipeline([["GET", taskKey(courseId, lessonId)], ...gone.map((member) => ["GET", subKey(courseId, lessonId, member.slice(lessonId.length + 1))])]),
    1 + gone.length,
  );
  if (!held || !held.every((raw) => raw === null || typeof raw === "string")) throw new UnknownReplyError("an assignment's records");
  const freed = held.reduce((sum: number, raw, i) => sum + recordBytes(raw, i === 0 ? 1 : 3), 0) + files.length * ENTRY_BYTES;
  return { courseId, lessonId, files, bytes, gone, freed };
}

/**
 * Forgets what readTaskDrop read, and only that: the files read leave the files' hash one by one (HDEL), so a file
 * handed in after the reading stays listed, never lost; the work read leaves the lists. Returns the files to delete.
 */
export async function applyTaskDrop(drop: TaskDrop, room: string | null, data: DataStore): Promise<string[]> {
  const { courseId, lessonId, files, bytes, gone, freed } = drop;
  await redisPipeline([
    ["DEL", taskKey(courseId, lessonId)],
    ...(files.length ? [["HDEL", filesKey(courseId, lessonId), ...files]] : []),
    ...gone.map((member) => ["DEL", subKey(courseId, lessonId, member.slice(lessonId.length + 1))]),
    ...(gone.length ? [["ZREM", waitingKey(courseId), ...gone], ["ZREM", allKey(courseId), ...gone]] : []),
  ]);
  if (room && bytes) await releaseBytes(room, bytes);
  if (freed) await giveData(data, [{ slot: TASKS_SLOT(courseId), bytes: freed }]);
  return files;
}

/** Forgets an assignment and all the work handed in for it, read first (readTaskDrop). Returns the files to delete. */
export async function dropTask(courseId: string, lessonId: string, room: string | null, data: DataStore): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  return applyTaskDrop(await readTaskDrop(courseId, lessonId), room, data);
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
 * With the file's `path`, the same round marks that file as having taken
 * its bytes, for an hour (TAKEN_SECONDS), after the INCRBY: a round cut
 * short leaves at worst the bytes without the mark, which only refuses
 * sooner, never a mark without the bytes.
 *
 * The total is read only in its exact shape (CX-123 rule 24): one reply for
 * each command, a whole number at least the bytes just added, and the mark
 * written. Anything else throws UnknownReplyError, so the work is not
 * handed in and the student is told something went wrong (the route's
 * "server_error"), never that the room is full. Whether the INCRBY was
 * applied is not known then, so nothing is given back here: the caller
 * gives the bytes back with undoTakeRoom, which does it only when the
 * file's mark says they entered (a DECRBY of bytes that never entered
 * would leave room for more than the store's limit).
 */
export async function takeRoom(room: string, bytes: number, limit: number = MAX_STORE_TASK_BYTES, path?: string): Promise<boolean> {
  if (!isRedisConfigured() || !Number.isFinite(bytes) || bytes <= 0 || !Number.isSafeInteger(limit) || limit <= 0) return false;
  const added = Math.ceil(bytes);
  const marked = typeof path === "string" && path !== "";
  const replies = repliesFor(
    await redisPipeline([["INCRBY", bytesKey(room), added], ...(marked ? [["SET", takenKey(path), added, "EX", TAKEN_SECONDS]] : [])]),
    marked ? 2 : 1,
  );
  // INCRBY answers the new total as a number. A total under `added` (a counter left below zero) is unknown here and
  // throws; the increment stays, so the counter is back at or above zero for the next try (Revisor 1 on #2655).
  const used = replies ? countOf(replies[0]) : null;
  if (used === null || used < added || (marked && replies?.[1] !== "OK")) throw new UnknownReplyError("the room taken by handed-in files");
  if (used > limit) {
    const [left] = await redisPipeline([["DECRBY", bytesKey(room), added], ...(marked ? [["DEL", takenKey(path)]] : [])]);
    if (typeof left === "number" && left < 0) await redisPipeline([["SET", bytesKey(room), 0]]);
    return false;
  }
  return true;
}

/**
 * Gives back the room takeRoom took for this file when its answer was not
 * known, only if the file's mark says the bytes entered: the mark is
 * deleted first, and only a DEL that answered exactly 1 (this call removed
 * it, so no other one will) is followed by the DECRBY, never below zero
 * (releaseBytes). No mark: the bytes never entered, or were given back
 * already. An answer of another shape throws UnknownReplyError and gives
 * nothing back, which only refuses sooner.
 *
 * The mark of a file whose room was taken with a known answer is left to
 * expire: this is called only from the hand-in route's failure on that same
 * call, and a file's path passes the door once (takeTaskUpload), so a later
 * releaseBytes of the same bytes never meets this.
 */
export async function undoTakeRoom(room: string, bytes: number, path: string): Promise<boolean> {
  if (!isRedisConfigured() || !Number.isFinite(bytes) || bytes <= 0 || !path) return false;
  const replies = repliesFor(await redisPipeline([["DEL", takenKey(path)]]), 1);
  if (!replies || (replies[0] !== 0 && replies[0] !== 1)) throw new UnknownReplyError("whether a handed-in file took its room");
  if (replies[0] !== 1) return false;
  // The mark is gone: an unknown give-back is said as unknown to the caller, which handles it, never as given back.
  if (!(await releaseBytes(room, bytes))) throw new UnknownReplyError("whether a handed-in file's room was given back");
  return true;
}

/**
 * What GET answers for the counter INCRBY/DECRBY keep: a whole number of bytes, as text. It can be below zero for a
 * moment (a DECRBY racing releaseBytes' SET 0), and a counter below zero is nothing used, as releaseBytes reads it
 * (Revisor 1 on #2655): never a store whose students can no longer hand in.
 */
const BYTES_TEXT = /^(0|-?[1-9]\d{0,15})$/;

/** A GET of the counter as text, a whole number, below zero read as zero; null for anything else, a number included (GET answers text or nil only; Codex P on #2655). */
function bytesUsed(reply: unknown): number | null {
  if (typeof reply !== "string" || !BYTES_TEXT.test(reply)) return null;
  const n = Number(reply);
  return Number.isSafeInteger(n) ? Math.max(0, n) : null;
}

/**
 * Whether a file of this size would still fit, read without taking anything.
 * Only an explicit nil is "nothing used"; a whole number from 0 is what is
 * used; any other reply is unknown and throws UnknownReplyError (Codex P on
 * #2655; CX-123 rule 24), so no upload is signed on a guess and nobody is
 * told the room is full when it was not read.
 */
export async function hasRoom(room: string, bytes: number, limit: number = MAX_STORE_TASK_BYTES): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([["GET", bytesKey(room)]]), 1);
  const reply = replies?.[0];
  const used = reply === null ? 0 : bytesUsed(reply);
  if (!replies || used === null) throw new UnknownReplyError("how much room a store's handed-in files take");
  return used + bytes <= limit;
}

/**
 * Gives back room taken for files that are no longer kept. True when the DECRBY answered the counter's new total, a
 * whole number (below zero it comes back to zero); nothing to give back is true too. Any other reply is unknown
 * (CX-123 rule 24): it is not known whether the bytes came back, so it answers false and says so in the log, never
 * "given back". It does not throw: the callers that delete records call it after the deletion, which must not be
 * undone or hidden by it (applyTaskDrop, forgetTasksPerson); undoTakeRoom throws on false itself.
 */
export async function releaseBytes(room: string, bytes: number): Promise<boolean> {
  if (!isRedisConfigured() || !(bytes > 0)) return true;
  const left = signedOf(repliesFor(await redisPipeline([["DECRBY", bytesKey(room), Math.ceil(bytes)]]), 1)?.[0]);
  if (left === null) {
    console.error(`giving back ${Math.ceil(bytes)} bytes of a store's task room: unknown reply, not counted as given back`);
    return false;
  }
  if (left < 0) await redisPipeline([["SET", bytesKey(room), 0]]);
  return true;
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
type CourseTasks = { id: string; modules: { lessons: { id: string; task?: unknown }[] }[] };

/** Every assignment of a course read for removal (readTaskDrop), before the course goes; throws on any unread. */
export async function readCourseTaskDrops(course: CourseTasks): Promise<TaskDrop[]> {
  const drops: TaskDrop[] = [];
  if (!isRedisConfigured()) return drops;
  for (const unit of course.modules) for (const lesson of unit.lessons) if (lesson.task) drops.push(await readTaskDrop(course.id, lesson.id));
  return drops;
}

/** Forgets what readCourseTaskDrops read, then the course's lists of work. Returns the files to delete. */
export async function applyCourseTaskDrops(course: CourseTasks, drops: TaskDrop[], room: string | null, data: DataStore): Promise<string[]> {
  const files: string[] = [];
  for (const drop of drops) files.push(...(await applyTaskDrop(drop, room, data)));
  if (files.length || course.modules.some((m) => m.lessons.some((l) => l.task))) {
    await redisPipeline([["DEL", waitingKey(course.id), allKey(course.id)]]);
  }
  return files;
}

/** A course's assignments all forgotten, each read first. Returns the files to delete. */
export async function dropCourseTasks(course: CourseTasks, room: string | null, data: DataStore): Promise<string[]> {
  return applyCourseTaskDrops(course, await readCourseTaskDrops(course), room, data);
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
