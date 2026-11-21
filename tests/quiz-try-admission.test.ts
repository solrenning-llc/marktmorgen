/**
 * A quiz try is paid for from the store's public requests on the buyers' side,
 * never from its buyer actions (#3466, MEDIUM of Claude 6's review 5831220863).
 *
 * The quiz editor promises "1,000 submissions per store per UTC month"
 * (components/quiz-editor.tsx, QUIZ_MONTHLY_SUBMISSIONS); a store on the Store
 * plan has 200 buyer actions a month and a free trial 50
 * (lib/store-allowance-rules.ts), shared with posts, comments, lessons marked
 * done and certificates. A try that took one of them could never reach the
 * promised figure, and tries that mark nothing (out of tries, already passed,
 * the creator's wait) drew down what every other buyer of the store shares.
 *
 * Now, against the real route (app/api/store/course/quiz/route.ts), the
 * in-memory Redis double and a synthetic store:
 *   - a try takes none of the store's buyer actions, and a Store-plan store's
 *     students send more tries than its whole buyer figure, each one marked;
 *   - one student's sixty tries on a three-try quiz spend three of the store's
 *     submissions and leave every buyer action to the others;
 *   - each try takes QUIZ_TRY_UNITS of the store's public requests (buyer
 *     side, lib/buyer-actions.ts takeBuyerRead), after the per-connection limit
 *     and before the listing, the student's access or the course is read;
 *   - a store whose requests are spent reads none of them and goes to its
 *     resting page;
 *   - what a try sends to Redis, at its heaviest (a first try that passes the
 *     last lesson and finishes the course, a try out of tries, a try over the
 *     store's month), stays inside its units' later-page commands
 *     (tests/traffic-cost.ts, COMMANDS.laterPage + COMMANDS.laterCount), the
 *     figure each public request is priced at (tests/plan-cost-registry.ts);
 *   - the promised 1,000 fit in a free trial's and a Store plan's requests.
 *
 * Synthetic data only; nothing real is reached.
 */
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/course/quiz/route";
import { editCourse, emptyCourse, saveCourse, type Course } from "@/lib/course";
import { emailKey, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
import { readQuiz, saveQuiz, setupOf, type Quiz } from "@/lib/quiz";
import * as rules from "@/lib/quiz-usage-rules";
import { QUIZ_MONTHLY_SUBMISSIONS, quizUsageKey } from "@/lib/quiz-usage-rules";
import { allowanceUsed } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { allowanceWindow } from "@/lib/allowance-window";
import { requestsIn } from "@/lib/traffic";
import { REQUESTS_PER_VISIT, TRIAL_EXTRA_REQUESTS, TRIAL_VISITS, VISITS_INCLUDED, EXTRA_REQUESTS, requestLimitFor } from "@/lib/traffic-rules";
import { COMMANDS } from "./traffic-cost";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const HOST = "marktmorgen.test";
const UNITS = Number((rules as Record<string, unknown>).QUIZ_TRY_UNITS ?? 0);
const PER_UNIT = COMMANDS.laterPage + COMMANDS.laterCount;

/** Every command sent to the store from here on. */
const sent: string[][] = [];
/** While true, every try's one step answers "stale", as when other tries keep being written between its read and its write. */
let losing = false;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String));
  if (losing && commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:quiz-try:")) return [["stale", 0]];
  return pipeline(commands);
}) as typeof redis.pipeline;
// Stripe is never reached: a purchase is the one written down on the thanks page.
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

/** Whether any command since `from` touched a listing, a course, a quiz or a student's record. */
const readContent = (from: number) => sent.slice(from).some((c) => c.slice(1).some((k) => /^nl:(course|catalog|learn|quiz):/.test(k)));

function quizOf(attempts: number): Quiz {
  const made = readQuiz({ passPercent: 100, attempts, waitMinutes: 0, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
  if (!made.ok) throw Error(`quiz: ${made.reason}`);
  return made.quiz;
}

type World = { store: Store; product: string; course: Course; lessons: string[]; quiz: Quiz; folder: string; window: string };

/** A paying Store-plan store selling one course whose two lessons each end in a three-try quiz. */
async function world(handle: string): Promise<World> {
  const owner = `${handle}@example.com`;
  if (!(await claimHandle(owner, handle, "Quiz School", "")).ok) throw Error("no handle");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Kiln safety", "", "49", null);
  if (!made.ok) throw Error("no product");
  let course = emptyCourse();
  for (const title of ["One", "Two"]) {
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title });
    if (!added.ok) throw Error("no lesson");
    course = added.course;
  }
  const certified = editCourse(course, { op: "certificate", on: true });
  if (!certified.ok) throw Error("no certificate");
  course = certified.course;
  const quiz = quizOf(3);
  const lessons = course.modules[0].lessons.map((l) => l.id);
  course = { ...course, modules: [{ ...course.modules[0], lessons: course.modules[0].lessons.map((l) => ({ ...l, quiz: setupOf(quiz) })) }] };
  if (!(await setProductCourse(owner, made.product.id, { id: course.id, lessons: lessons.length })).ok) throw Error("no course");
  const store = (await storeForEmail(owner)) as Store;
  await saveCourse(course, store);
  for (const lesson of lessons) await saveQuiz(course.id, lesson, quiz, store);
  const folder = await storeFolder(owner);
  const window = allowanceWindow(store)!.id;
  return { store, product: made.product.id, course, lessons, quiz, folder, window };
}

/** A student enrolled in the course, and the cookie their browser sends. */
async function student(w: World, email: string): Promise<string> {
  await recordEnrollment(w.store, email, w.product, Math.floor(Date.now() / 1000) - 60);
  return `${passCookieName(w.store)}=${await mintPass(w.store, email, "all")}`;
}

/** Sends one try from `address`, answering right or wrong. */
async function attempt(w: World, cookie: string, lesson: string, right: boolean, address = "203.0.113.20"): Promise<Response> {
  const form = new URLSearchParams({ handle: w.store.handle, product: w.product, lesson, [w.quiz.questions[0].id]: right ? "0" : "1" });
  const request = new Request(`https://${HOST}/api/store/course/quiz`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: HOST, origin: `https://${HOST}`, cookie, "x-forwarded-for": address },
    body: form.toString(),
  });
  answering(request);
  try {
    return await POST(request as unknown as NextRequest);
  } finally {
    answering(null);
  }
}

const marked = (r: Response) => r.status === 303 && (r.headers.get("location") ?? "").endsWith("?quiz=marked#quiz");
const spent = async (w: World) => Number((await redis.pipeline([["GET", quizUsageKey(w.store.sid ?? "", Date.now(), w.window)!]]))[0] ?? 0);

async function main(): Promise<void> {
  redis.clear();
  part("The units a try takes");
  is(`a try takes a whole number of public requests (${UNITS})`, Number.isSafeInteger(UNITS) && UNITS >= 1, true);

  part("A Store-plan store's students send more tries than its whole buyer figure");
  {
    const w = await world("quizstoreplan");
    const figure = STORE_ALLOWANCES.creator.buyer;
    let ok = 0;
    for (let i = 0; i <= figure; i += 1) {
      // Each student from an address of their own, as students at home are.
      const cookie = await student(w, `student${i}@example.com`);
      if (marked(await attempt(w, cookie, w.lessons[0], false, `198.51.${Math.floor(i / 250)}.${i % 250}`))) ok += 1;
    }
    is(`${figure + 1} students, one try each: every try is marked`, ok, figure + 1);
    is("the store's submissions spent are the tries marked", await spent(w), figure + 1);
    is("no buyer action was taken", await allowanceUsed(w.store, "buyer"), 0);
  }

  part("One student's sixty tries on a three-try quiz leave every buyer action to the others");
  redis.clear();
  {
    const w = await world("quizonestudent");
    const cookie = await student(w, "eager@example.com");
    for (let i = 0; i < 60; i += 1) await attempt(w, cookie, w.lessons[0], false);
    const [tries] = await redis.pipeline([["GET", `nl:course:${w.course.id}:quiz:${w.lessons[0]}:tries:${emailKey("eager@example.com")}`]]);
    is("three tries are marked", tries, "3");
    is("three of the store's submissions are spent", await spent(w), 3);
    is("the store's buyer actions are untouched", await allowanceUsed(w.store, "buyer"), 0);
  }

  part("Each try takes its units of the store's public requests, before anything of the course is read");
  redis.clear();
  {
    const w = await world("quizrequests");
    const cookie = await student(w, "counted@example.com");
    let before = await requestsIn(w.folder, w.window);
    await attempt(w, cookie, w.lessons[0], false);
    is(`a marked try takes ${UNITS}`, (await requestsIn(w.folder, w.window)) - before, UNITS);
    before = await requestsIn(w.folder, w.window);
    await attempt(w, "", w.lessons[0], false);
    is("a try from someone without access takes them too, and marks nothing", (await requestsIn(w.folder, w.window)) - before, UNITS);
    const route = readFileSync("app/api/store/course/quiz/route.ts", "utf8");
    const at = (needle: string) => route.indexOf(needle);
    is("the route takes them with takeBuyerRead(store, QUIZ_TRY_UNITS)", at("takeBuyerRead(store, QUIZ_TRY_UNITS)") > 0, true);
    is("after the per-connection limit", at("withinLimit(\"quiz-connection\"") < at("takeBuyerRead(store, QUIZ_TRY_UNITS)"), true);
    is("before the listing is read", at("takeBuyerRead(store, QUIZ_TRY_UNITS)") < at("readCourseListing(store"), true);
    is("before the student's access is read", at("takeBuyerRead(store, QUIZ_TRY_UNITS)") < at("courseAccess(store"), true);
    is("no buyer action is taken", route.includes("takeBuyerAction"), false);

    // Spent: the store's whole window of requests.
    await redis.pipeline([["SET", `nl:traffic:r:${w.folder}:${w.window}`, String(requestLimitFor(w.store, Date.now() / 1000))]]);
    const from = sent.length;
    const resting = await attempt(w, cookie, w.lessons[0], true);
    is("a store whose requests are spent goes to its resting page", [resting.status, resting.headers.get("location")], [303, `https://${HOST}/@${w.store.handle}/resting`]);
    is("and reads no listing, course, quiz or student record", readContent(from), false);
    await redis.pipeline([["DEL", `nl:traffic:r:${w.folder}:${w.window}`]]);
  }

  part("What a try sends stays inside its units' later-page commands");
  redis.clear();
  {
    const w = await world("quizcommands");
    const cookie = await student(w, "heavy@example.com");
    const cost = async (run: () => Promise<unknown>) => {
      const from = sent.length;
      await run();
      return sent.length - from;
    };
    const heaviest: [string, number][] = [];
    // A first try that fails, then one that passes; the last lesson's pass finishes the course.
    heaviest.push(["a first try that fails", await cost(() => attempt(w, cookie, w.lessons[0], false))]);
    heaviest.push(["a try that passes", await cost(() => attempt(w, cookie, w.lessons[0], true))]);
    heaviest.push(["a try after passing", await cost(() => attempt(w, cookie, w.lessons[0], true))]);
    heaviest.push(["a first try that passes the last lesson and finishes the course", await cost(() => attempt(w, cookie, w.lessons[1], true))]);
    const other = await student(w, "spent@example.com");
    for (let i = 0; i < 3; i += 1) await attempt(w, other, w.lessons[0], false);
    heaviest.push(["a try out of tries", await cost(() => attempt(w, other, w.lessons[0], false))]);
    const racing = await student(w, "racing@example.com");
    losing = true;
    try {
      heaviest.push(["a try that loses every round to other tries", await cost(() => attempt(w, racing, w.lessons[0], false))]);
    } finally {
      losing = false;
    }
    const third = await student(w, "late@example.com");
    await redis.pipeline([["SET", quizUsageKey(w.store.sid ?? "", Date.now(), w.window)!, String(QUIZ_MONTHLY_SUBMISSIONS)]]);
    heaviest.push(["a try over the store's month", await cost(() => attempt(w, third, w.lessons[0], false))]);
    for (const [what, commands] of heaviest) is(`${what}: ${commands} commands, at most ${UNITS} × ${PER_UNIT}`, commands <= UNITS * PER_UNIT, true);
  }

  part("The promised 1,000 fit in the requests of a free trial and of the Store plan");
  is(`a free trial: ${QUIZ_MONTHLY_SUBMISSIONS} × ${UNITS} within ${REQUESTS_PER_VISIT * TRIAL_VISITS + TRIAL_EXTRA_REQUESTS}`, UNITS >= 1 && QUIZ_MONTHLY_SUBMISSIONS * UNITS <= REQUESTS_PER_VISIT * TRIAL_VISITS + TRIAL_EXTRA_REQUESTS, true);
  is(`the Store plan: ${QUIZ_MONTHLY_SUBMISSIONS} × ${UNITS} within ${REQUESTS_PER_VISIT * VISITS_INCLUDED.creator + EXTRA_REQUESTS.creator}`, UNITS >= 1 && QUIZ_MONTHLY_SUBMISSIONS * UNITS <= REQUESTS_PER_VISIT * VISITS_INCLUDED.creator + EXTRA_REQUESTS.creator, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
