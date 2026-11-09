/**
 * 24 [E7], part 2: points for finishing a lesson. A store whose community is
 * on can give the community's own points (lib/community-points.ts, the same
 * board, levels and rewards as a like) for each lesson a member finishes in
 * one of its courses. The creator sets one number for all courses, from 0
 * (the default: nothing changes unless they choose) up to MAX_LESSON_POINTS.
 *
 * Held here: the creator's number is read and bounded, and an unreadable
 * one is unknown, never 0 (rule 24); only a current member earns (not one the
 * creator took out, not somebody who is not in the community); each lesson
 * gives its points once for good, so two presses at once, a lesson marked
 * done again, or undone and done again, give them once (rule 25); a reply
 * that cannot be read gives none and never says given; the person's erasure
 * takes the record of which lessons gave points with their other points
 * (rule 28) and the copy of their data lists them; the routes that mark a
 * lesson done give them, and the studio, the leaderboard and the cost line
 * say so (rules 26 and 27).
 */
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_LESSON_POINTS } from "@/lib/community-text";
import { awardLesson, lessonsGivenOf, pointsOf, pointsRecordOf, readLessonPoints, saveLessonPoints } from "@/lib/community-points";
import { pointsForLessonDone } from "@/lib/lesson-points";
import { memberKey, readMember, touchMember } from "@/lib/community";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { UnknownReplyError } from "@/lib/redis-reply";
import { communityWords } from "@/lib/buyer-words/community";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "lessonpoints@example.com";
const COURSE = "c0115e0000000000000000000000c0de";
const L1 = "lesson000001";
const L2 = "lesson000002";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lessonpts", "Lesson Points", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Lsp000001", subscriptionId: "sub_Lsp000001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const failed = async (work: () => Promise<unknown>) =>
    work().then(() => "answered", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)));

  part("What the creator sets");
  is("nothing set: 0", await readLessonPoints(id), 0);
  await saveLessonPoints(id, 4);
  is("set to 4", await readLessonPoints(id), 4);
  is(`never above ${MAX_LESSON_POINTS}`, await failed(() => saveLessonPoints(id, MAX_LESSON_POINTS + 1)), `Error: Points for a lesson must be a whole number from 0 to ${MAX_LESSON_POINTS}`);
  is("never a fraction", await failed(() => saveLessonPoints(id, 1.5)), `Error: Points for a lesson must be a whole number from 0 to ${MAX_LESSON_POINTS}`);
  is("still 4", await readLessonPoints(id), 4);
  redis.run(["SET", `nl:cm:${id}:lpts`, "eleven"]);
  is("a number kept out of shape: unknown, never 0", await failed(() => readLessonPoints(id)), "unknown");
  redis.run(["SET", `nl:cm:${id}:lpts`, String(MAX_LESSON_POINTS + 5)]);
  is("a number kept above the cap: unknown", await failed(() => readLessonPoints(id)), "unknown");
  await saveLessonPoints(id, 0);
  is("set back to 0: nothing kept", redis.run(["GET", `nl:cm:${id}:lpts`]), null);
  await saveLessonPoints(id, 4);

  part("Only a current member earns");
  const ada = "ada@example.com";
  const bob = "bob@example.com";
  const eve = "eve@example.com";
  await touchMember(id, ada, null, store);
  await touchMember(id, bob, null, store);
  await touchMember(id, eve, null, store);
  is("not in the community: nothing", await pointsForLessonDone(store, COURSE, L1, "stranger@example.com"), "not_member");
  is("and no points", redis.run(["ZSCORE", `nl:cm:${id}:pts`, memberKey("stranger@example.com")]), null);
  // The creator took Eve out: her record says so (lib/community.ts moderateMember writes it by a compare-and-set).
  const eveRecord = JSON.parse(redis.run(["HGET", `nl:cm:${id}:m`, memberKey(eve)]) as string) as Record<string, unknown>;
  redis.run(["HSET", `nl:cm:${id}:m`, memberKey(eve), JSON.stringify({ ...eveRecord, removed: true })]);
  is("Eve is taken out", (await readMember(id, memberKey(eve)))?.removed, true);
  is("taken out by the creator: nothing", await pointsForLessonDone(store, COURSE, L1, eve), "not_member");
  is("Eve has none", (await pointsOf(id, [memberKey(eve)])).get(memberKey(eve)), 0);

  part("Each lesson gives its points once, for good");
  is("Ada finishes a lesson", await pointsForLessonDone(store, COURSE, L1, ada), "given");
  is("four points", (await pointsOf(id, [memberKey(ada)])).get(memberKey(ada)), 4);
  is("the same lesson again: already", await pointsForLessonDone(store, COURSE, L1, ada), "already");
  is("still four", (await pointsOf(id, [memberKey(ada)])).get(memberKey(ada)), 4);
  is("another lesson: four more", [await pointsForLessonDone(store, COURSE, L2, ada), (await pointsOf(id, [memberKey(ada)])).get(memberKey(ada))], ["given", 8]);
  const both = await Promise.all([pointsForLessonDone(store, COURSE, L1, bob), pointsForLessonDone(store, COURSE, L1, bob)]);
  is("two presses at once: one given, one already", both.slice().sort(), ["already", "given"]);
  is("Bob got them once", (await pointsOf(id, [memberKey(bob)])).get(memberKey(bob)), 4);
  // Undone and done again: the lesson's set is not what decides, the record of points given is.
  redis.run(["SREM", `nl:course:${COURSE}:done:x`, L1]);
  is("undone and done again: already", await pointsForLessonDone(store, COURSE, L1, bob), "already");

  part("Nothing set, or the community off: nothing changes");
  await saveLessonPoints(id, 0);
  is("0 points set: none", await pointsForLessonDone(store, COURSE, "lesson000003", ada), "none");
  is("Ada still has 8", (await pointsOf(id, [memberKey(ada)])).get(memberKey(ada)), 8);
  await saveLessonPoints(id, 4);
  await setCommunity(OWNER, false);
  const off = (await storeForEmail(OWNER))!;
  is("community off: off", await pointsForLessonDone(off, COURSE, "lesson000003", ada), "off");
  await setCommunity(OWNER, true);
  is("a store with no community at all: off", await pointsForLessonDone({ ...store, community: null }, COURSE, L1, ada), "off");

  part("A reply that cannot be read gives none (rule 24)");
  const real = redis.pipeline.bind(redis);
  const cid = "dad00000000000000000000000000004";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((cmd, i) => (cmd[0] === "EVAL" && cmd.includes(`nl:cm:${id}:lw:${cid}`) && Array.isArray(replies[i]) ? (replies[i] as unknown[]).map((r, j) => (j === 1 ? ["?"] : r)) : replies[i]));
  }) as typeof redis.pipeline;
  is("whether a lesson gave points cannot be read: unknown", await failed(() => awardLesson(id, cid, COURSE, L1, 4, store)), "unknown");
  redis.pipeline = real;
  is("and no points", redis.run(["ZSCORE", `nl:cm:${id}:pts`, cid]), null);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((cmd, i) => (cmd[0] === "HGET" && String(cmd[1]).endsWith(":m") ? 42 : replies[i]));
  }) as typeof redis.pipeline;
  is("a member record that cannot be read: unknown, not given", await failed(() => pointsForLessonDone(store, COURSE, "lesson000004", ada)), "unknown");
  redis.pipeline = real;
  is("Ada still has 8", (await pointsOf(id, [memberKey(ada)])).get(memberKey(ada)), 8);
  is("points for a lesson in whole numbers only", await failed(() => awardLesson(id, cid, COURSE, L1, 0, store)), `Error: Points for a lesson must be a whole number from 1 to ${MAX_LESSON_POINTS}`);
  is("a lesson that is not one: refused", await failed(() => awardLesson(id, cid, COURSE, "Lesson 1", 4, store)), "Error: Not a course lesson");

  part("The copy of a person's data, and their erasure (rules 27 and 28)");
  is("her copy lists the lessons that gave her points", (await lessonsGivenOf(id, memberKey(ada))).slice().sort(), [`${COURSE}:${L1}`, `${COURSE}:${L2}`]);
  is("and her total", (await pointsRecordOf(id, memberKey(ada))).total, 8);
  const copySource = readFileSync("lib/person-copy.ts", "utf8");
  is("the copy of her data carries them", copySource.includes("lessonsThatGavePoints: lessonsGiven"), true);
  redis.run(["HSET", `nl:cm:${id}:lw:${memberKey(bob)}`, "not a lesson", "1"]);
  is("a record that does not read: unknown, never left out", await failed(() => lessonsGivenOf(id, memberKey(bob))), "Error: Incomplete community points record");
  redis.run(["HDEL", `nl:cm:${id}:lw:${memberKey(bob)}`, "not a lesson"]);
  await forgetCommunityPerson(id, memberKey(ada), ada, [], store);
  is("which lessons gave her points went with her", redis.run(["EXISTS", `nl:cm:${id}:lw:${memberKey(ada)}`]), 0);
  is("and her points", redis.run(["ZSCORE", `nl:cm:${id}:pts`, memberKey(ada)]), null);

  part("What gives them, and what members and the creator read");
  const progress = readFileSync("app/api/store/course/progress/route.ts", "utf8");
  is("marking a lesson done gives them", progress.includes("pointsForLessonDone(store, product.course.id, lessonId, access.learner.email)"), true);
  is("only when it was marked done, never when undone", /if \(done\)[^\n]*pointsForLessonDone/.test(progress) || progress.includes("if (done) await givePoints"), true);
  const quiz = readFileSync("app/api/store/course/quiz/route.ts", "utf8");
  is("passing a lesson's quiz gives them", quiz.includes("pointsForLessonDone(store, course.id, lessonId, access.learner.email)"), true);
  const manage = readFileSync("app/api/store/community/manage/route.ts", "utf8");
  is("the creator saves the number", manage.includes('action === "lesson-points"') && manage.includes("saveLessonPoints("), true);
  const studio = readFileSync("components/community-studio.tsx", "utf8");
  is("the studio asks for it, with its cap", studio.includes("Points for each lesson a member finishes") && studio.includes("MAX_LESSON_POINTS") && studio.includes('id="cm-lesson-points"'), true);
  const board = readFileSync("app/[handle]/community/leaderboard/page.tsx", "utf8");
  is("the leaderboard says what a lesson gives", board.includes("lessonPointsRule("), true);
  const w = communityWords("en");
  is("in plain words", w.lessonPointsRule(4), "Each lesson you finish in a course gives you 4 points.");
  is("one point", w.lessonPointsRule(1), "Each lesson you finish in a course gives you 1 point.");
  is("none: nothing is said", w.lessonPointsRule(0), "");
  for (const lang of ["es", "fr", "de", "it", "nl", "pt"] as const) {
    is(`${lang}: translated`, communityWords(lang).lessonPointsRule(4) !== w.lessonPointsRule(4) && communityWords(lang).lessonPointsRule(0) === "", true);
  }
  const cost = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("the cost line names what it spends", cost.includes('"pointsForLessonDone"') && cost.includes('"awardLesson"'), true);

  done();
}

void main();
