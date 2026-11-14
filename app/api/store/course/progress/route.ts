import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { DATA_FULL_BUYER_WORDS } from "@/lib/store-data-rules";
import { cookies } from "next/headers";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { ITEM_ID_PATTERN, findLesson, isOpen, readCourse } from "@/lib/course";
import { courseAccess, emailKey, markLesson } from "@/lib/learn";
import { heldBack, passedForGate } from "@/lib/quiz";
import { limited } from "@/lib/request-guard";
import { readCourseListing } from "@/lib/catalog";
import { noteIfFinished } from "@/lib/course-finish";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";

/** "Mark as done", and on to the next lesson. A plain form, no script needed. */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let handle = "";
  let productId = "";
  let lessonId = "";
  let done = true;
  let next = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    productId = String(form.get("product") ?? "").slice(0, 40);
    lessonId = String(form.get("lesson") ?? "").slice(0, 20);
    done = form.get("done") !== "0";
    next = String(form.get("next") ?? "").slice(0, 20);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  const product = await readCourseListing(store, productId);
  if (!store || !product?.course) return new Response("Not found.", { status: 404 });
  const base = `${origin}/@${store.handle}/course/${product.id}`;

  const access = await courseAccess(store, product, await cookies());
  const course = await readCourse(product.course.id);
  const found = course ? findLesson(course, lessonId) : null;
  if (!course || access.state !== "open" || !found || !isOpen(course, found.unit, access.start)) {
    return new Response(null, { status: 303, headers: { Location: base } });
  }
  // A lesson marked done is one of the store's buyer actions (lib/buyer-actions.ts).
  if (!(await takeBuyerAction(store, access.learner.owner ? "owner" : "buyer"))) return restingAway(origin, store);
  if (!access.learner.owner) {
    // A lesson behind a quiz that must be passed, or one whose own quiz must
    // be passed first, is not marked done by a button.
    const passed = await passedForGate(product.course.id, emailKey(access.learner.email));
    if (course && heldBack(course, passed).has(lessonId)) {
      return new Response(null, { status: 303, headers: { Location: base } });
    }
    // A lesson with an assignment is done when the work is handed in, or
    // approved (lib/assignment.ts), and not by a button either way.
    if (found.lesson.task) {
      return new Response(null, { status: 303, headers: { Location: `${base}/${lessonId}#task`, "Cache-Control": "no-store" } });
    }
    if (done && found.lesson.quiz?.required && !passed.has(lessonId)) {
      return new Response(null, { status: 303, headers: { Location: `${base}/${lessonId}#quiz`, "Cache-Control": "no-store" } });
    }
    try {
      await markLesson(product.course.id, access.learner.email, lessonId, done, store);
    } catch (error) {
      // No room in the store's data room: the lesson stays as it was (lib/store-data.ts).
      if (error instanceof DataRoomError) return new Response(DATA_FULL_BUYER_WORDS, { status: 409, headers: { "Cache-Control": "no-store" } });
      throw error;
    }
    // The last lesson done starts what finishing the course starts (lib/course-finish.ts).
    if (done) await noteIfFinished(store, product.id, product.course.id, access.learner.email);
  }
  const target = done && ITEM_ID_PATTERN.test(next) ? next : lessonId;
  return new Response(null, { status: 303, headers: { Location: `${base}/${target}`, "Cache-Control": "no-store" } });
}
