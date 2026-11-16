/**
 * Removing a course also removes the comments that belonged to its lessons.
 * The product route covers a course with lessons; the course route covers an
 * empty course after its last lesson was removed.
 */
import { NextRequest } from "next/server";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { lessonsInOrder, readCourse } from "@/lib/course";
import { addComment, markSeen, setCommentsOn } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { emailKey } from "@/lib/learn";
import { readListing } from "@/lib/catalog";
import { dataKey } from "@/lib/store-data";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  ensureStoreId,
  setStripeAccount,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "course-removal-comments@example.com";

function commentKeys(courseId: string, lessonIds: string[]): string[] {
  return [
    `nl:lc:${courseId}:c`,
    `nl:lc:${courseId}:all`,
    `nl:lc:${courseId}:r`,
    `nl:lc:${courseId}:names`,
    `nl:lc:${courseId}:off`,
    `nl:lc:${courseId}:seen`,
    ...lessonIds.map((lessonId) => `nl:lc:${courseId}:l:${lessonId}`),
  ];
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "coursecommentcleanup", "Course Comment Cleanup", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_CourseCleanup", true);
  await setSubscription(OWNER, {
    customerId: "cus_course_comment_cleanup",
    subscriptionId: "sub_course_comment_cleanup",
    active: true,
    tier: "creator",
    period: paidPeriod(),
  });
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const courseCall = async (body: Record<string, unknown>) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const removeProduct = async (id: string) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "remove", id }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const makeCourse = async (title: string) => {
    const made = await addProduct(OWNER, title, "", "40");
    if (!made.ok) throw new Error("product not made");
    const id = made.product.id;
    const enabled = await courseCall({ action: "enable", id });
    if (!enabled.body.ok) throw new Error(`course not enabled: ${enabled.body.error}`);
    const listing = await readListing((await storeForEmail(OWNER))!, id);
    if (!listing?.course) throw new Error("course not listed");
    return { id, courseId: listing.course.id };
  };
  const addLesson = async (id: string, courseId: string, title: string) => {
    const before = await readCourse(courseId);
    if (!before) throw new Error("course not found");
    const response = await courseCall({ action: "edit", id, op: "lesson-add", moduleId: before.modules[0].id, title });
    if (!response.body.ok) throw new Error(`lesson not added: ${response.body.error}`);
    const after = await readCourse(courseId);
    const lesson = after && lessonsInOrder(after).at(-1)?.lesson;
    if (!lesson) throw new Error("lesson not found");
    return lesson.id;
  };
  const seedComments = async (courseId: string, lessonId: string) => {
    const parent = await addComment({ room: store, courseId, lessonId, by: emailKey("student@example.com"), name: "Student", text: "Please explain this step.", now: 100 });
    if (!parent.ok) throw new Error("parent comment not made");
    const reply = await addComment({ room: store, courseId, lessonId, by: CREATOR_AUTHOR, text: "Here is the explanation.", parent: parent.comment.id, now: 101 });
    if (!reply.ok) throw new Error("reply not made");
    await setCommentsOn(courseId, false);
    await markSeen(courseId, 102);
  };
  const roomSlot = (courseId: string) => Number(redis.run(["HGET", dataKey(store)!, `lc:${courseId}`]) ?? 0);
  const present = (keys: string[]) => keys.filter((key) => Number(redis.run(["EXISTS", key])) === 1);

  const original = redis.pipeline.bind(redis);
  for (const mode of ["healthy", "foreign"] as const) {
  const first = await makeCourse("Requested course");
  const one = await addLesson(first.id, first.courseId, "Requested lesson");
  await seedComments(first.courseId, one);
  const victim = await makeCourse("Other retained course");
  const two = await addLesson(victim.id, victim.courseId, "Other retained lesson");
  await seedComments(victim.courseId, two);
  const before = redis.run(["GET", `nl:course:${victim.courseId}`]);
  const held = commentKeys(victim.courseId, [two]);
  let injections = 0;
  let reads = 0;
  redis.pipeline = async commands => {
    if(commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:course:${first.courseId}`){ reads++; if(mode === "foreign" && reads === 2){injections++; return [before];} }
    return original(commands);
  };
  const removed = await removeProduct(first.id);
  redis.pipeline = original;
  is("the intended single course GET was injected once", injections, mode === "foreign" ? 1 : 0);
  is("a different valid course identity cannot authorize removal", [removed.status, removed.body.ok], mode === "foreign" ? [503, false] : [200, true]);
  is("the other course record remains byte-identical", redis.run(["GET", `nl:course:${victim.courseId}`]), before);
  is("the other actual comments remain stored", present(held), held);
  is("the other course retains its counted comment room", roomSlot(victim.courseId) > 0, true);
  is("the other product remains listed", Boolean(await readListing((await storeForEmail(OWNER))!, victim.id)), true);
  is("the rejected target remains listed", Boolean(await readListing((await storeForEmail(OWNER))!, first.id)), mode === "foreign");
  }
  done();
}
void main().catch(error=>{console.error(error);process.exit(1)});
