import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { withinLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { makeVoice } from "@/lib/customer-voice";

/**
 * The request ends before the reading's lock (LOCK_SECONDS, 120 s) runs out,
 * so a second reading can never start, and be charged as another AI job,
 * while this one still runs. The model's answer takes 45 s at most (lib/ai.ts).
 */
export const maxDuration = 60;

/**
 * This month's summary of what customers are saying (lib/customer-voice.ts):
 * the one already made, or made now, once a month, as one of the month's AI
 * jobs. For whoever may see the numbers.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "stats", 200);
  if (!guarded.ok) return guarded.response;
  const { store } = guarded;
  if (!(await withinLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return Response.json({ ok: false, error: "slow" }, { status: 429 });
  try {
    const done = await makeVoice(store);
    if (!done.ok) return Response.json({ ok: false, error: done.reason, texts: done.texts ?? null }, { status: done.reason === "failed" ? 502 : done.reason === "busy" || done.reason === "changed" ? 409 : 400 });
    return Response.json({ ok: true, summary: done.summary, fresh: done.fresh, left: done.left });
  } catch (error) {
    console.error("summing up what customers say failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
