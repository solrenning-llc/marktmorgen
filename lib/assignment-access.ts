/**
 * Who may hand in work on a lesson's assignment: a student the lesson is
 * open for, as the lesson page decides it (lib/learn.ts, courseAccess), and
 * not held shut behind a quiz or another assignment (lib/quiz.ts, heldBack).
 * The creator looking at their own course reads the work in the studio and
 * hands nothing in. One check for every door that takes or gives back work.
 */
import { type Course, type CourseModule, type Lesson, findLesson, isOpen, readCourse } from "@/lib/course";
import { courseAccess, emailKey } from "@/lib/learn";
import { heldBack, passedForGate } from "@/lib/quiz";
import { readCourseListing } from "@/lib/catalog";
import { readTaskFor } from "@/lib/assignment";
import type { Task } from "@/lib/assignment-rules";
import { type Listing, type Store, normaliseHandle, storeForHandle } from "@/lib/store";

type CookieJar = { get(name: string): { value: string } | undefined };

export type OnTask =
  | { ok: true; store: Store; product: Listing; course: Course; lesson: Lesson; unit: CourseModule; task: Task; who: string; email: string }
  | { ok: false; reason: "unknown" | "closed" | "owner" | "held" };

export async function studentOnTask(handle: unknown, productId: unknown, lessonId: unknown, cookies: CookieJar): Promise<OnTask> {
  const store = typeof handle === "string" && handle ? await storeForHandle(normaliseHandle(handle)) : null;
  const product = await readCourseListing(store, typeof productId === "string" ? productId.slice(0, 40) : "");
  if (!store || !product?.course) return { ok: false, reason: "unknown" };
  const course = await readCourse(product.course.id);
  const found = course ? findLesson(course, typeof lessonId === "string" ? lessonId.slice(0, 20) : "") : null;
  if (!course || !found?.lesson.task) return { ok: false, reason: "unknown" };
  const access = await courseAccess(store, product, cookies);
  if (access.state !== "open" || !isOpen(course, found.unit, access.start)) return { ok: false, reason: "closed" };
  if (access.learner.owner) return { ok: false, reason: "owner" };
  const who = emailKey(access.learner.email);
  if (heldBack(course, await passedForGate(course.id, who)).has(found.lesson.id)) return { ok: false, reason: "held" };
  const task = await readTaskFor(course.id, found.lesson.id);
  if (!task) return { ok: false, reason: "unknown" };
  return { ok: true, store, product, course, lesson: found.lesson, unit: found.unit, task, who, email: access.learner.email };
}
