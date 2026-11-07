/**
 * A student's answer to the survey when they finish a course, kept (285
 * [SX1]; the rules are in lib/course-survey-rules.ts).
 *
 *   nl:course:<course>:survey   hash   student's key (lib/learn.ts emailKey) → their answer
 *
 * Under the course's own name, so a closed store's walk (lib/closed-store-data.ts)
 * finds it by the course's id with the rest of the course.
 *
 * Every answer takes SURVEY_ROOM_BYTES of the store's data room before it is
 * written, once per student and course; a change takes nothing more, and the
 * room comes back only when a deletion is confirmed. A reply that is not
 * exactly what was asked for leaves the outcome unknown: the charge stays
 * (never less than what may be kept) and the caller is told.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, TAKE_DATA, dataKey, giveData, monthOf, needData } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import { UnknownReply, exactReplies, plainList } from "@/lib/redis-exact";
import {
  MAX_COURSE_ANSWERS,
  SURVEY_ROOM_BYTES,
  type SurveyAnswer,
  cleanSurveyNote,
  parseAnswer,
  parseSurveyScore,
  serializeAnswer,
} from "@/lib/course-survey-rules";

const surveyKey = (course: string) => `nl:course:${course}:survey`;
/** Where a course's answers are counted in the store's data room. */
const SURVEY_SLOT = (course: string) => `cs:${course}`;

const unreadable = () => new Error("Course survey answers could not be read. Try again.");

/** The data room's own steps (TAKE_DATA) for a course's slot, grown or shrunk by `bytes`, inside a script whose KEYS[1] is the room. */
const SURVEY_ROOM = `local function surveyRoom(limit, month, slot, bytes)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, '1', month, 'a', slot, bytes}
${TAKE_DATA}
end`;

/**
 * Runs a script that takes answers out with their room (DROP_SURVEY_ANSWER,
 * DROP_ALL_SURVEY_ANSWERS) and answers how many went. A store with no room to
 * count in, a room that cannot be counted, or a reply that is not exactly the
 * script's throws UnknownReply: nothing is taken for none.
 */
async function dropWithRoom(script: string, courseId: string, room: DataStore, extra: string[], what: string, tries: number): Promise<number> {
  const key = dataKey(room);
  if (!key) throw new UnknownReply(what);
  let reply: unknown;
  for (let attempt = 1; ; attempt += 1) {
    const now = Date.now();
    try {
      [reply] = exactReplies(
        await redisPipeline([["EVAL", script, 2, key, surveyKey(courseId), contentRoomFor(room, now / 1000), monthOf(now), SURVEY_SLOT(courseId), SURVEY_ROOM_BYTES, ...extra]]),
        1,
        what,
      );
      break;
    } catch (error) {
      // A try that ran before the failure already gave back what it took out: the next finds nothing and gives nothing.
      if (error instanceof UnknownReply || attempt >= tries) throw error;
    }
  }
  const [state, , gone] = exactReplies(reply, 3, what);
  if (state !== 1 || typeof gone !== "number" || !Number.isSafeInteger(gone) || gone < 0) throw new UnknownReply(what);
  return gone;
}

/**
 * Keeps one student's answer. KEYS: the course's answers; ARGV: the student's
 * key, the record, the most answers. Answers 1 when it is a new answer, 2
 * when it changed one already kept, 4 when the course is full and nothing was
 * written, 0 when its own limit could not be read and nothing was written.
 */
export const SET_SURVEY_ANSWER = `-- marktmorgen:course-survey-set:v1
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 1 then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
  return 2
end
local count = tonumber(redis.call("HLEN", KEYS[1]))
local most = tonumber(ARGV[3])
if not count or not most or most < 1 then return 0 end
if count >= most then return 4 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/**
 * Changes one student's answer only when they already have one, without any
 * room taken: a kept answer is charged at its largest, so a change never
 * keeps more. KEYS: the course's answers; ARGV: the student's key, the
 * record. Answers 2 when it changed, 0 when there was none to change.
 */
export const CHANGE_SURVEY_ANSWER = `-- marktmorgen:course-survey-change:v1
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 2`;

/**
 * Takes a whole course's answers away, when the course goes, and gives back
 * their room in the same step, so a give-back is never lost after the answers
 * went and dropping again always leaves the room level. KEYS: the store's
 * data room, the course's answers; ARGV: the room's limit, this month, the
 * course's slot, the bytes each answer is charged at. The room's step comes
 * first: when it cannot be made ({-1, total}) nothing is deleted. Answers
 * {1, total, how many went}. Modelled by lib/redis-memory.ts.
 */
export const DROP_ALL_SURVEY_ANSWERS = `-- marktmorgen:course-survey-drop-all:v2
${SURVEY_ROOM}
local count = redis.call("HLEN", KEYS[2])
local each = tonumber(ARGV[4])
if not each or each < 0 then return {-1, 0, 0} end
local taken = surveyRoom(ARGV[1], ARGV[2], ARGV[3], -count * each)
if taken[1] ~= 1 then return {taken[1], taken[2], 0} end
redis.call("DEL", KEYS[2])
return {1, taken[2], count}`;

/**
 * Takes one student's answer out and gives back its room in the same step.
 * KEYS: the store's data room, the course's answers; ARGV: the room's limit,
 * this month, the course's slot, the bytes an answer is charged at, the
 * student's key. The room's step comes first: when it cannot be made
 * ({-1, total, 0}) nothing is taken out. Answers {1, total, 1} when one went,
 * {1, 0, 0} when there was none. Modelled by lib/redis-memory.ts.
 */
export const DROP_SURVEY_ANSWER = `-- marktmorgen:course-survey-drop:v2
${SURVEY_ROOM}
local each = tonumber(ARGV[4])
if not each or each < 0 then return {-1, 0, 0} end
if redis.call("HEXISTS", KEYS[2], ARGV[5]) == 0 then return {1, 0, 0} end
local taken = surveyRoom(ARGV[1], ARGV[2], ARGV[3], -each)
if taken[1] ~= 1 then return {taken[1], taken[2], 0} end
redis.call("HDEL", KEYS[2], ARGV[5])
return {1, taken[2], 1}`;

/**
 * Reads every answer of a course, only while there are no more than were
 * paid for. KEYS: the course's answers; ARGV: the most. Answers {1, flat
 * field and value list}, or {0, the count} without reading them.
 */
export const READ_SURVEY_ANSWERS = `-- marktmorgen:course-survey-read:v1
local count = redis.call("HLEN", KEYS[1])
if count > tonumber(ARGV[1]) then return {0, count} end
return {1, redis.call("HGETALL", KEYS[1])}`;

/** The student's own answer, or null when they gave none. A kept answer that cannot be read throws. */
export async function readMyAnswer(courseId: string, who: string): Promise<SurveyAnswer | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = exactReplies(await redisPipeline([["HGET", surveyKey(courseId), who]]), 1, "a course survey answer");
  if (raw === null) return null;
  const answer = parseAnswer(raw);
  if (!answer) throw unreadable();
  return answer;
}

/** Whether a student keeps an answer: one command, no comment read (for the page of a student who has not finished). */
export async function hasAnswer(courseId: string, who: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const [found] = exactReplies(await redisPipeline([["HEXISTS", surveyKey(courseId), who]]), 1, "whether a course survey answer is kept");
  if (found !== 0 && found !== 1) throw unreadable();
  return found === 1;
}

/** How many students answered a course's survey. */
export async function surveyAnswerCount(courseId: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [count] = exactReplies(await redisPipeline([["HLEN", surveyKey(courseId)]]), 1, "a course survey's count");
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw unreadable();
  return count;
}

export type AnswerResult = { ok: true; changed: boolean } | { ok: false; reason: "score" | "full" | "unknown" };

/**
 * Keeps a student's answer, or changes the one they gave. The caller has
 * checked that they finished the course. The room is taken first
 * (DataRoomError when the store has none left), and given back when the
 * answer was a change or the course was full.
 */
export async function answerSurvey(input: {
  courseId: string;
  /** lib/learn.ts emailKey of the student. */
  who: string;
  score: unknown;
  note: unknown;
  now?: number;
  room: DataStore;
}): Promise<AnswerResult> {
  const score = parseSurveyScore(input.score);
  if (score === null) return { ok: false, reason: "score" };
  if (!isRedisConfigured()) return { ok: false, reason: "unknown" };
  const answer: SurveyAnswer = { score, note: cleanSurveyNote(input.note), at: input.now ?? Math.floor(Date.now() / 1000) };
  const record = serializeAnswer(answer);
  // A change first, with no room taken: a full room never refuses one.
  let changed: unknown;
  try {
    [changed] = exactReplies(await redisPipeline([["EVAL", CHANGE_SURVEY_ANSWER, 1, surveyKey(input.courseId), input.who, record]]), 1, "a course survey answer's change");
  } catch {
    return { ok: false, reason: "unknown" };
  }
  if (changed === 2) return { ok: true, changed: true };
  if (changed !== 0) return { ok: false, reason: "unknown" };
  const charge = [{ slot: SURVEY_SLOT(input.courseId), bytes: SURVEY_ROOM_BYTES }];
  await needData(input.room, charge);
  let written: unknown;
  try {
    [written] = exactReplies(
      await redisPipeline([["EVAL", SET_SURVEY_ANSWER, 1, surveyKey(input.courseId), input.who, record, MAX_COURSE_ANSWERS]]),
      1,
      "a course survey answer's write",
    );
  } catch {
    // Not known whether it was written: the charge stays.
    return { ok: false, reason: "unknown" };
  }
  if (written === 1) return { ok: true, changed: false };
  if (written !== 2 && written !== 4 && written !== 0) return { ok: false, reason: "unknown" };
  // Nothing new kept: an answer that came in between was changed, or nothing was written. The charge goes
  // back; if that fails, the answer stands (or not) as written and the outcome is said as unknown, with the
  // charge kept (never less than what may be kept).
  try {
    await giveData(input.room, charge);
  } catch {
    return { ok: false, reason: "unknown" };
  }
  if (written === 2) return { ok: true, changed: true };
  return { ok: false, reason: written === 4 ? "full" : "unknown" };
}

/**
 * Takes a student's answer out; true when one went, its room back in the
 * same step. A reply that is not exactly the script's throws UnknownReply.
 */
export async function removeMyAnswer(courseId: string, who: string, room: DataStore): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const what = "a course survey answer's removal";
  const gone = await dropWithRoom(DROP_SURVEY_ANSWER, courseId, room, [who], what, 1);
  if (gone !== 0 && gone !== 1) throw new UnknownReply(what);
  return gone === 1;
}

/**
 * Every answer of a course, without whose it is, while there are at most
 * `most`; otherwise how many there are, nothing read. The caller pays for
 * `most` before (lib/course-survey-rules.ts surveyReadUnits).
 */
export async function readCourseAnswers(courseId: string, most: number): Promise<{ ok: true; answers: SurveyAnswer[] } | { ok: false; count: number }> {
  if (!isRedisConfigured()) return { ok: true, answers: [] };
  const what = "a course's survey answers";
  const [reply] = exactReplies(await redisPipeline([["EVAL", READ_SURVEY_ANSWERS, 1, surveyKey(courseId), Math.max(0, Math.floor(most))]]), 1, what);
  const [state, body] = exactReplies(reply, 2, what);
  if (state === 0) {
    if (typeof body !== "number" || !Number.isSafeInteger(body) || body < 0) throw new UnknownReply(what);
    return { ok: false, count: body };
  }
  const flat = plainList(body);
  if (state !== 1 || !flat || flat.length % 2 !== 0 || flat.length / 2 > Math.max(0, most)) throw new UnknownReply(what);
  const answers: SurveyAnswer[] = [];
  // Only the values: whose answer it is never leaves this function.
  for (let i = 1; i < flat.length; i += 2) {
    const answer = parseAnswer(flat[i]);
    if (!answer) throw unreadable();
    answers.push(answer);
  }
  return { ok: true, answers };
}

/** One person's answer in a course, for the copy of their data (lib/person-copy.ts). */
export async function answerOfPerson(courseId: string, who: string): Promise<SurveyAnswer | null> {
  return readMyAnswer(courseId, who);
}

/**
 * Deletes one person's answer in a course (lib/person-erasure.ts) and gives
 * back its room in the same step. Answers how many went (0 or 1); a reply
 * that is not exactly the script's throws UnknownReply.
 */
export async function forgetSurveyPerson(courseId: string, who: string, room: DataStore): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const what = "the deletion of a person's course survey answer";
  const gone = await dropWithRoom(DROP_SURVEY_ANSWER, courseId, room, [who], what, 1);
  if (gone !== 0 && gone !== 1) throw new UnknownReply(what);
  return gone;
}

/**
 * Deletes every answer of a course, when the course goes (a product removed:
 * app/api/store/product; a course turned off: app/api/store/course), and gives
 * back their room in the same script (DROP_ALL_SURVEY_ANSWERS). Tried again up
 * to `tries` times when Redis fails: a try that ran before the failure has
 * already given back what it deleted, so the next finds nothing and gives
 * nothing. A room that cannot be counted deletes nothing, and a reply that is
 * not exactly what the script answers throws UnknownReply. Answers how many went.
 */
export async function dropCourseSurvey(courseId: string, room: DataStore, tries = 3): Promise<number> {
  if (!isRedisConfigured()) return 0;
  // No room to count it in means no answer could have been kept (answerSurvey takes its room first): still unknown, never zero.
  return dropWithRoom(DROP_ALL_SURVEY_ANSWERS, courseId, room, [], "the deletion of a course's survey answers", tries);
}
