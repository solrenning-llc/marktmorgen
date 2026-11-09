import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinEssentialLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import { countStudio } from "@/lib/studio-route";
import { FUNNEL_EXPLAIN_JOBS, FUNNEL_EXPLAIN_READ_UNITS, explainFunnelIssue } from "@/lib/funnel-explain";
import { readFunnelChecks, readIssue, sameIssue } from "@/lib/funnel-review-issues";
import { FUNNEL_ID } from "@/lib/page-funnel";

/**
 * An AI explanation of one check a saved page funnel fails (26 [E9], lib/funnel-explain.ts):
 * `{ funnel, issue }`, where `issue` is the check as the studio drew it. The funnel's
 * checks are worked out again here (lib/funnel-review-issues.ts) and the
 * explanation is asked only when this one is still among them, word for word:
 * the check is the code's, never the browser's, and the answer never changes it.
 * Who may ask is who may edit pages, as for an AI funnel draft. Nothing is saved.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", 4_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  const funnelId = text(body.funnel, 40);
  const issue = readIssue(body.issue);
  if (!FUNNEL_ID.test(funnelId) || !issue) return fail("invalid");
  if (!(await withinEssentialLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return fail("slow", 429);
  // Off (Store, a trial, an unpaid renewal) or nothing left: refused before any funnel is read.
  if (!aiAvailableFor(store)) return fail("off");
  const left = await aiLeft(store).catch(() => null);
  if (left === null) return fail("off");
  if (left < FUNNEL_EXPLAIN_JOBS) return fail("used");
  // Reading the funnel again costs what drawing the funnels page does: the rest of a page's studio requests, taken first.
  const taken = await countStudio(store, null, FUNNEL_EXPLAIN_READ_UNITS);
  if (!taken.ok) return Response.json({ ok: false, error: "studio", message: taken.message }, { status: 429 });
  const read = await readFunnelChecks(taken.store ?? store, funnelId);
  if (!read.ok) return fail(read.reason, read.reason === "gone" ? 404 : 503);
  if (!read.checks.issues.some((found) => sameIssue(found, issue))) return fail("stale", 409);
  const done = await explainFunnelIssue(taken.store ?? store, issue, read.checks.funnel.name, read.checks.steps);
  if (!done.ok) return fail(done.reason, done.reason === "failed" ? 502 : 400);
  return Response.json({ ok: true, value: done.value, left: done.left });
}
