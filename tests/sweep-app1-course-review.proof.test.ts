/**
 * Sweep app1 proof (CX-123 rule 24), synthetic only. The creator approving a student's work,
 * app/api/store/course/route.ts:196-200:
 *   const to = await studentEmail(courseId, who);
 *   const result = await review({ ..., email: to ?? "", verdict, ... });
 *   if (verdict === "approved" && to) await noteIfFinished(...);
 * studentEmail (lib/learn.ts:761-764) answers null for an HGET lost or in another shape. The approval is then
 * written with no address: lib/assignment.ts:324-327 (finish) marks the task passed but skips markLesson, so the
 * lesson is not marked done for the student; the course's finish (certificate, finish email) is not noted; the
 * student is not told; and because the work is now approved and closed, the creator cannot approve it again to
 * repair it (409 "reviewed").
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { doneLessons, emailKey, recordEnrollment, touchStudent } from "@/lib/learn";
import { handIn, saveTask, submissionOf } from "@/lib/assignment";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
let lose = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (lose && commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).endsWith(":students")) return ["QUEUED"];
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "reviewer@example.com";
  await claimHandle(owner, "reviewshop", "Review School", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_reviewshop1", subscriptionId: "sub_reviewshop1", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Writing course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "Opening" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  const lessonId = course.modules[0].lessons[0].id;
  const withTask = editCourse(course, { op: "task", lessonId, task: { review: true, gate: false, file: false } });
  if (!withTask.ok) throw new Error("no task");
  course = withTask.course;
  await setProductCourse(owner, made.product.id, { id: course.id, lessons: 1 });
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  const task = { prompt: "Write your opening paragraph.", review: true, gate: false, file: false };
  await saveTask(course.id, lessonId, task, store);
  const session = await openSession(owner);
  const approve = async (who: string) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "review", id: made.product.id, lessonId, who, verdict: "approved", feedback: "" }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; told?: boolean } };
  };
  const student = async (email: string) => {
    const now = Math.floor(Date.now() / 1000) - 60;
    await recordEnrollment(store, email, made.product.id, now);
    await touchStudent(course.id, email, now, store);
    await handIn({ courseId: course.id, lessonId, who: emailKey(email), email, task, text: "My first go.", file: null, data: store });
    return emailKey(email);
  };

  part("Healthy control: approved, the lesson is marked done for the student");
  const ana = await student("ana@example.com");
  const okay = await approve(ana);
  is("ok", [okay.status, okay.body.ok], [200, true]);
  is("the lesson is done for Ana", (await doneLessons(course.id, "ana@example.com")).has(lessonId), true);

  part("DEFECT: the student's address read answers in another shape");
  const ben = await student("ben@example.com");
  lose = true;
  const approved = await approve(ben);
  lose = false;
  is("DEFECT: the creator is told it is approved", [approved.status, approved.body.ok], [200, true]);
  is("DEFECT: the work is approved", (await submissionOf(course.id, lessonId, ben))?.state, "approved");
  is("DEFECT: but the lesson is not marked done for Ben, nor is he told", [(await doneLessons(course.id, "ben@example.com")).has(lessonId), approved.body.told], [false, false]);
  const again = await approve(ben);
  is("DEFECT: and approving again to repair it is refused", [again.status, again.body.error], [409, "reviewed"]);
  is("DEFECT: still not done", (await doneLessons(course.id, "ben@example.com")).has(lessonId), false);
  done();
}
main();
