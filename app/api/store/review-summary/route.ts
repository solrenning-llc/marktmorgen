import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { withinLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { makeReviewSummary } from "@/lib/review-ai-summary";

/**
 * A product's AI summary of its reviews (lib/review-ai-summary.ts, 636
 * [GL4](d)): `{ product }` gives the one made this week, or makes it now, at
 * most once a week, as one of the month's AI jobs. For whoever may answer
 * reviews ("reviews"). Nothing is shown to buyers by it yet.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "reviews", 200);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const product = typeof body.product === "string" ? body.product : "";
  if (!(await withinLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return Response.json({ ok: false, error: "slow" }, { status: 429 });
  try {
    const done = await makeReviewSummary(store, product);
    if (!done.ok) return Response.json({ ok: false, error: done.reason, reviews: done.reviews ?? null, next: done.next ?? null }, { status: done.reason === "failed" || done.reason === "empty" ? 502 : done.reason === "busy" ? 409 : done.reason === "week" ? 429 : 400 });
    return Response.json({ ok: true, summary: done.summary, fresh: done.fresh, left: done.left });
  } catch (error) {
    console.error("summing up a product's reviews failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
