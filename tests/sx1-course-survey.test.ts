/**
 * 285 [SX1], unit 1: a short, optional survey when a student finishes a
 * course (lib/course-survey.ts), on the course's own page.
 *
 * What is checked, with the real code against the in-memory Redis:
 *
 *   - the question is the exact public sentence, a score is a whole number
 *     from 0 to 10, and a comment is short and clean;
 *   - a student answers once: a second answer changes the first, and the
 *     store's data room is charged once for it, before anything is written;
 *   - removing it takes it out and gives that room back;
 *   - a course keeps at most MAX_COURSE_ANSWERS answers; past it a new one is
 *     refused and its charge given back, while a student already counted can
 *     still change theirs;
 *   - a reply that is not exactly what was asked for leaves the outcome
 *     unknown and keeps the charge (never less than what may be kept);
 *   - the creator's summary (average, each score's count, the comments) reads
 *     only up to what was paid for, and never says who answered;
 *   - deleting a person takes their answer out, and the copy of a person's
 *     data holds their own answer and nobody else's;
 *   - the route takes a buyer action before it writes, keeps a per-person
 *     limit, asks that the course is finished (after the action is taken,
 *     before its progress is read) before an answer is kept, and never
 *     charges a student for removing their own answer; the course page
 *     charges the studio before it reads the answers, and only for the
 *     store's owner;
 *   - nothing about the survey reaches reviews: no public review request
 *     depends on a score;
 *   - every buyer language says each sentence with the numbers it is given.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerOfPerson,
  answerSurvey,
  forgetSurveyPerson,
  readCourseAnswers,
  readMyAnswer,
  removeMyAnswer,
  surveyAnswerCount,
} from "@/lib/course-survey";
import {
  MAX_COURSE_ANSWERS,
  MAX_SURVEY_NOTE,
  SURVEY_ENTRY_MAX_BYTES,
  SURVEY_QUESTION,
  SURVEY_READ_BYTES_PER_UNIT,
  SURVEY_ROOM_BYTES,
  SURVEY_SCORES,
  SURVEYS_PER_DAY,
  SURVEYS_PER_MINUTE,
  cleanSurveyNote,
  parseSurveyScore,
  serializeAnswer,
  summarizeSurvey,
  surveyReadUnits,
} from "@/lib/course-survey-rules";
import { COURSE_SURVEY_WORDS, courseSurveyWords } from "@/lib/buyer-words/course-survey";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { emailKey } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { PERSON_DATA } from "@/lib/person-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "s".repeat(32);
const OTHER = "t".repeat(32);
const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const ana = emailKey("ana@example.com");
  const ben = emailKey("ben@example.com");

  part("The rules: the exact question, a score from 0 to 10, a short clean comment");
  is("the question is the public sentence, word for word", SURVEY_QUESTION, "How likely are you to recommend this course to a friend?");
  is("eleven scores, 0 to 10", SURVEY_SCORES, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  is("0 is a score", parseSurveyScore("0"), 0);
  is("10 is a score", parseSurveyScore(10), 10);
  is("11 is not", parseSurveyScore("11"), null);
  is("-1 is not", parseSurveyScore("-1"), null);
  is("7.5 is not", parseSurveyScore("7.5"), null);
  is("010 is not", parseSurveyScore("010"), null);
  is("a word is not", parseSurveyScore("ten"), null);
  is("nothing is not", parseSurveyScore(undefined), null);
  is("a comment is cut to its length", cleanSurveyNote("a".repeat(MAX_SURVEY_NOTE + 50)).length, MAX_SURVEY_NOTE);
  is("a lone half of a character is dropped", cleanSurveyNote("ok \ud800 fine"), "ok  fine");
  is("a whole emoji stays", cleanSurveyNote("great 🎉"), "great 🎉");
  const worst = serializeAnswer({ score: 10, note: "€".repeat(MAX_SURVEY_NOTE), at: 9_999_999_999 });
  is("the largest answer fits the bytes it is charged", dataBytes([ana, worst], 1) <= SURVEY_ROOM_BYTES, true);
  is("and the bytes a read is paid for", Buffer.byteLength(ana + worst) <= SURVEY_ENTRY_MAX_BYTES, true);
  is("a read unit holds less than a studio request's 50 KB", SURVEY_READ_BYTES_PER_UNIT <= 50_000, true);
  is("no answers read costs one unit", surveyReadUnits(0), 1);
  is("the most answers cost what their bytes say", surveyReadUnits(MAX_COURSE_ANSWERS), Math.ceil((MAX_COURSE_ANSWERS * SURVEY_ENTRY_MAX_BYTES) / SURVEY_READ_BYTES_PER_UNIT));
  is("a person's limits are small", [SURVEYS_PER_MINUTE <= 10, SURVEYS_PER_DAY <= 100], [true, true]);

  part("A student answers once; a second answer changes the first, charged once");
  const before = await used();
  is("no answer yet", await readMyAnswer(COURSE, ana), null);
  is("a score of 11 is refused before anything", await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: "11", note: "" }), { ok: false, reason: "score" });
  is("nothing was charged for it", await used(), before);
  is("Ana gives 9", await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: "9", note: "  Clear and practical.  ", now: 1_000 }), { ok: true, changed: false });
  const charged = await used();
  is("the room is charged at least the fixed bytes of one answer", charged - before >= SURVEY_ROOM_BYTES, true);
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ben, score: 3, note: "" });
  is("each further answer is charged exactly those bytes", (await used()) - charged, SURVEY_ROOM_BYTES);
  await removeMyAnswer(COURSE, ben, ROOM);
  is("she reads her own answer", await readMyAnswer(COURSE, ana), { score: 9, note: "Clear and practical.", at: 1_000 });
  is("she changes it to 0", await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 0, note: "", now: 2_000 }), { ok: true, changed: true });
  is("the change is kept, a 0 too", await readMyAnswer(COURSE, ana), { score: 0, note: "", at: 2_000 });
  is("and charged nothing more", await used(), charged);
  is("one answer in the course", await surveyAnswerCount(COURSE), 1);

  part("Removing an answer takes it out and gives its room back");
  is("Ana removes hers", await removeMyAnswer(COURSE, ana, ROOM), true);
  is("it is gone", await readMyAnswer(COURSE, ana), null);
  is("its room comes back", await used(), before);
  is("removing again does nothing", await removeMyAnswer(COURSE, ana, ROOM), false);
  is("and gives nothing back twice", await used(), before);

  part("A course keeps at most MAX_COURSE_ANSWERS answers");
  redis.clear();
  const filler = serializeAnswer({ score: 7, note: "", at: 1 });
  const full: (string | number)[] = ["HSET", `nl:course:${OTHER}:survey`];
  for (let i = 0; i < MAX_COURSE_ANSWERS - 1; i += 1) full.push(`p${String(i).padStart(31, "0")}`, filler);
  full.push(ben, filler);
  redis.run(full);
  const atFull = await used();
  is("a new answer is refused", await answerSurvey({ room: ROOM, courseId: OTHER, who: ana, score: 2, note: "" }), { ok: false, reason: "full" });
  is("and the charge given back", await used(), atFull);
  is("Ben, already counted, can still change his", await answerSurvey({ room: ROOM, courseId: OTHER, who: ben, score: 1, note: "Too fast." }), { ok: true, changed: true });
  is("the count stays at the most", await surveyAnswerCount(OTHER), MAX_COURSE_ANSWERS);

  part("A reply that is not exactly what was asked for is unknown, and the charge stays");
  redis.clear();
  const quiet = await used();
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:course-survey-set:v1"))) return [7];
    return real(commands);
  }) as typeof redis.pipeline;
  is("an odd reply is unknown", await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 3, note: "" }), { ok: false, reason: "unknown" });
  redis.pipeline = real;
  is("what may have been kept stays counted", (await used()) - quiet >= SURVEY_ROOM_BYTES, true);
  redis.run(["HSET", `nl:course:${COURSE}:survey`, ana, "{not json"]);
  let threw = false;
  try {
    await readMyAnswer(COURSE, ana);
  } catch {
    threw = true;
  }
  is("a kept answer that cannot be read is an error, never 'no answer'", threw, true);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:course-survey-drop:v1"))) return [2];
    return real(commands);
  }) as typeof redis.pipeline;
  let dropThrew = false;
  const beforeDrop = await used();
  try {
    await removeMyAnswer(COURSE, ana, ROOM);
  } catch {
    dropThrew = true;
  }
  redis.pipeline = real;
  is("an odd reply to a removal is unknown", dropThrew, true);
  is("and gives no room back", await used(), beforeDrop);

  part("The creator's summary: average, each score's count, the comments, newest first");
  redis.clear();
  const students = ["a", "b", "c", "d"].map((n) => emailKey(`${n}@example.com`));
  await answerSurvey({ room: ROOM, courseId: COURSE, who: students[0], score: 10, note: "Loved it.", now: 10 });
  await answerSurvey({ room: ROOM, courseId: COURSE, who: students[1], score: 8, note: "", now: 20 });
  await answerSurvey({ room: ROOM, courseId: COURSE, who: students[2], score: 0, note: "Audio is quiet.", now: 30 });
  const read = await readCourseAnswers(COURSE, 10);
  is("all three are read", read.ok ? read.answers.length : -1, 3);
  const summary = summarizeSurvey(read.ok ? read.answers : []);
  is("count", summary.count, 3);
  is("average", summary.average, 6);
  is("each score's count, 0 to 10", summary.counts, [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
  is("only answers with a comment, newest first", summary.notes.map((n) => n.note), ["Audio is quiet.", "Loved it."]);
  is("nothing says who wrote them", JSON.stringify(summary).includes(students[0]), false);
  is("no answers: no average", summarizeSurvey([]).average, null);
  await answerSurvey({ room: ROOM, courseId: COURSE, who: students[3], score: 5, note: "" });
  is("more than was paid for is refused, with the count", await readCourseAnswers(COURSE, 3), { ok: false, count: 4 });

  part("Deleting a person takes their answer out of every course they answered");
  redis.clear();
  const empty = await used();
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 9, note: "Good." });
  await answerSurvey({ room: ROOM, courseId: OTHER, who: ana, score: 4, note: "" });
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ben, score: 10, note: "Ben's." });
  const withBen = await used();
  const hers = [await answerOfPerson(COURSE, ana), await answerOfPerson(OTHER, ana)];
  is("her copy holds her two answers", hers.map((a) => a?.score), [9, 4]);
  is("and nothing of Ben's", JSON.stringify(hers).includes("Ben's"), false);
  is("her answer in the first course goes", await forgetSurveyPerson(COURSE, ana, ROOM), 1);
  is("its room comes back, exactly", withBen - (await used()), SURVEY_ROOM_BYTES);
  const afterFirst = await used();
  is("and in the second", await forgetSurveyPerson(OTHER, ana, ROOM), 1);
  // The second course's last answer also closes its place in the room (lib/store-data.ts).
  is("its room comes back too", afterFirst - (await used()) >= SURVEY_ROOM_BYTES, true);
  is("none left", [await readMyAnswer(COURSE, ana), await readMyAnswer(OTHER, ana)], [null, null]);
  is("Ben's stays", (await readMyAnswer(COURSE, ben))?.score, 10);
  is("deleting her again finds nothing", await forgetSurveyPerson(COURSE, ana, ROOM), 0);
  await forgetSurveyPerson(COURSE, ben, ROOM);
  is("all room back", await used(), empty);

  part("The registries: deletion, the copy and the cost line say what the code does");
  const surveyData = PERSON_DATA.filter((entry) => entry.file === "lib/course-survey.ts");
  is("deleting a person erases their answers", surveyData.map((e) => e.how), ["erased"]);
  is("the eraser runs it", /module: "lib\/course-survey\.ts"[\s\S]{0,200}forgetSurveyPerson/.test(source("lib/person-erasure.ts")), true);
  is("the copy holds it", /"lib\/course-survey\.ts": \{ how: "copied"/.test(source("lib/person-copy.ts")) && /"lib\/course-survey\.ts": async/.test(source("lib/person-copy.ts")), true);
  const registry = source("tests/plan-cost-registry.ts");
  is("the route is a buyer action in the cost registry", registry.includes(`{ file: "app/api/store/course/survey/route.ts", names: ["takeBuyerAction(store)"`), true);
  is("its limits are named there", registry.includes(`{ file: "lib/course-survey-rules.ts", names: ["SURVEYS_PER_DAY", "SURVEYS_PER_MINUTE"] }`), true);
  is("its key family is counted in the store's data room", source("tests/store-data-registry.ts").includes(`"nl:course:@lib/course-survey.ts"`), true);

  part("The route: a buyer action before it writes, a person's limit, only after finishing, removal never charged");
  const route = source("app/api/store/course/survey/route.ts");
  is("refuses another site", route.includes("if (fromAnotherSite(request))"), true);
  is("the creator does not answer", /if \(access\.learner\.owner\) return back\(""\)/.test(route), true);
  const take = route.indexOf("takeBuyerAction(store)");
  const answer = route.indexOf("await answerSurvey(");
  const limit = route.indexOf("withinLimit(\"course-survey\"");
  const finished = route.indexOf("hasFinished(course, done, passed)");
  is("a buyer action is taken before answering", take > 0 && take < answer, true);
  is("the per-person limit comes before any read or write", limit > 0 && limit < answer && limit < route.indexOf("await removeMyAnswer(") && limit < route.indexOf("doneLessons("), true);
  is("the buyer action is taken before the student's progress is read", take > 0 && take < route.indexOf("doneLessons("), true);
  is("an answer is kept only from a student who finished the course", finished > take && finished < answer && /if \(!hasFinished\(course, done, passed\)\) return back\("unfinished"\)/.test(route), true);
  is("removing is not charged a buyer action", /action === "remove"[\s\S]{0,60}removeMyAnswer/.test(route) && route.indexOf("await removeMyAnswer(") < take, true);
  is("a full data room says so", route.includes("error instanceof DataRoomError") && route.includes('back("noroom")'), true);

  part("The course page: only the store's owner reads the answers, the studio paid first");
  const page = source("app/[handle]/course/[product]/page.tsx");
  const paid = page.indexOf("countStudio(store, null, surveyReadUnits(");
  is("the count is paid for before it is read", page.indexOf("countStudio(store, null, 1)") > 0 && page.indexOf("countStudio(store, null, 1)") < page.indexOf("await surveyAnswerCount("), true);
  is("the answers are paid for before they are read", paid > 0 && paid < page.indexOf("await readCourseAnswers("), true);
  is("only the owner, and only when asked", /const surveyAsks = open && access\.learner\.owner && query\.survey === "1";/.test(page), true);
  is("a student's own answer is read only for that student, once finished", /finished \? readMyAnswer\(course\.id, who\)/.test(page), true);

  part("Nothing about the survey reaches reviews or other students");
  for (const file of ["lib/course-survey.ts", "lib/course-survey-rules.ts", "app/api/store/course/survey/route.ts", "components/course-survey.tsx"]) {
    is(`${file} reads nothing of reviews`, /lib\/review|reviews/.test(source(file).replace(/^\s*(\*|\/\/).*$/gm, "")), false);
  }

  part("Every buyer language says each sentence, with its numbers");
  for (const code of LANGUAGE_CODES) {
    const w = COURSE_SURVEY_WORDS[code];
    is(`${code}: every word of English is there`, Object.keys(w).sort(), Object.keys(COURSE_SURVEY_WORDS.en).sort());
    is(`${code}: the score sentence carries the score`, w.yours(7).includes("7") && w.yours(7).includes("10"), true);
    is(`${code}: the average carries the count`, w.average("8.5", 12).includes("8.5") && w.average("8.5", 12).includes("12"), true);
    is(`${code}: each score's line carries its count`, w.countOf(9, 4).includes("9") && w.countOf(9, 4).includes("4"), true);
    is(`${code}: the length hint carries the limit`, w.noteHint(MAX_SURVEY_NOTE).includes(String(MAX_SURVEY_NOTE)), true);
    is(`${code}: each notice has words`, Object.values(w.notices).every((s) => typeof s === "string" && s.length > 3), true);
  }
  is("English asks the exact question", COURSE_SURVEY_WORDS.en.question, SURVEY_QUESTION);
  is("an unknown language speaks English", courseSurveyWords("xx").title, COURSE_SURVEY_WORDS.en.title);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
