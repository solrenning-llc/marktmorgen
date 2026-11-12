/**
 * Claude 1's LOW (rule 30) and nuvem M's LOW on #3432 at b3c28d3b7d: the course editor's `lesson-remove` could take
 * the last lesson off a published course, which then stayed on the store with nothing to hand over (handsOver).
 * It is now refused with `last_delivery` and the product's name, the lesson kept; removing a lesson that is not the
 * last, or the last one of a draft, still works (controls). `module-remove` already refuses a module with lessons.
 */
import { NextRequest } from "next/server";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { lessonsInOrder, readCourse } from "@/lib/course";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "course-last-lesson@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "courselastlesson", "Course Last Lesson", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_CourseLastLesson", true);
  await setSubscription(OWNER, { customerId: "cus_course_last", subscriptionId: "sub_course_last", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const call = async (body: Record<string, unknown>) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; product?: string } };
  };
  const makeCourse = async (title: string) => {
    const made = await addProduct(OWNER, title, "", "40");
    if (!made.ok) throw new Error("product not made");
    const id = made.product.id;
    if (!(await call({ action: "enable", id })).body.ok) throw new Error("course not enabled");
    const listing = await readListing((await storeForEmail(OWNER))!, id);
    if (!listing?.course) throw new Error("course not listed");
    return { id, courseId: listing.course.id };
  };
  const addLesson = async (id: string, courseId: string, title: string) => {
    const before = (await readCourse(courseId))!;
    const added = await call({ action: "edit", id, op: "lesson-add", moduleId: before.modules[0].id, title });
    if (!added.body.ok) throw new Error(`lesson not added: ${added.body.error}`);
    return lessonsInOrder((await readCourse(courseId))!).at(-1)!.lesson.id;
  };
  const lessons = async (courseId: string) => lessonsInOrder((await readCourse(courseId))!).length;

  part("The last lesson of a published course");
  const live = await makeCourse("The Sourdough Course");
  const first = await addLesson(live.id, live.courseId, "Starter");
  await setProductHidden(OWNER, live.id, false);
  const listed = await readListing((await storeForEmail(OWNER))!, live.id);
  is("published and handing over its lesson", [listed?.hidden, listed?.course?.lessons], [false, 1]);
  const refused = await call({ action: "edit", id: live.id, op: "lesson-remove", lessonId: first });
  is("refused, said why, named", [refused.status, refused.body.error, refused.body.product], [409, "last_delivery", "The Sourdough Course"]);
  is("the lesson is kept", await lessons(live.courseId), 1);

  part("Controls");
  const second = await addLesson(live.id, live.courseId, "Shaping");
  const notLast = await call({ action: "edit", id: live.id, op: "lesson-remove", lessonId: second });
  is("a lesson that is not the last still goes", [notLast.body.ok, await lessons(live.courseId)], [true, 1]);
  const draft = await makeCourse("The Draft Course");
  const only = await addLesson(draft.id, draft.courseId, "Intro");
  await setProductHidden(OWNER, draft.id, true);
  const fromDraft = await call({ action: "edit", id: draft.id, op: "lesson-remove", lessonId: only });
  is("a draft's last lesson still goes", [fromDraft.body.ok, await lessons(draft.courseId)], [true, 0]);

  done();
}

void main();
