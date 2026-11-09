import { windowId } from "@/lib/allowance-window";
import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { DATA_FULL_BUYER_WORDS } from "@/lib/store-data-rules";
import { cookies } from "next/headers";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { findLesson, isOpen, readCourse } from "@/lib/course";
import { courseAccess, emailKey, markLesson } from "@/lib/learn";
import { MAX_QUESTIONS, heldBack, passedForGate, readAnswers, readQuizFor, submitQuiz } from "@/lib/quiz";
import { clientAddress, limited, withinLimit } from "@/lib/request-guard";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";
import { QUIZ_TRIES_PER_CONNECTION_MINUTE, QUIZ_TRIES_PER_STUDENT_HOUR } from "@/lib/quiz-usage-rules";
import { readCourseListing } from "@/lib/catalog";
import { noteIfFinished } from "@/lib/course-finish";

/**
 * "Check my answers": marks one try at a lesson's quiz and goes back to the
 * lesson with the result. A plain form, so it works without scripts.
 *
 * Only a student the lesson is open for can answer, and the creator looking
 * at their own course is shown the answers instead of being marked. Passing
 * marks the lesson done, which is what the course's progress and its
 * certificate count.
 *
 * A try is limited per connection before the student's access is read, and
 * per student before it takes one of the store's buyer actions
 * (lib/buyer-actions.ts); a stranger without access spends none of them.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let form: FormData;
  try {
    form = await (await limited(request, 8_000)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const handle = normaliseHandle(String(form.get("handle") ?? ""));
  const productId = String(form.get("product") ?? "").slice(0, 40);
  const lessonId = String(form.get("lesson") ?? "").slice(0, 20);
  const store = handle ? await storeForHandle(handle) : null;
  const product = await readCourseListing(store, productId);
  if (!store || !product?.course) return new Response("Not found.", { status: 404 });
  const base = `${origin}/@${store.handle}/course/${product.id}`;
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
  // Nothing was counted; the answer says how long to wait before sending it again.
  const slow = (wait: string, seconds: number) => new Response(`Too many quiz answers were sent. Nothing was counted. Please wait ${wait} and send your answers again.`, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(seconds) } });
  if (!(await withinLimit("quiz-connection", `${store.sid}|${clientAddress(request)}`, QUIZ_TRIES_PER_CONNECTION_MINUTE, 60))) return slow("one minute", 60);

  const access = await courseAccess(store, product, await cookies());
  const course = await readCourse(product.course.id);
  const found = course ? findLesson(course, lessonId) : null;
  if (access.state !== "open" || !course || !found || !isOpen(course, found.unit, access.start)) return away(base);
  if (access.learner.owner) return away(`${base}/${lessonId}#quiz`);

  const who = emailKey(access.learner.email);
  if (!(await withinLimit("quiz-student", `${store.sid}|${who}`, QUIZ_TRIES_PER_STUDENT_HOUR, 3_600))) return slow("one hour", 3_600);
  // A try is one of the store's buyer actions, taken before anything of the quiz is read or written.
  if (!(await takeBuyerAction(store))) return restingAway(origin, store);
  // A lesson a required quiz still holds shut cannot be answered from here either.
  if (heldBack(course, await passedForGate(course.id, who)).has(lessonId)) return away(base);
  const quiz = await readQuizFor(course.id, lessonId);
  if (!quiz || !found.lesson.quiz) return away(`${base}/${lessonId}`);

  let result: Awaited<ReturnType<typeof submitQuiz>>;
  try {
    // The question ids the page showed, so a try drawn from a bank is marked on those (lib/quiz.ts).
    const shown = String(form.get("shown") ?? "").split(",").filter(Boolean).slice(0, MAX_QUESTIONS);
    result = await submitQuiz(course.id, lessonId, who, quiz, readAnswers(quiz, form), store.sid, windowId(store), store, shown);
  } catch (error) {
    // No room in the store's data room: the try was not counted (lib/store-data.ts).
    if (error instanceof DataRoomError) return new Response(DATA_FULL_BUYER_WORDS, { status: 409, headers: { "Cache-Control": "no-store" } });
    throw error;
  }
  if (!result.ok && result.reason === "usage_limit") return new Response("This store has reached its monthly quiz submission allowance. It resets at the start of the next UTC month.", { status: 429, headers: { "Cache-Control": "no-store" } });
  if (!result.ok && result.reason === "unavailable") return new Response("Quiz submissions are temporarily unavailable. Please try again later.", { status: 503, headers: { "Cache-Control": "no-store" } });
  // Too soon after the last try, or questions that are no longer this try's:
  // nothing was counted, and the lesson says why.
  if (!result.ok && result.reason === "wait") return away(`${base}/${lessonId}#quiz`);
  if (!result.ok && result.reason === "stale") return away(`${base}/${lessonId}?quiz=stale#quiz`);
  if (result.ok && result.grade.passed) {
    await markLesson(course.id, access.learner.email, lessonId, true, store, true);
    await noteIfFinished(store, product.id, course.id, access.learner.email);
  }
  return away(`${base}/${lessonId}?quiz=marked#quiz`);
}
