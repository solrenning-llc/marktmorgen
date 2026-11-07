/**
 * 296 [SQ7], unit 1: a student's quick rating of a lesson (lib/lesson-rating.ts).
 *
 * What is checked, with the real code against the in-memory Redis:
 *
 *   - a student gives a lesson 1 to 5, with an optional short comment, once:
 *     a second rating changes the first, and the store's data room is charged
 *     once for it, before anything is written;
 *   - removing it takes it out and gives that room back;
 *   - a lesson keeps at most MAX_LESSON_RATINGS raters; past it a new one is
 *     refused and its charge given back, while a student already counted can
 *     still change theirs;
 *   - a reply that is not exactly what was asked for leaves the outcome
 *     unknown and keeps the charge (never less than what may be kept);
 *   - the creator's summary reads only up to what was paid for, and says when
 *     more came in than that;
 *   - deleting a person takes their ratings from every lesson they rated,
 *     a lesson no longer in the course too, and the copy of a person's data
 *     holds their own ratings and nobody else's;
 *   - the route takes a buyer action before it writes, keeps a per-person
 *     limit, and never charges a student for removing their own rating; the
 *     lesson page charges the studio before it reads the ratings, and only for
 *     the store's owner;
 *   - every buyer language says each sentence with the numbers it is given.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dropCourseRatings,
  dropLessonRatings,
  forgetLessonRatingsPerson,
  lessonRatingCount,
  ratedLessonCount,
  rateLesson,
  ratingsOfPerson,
  readLessonRatings,
  readMyRating,
  removeMyRating,
} from "@/lib/lesson-rating";
import {
  MAX_LESSON_RATINGS,
  MAX_RATING_NOTE,
  RATING_ENTRY_MAX_BYTES,
  RATING_READ_BYTES_PER_UNIT,
  RATING_ROOM_BYTES,
  RATINGS_PER_DAY,
  RATINGS_PER_MINUTE,
  cleanNote,
  parseScore,
  ratingReadUnits,
  serializeRating,
  summarize,
} from "@/lib/lesson-rating-rules";
import { LESSON_RATING_WORDS, lessonRatingWords } from "@/lib/buyer-words/lesson-rating";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { emailKey } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { PERSON_DATA } from "@/lib/person-data";
import { closingOf, countedInRoom } from "@/lib/data-families";
import { erasureSize } from "@/lib/person-erasure";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "r".repeat(32);
const L1 = "lessonone001";
const L2 = "lessontwo002";
const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const ana = emailKey("ana@example.com");
  const ben = emailKey("ben@example.com");

  part("The rules: a score is a whole number from 1 to 5, a comment is short and clean");
  is("5 is a score", parseScore("5"), 5);
  is("1 is a score", parseScore(1), 1);
  is("0 is not", parseScore("0"), null);
  is("6 is not", parseScore("6"), null);
  is("3.5 is not", parseScore("3.5"), null);
  is("a word is not", parseScore("five"), null);
  is("nothing is not", parseScore(undefined), null);
  is("a comment is cut to its length", cleanNote("a".repeat(MAX_RATING_NOTE + 50)).length, MAX_RATING_NOTE);
  is("a lone half of a character is dropped", cleanNote("ok \ud800 fine"), "ok  fine");
  is("a whole emoji stays", cleanNote("great 🎉"), "great 🎉");
  const worst = serializeRating({ score: 5, note: "€".repeat(MAX_RATING_NOTE), at: 9_999_999_999 });
  is("the largest rating fits the bytes it is charged", dataBytes([ana, worst, L1], 2) <= RATING_ROOM_BYTES, true);
  is("and the bytes a read is paid for", Buffer.byteLength(ana + worst) <= RATING_ENTRY_MAX_BYTES, true);
  is("a read unit holds less than a studio request's 50 KB", RATING_READ_BYTES_PER_UNIT <= 50_000, true);
  is("no ratings read costs one unit", ratingReadUnits(0), 1);
  is("the most ratings cost what their bytes say", ratingReadUnits(MAX_LESSON_RATINGS), Math.ceil((MAX_LESSON_RATINGS * RATING_ENTRY_MAX_BYTES) / RATING_READ_BYTES_PER_UNIT));
  is("a person's limits are small", [RATINGS_PER_MINUTE <= 10, RATINGS_PER_DAY <= 100], [true, true]);

  part("A student rates a lesson once; a second rating changes the first, charged once");
  const before = await used();
  is("no rating yet", await readMyRating(COURSE, L1, ana), null);
  is("a score of 0 is refused before anything", await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ana, score: "0", note: "" }), { ok: false, reason: "score" });
  is("nothing was charged for it", await used(), before);
  is("Ana gives 4", await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ana, score: "4", note: "  Clear steps.  ", now: 1_000 }), { ok: true, changed: false });
  const charged = await used();
  // The first rating of a course also opens the course's place in the room (lib/store-data.ts).
  is("the room is charged at least the fixed bytes of one rating", charged - before >= RATING_ROOM_BYTES, true);
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ben, score: 3, note: "" });
  is("each further rating is charged exactly those bytes", (await used()) - charged, RATING_ROOM_BYTES);
  await removeMyRating(COURSE, L1, ben, ROOM);
  is("she reads her own rating", await readMyRating(COURSE, L1, ana), { score: 4, note: "Clear steps.", at: 1_000 });
  is("she changes it to 5", await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ana, score: 5, note: "", now: 2_000 }), { ok: true, changed: true });
  is("the change is kept", await readMyRating(COURSE, L1, ana), { score: 5, note: "", at: 2_000 });
  is("and charged nothing more", await used(), charged);
  is("one rating on the lesson", await lessonRatingCount(COURSE, L1), 1);

  part("Removing a rating takes it out and gives its room back");
  is("Ana removes hers", await removeMyRating(COURSE, L1, ana, ROOM), true);
  is("it is gone", await readMyRating(COURSE, L1, ana), null);
  is("its room comes back", await used(), before);
  is("removing again does nothing", await removeMyRating(COURSE, L1, ana, ROOM), false);
  is("and gives nothing back twice", await used(), before);

  part("A lesson keeps at most MAX_LESSON_RATINGS raters");
  redis.clear();
  const filler = serializeRating({ score: 3, note: "", at: 1 });
  const full: (string | number)[] = ["HSET", `nl:lr:${COURSE}:l:${L2}`];
  for (let i = 0; i < MAX_LESSON_RATINGS - 1; i += 1) full.push(`p${String(i).padStart(31, "0")}`, filler);
  full.push(ben, filler);
  redis.run(full);
  const atFull = await used();
  is("a new rater is refused", await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L2, who: ana, score: 2, note: "" }), { ok: false, reason: "full" });
  is("and the charge given back", await used(), atFull);
  is("Ben, already counted, can still change his", await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L2, who: ben, score: 1, note: "Too fast." }), { ok: true, changed: true });
  is("the count stays at the most", await lessonRatingCount(COURSE, L2), MAX_LESSON_RATINGS);

  part("A reply that is not exactly what was asked for is unknown, and the charge stays");
  redis.clear();
  const quiet = await used();
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:lesson-rating-set:v1"))) return [7];
    return real(commands);
  }) as typeof redis.pipeline;
  is("an odd reply is unknown", await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ana, score: 3, note: "" }), { ok: false, reason: "unknown" });
  redis.pipeline = real;
  is("what may have been kept stays counted", (await used()) - quiet >= RATING_ROOM_BYTES, true);
  redis.run(["HSET", `nl:lr:${COURSE}:l:${L1}`, ana, "{not json"]);
  let threw = false;
  try {
    await readMyRating(COURSE, L1, ana);
  } catch {
    threw = true;
  }
  is("a kept rating that cannot be read is an error, never 'no rating'", threw, true);

  part("The creator's summary: average, each score's count, the comments, newest first");
  redis.clear();
  const students = ["a", "b", "c", "d"].map((n) => emailKey(`${n}@example.com`));
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: students[0], score: 5, note: "Loved it.", now: 10 });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: students[1], score: 4, note: "", now: 20 });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: students[2], score: 2, note: "Audio is quiet.", now: 30 });
  const read = await readLessonRatings(COURSE, L1, 10);
  is("all three are read", read.ok ? read.ratings.length : -1, 3);
  const summary = summarize(read.ok ? read.ratings : []);
  is("count", summary.count, 3);
  is("average", summary.average, 11 / 3);
  is("each score's count, 1 to 5", summary.counts, [0, 1, 0, 1, 1]);
  is("only ratings with a comment, newest first", summary.notes.map((n) => n.note), ["Audio is quiet.", "Loved it."]);
  is("nothing says who wrote them", JSON.stringify(summary).includes(students[0]), false);
  is("no ratings: no average", summarize([]).average, null);
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: students[3], score: 1, note: "" });
  is("more than was paid for is refused, with the count", await readLessonRatings(COURSE, L1, 3), { ok: false, count: 4 });

  part("Deleting a person takes their ratings from every lesson, a removed lesson too");
  redis.clear();
  const empty = await used();
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ana, score: 4, note: "Good." });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L2, who: ana, score: 2, note: "" });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ben, score: 5, note: "Ben's." });
  const withBen = await used();
  const hers = await ratingsOfPerson(COURSE, ana);
  is("her copy holds her two ratings", hers.map((r) => [r.lesson, r.rating.score]).sort(), [[L1, 4], [L2, 2]]);
  is("and nothing of Ben's", JSON.stringify(hers).includes("Ben's"), false);
  // L2 is not passed as a lesson of the course: the course's own index finds it.
  is("both go", await forgetLessonRatingsPerson(COURSE, ana, ROOM), 2);
  is("none left", [await readMyRating(COURSE, L1, ana), await readMyRating(COURSE, L2, ana)], [null, null]);
  is("Ben's stays", (await readMyRating(COURSE, L1, ben))?.score, 5);
  is("her room comes back", withBen - (await used()), RATING_ROOM_BYTES * 2);
  is("a lesson with no rating left leaves the index", redis.run(["SMEMBERS", `nl:lr:${COURSE}:ls`]), [L1]);
  await forgetLessonRatingsPerson(COURSE, ben, ROOM);
  is("all room back", await used(), empty);
  is("the index is empty", redis.run(["SCARD", `nl:lr:${COURSE}:ls`]), 0);

  part("A lesson the creator removes takes its ratings with it, and their room comes back");
  redis.clear();
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ana, score: 4, note: "Good." });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ben, score: 2, note: "" });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L2, who: ana, score: 5, note: "" });
  const three = await used();
  is("both of the removed lesson's ratings go", await dropLessonRatings(COURSE, [L1], ROOM), 2);
  is("nothing of it is left", [redis.run(["EXISTS", `nl:lr:${COURSE}:l:${L1}`]), await lessonRatingCount(COURSE, L1)], [0, 0]);
  is("it leaves the course's rated lessons", redis.run(["SMEMBERS", `nl:lr:${COURSE}:ls`]), [L2]);
  is("their room comes back", three - (await used()), RATING_ROOM_BYTES * 2);
  is("the other lesson's rating stays", (await readMyRating(COURSE, L2, ana))?.score, 5);
  is("dropping it again does nothing and gives nothing back", [await dropLessonRatings(COURSE, [L1], ROOM), three - (await used())], [0, RATING_ROOM_BYTES * 2]);
  is("no lessons, nothing sent", await dropLessonRatings(COURSE, [], ROOM), 0);
  const realDrop = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:lesson-ratings-drop-lesson:v1"))) return [1, "?"];
    return realDrop(commands);
  }) as typeof redis.pipeline;
  // Another rating stays in the course's slot, so what comes back is only the ratings' own bytes.
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: "lessonthree3", who: ben, score: 3, note: "" });
  const beforeOdd = await used();
  let oddThrew = false;
  try {
    await dropLessonRatings(COURSE, [L2, "lessonzzz999"], ROOM);
  } catch {
    oddThrew = true;
  }
  redis.pipeline = realDrop;
  is("a reply that is not a count is unknown, said so", oddThrew, true);
  is("and only what was confirmed comes back", beforeOdd - (await used()), RATING_ROOM_BYTES);
  await forgetLessonRatingsPerson(COURSE, ana, ROOM);
  await forgetLessonRatingsPerson(COURSE, ben, ROOM);
  is("the room counts ratings, and a store's closing erases them", [countedInRoom(`nl:lr:${COURSE}:l:${L1}`), countedInRoom(`nl:lr:${COURSE}:ls`), closingOf(`nl:lr:${COURSE}:ls`)], [true, true, { how: "erase" }]);

  part("A course the creator removes or turns off takes every rating with it, a removed lesson's too");
  redis.clear();
  const other = "o".repeat(32);
  await rateLesson({ room: ROOM, courseId: other, lessonId: L1, who: ana, score: 5, note: "" });
  const withoutCourse = await used();
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ana, score: 4, note: "Good." });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L2, who: ben, score: 2, note: "" });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: "lessongone03", who: ana, score: 1, note: "" });
  is("every rating of the course goes, a lesson no longer in it too", await dropCourseRatings(COURSE, ROOM), 3);
  // The index is checked by its count: MemoryRedis keeps an emptied set, where Redis deletes it.
  is("nothing of the course is left", [L1, L2, "lessongone03"].map((l) => redis.run(["EXISTS", `nl:lr:${COURSE}:l:${l}`])).concat(redis.run(["SCARD", `nl:lr:${COURSE}:ls`])), [0, 0, 0, 0]);
  is("the room is what it was before the course was rated, its slot included", await used(), withoutCourse);
  is("another course's rating stays", (await readMyRating(other, L1, ana))?.score, 5);
  is("a course with no ratings: nothing", await dropCourseRatings(COURSE, ROOM), 0);
  redis.run(["SADD", `nl:lr:${COURSE}:ls`, "../../nl:x"]);
  let oddIndex = false;
  try {
    await dropCourseRatings(COURSE, ROOM);
  } catch {
    oddIndex = true;
  }
  is("an index entry that is not a lesson id is unknown: nothing is taken, the removal can be asked again", [oddIndex, redis.run(["SCARD", `nl:lr:${COURSE}:ls`])], [true, 1]);
  redis.clear();
  const productRoute = source("app/api/store/product/route.ts");
  const courseRoute = source("app/api/store/course/route.ts");
  is("removing a product with a course drops its ratings before the product goes, with its comments", (productRoute.match(/await dropCourseRatings\((?:found\.id|going\.course\.id), store\);/g) ?? []).length, 2);
  is("turning a course off drops its ratings, or says it could not", /try \{\s*await dropComments\(course\.id, \[\], store\);\s*(?:\/\/[^\n]*\n\s*)?await dropCourseRatings\(course\.id, store\);\s*\} catch/.test(courseRoute), true);
  is("removing a lesson or a module drops their ratings beside their comments", /dropLessonComments\(course\.id, gone, store\)[^\n]*\n\s*await dropLessonRatings\(course\.id, gone, store\)/.test(courseRoute), true);

  part("Deleting a person is priced at every lesson its ratings are kept under, a removed one too");
  redis.clear();
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L1, who: ana, score: 4, note: "" });
  await rateLesson({ room: ROOM, courseId: COURSE, lessonId: L2, who: ben, score: 3, note: "" });
  is("the rated lessons of a course are counted", await ratedLessonCount([COURSE]), 2);
  is("no course, nothing counted", await ratedLessonCount([]), 0);
  const scope = { store: ROOM, sid: "s", statsId: "f".repeat(32), listId: null, email: "ana@example.com", person: "p", learner: ana, courses: [{ productId: "p1", courseId: COURSE, lessonIds: [L1], moduleIds: ["m1"] }], productIds: ["p1"], communityId: null } as unknown as ErasureScope;
  is("the erasure is sized at the course's lessons and every lesson holding a rating", (await erasureSize(scope)).lessons, 1 + 2);
  // Changed check (rule 23, pre-review of 90c20877f): this used to SET the index to a string, but MemoryRedis's SET
  // silently replaces a key of another type, so the count read back a plain 0 and never failed; the stub below gives
  // the odd reply a real Redis's WRONGTYPE stands for.
  const realCount = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SCARD" && String(c[1]) === `nl:lr:${COURSE}:ls`)) return ["?"];
    return realCount(commands);
  }) as typeof redis.pipeline;
  let sizeThrew = false;
  try {
    await erasureSize(scope);
  } catch {
    sizeThrew = true;
  }
  redis.pipeline = realCount;
  is("a count that cannot be read stops the erasure's sizing, never taken for none", sizeThrew, true);
  redis.clear();

  part("The registries: deletion, the copy and the cost line say what the code does");
  const ratingData = PERSON_DATA.filter((entry) => entry.file === "lib/lesson-rating.ts");
  is("deleting a person erases their ratings", ratingData.map((e) => e.how), ["erased"]);
  is("the eraser runs it", /module: "lib\/lesson-rating\.ts"[\s\S]{0,200}forgetLessonRatingsPerson/.test(source("lib/person-erasure.ts")), true);
  is("the copy holds it", /"lib\/lesson-rating\.ts": \{ how: "copied"/.test(source("lib/person-copy.ts")) && /"lib\/lesson-rating\.ts": async/.test(source("lib/person-copy.ts")), true);
  const registry = source("tests/plan-cost-registry.ts");
  is("the route is a buyer action in the cost registry", registry.includes(`{ file: "app/api/store/course/rating/route.ts", names: ["takeBuyerAction(store)"`), true);
  is("its limits are named there", registry.includes(`{ file: "lib/lesson-rating-rules.ts", names: ["RATINGS_PER_DAY", "RATINGS_PER_MINUTE"] }`), true);

  part("The route: a buyer action before it writes, a person's limit, removal never charged");
  const route = source("app/api/store/course/rating/route.ts");
  is("refuses another site", route.includes("if (fromAnotherSite(request))"), true);
  is("the creator does not rate", /if \(access\.learner\.owner\) return back\(""\)/.test(route), true);
  const take = route.indexOf("takeBuyerAction(store)");
  const rate = route.indexOf("await rateLesson(");
  const limit = route.indexOf("withinLimit(\"lesson-rating\"");
  is("a buyer action is taken before rating", take > 0 && take < rate, true);
  is("the per-person limit comes before any rating read or write", limit > 0 && limit < rate && limit < route.indexOf("await removeMyRating("), true);
  // Changed assertion (rule 23, pre-review of 51916e1f1): the remove branch now checks who is signed in before it
  // removes, so the old 40-character window no longer reached removeMyRating; still no buyer action inside it.
  is("removing is not charged a buyer action", /if \(action === "remove"\) \{(?:(?!takeBuyerAction)[\s\S]){0,900}removeMyRating/.test(route) && route.indexOf("await removeMyRating(") < take, true);
  const removing = route.indexOf('if (action === "remove")');
  is("a student removes their own rating without the lesson being open to them: only who they are is asked", removing > 0 && removing < route.indexOf('access.state !== "open"') && removing < route.indexOf("findLesson(") && removing < route.indexOf("heldBack("), true);
  // Changed window (rule 23, second pre-review): the pass's scope is checked first in the branch, so 400 characters no
  // longer reach the owner's check; the check itself is unchanged.
  is("the store's owner never removes a student's rating", /if \(action === "remove"\) \{[\s\S]{0,900}learner\.owner\) return back\(""\)/.test(route), true);
  is("removing keeps to the courses the sign-in opens: a pass for one course never removes a rating in another", /if \(action === "remove"\) \{[\s\S]{0,600}learner\.scope !== "all" && !learner\.scope\.includes\(course\)\)/.test(route), true);
  const scored = route.indexOf("parseScore(form.get(\"score\"))");
  is("a score that is not one is refused before a buyer action is taken", scored > 0 && scored < take, true);
  is("a full data room says so", route.includes("error instanceof DataRoomError") && route.includes('back("noroom")'), true);

  part("The lesson page: only the store's owner reads the ratings, the studio paid first");
  const page = source("app/[handle]/course/[product]/[lesson]/page.tsx");
  const paid = page.indexOf("countStudio(store, null, ratingReadUnits(");
  is("the count is paid for before it is read", page.indexOf("countStudio(store, null, 1)") > 0 && page.indexOf("countStudio(store, null, 1)") < page.indexOf("await lessonRatingCount("), true);
  is("the ratings are paid for before they are read", paid > 0 && paid < page.indexOf("await readLessonRatings("), true);
  is("only the owner, and only when asked", /const ownerAsks = access\.state === "open" && open && access\.learner\.owner && query\.ratings === "1";/.test(page), true);
  const box = source("components/lesson-rating.tsx");
  is("asking to see the ratings is a button in a form, never a link a browser fetches ahead", /<Link[^>]*ownerShow|href=\{view\./.test(box) === false && /method="get"[\s\S]{0,300}name="ratings" value="1"/.test(box), true);
  is("the owner sees only the month of a comment, never the day", /toLocaleDateString\(locale, \{ year: "numeric", month: "long", timeZone: "UTC" \}\)/.test(box) && !/day: "numeric"/.test(box), true);
  is("a student's own rating is read only for that student", /student && open \? readMyRating\(course\.id, lesson\.id, who\)/.test(page), true);

  part("Every buyer language says each sentence, with its numbers");
  for (const code of LANGUAGE_CODES) {
    const w = LESSON_RATING_WORDS[code];
    is(`${code}: every word of English is there`, Object.keys(w).sort(), Object.keys(LESSON_RATING_WORDS.en).sort());
    is(`${code}: five score names`, w.scores.length, 5);
    is(`${code}: the score sentence carries the score`, w.yours(4).includes("4") && w.yours(4).includes("5"), true);
    is(`${code}: the average carries the count`, w.average("4.5", 12).includes("4.5") && w.average("4.5", 12).includes("12"), true);
    is(`${code}: the length hint carries the limit`, w.noteHint(MAX_RATING_NOTE).includes(String(MAX_RATING_NOTE)), true);
    is(`${code}: each notice has words`, Object.values(w.notices).every((s) => typeof s === "string" && s.length > 3), true);
  }
  is("the promise is what the page does: no 'at any time' while a closed lesson has no form", /at any time/.test(LESSON_RATING_WORDS.en.note), false);
  is("and it says deleting one's data removes it", /delete your data/.test(LESSON_RATING_WORDS.en.note), true);
  is("and that removing the lesson or the course removes it", /removes this lesson or course/.test(LESSON_RATING_WORDS.en.note), true);
  is("German says the rating and comment (plural) are deleted", /Sie werden gelöscht/.test(LESSON_RATING_WORDS.de.note), true);
  is("an unknown language speaks English", lessonRatingWords("xx").title, LESSON_RATING_WORDS.en.title);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
