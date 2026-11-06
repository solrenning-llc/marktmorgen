import type { NextRequest } from "next/server";
import { readListing } from "@/lib/catalog";
import { studioRefusal } from "@/lib/person-tasks";
import { guardStoreWrite, text } from "@/lib/store-request";
import { applyAccess, readAccessAsk, reviewAccess } from "@/lib/student-bulk";
import { ACCESS_REFUSALS, MAX_STUDENT_BODY_BYTES } from "@/lib/student-bulk-rules";
import { countStudio } from "@/lib/studio-route";

/**
 * Access to a course taken away from many students at once, or given back
 * (279 [H3-4], unit 1). POST `{ action: "review", id, change: "revoke" |
 * "grant", emails }` says what it would do and writes nothing; `{ action:
 * "apply", ..., expect }` does it only when it would change exactly `expect`
 * people now (the count the creator confirmed): otherwise 409 with what it
 * would do now, nothing written. The answer names, person by person, who
 * changed, who was already so, who is not a student, whose access could not be
 * read (never changed by guess), whose change could not be confirmed and whose
 * did not land. The undo is the opposite change for `changed`. `id` is the
 * product's, found through the creator's own store. The same permission as
 * taking one student off a course ("products"); the studio requests it uses
 * are taken before it writes (lib/student-bulk.ts). It sends no email and
 * refunds nothing: refunds stay one at a time.
 */

/** Seconds this route may run (route segment config): up to 500 people, twenty writes at a time. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", MAX_STUDENT_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  if (body.action !== "review" && body.action !== "apply") return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const read = readAccessAsk(body);
  if (!read.ok) return Response.json({ ok: false, error: read.error, message: ACCESS_REFUSALS[read.error] }, { status: 400 });
  try {
    const product = await readListing(store, text(body.id, 40));
    if (!product?.course) return Response.json({ ok: false, error: "product", message: ACCESS_REFUSALS.product }, { status: 404 });
    const courseId = product.course.id;
    if (body.action === "review") return Response.json({ ok: true, review: await reviewAccess(courseId, read.ask) }, { headers: NO_STORE });
    if (read.ask.expect === null) return Response.json({ ok: false, error: "expect", message: ACCESS_REFUSALS.expect }, { status: 400 });
    const applied = await applyAccess(store, courseId, read.ask, async (units) => {
      const counted = await countStudio(store, null, units);
      return counted.ok ? { ok: true } : { ok: false, reason: counted.reason, message: counted.message };
    });
    if (applied.kind === "stale") {
      return Response.json(
        { ok: false, error: "changed", message: "Something changed since your review. Nothing was changed. Check the new count and confirm again.", review: applied.review },
        { status: 409, headers: NO_STORE },
      );
    }
    if (applied.kind === "refused") {
      const refused = studioRefusal(applied.reason, applied.message);
      return Response.json(refused.body, { status: refused.status, headers: NO_STORE });
    }
    return Response.json({ ok: true, change: read.ask.change, ...applied.done }, { headers: NO_STORE });
  } catch (error) {
    console.error("changing students' access in bulk failed", error);
    return Response.json({ ok: false, error: "server_error", message: "That did not work. Review again to see what changed." }, { status: 500 });
  }
}
