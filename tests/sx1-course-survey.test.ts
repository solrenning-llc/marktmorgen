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
  dropCourseSurvey,
  hasAnswer,
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
  SURVEY_PAGE_BYTES,
  SURVEY_PAGE_COMMANDS,
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
import { DataRoomError, dataKey, dataUsed, needData } from "@/lib/store-data";
import { newCourseId } from "@/lib/course";
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

  part("A change keeps no more bytes, so a full room never refuses it; a new answer is refused");
  redis.clear();
  const SMALL = { ...ROOM, sid: "small-room-store" };
  await answerSurvey({ room: SMALL, courseId: COURSE, who: ana, score: 6, note: "" });
  // Fill the rest of this store's room, to within a few bytes.
  for (let chunk = (await dataUsed(SMALL))!.room; chunk >= 16; ) {
    try {
      await needData(SMALL, [{ slot: "filler", bytes: chunk }]);
    } catch (error) {
      if (!(error instanceof DataRoomError)) throw error;
      chunk = Math.floor(chunk / 2);
    }
  }
  is("Ana changes hers in a full room", await answerSurvey({ room: SMALL, courseId: COURSE, who: ana, score: 8, note: "Better on a second look." }), { ok: true, changed: true });
  is("the change is kept", (await readMyAnswer(COURSE, ana))?.score, 8);
  let refusedNew = false;
  try {
    await answerSurvey({ room: SMALL, courseId: COURSE, who: ben, score: 5, note: "" });
  } catch (error) {
    refusedNew = error instanceof DataRoomError;
  }
  is("Ben's new answer is refused for room", refusedNew, true);
  is("and nothing of his was written", await readMyAnswer(COURSE, ben), null);

  part("Giving room back failing after an answer was written is never an error: what was written stands");
  redis.clear();
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 4, note: "" });
  const realGive = redis.pipeline.bind(redis);
  let written = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const script = String(commands[0]?.[1] ?? "");
    // As if her answer came in between: the change found nothing, the full write found hers.
    if (commands[0]?.[0] === "EVAL" && script.startsWith("-- marktmorgen:course-survey-change:v1")) return [0];
    if (written && commands[0]?.[0] === "EVAL" && script.startsWith("-- marktmorgen:store-data:")) throw new Error("Redis is down");
    const out = await realGive(commands);
    if (commands[0]?.[0] === "EVAL" && script.startsWith("-- marktmorgen:course-survey-set:v1")) written = true;
    return out;
  }) as typeof redis.pipeline;
  let answered: unknown;
  try {
    answered = await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 2, note: "" });
  } catch (error) {
    answered = error;
  }
  redis.pipeline = realGive;
  // giveData never throws (lib/store-data.ts): the charge simply stays, never less than what is kept.
  is("the answer says it changed, with no error", answered, { ok: true, changed: true });
  is("and what was written is kept", (await readMyAnswer(COURSE, ana))?.score, 2);

  part("A course that goes takes its survey with it, giving back only what was confirmed gone");
  redis.clear();
  const bare = await used();
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 9, note: "" });
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ben, score: 3, note: "Hm." });
  await answerSurvey({ room: ROOM, courseId: OTHER, who: ana, score: 7, note: "" });
  const withTwo = await used();
  is("both answers of the course go", await dropCourseSurvey(COURSE, ROOM), 2);
  is("none are left", [await readMyAnswer(COURSE, ana), await readMyAnswer(COURSE, ben), await surveyAnswerCount(COURSE)], [null, null, 0]);
  // The course's place in the room closes too with its last answer (lib/store-data.ts).
  is("their room comes back", withTwo - (await used()) >= SURVEY_ROOM_BYTES * 2, true);
  is("another course's answers stay", (await readMyAnswer(OTHER, ana))?.score, 7);
  is("dropping again finds nothing", await dropCourseSurvey(COURSE, ROOM), 0);
  await dropCourseSurvey(OTHER, ROOM);
  is("all room back", await used(), bare);
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 9, note: "" });
  const beforeOdd = await used();
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // Regra 23: was the v1 header; the drop and its room's give-back are one script now (v2).
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:course-survey-drop-all:v2"))) return ["x"];
    return realGive(commands);
  }) as typeof redis.pipeline;
  let oddDrop = false;
  try {
    await dropCourseSurvey(COURSE, ROOM);
  } catch {
    oddDrop = true;
  }
  redis.pipeline = realGive;
  is("an odd reply to dropping a course's survey is unknown", oddDrop, true);
  is("and gives no room back", await used(), beforeOdd);
  // The room comes back in the same step as the delete: a room step that cannot be made deletes nothing, and a
  // give-back is never lost after the answers went, so dropping again always leaves the room level (pre-review on 8aba2d700).
  redis.clear();
  const level = await used();
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 9, note: "" });
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ben, score: 3, note: "" });
  const roomKey = dataKey(ROOM)!;
  const heldTotal = redis.run(["HGET", roomKey, "#"]);
  redis.run(["HSET", roomKey, "#", "not a count"]);
  let unreadRoom = false;
  try {
    await dropCourseSurvey(COURSE, ROOM);
  } catch {
    unreadRoom = true;
  }
  redis.run(["HSET", roomKey, "#", String(heldTotal)]);
  is("a room that cannot be read deletes nothing and says so", [unreadRoom, await surveyAnswerCount(COURSE)], [true, 2]);
  const sentDrop: (string | number)[][][] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sentDrop.push(commands);
    // A give-back sent on its own fails, as giveData's would, silently.
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:"))) throw new Error("down");
    return realGive(commands);
  }) as typeof redis.pipeline;
  let lostGive: unknown = null;
  try {
    lostGive = await dropCourseSurvey(COURSE, ROOM);
  } catch (error) {
    lostGive = error;
  }
  redis.pipeline = realGive;
  await dropCourseSurvey(COURSE, ROOM).catch(() => 0);
  is("a drop is one command, its room's give-back inside it", [lostGive, sentDrop.length, sentDrop.flat().length], [2, 1, 1]);
  is("and once the answers are gone the room is level, dropping again changes nothing", [await surveyAnswerCount(COURSE), await used()], [0, level]);
  const productRoute = source("app/api/store/product/route.ts");
  const courseRoute = source("app/api/store/course/route.ts");
  // Inside the removal's own check, before the product goes: a failure keeps the product for another try, as its comments do.
  // Regra 23: these were exact-text patterns that broke as soon as another drop (296 [SQ7] ratings) joined the same try; they
  // now say only what matters: inside the try, once, after every other drop of the check (a single step that is retried, so
  // a failure in the larger drops before it never loses the answers), and nowhere only logged. The count went from 2 to 1.
  const check = productRoute.slice(productRoute.indexOf("await removeProduct(ref, id, async"), productRoute.indexOf("result = removed.ok"));
  const surveyAt = check.indexOf("await dropCourseSurvey(going.course.id, store);");
  const checkTry = check.indexOf("try {");
  const checkCatch = check.indexOf("} catch {", checkTry);
  is(
    "removing a product drops its course's survey in the removal's check, after everything else it drops there",
    surveyAt > checkTry && surveyAt < checkCatch && check.slice(checkTry, surveyAt).includes("await dropComments(found.id") && check.slice(checkTry, surveyAt).includes("await dropCommentsAfterCourseGone(going.course.id") && !/await drop/.test(check.slice(surveyAt + 1, checkCatch)),
    true,
  );
  is("a failure there is never only logged, and it is dropped once", !/dropCourseSurvey\([^)]*\)\.catch/.test(productRoute) && (productRoute.match(/dropCourseSurvey\(/g) ?? []).length === 1, true);
  const disable = courseRoute.slice(courseRoute.indexOf('if (action === "disable")'), courseRoute.indexOf("await setProductCourse(ref, id, null)"));
  const disableTries = [...disable.matchAll(/try \{([\s\S]*?)\} catch \{\s*return Response\.json\(\{ ok: false, error: "unavailable" \}, \{ status: 503 \}\);/g)].map((m) => m[1]);
  is(
    "turning a course off drops its survey in a try that answers 503 on failure, after its comments",
    disableTries.some((body) => body.includes("await dropCourseSurvey(course.id, store);")) && disable.indexOf("await dropCourseSurvey(course.id, store);") > disable.indexOf("await dropComments(course.id, [], store);"),
    true,
  );
  is("and only there", (courseRoute.match(/dropCourseSurvey\(/g) ?? []).length === 1, true);

  part("What a course page adds to each of its views, and where that is paid");
  redis.clear();
  is("no answer kept: no", await hasAnswer(COURSE, ana), false);
  await answerSurvey({ room: ROOM, courseId: COURSE, who: ana, score: 5, note: "x".repeat(MAX_SURVEY_NOTE) });
  is("one kept: yes", await hasAnswer(COURSE, ana), true);
  const sent: (string | number)[][][] = [];
  const realSee = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent.push(commands);
    return realSee(commands);
  }) as typeof redis.pipeline;
  await hasAnswer(COURSE, ana);
  const looked = sent.flat();
  sent.length = 0;
  await readMyAnswer(COURSE, ana);
  const ownRead = sent.flat();
  redis.pipeline = realSee;
  is("whether one is kept is one command that returns no comment", looked.map((c) => c[0]), ["HEXISTS"]);
  is("reading one's own is one command", ownRead.map((c) => c[0]), ["HGET"]);
  is("a page view adds at most the commands the cost line prices", Math.max(looked.length, ownRead.length) <= SURVEY_PAGE_COMMANDS, true);
  // Regra 23: was SURVEY_ENTRY_MAX_BYTES alone; the key the command names and the command's own name are sent too.
  is("and at most the bytes it prices: one answer at its largest, the course's key and the command", SURVEY_PAGE_BYTES >= SURVEY_ENTRY_MAX_BYTES + `nl:course:${newCourseId()}:survey`.length + "HEXISTS".length, true);
  const coursePage = source("app/[handle]/course/[product]/page.tsx");
  const surveyRead = coursePage.slice(coursePage.indexOf("const surveyWho"), coursePage.indexOf("const surveyAsks"));
  // A view with the access open is counted where the page rests (isResting); any other browser pays a buyer request first.
  is(
    "a view without the access open pays a buyer request before the survey is read, and a refused one reads nothing",
    /surveyPaid = !surveyWho \|\| open \|\| \(await takePublicRequest\(store, "buyer"\)\)/.test(surveyRead) && /!surveyPaid\s*\?\s*"unread"/.test(surveyRead) && surveyRead.indexOf("surveyPaid =") < surveyRead.indexOf("hasAnswer(course.id, surveyWho)"),
    true,
  );
  const costLine = source("tests/plan-cost-registry.ts");
  is("the public requests line prices it for every request of the window", /limit \* surveyPageCost\(\)/.test(costLine) && costLine.includes(`{ file: "lib/course-survey-rules.ts", names: ["SURVEY_PAGE_COMMANDS", "SURVEY_PAGE_BYTES"] }`), true);

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
  is("removing is not charged a buyer action", /action === "remove"[\s\S]{0,300}removeMyAnswer/.test(route) && route.indexOf("await removeMyAnswer(") < take, true);
  is("a full data room says so", route.includes("error instanceof DataRoomError") && route.includes('back("noroom")'), true);
  is("removing needs the confirmation, and otherwise asks for it", /form\.get\("sure"\) !== "1"\) return back\("confirm"\)/.test(route), true);
  is("a student with this course in their pass removes their answer whatever their access is now", route.indexOf("await removeMyAnswer(") < route.indexOf('access.state !== "open"') && /scope === "all" \|\| access\.learner\.scope\.includes\(course\.id\)/.test(route), true);

  part("The course page: only the store's owner reads the answers, the studio paid first");
  const page = source("app/[handle]/course/[product]/page.tsx");
  const paid = page.indexOf("countStudio(store, null, surveyReadUnits(");
  is("the count is paid for before it is read", page.indexOf("countStudio(store, null, 1)") > 0 && page.indexOf("countStudio(store, null, 1)") < page.indexOf("await surveyAnswerCount("), true);
  is("the answers are paid for before they are read", paid > 0 && paid < page.indexOf("await readCourseAnswers("), true);
  is("only the owner, and only when asked", /const surveyAsks = open && access\.learner\.owner && query\.survey === "1";/.test(page), true);
  is("a student's whole answer is read only once they finished, for the form", /surveyWho && finished\s*\?\s*readMyAnswer\(course\.id, surveyWho\)/.test(page), true);
  is("otherwise only whether one is kept, one command and no comment", /surveyWho\s*\?\s*hasAnswer\(course\.id, surveyWho\)/.test(page), true);
  is("the form only once finished; otherwise only the way to remove a kept answer", /mode=\{finished \? "answer" : "remove"\}/.test(page), true);
  const box = source("components/course-survey.tsx");
  is("the notice takes the focus when the page comes back", box.includes("<ArrivalNotice"), true);
  is("a wrong score marks the scores invalid", /aria-invalid=\{notice === "score"/.test(box), true);
  is("removing asks first, on its own screen", box.includes('name="sure" value="1"') && box.includes('notice === "confirm"'), true);
  is("a comment shows only its month and year", /month: "long", year: "numeric"/.test(box) && !/day: "numeric"/.test(box), true);
  is("showing answers is never prefetched", /prefetch=\{false\}/.test(box), true);

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
    is(`${code}: says what removing and changing need`, typeof w.removeOnly === "string" && w.removeOnly.length > 10 && typeof w.confirm === "string" && typeof w.keep === "string", true);
  }
  is("English asks the exact question", COURSE_SURVEY_WORDS.en.question, SURVEY_QUESTION);
  is("English never promises a change at any time", /change or remove it at any time/i.test(COURSE_SURVEY_WORDS.en.note), false);
  is("an unknown language speaks English", courseSurveyWords("xx").title, COURSE_SURVEY_WORDS.en.title);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
