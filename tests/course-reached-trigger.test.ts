/**
 * Workflows that start when a student has done a share of a course (287 [H4-1], unit 1; lib/flow-rules.ts
 * reachedShare and isReachedShare, lib/flows.ts saveFlow and enroll, lib/flow-list.ts, lib/flow-review.ts,
 * lib/course-finish.ts; added 12 November 2026). Checked:
 *
 *   - the share is the whole percent of the course's lessons done, rounded down, so it is said only once reached;
 *   - a "reached" workflow is saved only for a course, with a share from 5% to 95% in steps of 5; a list kept with a
 *     share on another trigger, or a "reached" one without a valid share, is not read as a list (strict read);
 *   - the studio's review names a missing share and a course that is gone;
 *   - each lesson marked done starts the workflows at every share now reached, each once per student: a lesson
 *     undone and done again starts nothing more, and a student who jumps past several shares starts each of them;
 *   - finishing the course starts what finishing starts and any share not started yet, still once;
 *   - nobody who never agreed to hear from the creator is written to;
 *   - getting the course is an end a "reached" workflow would reach at once, and is refused.
 */
import { goalClash, isReachedShare, reachedShare } from "@/lib/flow-rules";
import { type Flow, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { parseFlowList } from "@/lib/flow-list";
import { flowConfigurationIssues } from "@/lib/flow-review";
import { upsertContact } from "@/lib/contacts";
import { markLesson } from "@/lib/learn";
import { noteIfFinished } from "@/lib/course-finish";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

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
  process.env.STRIPE_SECRET_KEY = "sk_test_course_reached_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_course_reached_only_a_stand_in";

  part("The share");
  is("whole percent, rounded down", [reachedShare(1, 4), reachedShare(1, 3), reachedShare(2, 3), reachedShare(3, 3)], [25, 33, 66, 100]);
  is("nothing done, no lessons or a bad count: zero", [reachedShare(0, 4), reachedShare(2, 0), reachedShare(-1, 4), reachedShare(1.5, 4)], [0, 0, 0, 0]);
  is("never more than the whole course", reachedShare(9, 4), 100);
  is(
    "a share a workflow may start at: 5% to 95%, in steps of 5",
    [isReachedShare(5), isReachedShare(25), isReachedShare(95), isReachedShare(0), isReachedShare(100), isReachedShare(33), isReachedShare("50"), isReachedShare(50.5)],
    [true, true, true, false, false, false, false, false],
  );
  is("getting the course is an end it would reach at once", goalClash("reached", "course1", { productId: "course1" }, true), true);

  const OWNER = "reached@example.com";
  await claimHandle(OWNER, "reachedshop", "Reached Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReached001", true);
  await setSubscription(OWNER, { customerId: "cus_Reached0001", subscriptionId: "sub_Reached0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Reached Kitchen", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  const guide = await addProduct(OWNER, "Pantry Guide", "A list.", "9", null);
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
  const [one, two, three, four] = course.modules[0].lessons.map((l) => l.id);
  let store = (await storeForEmail(OWNER))!;
  const courseId = made.product.id;
  const step = (subject: string) => [{ delayHours: 0, subject, body: "Hi." }];

  part("Saved, and checked when saved");
  const save = (share: unknown, productId = courseId) => saveFlow(store, { name: "Quarter", trigger: "reached", productId, share, active: true, steps: step("Quarter") }, { activate: true });
  is("only for a course", (await save(25, guide.product.id)).ok, false);
  const refused = await Promise.all([save(undefined), save(0), save(100), save(33), save("25")]);
  is("never without a share it may have", refused.map((r) => (r.ok ? "saved" : r.reason)), ["share", "share", "share", "share", "share"]);
  const quarter = await save(25);
  const half = await saveFlow(store, { name: "Half", trigger: "reached", productId: courseId, share: 50, active: true, steps: step("Halfway there") }, { activate: true });
  const most = await saveFlow(store, { name: "Most", trigger: "reached", productId: courseId, share: 75, active: true, steps: step("Almost done") }, { activate: true });
  const end = await saveFlow(store, { name: "End", trigger: "finished", productId: courseId, active: true, steps: step("You finished it") }, { activate: true });
  is("saved, each with its share", [quarter.ok, half.ok, most.ok, end.ok, (await readFlows(store.listId)).map((f) => [f.trigger, f.share ?? null])], [true, true, true, true, [["reached", 25], ["reached", 50], ["reached", 75], ["finished", null]]]);
  is("a share on another trigger is never kept", (await saveFlow(store, { name: "Other", trigger: "finished", productId: courseId, share: 50, active: false, steps: step("x") })).ok && (await readFlows(store.listId)).find((f) => f.name === "Other")?.share, undefined);
  store = (await storeForEmail(OWNER))!;

  part("Read strictly");
  const base = { id: "f1", name: "x", productId: courseId, active: true, createdAt: 1, steps: [] };
  is("a kept list with a valid share is read", parseFlowList([{ ...base, trigger: "reached", share: 50 }]) !== null, true);
  is(
    "a reached one without a valid share, or a share on another trigger, is not a list",
    [parseFlowList([{ ...base, trigger: "reached" }]), parseFlowList([{ ...base, trigger: "reached", share: 30.5 }]), parseFlowList([{ ...base, trigger: "finished", share: 50 }])],
    [null, null, null],
  );
  const review = (flow: Partial<Flow>, courses: string[]) =>
    flowConfigurationIssues({ ...(base as unknown as Flow), steps: [{ id: "s1", delayHours: 0, subject: "a", body: "b" }], trigger: "reached", ...flow } as Flow, { products: [{ id: courseId }], courses } as never);
  is("the review names a missing share", review({ share: undefined }, [courseId]).some((issue) => issue.includes("how much of the course")), true);
  is("and a course that is gone", review({ share: 50 }, []).some((issue) => issue.includes("trigger course is unavailable")), true);
  is("and has nothing to say of a good one", review({ share: 50 }, [courseId]).filter((issue) => issue.includes("course")), []);

  part("Partway through");
  for (const email of ["ana@example.com", "ben@example.com"]) {
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, productId: courseId, title: "Weeknight Course", source: "buyer" }, ROOM);
  }
  await markLesson(course.id, "ana@example.com", one, true, ROOM);
  is("a quarter done is not finishing", await noteIfFinished(store, courseId, course.id, "ana@example.com"), false);
  await run();
  is("and starts the quarter workflow", [to("Quarter"), to("Halfway there")], [["ana@example.com"], []]);
  await markLesson(course.id, "ana@example.com", two, true, ROOM);
  await noteIfFinished(store, courseId, course.id, "ana@example.com");
  await run();
  is("half done starts the half one, and the quarter one not again", [to("Quarter"), to("Halfway there"), to("Almost done")], [["ana@example.com"], ["ana@example.com"], []]);
  await markLesson(course.id, "ana@example.com", two, false, ROOM);
  await noteIfFinished(store, courseId, course.id, "ana@example.com");
  await markLesson(course.id, "ana@example.com", two, true, ROOM);
  await noteIfFinished(store, courseId, course.id, "ana@example.com");
  await run();
  is("undone and done again starts nothing more", [to("Quarter"), to("Halfway there")], [["ana@example.com"], ["ana@example.com"]]);
  for (const lesson of [one, two, three]) await markLesson(course.id, "ben@example.com", lesson, true, ROOM);
  await noteIfFinished(store, courseId, course.id, "ben@example.com");
  await run();
  is("three quarters at once starts every share reached, each once", [to("Quarter"), to("Halfway there"), to("Almost done")], [["ana@example.com", "ben@example.com"], ["ana@example.com", "ben@example.com"], ["ben@example.com"]]);

  part("Finishing it");
  await markLesson(course.id, "ana@example.com", three, true, ROOM);
  await markLesson(course.id, "ana@example.com", four, true, ROOM);
  is("the last lesson finishes it", await noteIfFinished(store, courseId, course.id, "ana@example.com"), true);
  await run();
  is("and starts what finishing starts and the share not started yet, still once each", [to("You finished it"), to("Almost done"), to("Quarter")], [["ana@example.com"], ["ana@example.com", "ben@example.com"], ["ana@example.com", "ben@example.com"]]);

  part("Only who agreed");
  for (const lesson of [one, two]) await markLesson(course.id, "cy@example.com", lesson, true, ROOM);
  await noteIfFinished(store, courseId, course.id, "cy@example.com");
  await run();
  is("somebody who never agreed to hear from the creator is not written to", [to("Quarter").includes("cy@example.com"), to("Halfway there").includes("cy@example.com")], [false, false]);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
