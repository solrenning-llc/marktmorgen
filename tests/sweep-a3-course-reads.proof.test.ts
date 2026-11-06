/**
 * Sweep A3 proof (CX-123 rules 24 and 30), synthetic only: the in-memory Redis double and a stand-in for the
 * creator's Stripe account. lib/learn.ts:
 *
 * 1. courseLedger, lines 382-385: whether the creator took a student off a course (setBlocked) is read with
 *    `flags[i] === 1 || flags[i] === "1"`; an answer in an unknown shape is "not taken off", so the course opens
 *    again for a student the creator removed (courseAccess, paidCourses, requestCourseLink). studentPage (lines
 *    640-648) already treats an unknown blocked answer as unknown (rule 30).
 * 2. courseProgress, lines 534-546: the HMGET of who opened the course and each SMEMBERS of lessons done are read
 *    with `Array.isArray(x) ? x : []`; an unknown answer is "never started, finished nothing". lib/flows.ts line
 *    1165-1185 decides a sequence's course condition on it ("has not finished the course"), sends the email or
 *    moves the run on, and writes the note as a fact.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { courseProgress, markLesson, paidCourses, recordEnrollment, setBlocked, touchStudent } from "@/lib/learn";
import { editCourse, emptyCourse, lessonsInOrder, saveCourse } from "@/lib/course";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sweep_a3_courses_only";
const OWNER = "sweepa3course@example.com";
const NOW = Math.floor(Date.now() / 1000);
const sessions: Record<string, Record<string, unknown>[]> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const data = path === "/checkout/sessions" ? sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [] : [];
  return new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "sweepcourse", "Sweep Course", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSweepCrs01", true);
  let made = emptyCourse();
  for (const title of ["One", "Two"]) {
    const added = editCourse(made, { op: "lesson-add", moduleId: made.modules[0].id, title });
    if (!added.ok) throw new Error("no lesson");
    made = added.course;
  }
  await saveCourse(made, ROOM);
  const product = await addProduct(OWNER, "Bookkeeping Basics", "", "49", null);
  if (!product.ok) throw new Error("no product");
  await setProductCourse(OWNER, product.product.id, { id: made.id, lessons: 2 });
  const store = (await storeForEmail(OWNER))!;
  const id = product.product.id;
  const paid = { id: "cs_test_ana000000001", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", created: NOW - 86_400, metadata: { store: "sweepcourse", product: id }, payment_intent: { id: "pi_ana01", latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } } };
  sessions["ana@example.com"] = [paid];
  await recordEnrollment(store, "ana@example.com", id, NOW - 86_400);
  const open = async () => [...(await paidCourses(store, "ana@example.com")).keys()];

  part("1. courseLedger: healthy control");
  is("bought: open", await open(), [id]);
  await setBlocked(store, made.id, "ana@example.com", true);
  is("taken off the course by the creator: shut", await open(), []);

  part("1. DEFECT: the SISMEMBER of the blocked list answers in an unknown shape");
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    return commands.every((c) => c[0] === "SISMEMBER" && String(c[1]).endsWith(":blocked")) ? replies.map(() => "?") : replies;
  }) as typeof redis.pipeline;
  const reopened = await open();
  redis.pipeline = real;
  is("DEFECT: the removed student's course opens again", reopened, [id]);

  part("2. courseProgress: healthy control (Ben opened it and finished both lessons)");
  await touchStudent(made.id, "ben@example.com", NOW - 3_600, ROOM);
  for (const { lesson } of lessonsInOrder(made)) await markLesson(made.id, "ben@example.com", lesson.id, true, ROOM);
  is("started and finished", (await courseProgress(store, id, ["ben@example.com"])).get("ben@example.com"), { started: true, finished: true });

  part("2. DEFECT: the progress reads answer in an unknown shape");
  redis.pipeline = (async (commands: Command[]) => (commands[0]?.[0] === "HMGET" && String(commands[0][1]).endsWith(":students") ? commands.map(() => ({ unexpected: true })) : real(commands))) as typeof redis.pipeline;
  const progress = (await courseProgress(store, id, ["ben@example.com"])).get("ben@example.com");
  redis.pipeline = real;
  is("DEFECT: no error, read as never started and finished nothing", progress, { started: false, finished: false });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
