import type { NextRequest } from "next/server";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { normaliseHandle, storeFolder, storeRef } from "@/lib/store";
import { storeForHandleExactly } from "@/lib/store-exact";
import { takeBuyerAction, takeBuyerRead } from "@/lib/buyer-actions";
import { readCourseListing } from "@/lib/catalog";
import { findLesson, isOpen, readCourse } from "@/lib/course";
import { courseAccess, emailKey } from "@/lib/learn";
import { costPauseCode, costStandingOf } from "@/lib/plan-standing";
import { checkSubmissionFile, maySubmit } from "@/lib/submission-rules";
import {
  abortSubmissionDoor,
  buyerSubmissionsFor,
  closeSubmissionDoor,
  liveCount,
  openSubmissionDoor,
  readSetupFor,
  signSubmissionDoor,
  withdrawSubmission,
} from "@/lib/submission-store";
import { PIECES_PER_ASK } from "@/lib/vault-rules";
import { SUBMISSIONS_READY } from "@/lib/submission-switch";

/** Uploads one buyer may open on a store in an hour: a few tries at the right file, never a file host. */
const SUBMISSION_OPENS_PER_HOUR = 10;
/** The largest body this door reads: the note at its longest, escaped, and the piece tags of the largest file. */
const BODY_BYTES = 64_000;

const no = (error: string, status = 400) => Response.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });
const yes = (body: Record<string, unknown>) => Response.json({ ok: true, ...body }, { headers: { "Cache-Control": "no-store" } });
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/**
 * The door a buyer's file for review goes through, from their browser
 * straight to the store's vault (750 [CD1] unit 2; lib/submission-store.ts):
 *
 *   { action: "open", handle, product, lesson, name, bytes, type }
 *   { action: "sign", handle, product, lesson, pathname, numbers }
 *   { action: "done", handle, product, lesson, pathname, etags, note }
 *   { action: "abort", handle, product, lesson, pathname }
 *   { action: "mine", handle, product, lesson }               the buyer's own files there (unit 5)
 *   { action: "withdraw", handle, product, lesson, id }       one of them withdrawn (unit 5)
 *
 * Refused from another site. The store is found by its address, then one of
 * its public requests is taken before anything else is read for the request.
 * Only the signed-in buyer of the course, with the lesson open to them, on a
 * lesson whose creator asked for submissions, may open (maySubmit); the file
 * is checked against what the creator asked before anything is spent
 * (checkSubmissionFile); then the buyer action, the month's upload allowance
 * and the plan's storage, in that order. Every later step is for an upload
 * this buyer opened on this lesson of this store, read from the door kept for
 * it, never from the request. Anything that could not be read is refused.
 * Listing and withdrawing are for the signed-in buyer's own files only, also
 * once their access has ended: the list pays its reads before it makes them
 * (mineUnits), and a withdrawal is one buyer action.
 *
 * Off while SUBMISSIONS_READY is false (lib/submission-switch.ts): the
 * trainers' page still says "Not yet".
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return no("forbidden", 403);
  // Off until the buyer's side of the lesson page and the notices work (lib/submission-switch.ts).
  if (!SUBMISSIONS_READY) return no("off", 404);
  let body: Record<string, unknown>;
  try {
    body = (await (await limited(request, BODY_BYTES)).json()) as Record<string, unknown>;
  } catch {
    return no("invalid");
  }
  if (!body || typeof body !== "object") return no("invalid");
  const action = text(body.action, 10);
  if (!["open", "sign", "done", "abort", "mine", "withdraw"].includes(action)) return no("invalid");

  try {
    const found = await storeForHandleExactly(normaliseHandle(text(body.handle, 80)));
    if (found === "unknown") return no("unavailable", 503);
    if (found === "none") return no("unknown", 404);
    const store = found;
    // One of the store's public requests, before anything else is read for this one.
    if (!(await takeBuyerRead(store))) return no("resting", 503);

    const product = await readCourseListing(store, text(body.product, 40));
    if (!product?.course) return no("unknown", 404);
    const course = await readCourse(product.course.id);
    const place = course ? findLesson(course, text(body.lesson, 20)) : null;
    if (!course || !place) return no("unknown", 404);
    const access = await courseAccess(store, product, request.cookies);
    const learner = access.learner;
    if (learner?.owner) return no("owner", 403);
    const folder = await storeFolder(storeRef(store));
    const who = learner ? emailKey(learner.email) : "";
    const where = { store, folder, courseId: course.id, lessonId: place.lesson.id, who };
    const now = Math.floor(Date.now() / 1000);

    // Giving an upload up is always let through for the buyer who opened it.
    if (action === "abort") {
      if (!who) return no("signed_out", 401);
      const given = await abortSubmissionDoor(where, text(body.pathname, 400));
      return given === "done" ? yes({}) : given === "unknown" ? no("unknown", 404) : no("files_unavailable", 503);
    }

    // The buyer's own files on the lesson, and withdrawing one: theirs alone, whatever their access is now (unit 5).
    if (action === "mine") {
      if (!who) return no("signed_out", 401);
      const listed = await buyerSubmissionsFor({ folder, who, courseId: course.id, lessonId: place.lesson.id }, now, (units) => takeBuyerRead(store, units));
      return listed.ok ? yes({ submissions: listed.rows }) : no("resting", 503);
    }
    if (action === "withdraw") {
      if (!who) return no("signed_out", 401);
      if (!(await takeBuyerAction(store))) return no("resting", 503);
      const withdrawn = await withdrawSubmission({ data: store, folder, who, courseId: course.id, lessonId: place.lesson.id, id: text(body.id, 40) }, now);
      if (!withdrawn.ok) {
        const status = { gone: 404, state: 409, expired: 409, full: 409, unavailable: 503 }[withdrawn.reason];
        return no(withdrawn.reason === "gone" ? "unknown" : withdrawn.reason === "unavailable" ? "files_unavailable" : withdrawn.reason, status);
      }
      return yes({ submission: { id: withdrawn.submission.id, state: withdrawn.submission.state }, deleted: withdrawn.deleted });
    }

    const setup = await readSetupFor(course.id, place.lesson.id);
    const lessonOpen = access.state === "open" && isOpen(course, place.unit, access.start);
    const decision = maySubmit({
      kind: "lesson",
      setup,
      signedIn: learner?.email ?? null,
      purchase: learner && lessonOpen ? { email: learner.email, state: "paid", paidCents: product.priceCents } : null,
      // The count gates opening only: a later step is for an upload whose place is already held (its door).
      // Read only once there is a signed-in buyer and a setup; before that maySubmit has already said no.
      waiting: action !== "open" ? 0 : who && setup ? await liveCount(folder, course.id, place.lesson.id, who, now) : "unknown",
      now,
    });
    if (!decision.ok) {
      const status = decision.reason === "unknown" ? 503 : decision.reason === "signed-out" ? 401 : decision.reason === "busy" ? 409 : 403;
      return no(decision.reason, status);
    }
    const asked = setup!;

    if (action === "open") {
      const file = checkSubmissionFile({
        limits: asked,
        declared: { bytes: body.bytes, type: body.type, name: body.name },
        standing: costStandingOf(store),
        tier: store.tier,
      });
      if (!file.ok) return no(file.reason, file.reason === "unknown" ? 503 : file.reason === "plan" ? 409 : 400);
      // Nothing new is stored while a renewal is unpaid or the plan disputed (232 [CA1] unit 4).
      const paused = costPauseCode(store);
      if (paused) return no(paused, 409);
      if (!(await withinLimit("submission-open", who, SUBMISSION_OPENS_PER_HOUR, 3_600))) return no("slow", 429);
      if (!(await takeBuyerAction(store))) return no("resting", 503);
      const opened = await openSubmissionDoor({ ...where, data: store, email: learner!.email, setup: asked, file, nowSeconds: now });
      if (!opened.ok) {
        const status = { busy: 409, full: 409, budget: 503, room: 409, pending: 409, off: 404, invalid: 400, unavailable: 503 }[opened.reason];
        return no(opened.reason === "budget" ? "upload_budget_unavailable" : opened.reason === "unavailable" ? "files_unavailable" : opened.reason, status);
      }
      return yes({ upload: opened.upload });
    }

    const pathname = text(body.pathname, 400);
    if (action === "sign") {
      const numbers = Array.isArray(body.numbers) ? body.numbers.filter((n): n is number => Number.isInteger(n)) : [];
      if (!numbers.length || numbers.length > PIECES_PER_ASK || numbers.length !== (body.numbers as unknown[]).length) return no("invalid");
      const signed = await signSubmissionDoor(where, pathname, numbers);
      return signed.ok ? yes({ pieces: signed.pieces }) : signed.reason === "budget" ? no("upload_budget_unavailable", 503) : no("unknown", 404);
    }

    // done: the record is one of the store's buyer actions.
    const etags = Array.isArray(body.etags) ? body.etags.filter((e): e is string => typeof e === "string") : [];
    if (!(await takeBuyerAction(store))) return no("resting", 503);
    const closed = await closeSubmissionDoor({ ...where, data: store, note: body.note }, pathname, etags, now);
    if (!closed.ok) {
      const status = { unknown: 404, invalid: 400, unavailable: 503, off: 404, note: 400, full: 409 }[closed.reason];
      return no(closed.reason === "unavailable" ? "files_unavailable" : closed.reason, status);
    }
    const { id, file, at, keepUntil, state } = closed.submission;
    return yes({ submission: { id, file, at, keepUntil, state } });
  } catch (error) {
    // Redis or the vault answered out of shape, or could not be reached: nothing is said done.
    console.error("a buyer's submission door failed", error);
    return no("unavailable", 503);
  }
}
