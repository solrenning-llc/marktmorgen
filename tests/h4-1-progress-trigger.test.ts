/**
 * 287 [H4-1] "Reaches a share of a course" as a workflow trigger, against the
 * in-memory Redis double and synthetic stores only. Checked:
 *
 *   - the trigger is saved only for one of the store's courses and one of
 *     the shares offered (PROGRESS_PERCENTS), never another number;
 *   - progress is read on the server, from the lessons marked done (by a
 *     button, a quiz passed or work approved, which all reach
 *     noteIfFinished), and each share starts its workflows once per person
 *     per course: undone and done again starts nothing more;
 *   - a jump past several shares at once starts each of them once;
 *   - only somebody on the list who agreed to hear from the creator is
 *     written to, and the emails go out through the sequence's own sending,
 *     inside the store's email allowance;
 *   - an unknown reply (the workflows, the lessons done or the mark) starts
 *     nothing, and a plan without workflows reads nothing;
 *   - the check takes the store's public requests first, and the marks are
 *     erased with the person, exactly.
 */
import { readFileSync } from "node:fs";
import { FLOW_TRIGGERS, PROGRESS_PERCENTS } from "@/lib/flow-rules";
import { flowsStartedFor, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { emailKey, markLesson } from "@/lib/learn";
import { noteIfFinished } from "@/lib/course-finish";
import { PROGRESS_TRIGGER_UNITS, forgetProgressPerson, noteProgress } from "@/lib/course-progress-trigger";
import { ERASERS } from "@/lib/person-erasure";
import { PERSON_DATA } from "@/lib/person-data";
import { RUN_START_COMMANDS } from "@/lib/flow-limits";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { laterPageCost } from "./traffic-cost";
import { request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const to = (subject: string) => mail.ses.filter((message) => message.subject === subject).flatMap((message) => message.to).sort();
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_progress_trigger_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_progress_trigger_only_a_stand_in";

  const OWNER = "progress@example.com";
  await claimHandle(OWNER, "progress", "Progress Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestProgress01", true);
  await setSubscription(OWNER, { customerId: "cus_Progress01", subscriptionId: "sub_Progress01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Progress Kitchen", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Bread Course", "Four loaves.", "49", null);
  const guide = await addProduct(OWNER, "Flour Guide", "A list.", "9", null);
  if (!made.ok || !guide.ok) throw new Error("no product");
  let course = emptyCourse();
  for (const title of ["One", "Two", "Three", "Four"]) {
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title });
    if (!added.ok) throw new Error("no lesson");
    course = added.course;
  }
  await saveCourse(course, ROOM);
  const set = await setProductCourse(OWNER, made.product.id, { id: course.id, lessons: 4 });
  if (!set.ok) throw new Error(`not a course: ${JSON.stringify(set)}`);
  const lessons = course.modules[0].lessons.map((l) => l.id);
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId!;
  const productId = made.product.id;
  const step = (subject: string) => [{ delayHours: 0, subject, body: "Hi." }];

  part("Saved, and checked when saved");
  is("a trigger of its own", FLOW_TRIGGERS.includes("progress"), true);
  is("shares offered, each a whole percent between none and all", [PROGRESS_PERCENTS.length > 0, PROGRESS_PERCENTS.every((p) => Number.isInteger(p) && p > 0 && p < 100)], [true, true]);
  is("only for a course", await saveFlow(store, { name: "Half", trigger: "progress", productId: guide.product.id, percent: 50, steps: step("x") }), { ok: false, reason: "product" });
  for (const percent of [0, 100, 33, "50", null, undefined, 50.5]) {
    is(`a share not offered (${String(percent)}) is refused`, await saveFlow(store, { name: "Half", trigger: "progress", productId, percent, steps: step("x") }), { ok: false, reason: "percent" });
  }
  const half = await saveFlow(store, { name: "Halfway", trigger: "progress", productId, percent: 50, steps: step("You are halfway") }, { activate: true });
  const most = await saveFlow(store, { name: "Almost", trigger: "progress", productId, percent: 75, steps: step("Almost there") }, { activate: true });
  const paused = await saveFlow(store, { name: "Paused", trigger: "progress", productId, percent: 25, steps: step("A quarter") });
  is("saved with its course and share", [half.ok, most.ok, paused.ok, (await readFlows(list)).map((f) => [f.trigger, f.productId, f.percent])], [true, true, true, [["progress", productId, 50], ["progress", productId, 75], ["progress", productId, 25]]]);
  const flows = await readFlows(list);
  const [halfId, mostId] = [flows[0].id, flows[1].id];

  part("Who it starts, and when");
  for (const email of ["ana@example.com", "bo@example.com"]) await upsertContact(list, email, { agreed: true, explicit: true, productId, title: "Bread Course", source: "buyer" }, ROOM);
  await markLesson(course.id, "ana@example.com", lessons[0], true, ROOM);
  await noteIfFinished(store, productId, course.id, "ana@example.com");
  is("a quarter done starts nothing switched on (the paused workflow at a quarter starts nothing)", await flowsStartedFor(flows, "ana@example.com"), []);
  await markLesson(course.id, "ana@example.com", lessons[1], true, ROOM);
  await noteIfFinished(store, productId, course.id, "ana@example.com");
  is("half done starts the workflow at half", await flowsStartedFor(flows, "ana@example.com"), [halfId]);
  await run();
  is("and its email goes to that student", to("You are halfway"), ["ana@example.com"]);
  await markLesson(course.id, "ana@example.com", lessons[1], false, ROOM);
  await markLesson(course.id, "ana@example.com", lessons[1], true, ROOM);
  is("undone and done again starts nothing more", (await noteProgress(store, productId, course.id, "ana@example.com", lessons)).milestones, []);
  await run();
  is("no second email", to("You are halfway"), ["ana@example.com"]);
  for (const id of lessons.slice(0, 3)) await markLesson(course.id, "bo@example.com", id, true, ROOM);
  is("three lessons at once: each share reached starts once", (await noteProgress(store, productId, course.id, "bo@example.com", lessons)).milestones, [50, 75]);
  is("both workflows started", await flowsStartedFor(flows, "bo@example.com"), [halfId, mostId]);
  is("again: nothing", (await noteProgress(store, productId, course.id, "bo@example.com", lessons)).milestones, []);
  for (const id of lessons.slice(0, 2)) await markLesson(course.id, "cy@example.com", id, true, ROOM);
  await noteIfFinished(store, productId, course.id, "cy@example.com");
  is("somebody not on the list is not started", await flowsStartedFor(flows, "cy@example.com"), []);
  await run();
  is("and never written to", [to("You are halfway"), to("Almost there")], [["ana@example.com", "bo@example.com"], ["bo@example.com"]]);

  part("Unknown replies start nothing");
  const original = redis.pipeline.bind(redis) as Pipe;
  const lie = async (match: (c: (string | number)[]) => boolean, reply: unknown, email: string) => {
    for (const id of lessons.slice(0, 2)) await markLesson(course.id, email, id, true, ROOM);
    await upsertContact(list, email, { agreed: true, explicit: true, productId, title: "Bread Course", source: "buyer" }, ROOM);
    redis.pipeline = (async (commands: (string | number)[][]) => (commands.some(match) ? reply : original(commands))) as typeof redis.pipeline;
    try {
      return await noteProgress(store, productId, course.id, email, lessons);
    } finally {
      redis.pipeline = original as typeof redis.pipeline;
    }
  };
  const getter = Object.defineProperty(new Array(1), "0", { get: () => [lessons[0], lessons[1]] });
  const cases: [string, (c: (string | number)[]) => boolean, unknown][] = [
    ["the workflows, unreadable", (c) => c[0] === "GET" && String(c[1]).startsWith("nl:mail:flows:"), [42]],
    ["the workflows, no reply", (c) => c[0] === "GET" && String(c[1]).startsWith("nl:mail:flows:"), []],
    ["the lessons done, not a list", (c) => c[0] === "SMEMBERS", ["l1"]],
    ["the lessons done, a getter", (c) => c[0] === "SMEMBERS", getter],
    ["the lessons done, a number among them", (c) => c[0] === "SMEMBERS", [[lessons[0], lessons[1], 7]]],
    ["the lessons done, an extra reply", (c) => c[0] === "SMEMBERS", [[lessons[0], lessons[1]], []]],
    ["the mark, as text", (c) => c[0] === "HSETNX", ["1", 1]],
    ["the mark, missing", (c) => c[0] === "HSETNX", [1]],
    ["the mark, null", (c) => c[0] === "HSETNX", [null, 1]],
    ["the mark's expiry, unknown", (c) => c[0] === "HSETNX", [1, null]],
  ];
  let n = 0;
  for (const [label, match, reply] of cases) {
    const email = `unknown${n++}@example.com`;
    const result = await lie(match, reply, email);
    is(`${label}: not checked, nothing started`, [result.state, result.milestones, await flowsStartedFor(flows, email)], ["not_checked", [], []]);
  }

  part("What it costs");
  let commands = 0;
  const counting = (async (c: (string | number)[][]) => { commands += c.length; return original(c); }) as typeof redis.pipeline;
  redis.pipeline = counting;
  try {
    is("a plan without workflows reads nothing", (await noteProgress({ ...store, tier: "creator" }, productId, course.id, "ana@example.com", lessons)).state, "none");
  } finally { redis.pipeline = original as typeof redis.pipeline; }
  is("not one command for it", commands, 0);
  await upsertContact(list, "dee@example.com", { agreed: true, explicit: true, productId, title: "Bread Course", source: "buyer" }, ROOM);
  for (const id of lessons.slice(0, 3)) await markLesson(course.id, "dee@example.com", id, true, ROOM);
  commands = 0;
  redis.pipeline = counting;
  try {
    await noteProgress(store, productId, course.id, "dee@example.com", lessons);
  } finally { redis.pipeline = original as typeof redis.pipeline; }
  // Two runs started, each priced as a run in the day's runs (lib/flow-limits.ts); the check is the rest, and at every share
  // offered reached at once it marks one more field for each of the others.
  const check = commands - 2 * RUN_START_COMMANDS + (PROGRESS_PERCENTS.length - 2);
  is(`the check, beside the runs' own starts, is at most ${check} commands`, check <= 25, true);
  is(`and ${PROGRESS_TRIGGER_UNITS} public request, priced as a page, is above a light request of those commands`, laterPageCost() * PROGRESS_TRIGGER_UNITS >= request("light", check), true);
  const source = readFileSync("lib/course-progress-trigger.ts", "utf8");
  is("the check takes the store's public requests first", source.indexOf('if (!(await takePublicRequest(store, "buyer", Date.now(), PROGRESS_TRIGGER_UNITS))) {') > 0 && source.indexOf("takePublicRequest(store") < source.indexOf("readFlowListStrict("), true);
  const finish = readFileSync("lib/course-finish.ts", "utf8");
  is("every place a lesson is marked done reaches it, through noteIfFinished, before the all-done check", finish.indexOf("await noteProgress(store, productId, courseId, email, lessons);") > 0 && finish.indexOf("await noteProgress(") < finish.indexOf("if (!lessons.every((id) => done.has(id))) return false;"), true);

  part("Erased with the person");
  const key = `nl:course:${course.id}:pct:${emailKey("ana@example.com")}`;
  is("the mark is kept", redis.run(["HGETALL", key]) !== null, true);
  is("deleted, counted exactly", await forgetProgressPerson([course.id, "course_other"], "ana@example.com"), 1);
  is("and gone", await flowsStartedFor(flows, "ana@example.com") && redis.run(["EXISTS", key]), 0);
  const bad = async (reply: unknown) => {
    redis.pipeline = (async () => reply) as typeof redis.pipeline;
    try { await forgetProgressPerson([course.id], "bo@example.com"); return "ok"; } catch (error) { return (error as Error).name; } finally { redis.pipeline = original as typeof redis.pipeline; }
  };
  is("an unknown count is never taken for gone", [await bad([]), await bad([null]), await bad(["1"]), await bad([2]), await bad([-1]), await bad([1, 0])], ["UnknownReply", "UnknownReply", "UnknownReply", "UnknownReply", "UnknownReply", "UnknownReply"]);
  is("a person's deletion runs it", ERASERS.some((e) => e.module === "lib/course-progress-trigger.ts"), true);
  is("and the privacy list names it", PERSON_DATA.some((d) => d.file === "lib/course-progress-trigger.ts" && d.how === "erased"), true);

  part("The studio and the privacy policy");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the studio offers it for a course and says what it does", [studio.includes('{courses.length ? <option value="progress">Someone who agreed to hear from you reaches a share of a course</option> : null}'), studio.includes("Starts when someone who agreed to hear from you has done")], [true, true]);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the privacy policy says what it keeps", privacy.includes("A sequence may also start when you have done a share of a course&apos;s lessons that the creator chose, such as half of them; which of those shares you reached is kept for up to 400 days, and deleted with your course progress."), true);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
