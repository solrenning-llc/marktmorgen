import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinEssentialLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE, MAX_HELP_QUESTION } from "@/lib/ai-rules";
import { HELP_NOT_COVERED, answerHelp } from "@/lib/ai";
import { looksForeign, pickHelp } from "@/lib/help-ask";

/**
 * The studio's help assistant (lib/help-ask.ts): `{ question }`. Anybody on
 * the store's team may ask. A question in English that no help answer shares
 * a word with is answered here, without asking the model or counting a job.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "member", 2_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const question = text(body.question, MAX_HELP_QUESTION).trim();
  if (question.length < 3) return Response.json({ ok: false, error: "notes" }, { status: 400 });
  if (!(await withinEssentialLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return Response.json({ ok: false, error: "slow" }, { status: 429 });
  // A question in English that no answer shares a word with is answered here, at no cost;
  // one in another language is put into English first, inside the one job (lib/ai.ts).
  const foreign = looksForeign(question);
  if (!foreign && pickHelp(question).length === 0) {
    return Response.json({ ok: true, value: { answer: HELP_NOT_COVERED, sources: [] }, left: null });
  }
  const done = await answerHelp(store, question, (q) => pickHelp(q), { translate: foreign });
  if (!done.ok) return Response.json({ ok: false, error: done.reason }, { status: done.reason === "failed" ? 502 : 400 });
  return Response.json({ ok: true, value: done.value, left: done.left });
}
