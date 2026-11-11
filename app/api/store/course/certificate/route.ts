import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { DATA_FULL_BUYER_WORDS } from "@/lib/store-data-rules";
import { cookies } from "next/headers";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readCourse } from "@/lib/course";
import { courseAccess, doneLessons, emailKey, storeKey } from "@/lib/learn";
import { passedForGate } from "@/lib/quiz";
import { hasFinished, issueCertificate } from "@/lib/certificate";
import { limited } from "@/lib/request-guard";
import { readCourseListing } from "@/lib/catalog";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";
import { UnknownReplyError } from "@/lib/redis-reply";
import { coursesWords } from "@/lib/buyer-words/courses";

/**
 * "Get my certificate": issues a student's certificate of completion under
 * the name they typed, then opens it. Issued once per student and course;
 * pressing again opens the one already issued.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let handle = "";
  let productId = "";
  let name: unknown = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    productId = String(form.get("product") ?? "").slice(0, 40);
    name = String(form.get("name") ?? "").slice(0, 400);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  const product = await readCourseListing(store, productId);
  if (!store || !product?.course) return new Response("Not found.", { status: 404 });
  const base = `${origin}/@${store.handle}/course/${product.id}`;
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });

  const access = await courseAccess(store, product, await cookies());
  const course = await readCourse(product.course.id);
  if (access.state !== "open" || access.learner.owner || !course?.certificate) return away(base);
  // A certificate asked for is one of the store's buyer actions (lib/buyer-actions.ts).
  if (!(await takeBuyerAction(store))) return restingAway(origin, store);

  const who = emailKey(access.learner.email);
  let done: Set<string>;
  let passed: Set<string>;
  try {
    [done, passed] = await Promise.all([doneLessons(course.id, access.learner.email), passedForGate(course.id, who)]);
  } catch (error) {
    // Progress that could not be read is unknown, never "unfinished": said as it is, in the store's language (rule 24).
    if (error instanceof UnknownReplyError) return new Response(coursesWords(store.language).certProgressUnknown, { status: 503, headers: { "Cache-Control": "no-store" } });
    throw error;
  }
  if (!hasFinished(course, done, passed)) return away(`${base}?cert=unfinished#certificate`);

  let issued: Awaited<ReturnType<typeof issueCertificate>>;
  try {
    issued = await issueCertificate({
      store: storeKey(store),
      productId: product.id,
      course,
      title: product.title,
      creator: store.name,
      email: access.learner.email,
      who,
      name,
      room: store,
    });
  } catch (error) {
    // No room in the store's data room: no certificate was written (lib/store-data.ts).
    if (error instanceof DataRoomError) return new Response(DATA_FULL_BUYER_WORDS, { status: 409, headers: { "Cache-Control": "no-store" } });
    throw error;
  }
  if (!issued.ok) return away(`${base}?cert=name#certificate`);
  return away(`${origin}/@${store.handle}/certificate/${issued.certificate.id}${issued.fresh ? "?issued=1" : ""}`);
}
