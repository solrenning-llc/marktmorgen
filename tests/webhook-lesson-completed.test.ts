/**
 * The webhook event course.lesson_completed (378 [TB4] complement WG (a)):
 * sent when a student finishes a lesson, from lib/course-finish.ts
 * noteIfFinished, which every place a lesson becomes done already calls (the
 * button, a quiz passed, work handed in or approved). What is checked, with
 * synthetic stores and courses:
 *
 *   - one message per student and lesson, with the lesson, the product and how
 *     far they are; the same lesson again, or undone and done again, nothing
 *     more;
 *   - a lesson not read as done, or not in the course, sends nothing;
 *   - the last lesson sends both the lesson's and the course's events;
 *   - the four routes pass the lesson they marked done.
 */
import { readFileSync } from "node:fs";
import { noteIfFinished } from "@/lib/course-finish";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { markLesson } from "@/lib/learn";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });
console.error = () => {};

type Lesson = { email: string; product: { id: string; title: string }; lesson: { id: string; title: string }; lessons_done: number; lessons: number; completed_at: string };

async function main(): Promise<void> {
  redis.clear();
  const owner = "lesson-hook@example.com";
  await claimHandle(owner, "lessonhook", "Lesson Hook", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_LessonHook01", subscriptionId: "sub_LessonHook01", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Sourdough at Home", "A synthetic course", "49", null);
  if (!made.ok) throw new Error("no product");
  const base = emptyCourse();
  const one = editCourse(base, { op: "lesson-add", moduleId: base.modules[0].id, title: "Starter" });
  if (!one.ok) throw new Error("no lesson");
  const two = editCourse(one.course, { op: "lesson-add", moduleId: base.modules[0].id, title: "Bake" });
  if (!two.ok) throw new Error("no lesson");
  const course = two.course;
  const [first, second] = course.modules[0].lessons.map((l) => l.id);
  await saveCourse(course, ROOM);
  if (!(await setProductCourse(owner, made.product.id, { id: course.id, lessons: 2 })).ok) throw new Error("not linked");
  let store = (await storeForEmail(owner))!;
  if (!(await addEndpoint(store, "https://hooks.example.com/lessons", ["course.lesson_completed", "course.completed"])).ok) throw new Error("no endpoint");
  store = (await storeForEmail(owner))!;
  const email = "ada@example.com";
  const lessonsSent = async () => (await recentMessages(store, "course.lesson_completed", 10)).map((m) => m.data as Lesson);

  part("An event a store can listen for, in the studio's list");
  is("course.lesson_completed is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("course.lesson_completed"), true);
  is("the studio lists it", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "course.lesson_completed", label: "Lesson completed"'), true);

  part("A lesson not done, or not in the course, sends nothing");
  await noteIfFinished(store, made.product.id, course.id, email, first);
  is("a lesson not read as done", (await lessonsSent()).length, 0);
  await markLesson(course.id, email, first, true, ROOM);
  await noteIfFinished(store, made.product.id, course.id, email, "l_not_here");
  is("a lesson the course does not have", (await lessonsSent()).length, 0);

  part("One message per lesson, once");
  is("the first lesson: not finished", await noteIfFinished(store, made.product.id, course.id, email, first), false);
  let sent = await lessonsSent();
  is("one message, with the lesson, the product and how far", [sent.length, sent[0]?.email, sent[0]?.lesson, sent[0]?.product, sent[0]?.lessons_done, sent[0]?.lessons], [1, email, { id: first, title: "Starter" }, { id: made.product.id, title: "Sourdough at Home" }, 1, 2]);
  await noteIfFinished(store, made.product.id, course.id, email, first);
  await markLesson(course.id, email, first, false, ROOM);
  await markLesson(course.id, email, first, true, ROOM);
  await noteIfFinished(store, made.product.id, course.id, email, first);
  is("the same lesson again, or undone and done again: nothing more", (await lessonsSent()).length, 1);
  is("without a lesson named, as before: no lesson event", [await noteIfFinished(store, made.product.id, course.id, email), (await lessonsSent()).length], [false, 1]);

  part("The last lesson: the lesson's and the course's");
  await markLesson(course.id, email, second, true, ROOM);
  is("finished", await noteIfFinished(store, made.product.id, course.id, email, second), true);
  sent = await lessonsSent();
  is("the second lesson's message, two of two", [sent.length, sent.find((m) => m.lesson.id === second)?.lessons_done], [2, 2]);
  is("and the course's", (await recentMessages(store, "course.completed", 10)).length, 1);

  part("The four routes pass the lesson they marked done");
  for (const [file, arg] of [
    ["app/api/store/course/progress/route.ts", "lessonId"],
    ["app/api/store/course/quiz/route.ts", "lessonId"],
    ["app/api/store/course/task/route.ts", "lesson.id"],
    ["app/api/store/course/route.ts", "found.lesson.id"],
  ] as const) {
    const calls = readFileSync(file, "utf8").match(/noteIfFinished\([^)]*\)/g) ?? [];
    is(`${file}: every call names the lesson`, calls.length > 0 && calls.every((c) => c.endsWith(`, ${arg})`)), true);
  }

  done();
}

void main();
