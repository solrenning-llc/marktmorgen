import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { MAX_CAPTION_BYTES } from "@/lib/captions";
import { readKind } from "@/lib/catalog";
import { ITEM_ID_PATTERN, findLesson, readCourses } from "@/lib/course";
import { storeFolder, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { dropCaption, isStreamConfigured } from "@/lib/stream";
import { addStoreCaption } from "@/lib/store-caption";
import { readStreamPath } from "@/lib/stream-rules";
import { autoQuote, requestAutoCaptions } from "@/lib/auto-captions";
import { heldRefusal } from "@/lib/child-safety";

/** Changes to captions one store may make in an hour: a long course, in several languages, in one sitting. */
const CHANGES_PER_HOUR = 600;

/** What a refusal is answered with. */
const STATUS: Record<string, number> = { off: 404, unknown: 404, unavailable: 503 };

/**
 * Captions for a lesson's video (lib/captions.ts, lib/stream.ts).
 *
 * `{ action: "add", lessonId, lang, text }` gives the lesson's video
 * captions in one language from the words of a .vtt or .srt file, read in
 * the studio's browser and sent as text. `{ action: "remove", lessonId,
 * lang }` takes them away. Either answers the languages the video has
 * captions in afterward. `{ action: "quote", lessonId }` answers the video's
 * length as captions written by AI are charged for it, and `{ action:
 * "auto", lessonId, spoken, also }` charges for them and has them written
 * (lib/auto-captions.ts).
 *
 * Asked for only what a signed-in creator may do: the lesson has to be one
 * of this store's own, and its video one the video service keeps for this
 * store. Which video is never taken from the request: it is read from the
 * lesson.
 */
export async function POST(request: NextRequest) {
  // The file's own ceiling, as JSON writes it at worst, and room for the rest.
  // Captions written by AI are charged to the plan's card at once, so asking
  // for them takes the right to spend on the plan; the rest is product work.
  const guarded = await guardStoreWrite(request, (body) => (body.action === "auto" ? "billing" : "products"), MAX_CAPTION_BYTES * 2 + 4_000);
  if (!guarded.ok) return guarded.response;
  if (!isStreamConfigured()) return Response.json({ ok: false, error: "off" }, { status: 404 });
  const { ref, body } = guarded;

  const action = text(body.action, 10);
  const lessonId = text(body.lessonId, 20);
  const lang = text(body.lang, 10);
  if (action !== "add" && action !== "remove" && action !== "auto" && action !== "quote") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  if (!ITEM_ID_PATTERN.test(lessonId)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });

  try {
    const store = await storeForEmail(ref);
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
    const courseProducts = (await readKind(store, "course")).flatMap((p) => (p.course ? [{ product: p.id, course: p.course.id }] : []));
    const courses = await readCourses(courseProducts.map((entry) => entry.course));
    const hit = [...courses.values()].map((course) => ({ course, found: findLesson(course, lessonId) })).find((entry) => entry.found !== null);
    const found = hit?.found ?? null;
    const pathname = found?.lesson.video?.pathname ?? "";
    const folder = await storeFolder(ref);
    if (readStreamPath(pathname)?.folder !== folder) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    // A lesson of a course held for a child-safety report (lib/child-safety.ts) keeps its captions as they are,
    // and its video is sent to nobody to be captioned. A hold that cannot be read is not a yes.
    const owner = courseProducts.find((entry) => entry.course === hit?.course.id)?.product ?? "";
    const held = await heldRefusal(store, owner);
    if (held) return held;
    const refused = await withinServiceWhy("stream-captions", folder, CHANGES_PER_HOUR, 3600, store);
    if (refused) return serviceRefusedJson(refused, "slow_down");

    if (action === "quote") {
      const quote = await autoQuote(pathname);
      return quote ? Response.json({ ok: true, ...quote }, { headers: { "Cache-Control": "no-store" } }) : Response.json({ ok: false, error: "caption_not_ready" }, { status: 400 });
    }
    if (action === "auto") {
      const also = Array.isArray(body.also) ? body.also.slice(0, 5).map((code: unknown) => text(code, 10)) : [];
      const asked = await requestAutoCaptions(store, pathname, text(body.spoken, 10), also);
      if (!asked.ok) return Response.json({ ok: false, error: asked.reason === "off" ? "off" : `auto_${asked.reason}` }, { status: asked.reason === "off" ? 404 : 400 });
      return Response.json({ ok: true, writing: asked.writing, cents: asked.cents }, { headers: { "Cache-Control": "no-store" } });
    }
    const answer = action === "add" ? await addStoreCaption(store, pathname, lang, body.text) : await dropCaption(pathname, lang);
    if (!answer.ok) {
      const error = answer.reason === "unavailable" ? "video_unavailable" : `caption_${answer.reason}`;
      return Response.json({ ok: false, error: answer.reason === "off" ? "off" : error }, { status: STATUS[answer.reason] ?? 400 });
    }
    return Response.json({ ok: true, captions: answer.captions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("changing a lesson video's captions failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
