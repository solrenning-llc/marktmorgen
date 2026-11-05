/**
 * Sequences that follow a course (lib/flow-rules.ts, lib/flows.ts,
 * lib/course-finish.ts; added 12 October 2026). Checked:
 *
 *   - a condition on a course names one of the store's courses, and an
 *     ordinary product is refused for it; so is "finishes" for a product
 *     that is not a course, and an end the course itself would reach at once;
 *   - "has not opened the course", three days after getting it, goes only to
 *     those who have not opened it;
 *   - doing every lesson starts the sequences that start when someone
 *     finishes that course, once, and only for somebody who agreed to hear
 *     from the creator; a lesson undone and done again starts nothing more.
 */
import { holds, readCondition, goalClash } from "@/lib/flow-rules";
import { enroll, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { markLesson, touchStudent } from "@/lib/learn";
import { noteIfFinished } from "@/lib/course-finish";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const HOUR = 3_600_000;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const to = (subject: string) =>
  mail.ses.filter((message) => message.subject === subject).flatMap((message) => message.to).sort();
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_course_triggers_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_course_triggers_only_a_stand_in";

  part("Read strictly");
  const known = (id: string) => id === "course1" || id === "guide1";
  const isCourse = (id: string) => id === "course1";
  is("a condition on a course needs a course", [
    readCondition({ if: "unstarted", productId: "course1" }, known, isCourse),
    readCondition({ if: "finished", productId: "guide1" }, known, isCourse),
    readCondition({ if: "started" }, known, isCourse),
  ], [{ if: "unstarted", productId: "course1" }, "bad", "bad"]);
  const person = { ids: ["course1"], source: "buyer", tags: [] };
  is("each holds as it says", [
    holds({ if: "started", productId: "course1" }, { ...person, course: { started: true, finished: false } }, new Set()),
    holds({ if: "unstarted", productId: "course1" }, { ...person, course: { started: true, finished: false } }, new Set()),
    holds({ if: "unfinished", productId: "course1" }, { ...person, course: { started: true, finished: false } }, new Set()),
    holds({ if: "finished", productId: "course1" }, { ...person }, new Set()),
  ], [true, false, true, false]);
  is("finishing a course cannot end at getting that course", goalClash("finished", "course1", { productId: "course1" }, true), true);

  const OWNER = "harbor@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  const guide = await addProduct(OWNER, "Pantry Guide", "A list.", "9", null);
  if (!made.ok || !guide.ok) throw new Error("no product");
  let course = emptyCourse();
  for (const title of ["One", "Two"]) {
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title });
    if (!added.ok) throw new Error("no lesson");
    course = added.course;
  }
  await saveCourse(course, ROOM);
  const set = await setProductCourse(OWNER, made.product.id, { id: course.id, lessons: 2 });
  if (!set.ok) throw new Error(`not a course: ${JSON.stringify(set)}`);
  const [one, two] = course.modules[0].lessons.map((l) => l.id);
  let store = (await storeForEmail(OWNER))!;
  const courseId = made.product.id;

  part("Saved, and checked when saved");
  is("finishing is only for a course", (await saveFlow(store, { name: "Next", trigger: "finished", productId: guide.product.id, active: true, steps: [{ delayHours: 0, subject: "Well done", body: "Next." }] }, { activate: true })).ok, false);
  is("a condition on an ordinary product is refused", (await saveFlow(store, { name: "Nudge", trigger: "product", productId: courseId, active: true, steps: [{ delayHours: 72, subject: "Start here", body: "Hi.", when: { if: "unstarted", productId: guide.product.id } }] }, { activate: true })).ok, false);
  const nudge = await saveFlow(store, {
    name: "Nudge",
    trigger: "product",
    productId: courseId,
    active: true,
    steps: [{ delayHours: 72, subject: "Your first lesson is waiting", body: "Hi.", when: { if: "unstarted", productId: courseId } }],
  }, { activate: true });
  const next = await saveFlow(store, { name: "Next", trigger: "finished", productId: courseId, active: true, steps: [{ delayHours: 0, subject: "You finished it", body: "Well done." }] }, { activate: true });
  is("both saved", [nudge.ok, next.ok, (await readFlows(store.listId)).map((f) => f.trigger)], [true, true, ["product", "finished"]]);
  store = (await storeForEmail(OWNER))!;

  part("Has not opened the course, three days on");
  for (const email of ["ana@example.com", "ben@example.com"]) {
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, productId: courseId, title: "Weeknight Course", source: "buyer" }, ROOM);
    await enroll(store, email, { joined: false, productId: courseId });
  }
  await touchStudent(course.id, "ana@example.com", Math.floor(Date.now() / 1000), ROOM);
  shift += 73 * HOUR;
  await run();
  is("only the one who has not opened it", to("Your first lesson is waiting"), ["ben@example.com"]);

  part("Finishing it");
  await markLesson(course.id, "ana@example.com", one, true, ROOM);
  is("one lesson of two is not finishing", await noteIfFinished(store, courseId, course.id, "ana@example.com"), false);
  await markLesson(course.id, "ana@example.com", two, true, ROOM);
  is("the last one is", await noteIfFinished(store, courseId, course.id, "ana@example.com"), true);
  await run();
  is("and starts what finishing starts", to("You finished it"), ["ana@example.com"]);
  await markLesson(course.id, "ana@example.com", two, false, ROOM);
  await markLesson(course.id, "ana@example.com", two, true, ROOM);
  is("undone and done again starts nothing more", await noteIfFinished(store, courseId, course.id, "ana@example.com"), false);
  await markLesson(course.id, "cy@example.com", one, true, ROOM);
  await markLesson(course.id, "cy@example.com", two, true, ROOM);
  await noteIfFinished(store, courseId, course.id, "cy@example.com");
  await run();
  is("somebody who never agreed to hear from the creator is not written to", to("You finished it"), ["ana@example.com"]);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
