import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { lockedFor } from "@/lib/two-step";
import { lockRead } from "@/lib/two-step-unknown";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { findLesson, isOpen, readCourse } from "@/lib/course";
import { courseAccess, emailKey, storeKey } from "@/lib/learn";
import { heldBack, passedForGate } from "@/lib/quiz";
import { limited, withinLimit } from "@/lib/request-guard";
import { readCourseListing } from "@/lib/catalog";
import { addComment, commentsOn, deleteComment, readComment, setHidden } from "@/lib/lesson-comments";
import { COMMENTS_PER_DAY, COMMENTS_PER_MINUTE, COMMENT_ID_PATTERN, CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { tellCreator, tellStudent } from "@/lib/lesson-comment-notify";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";

/**
 * Comments under a lesson, from the lesson page itself: a plain form, no
 * script needed. `action` is "post" (with `text`, and `name` the first time,
 * and `parent` for an answer), "delete" (a student their own, the creator
 * any), or "hide" / "show" (the creator). Every answer goes back to the
 * lesson, with `?c=` saying what happened.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let form: FormData;
  try {
    form = await (await limited(request, 16_000)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const field = (name: string, max: number) => String(form.get(name) ?? "").slice(0, max);
  const handle = normaliseHandle(field("handle", 60));
  const productId = field("product", 40);
  const lessonId = field("lesson", 20);
  const action = field("action", 10) || "post";

  const store = handle ? await storeForHandle(handle) : null;
  const product = await readCourseListing(store, productId);
  if (!store || !product?.course) return new Response("Not found.", { status: 404 });
  const base = `${origin}/@${store.handle}/course/${product.id}`;
  const back = (notice: string, anchor = "comments") =>
    new Response(null, {
      status: 303,
      headers: { Location: `${base}/${lessonId}${notice ? `?c=${notice}` : ""}#${anchor}`, "Cache-Control": "no-store" },
    });

  const course = await readCourse(product.course.id);
  const found = course ? findLesson(course, lessonId) : null;
  const access = await courseAccess(store, product, request.cookies);
  if (!course || !found || access.state !== "open" || !isOpen(course, found.unit, access.start)) {
    return new Response(null, { status: 303, headers: { Location: base } });
  }
  const owner = access.learner.owner;
  const by = owner ? CREATOR_AUTHOR : emailKey(access.learner.email);
  if (!owner) {
    const passed = await passedForGate(course.id, by);
    if (heldBack(course, passed).has(lessonId)) return new Response(null, { status: 303, headers: { Location: base } });
  }
  if (!(await commentsOn(course.id))) return back("off");
  // The creator deleting a comment, from a session let in without its second step, waits (lib/two-step.ts).
  const lock = owner && action === "delete" ? await lockRead(lockedFor(request, "products", "cm-delete"), { back: `${base}/${lessonId}#comments`, to: "the lesson" }) : false;
  if (lock instanceof Response) return lock;
  if (lock) return back("locked");

  // Each act here is one of the store's buyer actions, or the creator's
  // studio requests (lib/buyer-actions.ts); a student deleting their own
  // comment is not: it can only follow one that was.
  if (!(action === "delete" && !owner) && !(await takeBuyerAction(store, owner ? "owner" : "buyer"))) return restingAway(origin, store);

  if (action === "delete" || action === "hide" || action === "show") {
    const id = field("id", 20);
    const comment = COMMENT_ID_PATTERN.test(id) ? await readComment(course.id, id) : null;
    if (!comment || comment.lesson !== lessonId) return back("gone");
    if (action === "delete") {
      if (!owner && comment.by !== by) return back("gone");
      await deleteComment(course.id, id, store);
      return back("deleted");
    }
    if (!owner) return back("gone");
    await setHidden(course.id, id, action === "hide");
    return back(action === "hide" ? "hidden" : "shown", `c-${id}`);
  }

  const who = `${storeKey(store)}:${by}`;
  if (!owner) {
    const [minute, day] = await Promise.all([
      withinLimit("lesson-comment", who, COMMENTS_PER_MINUTE, 60),
      withinLimit("lesson-comment-day", who, COMMENTS_PER_DAY, 86_400),
    ]);
    if (!minute || !day) return back("slow");
  }
  const parent = field("parent", 20);
  let result: Awaited<ReturnType<typeof addComment>>;
  try {
    result = await addComment({
      courseId: course.id,
      lessonId,
      by,
      text: form.get("text"),
      name: form.get("name"),
      parent: COMMENT_ID_PATTERN.test(parent) ? parent : null,
      room: store,
    });
  } catch (error) {
    // No room in the store's data room: nothing was written (lib/store-data.ts).
    if (error instanceof DataRoomError) return back("noroom");
    throw error;
  }
  if (!result.ok) return back(result.reason);

  await tellCreator(store, product, found.lesson.title, result.comment);
  if (result.parent) {
    await tellStudent({
      store,
      product,
      courseId: course.id,
      lessonTitle: found.lesson.title,
      parent: result.parent,
      reply: result.comment,
      origin,
    }).catch((error) => console.error("a comment answer email failed", error));
  }
  return back("posted", `c-${result.comment.id}`);
}
