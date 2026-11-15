import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { withinEssentialLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { makeVoice } from "@/lib/customer-voice";
import { withCutoff } from "@/lib/fetch-timeout";

/**
 * The request ends before the reading's lock (LOCK_SECONDS, 120 s) runs out,
 * so a second reading can never start, and be charged as another AI job,
 * while this one still runs. The model's answer takes 45 s at most (lib/ai.ts).
 */
export const maxDuration = 60;
/** Kept before the platform's cut, for the answer to reach the creator. */
const CUT_MARGIN_MS = 2_000;

/**
 * This month's summary of what customers are saying (lib/customer-voice.ts):
 * the one already made, or made now, once a month, as one of the month's AI
 * jobs. For whoever may see the numbers. The per-minute AI counter must
 * confirm the request fits before any work: an answer it cannot read refuses
 * with 429, never lets the job through (CX-123 rule 24, Codex Z, 6e484fea).
 */
export async function POST(request: NextRequest) {
  // Every request inside is given up by then, and the summary is not counted
  // when too little of it is left for the model (makeVoice, "late").
  const cutoff = Date.now() + maxDuration * 1000 - CUT_MARGIN_MS;
  const guarded = await guardStoreWrite(request, "stats", 200);
  if (!guarded.ok) return guarded.response;
  const { store } = guarded;
  if (!(await withinEssentialLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return Response.json({ ok: false, error: "slow" }, { status: 429 });
  try {
    const done = await withCutoff(cutoff, () => makeVoice(store));
    // "unread": a list could not be read just now, so too few texts is not known to be few (rule 24); nothing was counted.
    if (!done.ok) return Response.json({ ok: false, error: done.reason, texts: done.texts ?? null, unread: done.unread ?? null }, { status: done.reason === "failed" ? 502 : done.reason === "busy" || done.reason === "changed" ? 409 : done.reason === "late" || done.reason === "unread" ? 503 : 400 });
    return Response.json({ ok: true, summary: done.summary, fresh: done.fresh, left: done.left });
  } catch {
    // A fixed label only (rule 30): the error of a model call made with customers' texts may carry them.
    console.error("summing up what customers say failed");
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
