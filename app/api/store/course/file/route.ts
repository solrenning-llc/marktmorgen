import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { findLesson, isOpen, readCourse } from "@/lib/course";
import { courseAccess, emailKey } from "@/lib/learn";
import { heldBack, passedForGate } from "@/lib/quiz";
import { plain, serveFile } from "@/lib/serve-file";
import { readCourseListing } from "@/lib/catalog";
import { coursesWords } from "@/lib/buyer-words/courses";
import { takePublicRequest } from "@/lib/traffic";
import { speech } from "@/lib/buyer-words";
import { SESSION_COOKIE } from "@/lib/auth";
import { seesDrafts } from "@/lib/draft-view";

/**
 * A lesson's download: a worksheet, the slides. Handed over only to someone
 * the lesson is open for, the same check the lesson page makes.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const store = await storeForHandle(normaliseHandle(q.get("h") ?? ""));
  const product = await readCourseListing(store, q.get("p"));
  if (!store || !product?.course) return plain(404, "Not found.");
  // A draft's lessons, its free preview included, hand out nothing to whoever
  // only knows its id: only to its students and the store's owner and team,
  // signed in (MM-SA-30). Anyone else gets what an id that does not exist gets.
  if (product.hidden) {
    const jar = await cookies();
    if ((await courseAccess(store, product, jar)).state !== "open" && !(await seesDrafts(store, jar.get(SESSION_COOKIE)?.value))) return plain(404, "Not found.");
  }
  const course = await readCourse(product.course.id);
  const found = course ? findLesson(course, q.get("l") ?? "") : null;
  const index = Number(q.get("i"));
  const file = found && Number.isInteger(index) ? found.lesson.files[index] : undefined;
  if (!found || !file) return plain(404, "Not found.");

  if (!found.lesson.preview) {
    // Said to the student in the store's language (lib/buyer-words/courses.ts).
    const w = coursesWords(store.language);
    const access = await courseAccess(store, product, await cookies());
    if (!course || access.state !== "open" || !isOpen(course, found.unit, access.start)) {
      return plain(403, w.notOpenForYou);
    }
    if (!access.learner.owner && course) {
      const passed = await passedForGate(course.id, emailKey(access.learner.email));
      const blocker = heldBack(course, passed).get(found.lesson.id);
      if (blocker) {
        // Held by a quiz to pass, or by work to hand in (lib/assignment-rules.ts).
        return plain(403, findLesson(course, blocker)?.lesson.task ? `${w.opensOnTask}.` : w.opensOnPassFile);
      }
    }
  }
  // One of the store's public requests: on the buyers' side, or the public's for a lesson anyone may preview (lib/buyer-actions.ts).
  if (!(await takePublicRequest(store, found.lesson.preview ? "public" : "buyer"))) return plain(503, speech(store).w.restingTitle);
  return serveFile(file);
}
