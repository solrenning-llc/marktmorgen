import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { ITEM_ID_PATTERN, findLesson, isOpen, readCourse } from "@/lib/course";
import { courseAccess, emailKey, storeKey } from "@/lib/learn";
import { heldBack, passedQuizzes } from "@/lib/quiz";
import { limited, withinLimit } from "@/lib/request-guard";
import { readCourseListing } from "@/lib/catalog";
import { rateLesson, removeMyRating } from "@/lib/lesson-rating";
import { RATINGS_PER_DAY, RATINGS_PER_MINUTE, parseScore } from "@/lib/lesson-rating-rules";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";

/**
 * A student's quick rating of a lesson (296 [SQ7]), from the lesson page
 * itself: a plain form, no script needed. `action` is "rate" (with `score`
 * 1 to 5 and an optional `note`) or "remove". Rating takes a student of the
 * course, on a lesson open to them; removing takes only who they are signed
 * in as, on a pass that reaches this course, so a student whose access
 * ended, was refunded or is held back can still take back what they gave. The store's owner sees the ratings and
 * never gives or removes one. Every answer goes back to the lesson, with
 * `?r=` saying what happened.
 *
 * A rating is one of the store's buyer actions (lib/buyer-actions.ts), taken
 * before it is written and after its score is checked. Removing one's own
 * rating is not: it can only follow a rating that was. Both stay inside a
 * per-person limit.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let form: FormData;
  try {
    form = await (await limited(request, 4_000)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const field = (name: string, max: number) => String(form.get(name) ?? "").slice(0, max);
  const handle = normaliseHandle(field("handle", 60));
  const productId = field("product", 40);
  const lessonId = field("lesson", 20);
  const action = field("action", 10) || "rate";

  const store = handle ? await storeForHandle(handle) : null;
  const product = await readCourseListing(store, productId);
  if (!store || !product?.course) return new Response("Not found.", { status: 404 });
  const base = `${origin}/@${store.handle}/course/${product.id}`;
  const back = (notice: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${base}/${lessonId}${notice ? `?r=${notice}` : ""}#rating`, "Cache-Control": "no-store" },
    });

  const access = await courseAccess(store, product, request.cookies);
  const course = product.course.id;
  // Within the per-person limit, whatever is asked.
  const limitedFor = async (who: string) => {
    const person = `${storeKey(store)}:${who}`;
    const [minute, day] = await Promise.all([
      withinLimit("lesson-rating", person, RATINGS_PER_MINUTE, 60),
      withinLimit("lesson-rating-day", person, RATINGS_PER_DAY, 86_400),
    ]);
    return !minute || !day;
  };

  // Taking back one's own rating asks only who is signed in, for this course:
  // not that the lesson is still in it, open to them or not held back. Only
  // their own entry under this course is touched; one never given is nothing.
  if (action === "remove") {
    const learner = access.learner;
    if (!learner || !ITEM_ID_PATTERN.test(lessonId)) return new Response(null, { status: 303, headers: { Location: base } });
    // A pass opened for some courses only (a sign-in link, or an address typed at checkout) reaches only those: never
    // the rating its address gave in another course of the store. Access that ended is still the person's own course.
    if (learner.scope !== "all" && !learner.scope.includes(course)) return new Response(null, { status: 303, headers: { Location: base } });
    // The creator reads ratings; only students give or take them back.
    if (learner.owner) return back("");
    const who = emailKey(learner.email);
    if (await limitedFor(who)) return back("slow");
    const gone = await removeMyRating(course, lessonId, who, store).catch(() => null);
    return back(gone === null ? "unknown" : "removed");
  }
  if (action !== "rate") return back("");

  const kept = await readCourse(course);
  const found = kept ? findLesson(kept, lessonId) : null;
  if (!kept || !found || access.state !== "open" || !isOpen(kept, found.unit, access.start)) {
    return new Response(null, { status: 303, headers: { Location: base } });
  }
  // The creator reads ratings; only students give them.
  if (access.learner.owner) return back("");
  const who = emailKey(access.learner.email);
  const passed = await passedQuizzes(kept.id, who);
  if (heldBack(kept, passed).has(lessonId)) return new Response(null, { status: 303, headers: { Location: base } });
  if (await limitedFor(who)) return back("slow");

  // A score that is not one is said before anything is taken.
  const score = parseScore(form.get("score"));
  if (score === null) return back("score");
  if (!(await takeBuyerAction(store))) return restingAway(origin, store);
  try {
    const result = await rateLesson({ courseId: kept.id, lessonId, who, score, note: form.get("note"), room: store });
    return back(result.ok ? "saved" : result.reason);
  } catch (error) {
    // No room in the store's data room: nothing was written (lib/store-data.ts).
    if (error instanceof DataRoomError) return back("noroom");
    throw error;
  }
}
