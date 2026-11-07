import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readCourse } from "@/lib/course";
import { courseAccess, doneLessons, emailKey, storeKey } from "@/lib/learn";
import { passedQuizzes } from "@/lib/quiz";
import { hasFinished } from "@/lib/certificate";
import { limited, withinLimit } from "@/lib/request-guard";
import { readCourseListing } from "@/lib/catalog";
import { answerSurvey, removeMyAnswer } from "@/lib/course-survey";
import { SURVEYS_PER_DAY, SURVEYS_PER_MINUTE } from "@/lib/course-survey-rules";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";

/**
 * A student's answer to the survey when they finish a course (285 [SX1]),
 * from the course's own page: a plain form, no script needed. `action` is
 * "answer" (with `score` 0 to 10 and an optional `note`) or "remove". Only a
 * student of the course, and an answer only once they finished it (every
 * lesson done, every quiz that has to be passed passed: lib/certificate.ts
 * hasFinished); the store's owner reads the answers and never gives one.
 * Every answer goes back to the course page, with `?sv=` saying what
 * happened.
 *
 * An answer is one of the store's buyer actions (lib/buyer-actions.ts),
 * taken before the student's progress is read and before anything is
 * written. Removing one's own answer is not: it can only follow an answer
 * that was, and a student can always take back what they gave. Both stay
 * inside a per-person limit.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let form: FormData;
  try {
    form = await (await limited(request, 6_000)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const field = (name: string, max: number) => String(form.get(name) ?? "").slice(0, max);
  const handle = normaliseHandle(field("handle", 60));
  const productId = field("product", 40);
  const action = field("action", 10) || "answer";

  const store = handle ? await storeForHandle(handle) : null;
  const product = await readCourseListing(store, productId);
  if (!store || !product?.course) return new Response("Not found.", { status: 404 });
  const base = `${origin}/@${store.handle}/course/${product.id}`;
  const back = (notice: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${base}${notice ? `?sv=${notice}` : ""}#survey`, "Cache-Control": "no-store" },
    });

  const course = await readCourse(product.course.id);
  const access = await courseAccess(store, product, request.cookies);
  if (!course || access.state !== "open") return new Response(null, { status: 303, headers: { Location: base } });
  // The creator reads the answers; only students give them.
  if (access.learner.owner) return back("");
  const who = emailKey(access.learner.email);

  const person = `${storeKey(store)}:${who}`;
  const [minute, day] = await Promise.all([
    withinLimit("course-survey", person, SURVEYS_PER_MINUTE, 60),
    withinLimit("course-survey-day", person, SURVEYS_PER_DAY, 86_400),
  ]);
  if (!minute || !day) return back("slow");

  if (action === "remove") {
    const gone = await removeMyAnswer(course.id, who, store).catch(() => null);
    return back(gone === null ? "unknown" : "removed");
  }
  if (action !== "answer") return back("");

  if (!(await takeBuyerAction(store))) return restingAway(origin, store);
  const [done, passed] = await Promise.all([doneLessons(course.id, access.learner.email), passedQuizzes(course.id, who)]);
  if (!hasFinished(course, done, passed)) return back("unfinished");
  try {
    const result = await answerSurvey({ courseId: course.id, who, score: form.get("score"), note: form.get("note"), room: store });
    return back(result.ok ? "saved" : result.reason);
  } catch (error) {
    // No room in the store's data room: nothing was written (lib/store-data.ts).
    if (error instanceof DataRoomError) return back("noroom");
    throw error;
  }
}
