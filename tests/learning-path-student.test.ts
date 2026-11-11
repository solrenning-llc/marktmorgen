/**
 * 249 [ST2], unit 4a: what a student has and what they finished, for a
 * learning path (lib/learning-path-student.ts), read exactly from the same
 * records a course page reads: the store's course listings, the courses the
 * address paid for (lib/learn.ts paidCourses) within what this browser was
 * let into, and each course's lessons done and quizzes passed
 * (lib/certificate.ts hasFinished). Anything that does not read is unknown,
 * never "none" and never "finished" (rule 24). Synthetic only: the in-memory
 * Redis double.
 */
import { editCourse, emptyCourse, saveCourse, type Course } from "@/lib/course";
import { markLesson, recordEnrollment } from "@/lib/learn";
import { pathStudent } from "@/lib/learning-path-student";
import { pathProgress, type LearningPath } from "@/lib/learning-path-rules";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_learning_path_student_only";
/** Stripe, simulated: an address's checkout sessions, read whole ("list"), cut short ("more") or failing ("down"). */
let stripe: "list" | "more" | "down" = "list";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.stripe.com/")) return new Response("{}", { status: 404 });
  stripeCalls += 1;
  if (stripe === "down") throw new Error("synthetic: Stripe did not answer");
  return Response.json({ object: "list", data: [], has_more: stripe === "more" });
}) as typeof fetch;
const quiet = console.error;

const real = redis.pipeline.bind(redis);
/** A reply to replace, by command and key pattern, while a check runs. */
let garble: { command: string; key: RegExp; reply: unknown } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  if (!garble) return replies;
  return replies.map((reply: unknown, i: number) => (commands[i][0] === garble!.command && garble!.key.test(String(commands[i][1])) ? garble!.reply : reply));
}) as typeof redis.pipeline;

async function course(owner: string, title: string, lessons: number): Promise<{ product: string; course: Course }> {
  const made = await addProduct(owner, title, "", "40");
  if (!made.ok) throw new Error("product");
  let built = emptyCourse();
  for (let i = 0; i < lessons; i += 1) {
    const next = editCourse(built, { op: "lesson-add", moduleId: built.modules[0].id, title: `Lesson ${i + 1}` });
    if (!next.ok) throw new Error("lesson");
    built = next.course;
  }
  await saveCourse(built, ROOM);
  const linked = await setProductCourse(owner, made.product.id, { id: built.id, lessons });
  if (!linked.ok) throw new Error("link");
  return { product: made.product.id, course: built };
}

async function main(): Promise<void> {
  console.error = () => undefined;
  redis.clear();
  const owner = "paths-student@example.com";
  await claimHandle(owner, "pathstudent", "Path Student", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestPathStud01", true);
  await setSubscription(owner, { customerId: "cus_pathstud", subscriptionId: "sub_pathstud", active: true, tier: "pro", period: paidPeriod() });
  const a = await course(owner, "Clay basics", 1);
  const b = await course(owner, "Wheel throwing", 2);
  const c = await course(owner, "Glazing", 1);
  const store = (await storeForEmail(owner))!;
  const path: LearningPath = { name: "Become a potter", courses: [a.product, b.product, c.product], order: "sequence" };
  const student = "student@example.com";
  await recordEnrollment(store, student, a.product, 1_700_000_000);
  await recordEnrollment(store, student, b.product, 1_700_000_000);
  await markLesson(a.course.id, student, a.course.modules[0].lessons[0].id, true, ROOM);
  await markLesson(b.course.id, student, b.course.modules[0].lessons[0].id, true, ROOM);
  const learner = { email: student, scope: "all" as const, owner: false };

  part("What the student has and finished");
  const seen = await pathStudent(store, path, learner);
  is("the courses they paid for", [...(seen.has ?? [])].sort(), [a.product, b.product].sort());
  is("finished: every lesson done; one lesson of two is not finished", [...(seen.finished ?? [])], [a.product]);
  is("each course by its title", [...seen.titles.entries()], [[a.product, "Clay basics"], [b.product, "Wheel throwing"], [c.product, "Glazing"]]);
  is("and the path reads from it", pathProgress(path, seen).courses.map((x) => x.state), ["done", "open", "not_owned"]);

  const scoped = await pathStudent(store, path, { email: student, scope: [a.course.id], owner: false });
  is("a browser let into one course only has that one", [...(scoped.has ?? [])], [a.product]);

  const creator = await pathStudent(store, path, { email: owner, scope: "all", owner: true });
  is("the creator has every course of the path", [...(creator.has ?? [])].sort(), [a.product, b.product, c.product].sort());

  await markLesson(b.course.id, student, b.course.modules[0].lessons[1].id, true, ROOM);
  is("the last lesson done: finished", [...((await pathStudent(store, path, learner)).finished ?? [])].sort(), [a.product, b.product].sort());

  part("Unknown is never none and never finished (rule 24)");
  garble = { command: "HGETALL", key: /^nl:learn:enr:/, reply: ["only-a-field"] };
  const ledger = await pathStudent(store, path, learner);
  garble = null;
  is("what they paid for does not read: has is unknown, and so is finished", [ledger.has, ledger.finished], [null, null]);

  garble = { command: "SMEMBERS", key: /:done:/, reply: 42 };
  const lessonsDone = await pathStudent(store, path, learner);
  garble = null;
  is("their lessons done do not read: finished is unknown, has still known", [lessonsDone.has === null, lessonsDone.finished], [false, null]);

  garble = { command: "MGET", key: /^nl:course:[0-9a-f]+$/, reply: ["{not a course", "{not a course"] };
  const outline = await pathStudent(store, path, learner);
  garble = null;
  is("a course's outline does not read: finished is unknown", outline.finished, null);

  garble = { command: "SMEMBERS", key: /:passed:|quiz/, reply: 42 };
  const passes = await pathStudent(store, path, learner);
  garble = null;
  is("their quiz passes do not read: finished is unknown", passes.finished, null);

  const progress = pathProgress(path, ledger);
  is("and the path says nothing is done or open", [progress.finished, progress.complete, progress.courses.every((x) => x.state === "unknown")], [null, false, true]);

  part("What they paid for at Stripe does not read: unknown, never \"not bought\" (review of #3724)");
  const fresh = "fresh-student@example.com";
  await recordEnrollment(store, fresh, a.product, 1_700_000_000);
  const freshLearner = { email: fresh, scope: "all" as const, owner: false };
  stripe = "down";
  stripeCalls = 0;
  const down = await pathStudent(store, path, freshLearner);
  is("Stripe asked, and failing: has and finished unknown", [stripeCalls > 0, down.has, down.finished], [true, null, null]);
  is("so the path shows nothing as not bought", pathProgress(path, down).courses.every((x) => x.state === "unknown"), true);
  stripe = "more";
  const cut = await pathStudent(store, path, { ...freshLearner, email: "cut-student@example.com" });
  is("a list of purchases cut short (more pages): unknown", [cut.has, cut.finished], [null, null]);
  stripe = "list";
  const whole = await pathStudent(store, path, { ...freshLearner, email: "whole-student@example.com" });
  is("read whole and empty: known, nothing had", [whole.has ? [...whole.has] : null], [[]]);

  part("A course gone from the store");
  const gone: LearningPath = { ...path, courses: [a.product, "prodGone0001"] };
  const after = await pathStudent(store, gone, learner);
  is("a product no longer there is not had, and has no title", [after.has?.has("prodGone0001"), after.titles.has("prodGone0001")], [false, false]);

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error = quiet;
  console.error(error);
  process.exit(1);
});
