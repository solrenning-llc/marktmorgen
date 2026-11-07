import type { NextRequest } from "next/server";
import { readListing } from "@/lib/catalog";
import { studioRefusal } from "@/lib/person-tasks";
import { guardStoreWrite, text } from "@/lib/store-request";
import { type PayStudio, applyAccess, applyGive, readAccessAsk, readGiveAsk, reviewAccess, reviewGive } from "@/lib/student-bulk";
import { ACCESS_REFUSALS, GIVE_REFUSALS, type GiveRefusal, MAX_STUDENT_BODY_BYTES, givable } from "@/lib/student-bulk-rules";
import type { Store } from "@/lib/store";
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
 * taking one student off a course ("products"); the studio requests the review
 * and the change use are taken before anything about the students is read,
 * and those of the writes before the first write (lib/student-bulk.ts). It sends no email and
 * refunds nothing: refunds stay one at a time.
 *
 * Unit 2: `{ change: "give" | "takeback", to, emails }` gives another of the
 * store's courses (`to`, a product id that givable() accepts) with no payment,
 * or takes back one the studio gave, for whoever may say who owns what
 * ("import", as the API's gift), within the store's gifts of the day (the
 * API's count, GIVES_PER_DAY), the same review, `expect` and 409; the
 * studio requests its reads take are taken before it reads, on a review too,
 * and those its writes take before it writes (lib/student-bulk.ts, applyGive).
 */

/** Seconds this route may run (route segment config): up to 500 people, twenty writes at a time. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  // Giving a course, or taking one back, says who owns what: "import", as the API's gift (owner and admins).
  const guarded = await guardStoreWrite(request, (body) => (body.change === "give" || body.change === "takeback" ? "import" : "products"), MAX_STUDENT_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  if (body.action !== "review" && body.action !== "apply") return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  if (body.change === "give" || body.change === "takeback") return give(store, body);
  const read = readAccessAsk(body);
  if (!read.ok) return Response.json({ ok: false, error: read.error, message: ACCESS_REFUSALS[read.error] }, { status: 400 });
  try {
    const product = await readListing(store, text(body.id, 40));
    if (!product?.course) return Response.json({ ok: false, error: "product", message: ACCESS_REFUSALS.product }, { status: 404 });
    const courseId = product.course.id;
    const pay: PayStudio = async (units) => {
      const counted = await countStudio(store, null, units);
      return counted.ok ? { ok: true } : { ok: false, reason: counted.reason, message: counted.message };
    };
    const refusal = (reason: string, message: string) => {
      const refused = studioRefusal(reason, message);
      return Response.json(refused.body, { status: refused.status, headers: NO_STORE });
    };
    if (body.action === "review") {
      const reviewed = await reviewAccess(courseId, read.ask, pay);
      return reviewed.kind === "refused" ? refusal(reviewed.reason, reviewed.message) : Response.json({ ok: true, review: reviewed.review }, { headers: NO_STORE });
    }
    if (read.ask.expect === null) return Response.json({ ok: false, error: "expect", message: ACCESS_REFUSALS.expect }, { status: 400 });
    const applied = await applyAccess(store, courseId, read.ask, pay);
    if (applied.kind === "stale") {
      return Response.json(
        { ok: false, error: "changed", message: "Something changed since your review. Nothing was changed. Check the new count and confirm again.", review: applied.review },
        { status: 409, headers: NO_STORE },
      );
    }
    if (applied.kind === "refused") return refusal(applied.reason, applied.message);
    return Response.json({ ok: true, change: read.ask.change, ...applied.done }, { headers: NO_STORE });
  } catch (error) {
    console.error("changing students' access in bulk failed", error);
    return Response.json({ ok: false, error: "server_error", message: "That did not work. Review again to see what changed." }, { status: 500 });
  }
}

const payFor = (store: Store): PayStudio => async (units) => {
  const counted = await countStudio(store, null, units);
  return counted.ok ? ({ ok: true } as const) : { ok: false as const, reason: counted.reason, message: counted.message };
};

/** A refusal of the gift's own (GIVE_REFUSALS), or the studio's when its requests were not given. */
function refused(reason: string, message: string): Response {
  if (Object.hasOwn(GIVE_REFUSALS, reason)) {
    const own = reason as GiveRefusal;
    return Response.json({ ok: false, error: own, message: GIVE_REFUSALS[own] }, { status: own === "unavailable" ? 503 : own === "daily_limit" ? 429 : 409, headers: NO_STORE });
  }
  const studio = studioRefusal(reason, message);
  return Response.json(studio.body, { status: studio.status, headers: NO_STORE });
}

async function give(store: Store, body: Record<string, unknown>): Promise<Response> {
  const read = readGiveAsk(body);
  if (!read.ok) return Response.json({ ok: false, error: read.error, message: GIVE_REFUSALS[read.error] }, { status: 400 });
  const { ask } = read;
  try {
    const product = await readListing(store, ask.to);
    if (!product?.course || !givable(product)) return Response.json({ ok: false, error: "product", message: GIVE_REFUSALS.product }, { status: 404 });
    const target = { productId: product.id, courseId: product.course.id };
    if (body.action === "review") {
      const reviewed = await reviewGive(store, target, ask, payFor(store));
      return reviewed.kind === "review" ? Response.json({ ok: true, review: reviewed.review }, { headers: NO_STORE }) : refused(reviewed.reason, reviewed.message);
    }
    if (ask.expect === null) return Response.json({ ok: false, error: "expect", message: GIVE_REFUSALS.expect }, { status: 400 });
    const applied = await applyGive(store, target, ask, payFor(store));
    if (applied.kind === "stale") {
      return Response.json(
        { ok: false, error: "changed", message: "Something changed since your review. Nothing was changed. Check the new count and confirm again.", review: applied.review },
        { status: 409, headers: NO_STORE },
      );
    }
    if (applied.kind === "refused") return refused(applied.reason, applied.message);
    return Response.json({ ok: true, change: ask.change, ...applied.done }, { headers: NO_STORE });
  } catch (error) {
    console.error("giving a course in bulk failed", error);
    return Response.json({ ok: false, error: "server_error", message: "That did not work. Review again to see what changed." }, { status: 500 });
  }
}
