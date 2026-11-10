import type { NextRequest } from "next/server";
import { jsonAccess } from "@/lib/studio-route";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readListingExactly } from "@/lib/catalog";
import { findLesson, readCourse } from "@/lib/course";
import { type Store, storeFolder, storeRef } from "@/lib/store";
import { takeAllowance } from "@/lib/store-allowance";
import { readSubmissionReply, readSubmissionSetup } from "@/lib/submission-rules";
import { SUBMISSION_LIST_UNITS, SUBMISSION_REPLY_UNITS, readSetupFor, replySubmission, reviewList, saveSetupFor } from "@/lib/submission-store";
import { DataRoomError } from "@/lib/store-data";
import { SUBMISSIONS_READY } from "@/lib/submission-switch";

const json = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const no = (error: string, status: number) => json({ ok: false, error }, status);

/** The creator's own course, found through their own store; null when it is not theirs or not there. */
async function courseOf(store: Store, productId: string): Promise<{ courseId: string; course: NonNullable<Awaited<ReturnType<typeof readCourse>>> } | null | "unknown"> {
  const product = await readListingExactly(store, productId);
  if (product === "unknown") return "unknown";
  if (!product?.course) return null;
  const course = await readCourse(product.course.id);
  return course ? { courseId: course.id, course } : null;
}

/** More studio requests, taken before a read that moves more than one request carries. */
async function takeMore(store: Store, units: number): Promise<Response | null> {
  if (units <= 0) return null;
  const taken = await takeAllowance(store, "studio", units);
  if (taken.ok) return null;
  return json({ ok: false, error: taken.reason === "used" ? "limit" : "unavailable", ...(taken.message ? { message: taken.message } : {}) }, taken.reason === "used" ? 429 : 503);
}

/**
 * The studio's side of buyers' files for review (750 [CD1] unit 4).
 *
 *   GET ?id=<product>&lessonId=<lesson>   what the lesson asks for, or null
 *   GET ?id=<product>&list=1[&before=n]   one page of the course's kept files, newest first
 *
 * Only for a role that may change products, on the store the studio page was
 * drawn for (jsonAccess, which takes one studio request before anything is
 * read). Anything that cannot be read is said as unknown, never as "none".
 * Answers "off" while SUBMISSIONS_READY is false.
 */
export async function GET(request: NextRequest) {
  if (!SUBMISSIONS_READY) return no("off", 404);
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const params = request.nextUrl.searchParams;
  try {
    const found = await courseOf(access.store, (params.get("id") ?? "").slice(0, 40));
    if (found === "unknown") return no("unavailable", 503);
    if (!found) return no("unknown", 404);
    if (params.get("list") === "1") {
      const refused = await takeMore(access.store, SUBMISSION_LIST_UNITS);
      if (refused) return refused;
      const before = Number(params.get("before"));
      const page = await reviewList(await storeFolder(storeRef(access.store)), found.courseId, Math.floor(Date.now() / 1000), params.has("before") && Number.isSafeInteger(before) ? before : undefined);
      return json({
        ok: true,
        next: page.next,
        rows: page.rows.map((row) => {
          const lesson = findLesson(found.course, row.lessonId);
          const title = lesson?.lesson.title ?? "A lesson removed since";
          if (row.submission === "unread") return { id: row.id, lessonId: row.lessonId, lessonTitle: title, unread: true };
          const s = row.submission;
          return { id: row.id, lessonId: row.lessonId, lessonTitle: title, buyer: s.buyer, file: s.file, note: s.note, at: s.at, keepUntil: s.keepUntil, state: s.state, reply: s.reply };
        }),
      });
    }
    const lessonId = (params.get("lessonId") ?? "").slice(0, 20);
    if (!findLesson(found.course, lessonId)) return no("unknown", 404);
    return json({ ok: true, setup: await readSetupFor(found.courseId, lessonId) });
  } catch (error) {
    // A reply out of shape, or a database that did not answer: unknown, never "nothing asked" or "nothing to review".
    console.error("the studio's submissions could not be read", error);
    return no("unavailable", 503);
  }
}

const SETUP_ERRORS = { instruction: "instruction", kinds: "kinds", size: "size", keep: "keep" } as const;

/**
 * Changes from the studio:
 *
 *   { action: "setup", id, lessonId, setup }        saves what the lesson asks for
 *   { action: "setup", id, lessonId, setup: null }  stops asking; answers the setup it had, for an undo
 *   { action: "reply", id, submission, text }       the creator's reply to one kept file, once
 *
 * Kept files are never deleted by a change here: stopping asking leaves what
 * buyers already sent, until its keeping time ends.
 */
export async function POST(request: NextRequest) {
  if (!SUBMISSIONS_READY) return no("off", 404);
  const guarded = await guardStoreWrite(request, "products", 24_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const action = text(body.action, 10);
  try {
    const found = await courseOf(store, text(body.id, 40));
    if (found === "unknown") return no("unavailable", 503);
    if (!found) return no("unknown", 404);

    if (action === "setup") {
      const lessonId = text(body.lessonId, 20);
      if (!findLesson(found.course, lessonId)) return no("unknown", 404);
      if (body.setup === null) {
        const was = await saveSetupFor(store, found.courseId, lessonId, null);
        return json({ ok: true, setup: null, was });
      }
      const read = readSubmissionSetup(body.setup);
      if (!read.ok) return no(SETUP_ERRORS[read.reason], 400);
      await saveSetupFor(store, found.courseId, lessonId, read.setup);
      return json({ ok: true, setup: read.setup });
    }

    if (action === "reply") {
      const read = readSubmissionReply({ text: body.text });
      if (!read.ok) return no(read.reason === "text" ? "reply" : "invalid", 400);
      const refused = await takeMore(store, SUBMISSION_REPLY_UNITS);
      if (refused) return refused;
      const done = await replySubmission(
        { data: store, folder: await storeFolder(storeRef(store)), courseId: found.courseId, id: text(body.submission, 40), reply: read.reply },
        Math.floor(Date.now() / 1000),
      );
      if (!done.ok) return no(done.reason === "state" ? "reviewed" : done.reason, done.reason === "gone" ? 404 : done.reason === "too_long" ? 400 : 409);
      return json({ ok: true, state: done.submission.state, reply: done.submission.reply });
    }
    return no("invalid", 400);
  } catch (error) {
    // Nothing is said saved or sent on an answer that could not be read.
    console.error("a studio submissions change failed", error);
    return error instanceof DataRoomError ? no("full", 409) : no("unavailable", 503);
  }
}
