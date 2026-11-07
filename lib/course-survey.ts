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
import { type DataStore, giveData, needData } from "@/lib/store-data";
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
 * Takes a whole course's answers away, when the course goes. KEYS: the
 * course's answers. Answers how many there were, all gone.
 */
export const DROP_ALL_SURVEY_ANSWERS = `-- marktmorgen:course-survey-drop-all:v1
local count = redis.call("HLEN", KEYS[1])
redis.call("DEL", KEYS[1])
return count`;

/** Takes one student's answer out. KEYS: the course's answers; ARGV: the student's key. Answers 1 when one went, 0 when there was none. */
export const DROP_SURVEY_ANSWER = `-- marktmorgen:course-survey-drop:v1
return redis.call("HDEL", KEYS[1], ARGV[1])`;

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
 * Takes a student's answer out; true when one went, and its room came back.
 * A reply that is not exactly 0 or 1 throws UnknownReply, and nothing comes back.
 */
export async function removeMyAnswer(courseId: string, who: string, room: DataStore): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const [gone] = exactReplies(await redisPipeline([["EVAL", DROP_SURVEY_ANSWER, 1, surveyKey(courseId), who]]), 1, "a course survey answer's removal");
  if (gone === 0) return false;
  if (gone !== 1) throw new UnknownReply("a course survey answer's removal");
  await giveData(room, [{ slot: SURVEY_SLOT(courseId), bytes: SURVEY_ROOM_BYTES }]);
  return true;
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
 * back its room once confirmed gone. Answers how many went (0 or 1); a reply
 * that is not exactly that throws UnknownReply, with nothing given back.
 */
export async function forgetSurveyPerson(courseId: string, who: string, room?: DataStore): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const what = "the deletion of a person's course survey answer";
  const [gone] = exactReplies(await redisPipeline([["EVAL", DROP_SURVEY_ANSWER, 1, surveyKey(courseId), who]]), 1, what);
  if (gone !== 0 && gone !== 1) throw new UnknownReply(what);
  if (room && gone === 1) await giveData(room, [{ slot: SURVEY_SLOT(courseId), bytes: SURVEY_ROOM_BYTES }]);
  return gone;
}

/**
 * Deletes every answer of a course, when the course goes (a product removed:
 * app/api/store/product; a course turned off: app/api/store/course), and gives
 * back the room of each answer confirmed gone. Tried again up to `tries` times
 * when Redis fails; a reply that is not exactly a count throws UnknownReply,
 * with nothing given back. Answers how many went.
 */
export async function dropCourseSurvey(courseId: string, room: DataStore, tries = 3): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const what = "the deletion of a course's survey answers";
  let gone: unknown;
  for (let attempt = 1; ; attempt += 1) {
    try {
      [gone] = exactReplies(await redisPipeline([["EVAL", DROP_ALL_SURVEY_ANSWERS, 1, surveyKey(courseId)]]), 1, what);
      break;
    } catch (error) {
      if (error instanceof UnknownReply || attempt >= tries) throw error;
    }
  }
  if (typeof gone !== "number" || !Number.isSafeInteger(gone) || gone < 0) throw new UnknownReply(what);
  if (gone > 0) await giveData(room, [{ slot: SURVEY_SLOT(courseId), bytes: SURVEY_ROOM_BYTES * gone }]);
  return gone;
}
