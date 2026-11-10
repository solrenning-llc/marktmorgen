import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";
import { normaliseHandle } from "@/lib/store";
import { COURSE_ID_PATTERN } from "@/lib/course";
import { NEXT_STEP_NO_SECONDS, nextStepCookie } from "@/lib/course-next-step";

/** A product id as a course's address carries it (lib/catalog.ts ids). */
const PRODUCT_ID = /^[a-z0-9]{6,40}$/;

/**
 * A student's "No thanks" to a course's "Next step" (560 [AS1]): kept in their
 * browser by a cookie this answer sets, `nl_ns_<course>` holding only "1", for
 * NEXT_STEP_NO_SECONDS (a year), HttpOnly, and sent only to the store's course
 * pages (Path=/@<handle>/course/). Set by the server, not by script, so a
 * browser that caps cookies written by script (Safari keeps those 7 days) keeps
 * it the year the privacy policy says (review of #3530, MEDIUM).
 *
 * Nothing is read or written on our side: the handle and the course are only
 * checked for their shape, so the answer costs one call and no database
 * command, and a wrong one sets nothing a page reads. A plain form, no script
 * needed: without one the answer goes back to the course's page.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let course = "";
  let product = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? "")).slice(0, 40);
    course = String(form.get("course") ?? "").slice(0, 40);
    product = String(form.get("product") ?? "").slice(0, 40);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!HANDLE_PATTERN.test(handle) || !COURSE_ID_PATTERN.test(course) || !PRODUCT_ID.test(product)) return new Response("Bad request", { status: 400 });
  const secure = originFrom(request).startsWith("https:") ? "; Secure" : "";
  const cookie = `${nextStepCookie(course)}=1; Path=/@${handle}/course/; Max-Age=${NEXT_STEP_NO_SECONDS}; SameSite=Lax; HttpOnly${secure}`;
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  if (wantsJson) return new Response(null, { status: 204, headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
  return new Response(null, { status: 303, headers: { "Set-Cookie": cookie, Location: `${originFrom(request)}/@${handle}/course/${product}`, "Cache-Control": "no-store" } });
}
