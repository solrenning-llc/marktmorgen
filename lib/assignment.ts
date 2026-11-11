/**
 * Assignments: where they are kept, and what handing one in and reviewing it
 * do (lib/assignment-rules.ts says what they are).
 *
 *   nl:course:<course>:task:<lesson>              the prompt and its switches
 *   nl:course:<course>:task:<lesson>:sub:<who>    one student's work, and what came back
 *   nl:course:<course>:task:<lesson>:sub:<who>:lock  one hand-in of that work at a time, a minute at most
 *   nl:course:<course>:task:<lesson>:files        every file handed in for it, and its size, to delete with it
 *   nl:course:<course>:tasks:waiting              work waiting for the creator, oldest first
 *   nl:course:<course>:tasks:all                  all the work handed in, by when it last was
 *   nl:tasks:bytes:<store key>                    what the store's students keep handed in, in bytes
 *   nl:tasks:taken:<hash of a file's path>        the bytes one file took of that room, for an hour (undoTakeRoom)
 *   nl:tasks:doors                                files a student was let upload, by when: handed in, or deleted after a day
 *   nl:tasks:held                                 names a hand-in took, by when: deleted after a day unless the work keeps them
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
import { withLock } from "@/lib/redis-lock";
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
/** Names a hand-in took, by when: swept a day on unless the student's work keeps the file (takeTaskUpload). */
const HELD_KEY = "nl:tasks:held";
/** A file uploaded and not handed in within this long is deleted. */
export const DOOR_SECONDS = 24 * 60 * 60;
const WHO = /^[0-9a-f]{16,64}$/;

/** A JSON object as kept, or null when the text does not read as one. */
function storedObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A lesson's assignment, or null when it has none: only an explicit nil is none. A reply of another shape, or a
 * record not as saveTask wrote it (a prompt, and its three switches as true or false), throws UnknownReplyError
 * (CX-123 rule 24; Claude 4's audit), never "no assignment".
 */
export async function readTaskFor(courseId: string, lessonId: string): Promise<Task | null> {
  if (!isRedisConfigured() || !ITEM_ID_PATTERN.test(lessonId)) return null;
  const raw = repliesFor(await redisPipeline([["GET", taskKey(courseId, lessonId)]]), 1)?.[0];
  if (raw === null) return null;
  const value = typeof raw === "string" ? storedObject(raw) : null;
  const exact =
    !!value && typeof value.prompt === "string" && value.prompt !== "" && [value.review, value.gate, value.file].every((on) => typeof on === "boolean");
  if (!value || !exact) throw new UnknownReplyError("a lesson's assignment");
  return { ...(parseTaskSetup(value) as Task), prompt: value.prompt as string };
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
export type TaskDrop = { courseId: string; lessonId: string; files: string[]; sizes: number[]; bytes: number; gone: string[]; freed: number };

/** An assignment's files' hash (HGETALL), each file with its size, in its exact shape; anything else throws UnknownReplyError. */
function handedFilesOf(flat: unknown): { path: string; bytes: number }[] {
  // HGETALL answers a plain list of text: read from its own slots (stringList), so a Proxy, a hole, a member that is
  // not text or a reply that is not a list (an object too) is unknown, never a list.
  const pairs = stringList(flat);
  if (!pairs || pairs.length % 2 !== 0) throw new UnknownReplyError("the files handed in for an assignment");
  const out: { path: string; bytes: number }[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const [name, size] = [pairs[i], pairs[i + 1]];
    if (!name || !FILE_BYTES_TEXT.test(size)) throw new UnknownReplyError("the files handed in for an assignment");
    out.push({ path: name, bytes: Number(size) });
  }
  return out;
}

/**
 * Reads what removing an assignment will forget: its handed-in files and their sizes, the work handed in, and what
 * the records weigh. Every reply in its exact shape (CX-123 rules 24 and 30; Claude 4 after Codex P on #2655): a
 * files' hash, a list of work or a record that does not read throws UnknownReplyError. A caller reads this before it
 * takes the assignment out of the course (Revisor 1 on #2810), so a read that fails leaves everything findable.
 */
export async function readTaskDrop(courseId: string, lessonId: string): Promise<TaskDrop> {
  const listed = handedFilesOf(repliesFor(await redisPipeline([["HGETALL", filesKey(courseId, lessonId)]]), 1)?.[0]);
  const files = listed.map((f) => f.path);
  const sizes = listed.map((f) => f.bytes);
  const bytes = listed.reduce((sum, f) => sum + f.bytes, 0);
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
  return { courseId, lessonId, files, sizes, bytes, gone, freed };
}

/**
 * The bytes of the files this call took out of a files' hash, one HDEL each, so each reply says whether this call
 * removed that file (Claude 6 on #3009): a creator's drop, a student's erasure and a hand-in replacing its file can
 * all remove the same one. Exactly 1: removed here, its bytes are this call's to give back. Exactly 0: another path
 * removed it first and gave them back; nothing here. Any other reply is unknown (CX-123 rule 24): nothing is given
 * back for that file, which only refuses sooner, never leaves the store holding more than its room, and it is said in
 * the log. Never throws: the deletion already happened and its files are still to be deleted.
 */
function removedBytes(replies: unknown[] | null, sizes: unknown[]): number {
  let bytes = 0;
  let unknown = 0;
  sizes.forEach((size, i) => {
    const reply = replies ? replies[i] : undefined;
    // A size is given back only when it is a safe positive whole number (Codex N on #3078): text, a fraction, zero, a
    // negative or one past the safe integers is unknown, never read as a size (CX-123 rule 24), so nothing comes back.
    if (reply === 1 && typeof size === "number" && Number.isSafeInteger(size) && size > 0 && Number.isSafeInteger(bytes + size)) bytes += size;
    else if (reply !== 0) unknown++;
  });
  if (unknown) console.error(`not giving back the room of ${unknown} handed-in file(s)`, new UnknownReplyError("whether a handed-in file left the files' hash"));
  return bytes;
}

/**
 * Forgets what readTaskDrop read, and only that: the files read leave the files' hash one by one (HDEL), so a file
 * handed in after the reading stays listed, never lost; the work read leaves the lists. Returns the files to delete.
 */
export async function applyTaskDrop(drop: TaskDrop, room: string | null, data: DataStore): Promise<string[]> {
  const { courseId, lessonId, files, sizes, gone, freed } = drop;
  const commands = [
    ["DEL", taskKey(courseId, lessonId)],
    // One HDEL per file: only a file this call removed has its bytes given back here (removedBytes).
    ...files.map((file) => ["HDEL", filesKey(courseId, lessonId), file]),
    ...gone.map((member) => ["DEL", subKey(courseId, lessonId, member.slice(lessonId.length + 1))]),
    ...(gone.length ? [["ZREM", waitingKey(courseId), ...gone], ["ZREM", allKey(courseId), ...gone]] : []),
  ];
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  const bytes = files.length ? removedBytes(replies?.slice(1, 1 + files.length) ?? null, sizes) : 0;
  if (room && bytes) await releaseBytes(room, bytes);
  if (freed) await giveData(data, [{ slot: TASKS_SLOT(courseId), bytes: freed }]);
  return files;
}

/** Forgets an assignment and all the work handed in for it, read first (readTaskDrop). Returns the files to delete. */
export async function dropTask(courseId: string, lessonId: string, room: string | null, data: DataStore): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  return applyTaskDrop(await readTaskDrop(courseId, lessonId), room, data);
}

const TASK_STATES: readonly unknown[] = ["waiting", "approved", "again"] satisfies TaskState[];
const wholeFrom = (value: unknown, least: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= least;

function isHandedFile(value: unknown): value is HandedFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return typeof file.path === "string" && file.path !== "" && typeof file.name === "string" && wholeFrom(file.bytes, 0) && typeof file.type === "string";
}

/** A student's record as handIn and review write it, or null for anything else. */
function storedSubmission(raw: string): Submission | null {
  const v = storedObject(raw);
  if (!v) return null;
  const exact =
    typeof v.text === "string" &&
    (v.file === null || isHandedFile(v.file)) &&
    wholeFrom(v.at, 0) &&
    TASK_STATES.includes(v.state) &&
    typeof v.feedback === "string" &&
    wholeFrom(v.reviewedAt, 0) &&
    wholeFrom(v.tries, 1);
  return exact ? (v as Submission) : null;
}

/**
 * One student's work on one assignment, or null when they have handed nothing in: only an explicit nil is nothing.
 * A reply cut short, of another shape, or a record that does not read as handIn wrote it throws UnknownReplyError
 * (CX-123 rule 24; Claude 4's audit), so approved work is never taken for nothing handed in and handed in over.
 */
export async function submissionOf(courseId: string, lessonId: string, who: string): Promise<Submission | null> {
  return (await readSubmission(courseId, lessonId, who)).found;
}

/** The work as read, and its exact text ("" for none), for a write made only over that same text (HAND_IN_WRITE_IF). */
async function readSubmission(courseId: string, lessonId: string, who: string): Promise<{ found: Submission | null; raw: string }> {
  if (!isRedisConfigured() || !WHO.test(who) || !ITEM_ID_PATTERN.test(lessonId)) return { found: null, raw: "" };
  const reply = repliesFor(await redisPipeline([["GET", subKey(courseId, lessonId, who)]]), 1)?.[0];
  if (reply === null) return { found: null, raw: "" };
  const found = typeof reply === "string" ? storedSubmission(reply) : null;
  if (!found || typeof reply !== "string") throw new UnknownReplyError("one student's work on an assignment");
  return { found, raw: reply };
}

/** A student's record that is there but does not read as handIn wrote it: kept, and said as not read. */
export type UnreadSubmission = { unread: true };

export function isUnreadSubmission(value: Submission | UnreadSubmission | null | undefined): value is UnreadSubmission {
  return !!value && "unread" in value && value.unread === true;
}

/**
 * Several students' work at once, in the order asked, null where there is none (an explicit nil). A reply cut short
 * or of another shape throws UnknownReplyError (CX-123 rule 24); a record that is there but does not read is
 * answered `{ unread: true }`, never null, so it does not drop out of the person's copy of their data
 * (lib/person-copy.ts) nor out of the studio's list of work, which say it could not be read.
 */
export async function submissionsOf(courseId: string, rows: { lessonId: string; who: string }[]): Promise<(Submission | UnreadSubmission | null)[]> {
  const asked = rows.filter((r) => WHO.test(r.who) && ITEM_ID_PATTERN.test(r.lessonId));
  if (!isRedisConfigured() || !asked.length) return rows.map(() => null);
  const raws = repliesFor(await redisPipeline(asked.map((r) => ["GET", subKey(courseId, r.lessonId, r.who)])), asked.length);
  if (!raws || !raws.every((raw) => raw === null || typeof raw === "string")) throw new UnknownReplyError("several students' work on assignments");
  const read = (raw: unknown): Submission | UnreadSubmission | null => (raw === null ? null : (storedSubmission(raw as string) ?? { unread: true }));
  const found = new Map(asked.map((r, i) => [`${r.lessonId}|${r.who}`, read(raws[i])]));
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

/** How long one hand-in holds its work's lock at most, and how long the next one waits for it. */
const HAND_IN_LOCK_SECONDS = 60;
const HAND_IN_WAIT_MS = 5_000;

/**
 * One hand-in of one student's work on one lesson at a time (CX-123 rule 24): two at once would each read the same
 * earlier work, each answer its file as the one replaced, and the file one of them handed in would stay stored with
 * no work keeping it (freedBytes keeps the room from coming back twice, not that orphan). The route runs everything
 * from reading the earlier work to deleting the file it replaced inside this. A lock still taken after the wait
 * throws LockBusyError before anything is read or taken, so the student can simply hand in again.
 */
export function oneHandInAtATime<T>(courseId: string, lessonId: string, who: string, work: () => Promise<T>): Promise<T> {
  return withLock(`${subKey(courseId, lessonId, who)}:lock`, HAND_IN_LOCK_SECONDS, HAND_IN_WAIT_MS, () => work());
}

/**
 * What handing in did: where the work stands, and the earlier file it replaced, with its size, to delete; and
 * `freedBytes`, that file's bytes when this hand-in took it out of the files' hash, for the caller to give back to the
 * store's task room (0 when another path, a drop of the assignment, removed it first and gave them back).
 */
export type HandIn = { state: TaskState; replaced: HandedFile | null; freedBytes: number };

/**
 * Another hand-in of the same work was written between this one's read and its write (its lease ran out while it
 * waited; Codex P and Codex N on #3135): nothing of this one was written, and the work keeps the other's.
 */
export class HandInChangedError extends Error {
  constructor() {
    super("this work was handed in again meanwhile");
    this.name = "HandInChangedError";
  }
}

/**
 * The work written only over the one it was read as (KEYS: the work, the lesson's files, the course's waiting list,
 * its list of all work; ARGV: the work as read or "" for none, the new work, the file's path or "", its bytes, "1"
 * when a person reads it, when, the lists' member). 1 when written, 0 when the work changed since and nothing was
 * written; so the file it replaced is answered, deleted and given back by one hand-in only.
 */
export const HAND_IN_WRITE_IF = `-- marktmorgen:hand-in-write-if:v1
local now = redis.call('GET', KEYS[1]) or ''
if now ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[2], ARGV[3], ARGV[4]) end
if ARGV[5] == '1' then redis.call('ZADD', KEYS[3], ARGV[6], ARGV[7]) else redis.call('ZREM', KEYS[3], ARGV[7]) end
redis.call('ZADD', KEYS[4], ARGV[6], ARGV[7])
return 1`;

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
  /**
   * Called just before the work is written. A failure before it kept nothing; from it on, the work (and the file in
   * it) may be kept even when the call fails, its answer lost or a step after it failing (CX-123 rule 24).
   */
  writing?: () => void;
}): Promise<HandIn> {
  const { courseId, lessonId, who, task } = input;
  const at = input.now ?? Math.floor(Date.now() / 1000);
  const read = await readSubmission(courseId, lessonId, who);
  const before = read.found;
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
  input.writing?.();
  // Written only over the work read above (HAND_IN_WRITE_IF): a hand-in whose lease ran out while another replaced the
  // work writes nothing, so the earlier file is answered as replaced, deleted and given back by one hand-in only, and
  // the successor's work is never written over. Its own taking for the record stays counted, which only refuses sooner.
  const wrote = repliesFor(
    await redisPipeline([
      [
        "EVAL",
        HAND_IN_WRITE_IF,
        4,
        subKey(courseId, lessonId, who),
        filesKey(courseId, lessonId),
        waitingKey(courseId),
        allKey(courseId),
        read.raw,
        JSON.stringify(kept),
        input.file?.path ?? "",
        input.file?.bytes ?? 0,
        task.review ? "1" : "0",
        at,
        member,
      ],
    ]),
    1,
  )?.[0];
  if (wrote === 0) throw new HandInChangedError();
  if (wrote !== 1) throw new UnknownReplyError("whether a hand-in was written");
  if (grown < 0) await giveData(input.data, [{ slot: TASKS_SLOT(courseId), bytes: -grown }]);
  if (!task.review) await finish(courseId, lessonId, who, input.email, input.data);
  const replaced = before?.file && before.file.path !== input.file?.path ? before.file : null;
  let freedBytes = 0;
  if (replaced) {
    // Its entry and its bytes are given back only when this HDEL removed it (removedBytes): a drop racing this
    // hand-in may have removed it and given them back already.
    const size = Number(replaced.bytes) || 0;
    const gone = repliesFor(await redisPipeline([["HDEL", filesKey(courseId, lessonId), replaced.path]]), 1);
    if (gone?.[0] === 1) await giveData(input.data, [{ slot: TASKS_SLOT(courseId), bytes: ENTRY_BYTES }]);
    freedBytes = removedBytes(gone, [size]);
  }
  return { state, replaced, freedBytes };
}

/** The lesson done, for the outline, the progress and the certificate, and the lessons after it open. */
async function finish(courseId: string, lessonId: string, who: string, email: string, data: DataStore): Promise<void> {
  await markPassed(courseId, who, lessonId, data);
  if (email) await markLesson(courseId, email, lessonId, true, data, true);
}

export type Waiting = { lessonId: string; who: string; at: number };

/** When work was handed in, as a sorted set's score is answered: a whole number of seconds, as text. */
const SECONDS_TEXT = /^(0|[1-9]\d{0,15})$/;

/**
 * Work for the creator to read, and how much there is: what is waiting,
 * oldest first, or with `all` everything handed in, newest first. Every
 * reply in its exact shape (CX-123 rule 24): a list or a count of another
 * shape, a member that is not "lesson|student" or a time that is not one
 * throws UnknownReplyError, never an empty list.
 */
export async function waitingWork(courseId: string, limit = 50, all = false): Promise<{ rows: Waiting[]; total: number }> {
  if (!isRedisConfigured()) return { rows: [], total: 0 };
  const key = all ? allKey(courseId) : waitingKey(courseId);
  const replies = repliesFor(
    await redisPipeline([
      all ? ["ZREVRANGE", key, 0, limit - 1, "WITHSCORES"] : ["ZRANGEBYSCORE", key, "-inf", "+inf", "WITHSCORES", "LIMIT", 0, limit],
      ["ZCARD", key],
    ]),
    2,
  );
  const flat = replies ? stringList(replies[0]) : null;
  const total = replies ? countOf(replies[1]) : null;
  if (!flat || flat.length % 2 !== 0 || total === null) throw new UnknownReplyError("the work handed in for a course");
  const out: Waiting[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const parts = flat[i].split("|");
    if (parts.length !== 2 || !parts[0] || !parts[1] || !SECONDS_TEXT.test(flat[i + 1])) throw new UnknownReplyError("the work handed in for a course");
    out.push({ lessonId: parts[0], who: parts[1], at: Number(flat[i + 1]) });
  }
  return { rows: out, total };
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

/**
 * Lists a name a door is about to open for, before the file store is asked about it (app/api/store/course/task/upload):
 * true when this call listed it anew, false when it was listed already (another door for it still open; it keeps the
 * time it was first listed at, so the sweep still deletes it a day after that first door). Read exactly (CX-123 rule 24): any other answer throws UnknownReplyError, and no
 * door is opened. Listed first, then the file store asked: a door listed after a hand-in took the name finds the
 * handed-in file there, is refused and takes back only its own listing (dropTaskDoor), so the sweep is not pointed at
 * handed-in work. (Only a file that lands between a hand-in's two steps, its take and its read of the file, while the
 * same student asks a second door for the same name, could still be listed; it is that student's own file.)
 */
export async function listTaskDoor(path: string, now = Date.now()): Promise<boolean> {
  // NX: a name listed already keeps the time it was first listed at, so doors asked again and again never keep an
  // unused file out of the sweep (Claude 6's review of #3461, MEDIUM 2).
  const added = countOf(repliesFor(await redisPipeline([["ZADD", DOORS_KEY, "NX", Math.floor(now / 1000), path]]), 1)?.[0]);
  if (added !== 0 && added !== 1) throw new UnknownReplyError("an assignment upload's listing");
  return added === 1;
}

/** Takes back a listing this door made itself (listTaskDoor answered true) when the door is not opened after all. */
export async function dropTaskDoor(path: string): Promise<void> {
  await redisPipeline([["ZREM", DOORS_KEY, path]]);
}

/**
 * Whether this file was let in through the door and not handed in yet; it is then taken. The name is held for the
 * sweep (HELD_KEY) before it comes off the doors' list, so whatever becomes of the hand-in that took it (refused, its
 * write lost, or the function stopped by its time limit before it wrote anything) the file is never kept for ever
 * outside the sweep and the room: a day on, the sweep deletes it unless the student's work keeps it (the second
 * pre-review of 9 November 2026). A hold this call wrote for a name it did not take is taken back. A hand-in that
 * keeps its file lets go of the hold (releaseTaskHold), so the sweep has nothing to read for it.
 */
export async function takeTaskUpload(path: string, now = Date.now()): Promise<boolean> {
  // Read exactly (CX-123 rule 24; Claude 6's review of #3461, MEDIUM 3): the hold's ZADD and the doors' ZREM each
  // answer the whole number 0 or 1. Any other answer is not known: it throws, the route answers server_error, and the
  // hold stays, so the sweep reads the name a day on (it deletes only a file no work keeps), never left in neither list.
  const added = countOf(repliesFor(await redisPipeline([["ZADD", HELD_KEY, Math.floor(now / 1000), path]]), 1)?.[0]);
  if (added !== 0 && added !== 1) throw new UnknownReplyError("holding an assignment upload for the sweep");
  const removed = countOf(repliesFor(await redisPipeline([["ZREM", DOORS_KEY, path]]).catch(() => null), 1)?.[0]);
  if (removed === 1) return true;
  if (removed !== 0) throw new UnknownReplyError("taking an assignment upload from the doors");
  if (added === 1) await redisPipeline([["ZREM", HELD_KEY, path]]).catch(() => null);
  return false;
}

/** Lets go of a taken name's hold once the work keeps its file (takeTaskUpload). Best effort: the sweep reads the work anyway. */
export async function releaseTaskHold(path: string): Promise<void> {
  await redisPipeline([["ZREM", HELD_KEY, path]]).catch((error: unknown) => console.error("letting go of a handed-in file's hold failed", error));
}

/** The course, lesson and student a path in a store's assignment folders names (lib/assignment-rules.ts, taskFolder). */
function handedInWorkOf(path: string): { courseId: string; lessonId: string; who: string } | null {
  const parts = path.split("/");
  if (parts.length !== 7 || parts[0] !== "stores" || parts[2] !== "tasks") return null;
  return { courseId: parts[3], lessonId: parts[4], who: parts[5] };
}

/** How many doors a pipeline of ZREMs takes off the list at most (see sweepTaskUploads). */
const TAKE_BATCH = 25;

/**
 * Deletes, with `remove`, the files uploaded more than a day ago and never
 * handed in: the student closed the page, or chose another file, or the file
 * was a deleted person's that the file store did not answer for
 * (lib/person-erasure.ts). A few hundred a run at most from each list;
 * answers the paths deleted.
 *
 * Two lists: the doors never taken by a hand-in (DOORS_KEY), and the names a
 * hand-in took more than a day ago (HELD_KEY, takeTaskUpload): whatever became
 * of that hand-in (refused, cut off by its time limit, its write lost), the
 * file is deleted unless the student's work keeps it (the second pre-review of
 * 9 November 2026). A held name listed again among the doors is left to them.
 *
 * Each path is taken off its list by its own ZREM, and only one this run
 * removed itself (exactly 1) is deleted: a hand-in that took the door
 * (takeTaskUpload) after the list was read keeps its file (Claude 5 on
 * #2836). A file that is a student's handed-in work is never deleted, whatever
 * the list says: read from the work itself, by the course, lesson and student
 * its path names; work that cannot be read keeps the file and puts it back.
 * Each won path is deleted on its own, and only a path whose deletion failed
 * is put back, so one that keeps failing never holds the others (Claude 5 on
 * #3045; as lib/community-files.ts does). The lists, the pipelines and each
 * ZREM are read in their exact shape (CX-123 rule 24): anything else deletes
 * nothing it cannot prove was this run's own, is logged, and the paths
 * deleted are still answered, so the cron counts them.
 *
 * The ZREMs go TAKE_BATCH to a pipeline: a reply lost after they ran (a
 * timeout, a cut connection) leaves those names off their list with nothing
 * deleted, and putting them back blind is not safe (a hand-in may have won
 * them), so a lost reply costs at most TAKE_BATCH files kept, not the run's
 * whole list.
 */
export async function sweepTaskUploads(remove: (paths: string[]) => Promise<void>, now = Date.now(), limit = 300): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const before = Math.floor(now / 1000) - DOOR_SECONDS;
  const doors = await sweepList(DOORS_KEY, remove, before, limit);
  const holds = await sweepList(HELD_KEY, remove, before, limit);
  return [...doors, ...holds];
}

/** One list of sweepTaskUploads: its names before `before`, each taken off it, and deleted unless work keeps it. */
async function sweepList(key: string, remove: (paths: string[]) => Promise<void>, before: number, limit: number): Promise<string[]> {
  const found = repliesFor(await redisPipeline([["ZRANGEBYSCORE", key, 0, before, "LIMIT", 0, limit]]), 1)?.[0];
  const listed = Array.isArray(found) ? repliesFor(found, found.length) : null;
  if (!listed || !listed.every((p): p is string => typeof p === "string")) throw new UnknownReplyError("the uploads never handed in");
  if (!listed.length) return [];
  const won: string[] = [];
  let unknown = 0;
  for (let at = 0; at < listed.length; at += TAKE_BATCH) {
    const batch = listed.slice(at, at + TAKE_BATCH);
    let takes: unknown[] | null;
    try {
      takes = repliesFor(await redisPipeline(batch.map((p) => ["ZREM", key, p])), batch.length);
    } catch (error) {
      console.error(`taking ${batch.length} unused assignment uploads off their list: no reply, their files are kept`, error);
      unknown += batch.length;
      continue;
    }
    if (!takes) {
      unknown += batch.length;
      continue;
    }
    batch.forEach((p, i) => {
      if (takes[i] === 1) won.push(p);
      else if (takes[i] !== 0) unknown += 1;
    });
  }
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const p of won) {
    const kept = await keptByWork(p, key === HELD_KEY);
    if (kept === true) continue;
    if (kept === null) {
      failed.push(p);
      continue;
    }
    try {
      await remove([p]);
      deleted.push(p);
    } catch (error) {
      console.error("could not delete an unused assignment upload; it is put back for the next run", error);
      failed.push(p);
    }
  }
  if (failed.length) {
    const back = repliesFor(await redisPipeline([["ZADD", key, ...failed.flatMap((p) => [before, p])]]), 1)?.[0];
    if (countOf(back) === null) console.error(`putting back ${failed.length} unused assignment uploads: unknown reply, they may be left`);
  }
  if (unknown) console.error(`${unknown} unused assignment uploads: whether they were taken off their list came back in an unknown shape; their files are kept`);
  return deleted;
}

/**
 * Whether a swept path must stay: true when the student's work keeps it (or, for a held name, when a door lists it
 * again: the doors' sweep has it), false when nothing does, null when that cannot be read (kept, put back). A path
 * that names no work is a door's file as before.
 */
async function keptByWork(path: string, held: boolean): Promise<boolean | null> {
  try {
    if (held) {
      const door = repliesFor(await redisPipeline([["ZSCORE", DOORS_KEY, path]]), 1);
      if (!door) return null;
      if (door[0] !== null) return true;
    }
    const work = handedInWorkOf(path);
    if (!work) return false;
    return (await submissionOf(work.courseId, work.lessonId, work.who))?.file?.path === path;
  } catch (error) {
    console.error("reading the work an unused assignment upload may belong to failed; kept for the next run", error);
    return null;
  }
}

/**
 * Whether to tell the creator about new work now: once an hour per course at most. "OK" is now, nil is told already
 * this hour; anything else throws UnknownReplyError (CX-123 rule 24), so no email goes on a guess.
 */
export async function tellCreatorNow(courseId: string): Promise<boolean> {
  const fresh = repliesFor(await redisPipeline([["SET", `nl:course:${courseId}:tasks:told`, "1", "NX", "EX", 3_600]]), 1)?.[0];
  if (fresh === "OK") return true;
  if (fresh === null) return false;
  throw new UnknownReplyError("whether a creator was told of new work this hour");
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
 * The file a stored record names, for an erasure: null when it names none, undefined when the record does not read
 * well enough to say. Only the file is needed here, so a record otherwise out of shape still gives up its file. A
 * size that does not read gives back no room (which only refuses sooner).
 */
function fileOfRecord(raw: string): { path: string; bytes: number } | null | undefined {
  const value = storedObject(raw);
  if (!value) return undefined;
  const file = value.file;
  if (file === null) return null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return undefined;
  const { path, bytes } = file as { path?: unknown; bytes?: unknown };
  if (typeof path !== "string" || !path) return undefined;
  return { path, bytes: wholeFrom(bytes, 0) ? (bytes as number) : 0 };
}

/** Whether a listed file sits in exactly this student's own folder for this assignment (taskFolder, any store folder). */
function inStudentFolder(path: string, courseId: string, lessonId: string, who: string): boolean {
  const parts = path.split("/");
  return parts.length === 7 && parts[0] === "stores" && !!parts[1] && parts[2] === "tasks" && parts[3] === courseId && parts[4] === lessonId && parts[5] === who && !!parts[6] && !path.includes("..");
}

/**
 * Thrown by forgetTasksPerson when it deleted records whose handed-in file it could not read from them: the
 * erasure is incomplete (a file may be left), and is said so, never "done".
 */
export class TaskRecordUnreadError extends Error {
  constructor(
    readonly unread: number,
    readonly records: number,
  ) {
    super(`${unread} of ${records} deleted assignment records did not say which file was handed in with them`);
    this.name = "TaskRecordUnreadError";
  }
}

/**
 * Deletes one student's work in a course's assignments (lib/person-erasure.ts):
 * each record of what they handed in and what came back, its place in the
 * creator's lists, and the room its files took. Returns the files to delete
 * from the file store, as dropTask does.
 *
 * Read exactly (CX-123 rule 24; Claude 4's audit): a reply cut short or of
 * another shape throws UnknownReplyError before anything is deleted, so the
 * erasure says it could not finish and its retry finds everything. A record
 * that is there but does not say its file is deleted all the same (the
 * erasure must remove it); the files of the records that do read go to the
 * daily job that deletes uploads nobody kept (staleTaskUploads, as the
 * erasure itself does when the file store does not answer), and it throws
 * TaskRecordUnreadError, so the erasure is said to be incomplete; that
 * record's file is still found in the assignment's files hash under the
 * student's own folder, and deleted with it. The deletion's receipt is
 * read too: a batch that does not answer a count for every command throws
 * UnknownReplyError, its files left to the daily job (Codex P on #2847).
 */
export async function forgetTasksPerson(courseId: string, lessonIds: string[], who: string, room: string | null): Promise<{ records: number; files: string[] }> {
  if (!lessonIds.length || !WHO.test(who) || !isRedisConfigured()) return { records: 0, files: [] };
  const raws = repliesFor(await redisPipeline(lessonIds.map((l) => ["GET", subKey(courseId, l, who)])), lessonIds.length);
  if (!raws || !raws.every((raw) => raw === null || typeof raw === "string")) throw new UnknownReplyError("a student's work on a course's assignments");
  const handed = lessonIds.flatMap((lessonId, i) => (typeof raws[i] === "string" ? [{ lessonId, file: fileOfRecord(raws[i] as string) }] : []));
  if (!handed.length) return { records: 0, files: [] };
  const unreadLessons = handed.filter((h) => h.file === undefined).map((h) => h.lessonId);
  const unread = unreadLessons.length;
  const files = handed.flatMap((h) => (h.file ? [{ lessonId: h.lessonId, ...h.file }] : []));
  // A record that does not say its file still has it listed in the assignment's files hash, under the student's own
  // folder (taskFolder): it is taken from there, so neither this run nor the retry leaves it behind (Claude 6 on
  // #2847). Read exactly, before anything is deleted; read only when a record does not read.
  if (unread) {
    const hashes = repliesFor(await redisPipeline(unreadLessons.map((l) => ["HGETALL", filesKey(courseId, l)])), unread);
    if (!hashes) throw new UnknownReplyError("the files handed in for an assignment");
    unreadLessons.forEach((lessonId, i) => {
      for (const f of handedFilesOf(hashes[i])) if (inStudentFolder(f.path, courseId, lessonId, who)) files.push({ lessonId, ...f });
    });
  }
  const members = handed.map((h) => `${h.lessonId}|${who}`);
  const batch: (string | number)[][] = [
    ["DEL", ...handed.map((h) => subKey(courseId, h.lessonId, who))],
    ["ZREM", waitingKey(courseId), ...members],
    ["ZREM", allKey(courseId), ...members],
    // One HDEL per file: only a file this erasure removed has its bytes given back here (removedBytes).
    ...files.map((f) => ["HDEL", filesKey(courseId, f.lessonId), f.path]),
    // Thrown below, the files it read would not reach the erasure: the daily job deletes them instead.
    ...(unread && files.length ? [["ZADD", DOORS_KEY, ...files.flatMap((f) => [0, f.path])]] : []),
  ];
  // Every command answers a count (Codex P on #2847). Anything else may have applied all, part or none of the
  // batch: nothing is sent again on a guess and no room is given back, the files read go to the daily job that
  // deletes uploads nobody kept, and the erasure is told it could not finish, never "done".
  const receipt = repliesFor(await redisPipeline(batch), batch.length);
  if (!receipt || !receipt.every((reply) => countOf(reply) !== null)) {
    if (files.length) await redisPipeline([["ZADD", DOORS_KEY, ...files.flatMap((f) => [0, f.path])]]);
    throw new UnknownReplyError("the deletion of a student's work on a course's assignments");
  }
  // Each file's bytes come back only when its own HDEL removed it here (removedBytes).
  const bytes = files.length ? removedBytes(receipt.slice(3, 3 + files.length), files.map((f) => f.bytes)) : 0;
  if (room && bytes) await releaseBytes(room, bytes);
  if (unread) throw new TaskRecordUnreadError(unread, handed.length);
  return { records: handed.length, files: files.map((f) => f.path) };
}
