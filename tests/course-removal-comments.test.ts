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
  setProductHidden,
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

  part("Removing a product with a course");
  const first = await makeCourse("Course removed with comments");
  const firstLesson = await addLesson(first.id, first.courseId, "A lesson with comments");
  await seedComments(first.courseId, firstLesson);
  const firstKeys = commentKeys(first.courseId, [firstLesson]);
  is("the course has every comment family and counted room before removal", [present(firstKeys).length, roomSlot(first.courseId) > 0], [firstKeys.length, true]);
  const original = redis.pipeline.bind(redis);
  let injections = 0;
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] === "DEL" && command[1] === `nl:lc:${first.courseId}:c`)) {
      injections += 1;
      return [];
    }
    return original(commands);
  };
  const failed = await removeProduct(first.id);
  redis.pipeline = original;
  is("product: an unknown comment deletion refuses removal", [failed.status, injections], [503, 1]);
  const removed = await removeProduct(first.id);
  is("the product removal succeeds", [removed.status, removed.body.ok], [200, true]);
  is("the removed course leaves no comment family or counted room", [present(firstKeys), roomSlot(first.courseId)], [[], 0]);

  part("Removing a product after its course record is already absent");
  const absent = await makeCourse("Course record already absent");
  const absentLesson = await addLesson(absent.id, absent.courseId, "A lesson whose course record is gone");
  await seedComments(absent.courseId, absentLesson);
  const absentKeys = commentKeys(absent.courseId, [absentLesson]);
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:course:${absent.courseId}`) {
      return [];
    }
    return original(commands);
  };
  const unreadableCourse = await removeProduct(absent.id);
  redis.pipeline = original;
  is(
    "an incomplete course read keeps the product for a later try",
    [unreadableCourse.status, Boolean(await readListing((await storeForEmail(OWNER))!, absent.id))],
    [503, true],
  );
  redis.run(["DEL", `nl:course:${absent.courseId}`]);
  const removedAbsent = await removeProduct(absent.id);
  is(
    "confirmed course absence does not leave the product impossible to remove",
    [removedAbsent.status, removedAbsent.body.ok],
    [200, true],
  );
  is(
    "the missing course's indexed lesson comments and counted room are removed",
    [present(absentKeys), roomSlot(absent.courseId)],
    [[], 0],
  );

  part("Disabling an empty course after its last lesson was removed");
  const second = await makeCourse("Course disabled after comments");
  const secondLesson = await addLesson(second.id, second.courseId, "Last lesson");
  await seedComments(second.courseId, secondLesson);
  // A course on the store keeps its last lesson (#3432, last_delivery): the creator unpublishes it first.
  await setProductHidden(OWNER, second.id, true);
  const lessonRemoved = await courseCall({ action: "edit", id: second.id, op: "lesson-remove", lessonId: secondLesson });
  is("the last lesson is removed first", [lessonRemoved.status, lessonRemoved.body.ok, lessonsInOrder((await readCourse(second.courseId))!).length], [200, true, 0]);
  const secondKeys = commentKeys(second.courseId, []);
  is("course-level comment records and room still exist until the course goes", [present(secondKeys).length > 0, roomSlot(second.courseId) > 0], [true, true]);
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] === "DEL" && command[1] === `nl:lc:${second.courseId}:c`)) return [];
    return original(commands);
  };
  const failedDisable = await courseCall({ action: "disable", id: second.id });
  redis.pipeline = original;
  is("course: an unknown comment deletion refuses disable", failedDisable.status, 503);
  const disabled = await courseCall({ action: "disable", id: second.id });
  is("the empty course is disabled", [disabled.status, disabled.body.ok], [200, true]);
  is("disabling leaves no course-level comment family or counted room", [present(secondKeys), roomSlot(second.courseId)], [[], 0]);

  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
