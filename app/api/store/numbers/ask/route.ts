import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { readNumbers } from "@/lib/stats-report";
import { MAX_QUESTION, askNumbers } from "@/lib/numbers-ask";
import { countUnits } from "@/lib/person-agenda-read";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";

/**
 * A question about the store's numbers (lib/numbers-ask.ts): `{ question }`.
 * For whoever may see the numbers; answered from exactly what the Numbers
 * panel shows, and one of the month's AI jobs. Reading those numbers is
 * counted as the studio page that shows them is, before they are read.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "stats", 2_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const question = text(body.question, MAX_QUESTION).trim();
  if (question.length < 3) return Response.json({ ok: false, error: "notes" }, { status: 400 });
  if (!(await withinLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return Response.json({ ok: false, error: "slow" }, { status: 429 });
  // The numbers are read from Stripe again, as the studio's home page draws them, which counts STUDIO_PAGE_UNITS:
  // the rest of those are counted before they are read, besides the one this request already took.
  const counted = await countUnits(store, STUDIO_PAGE_UNITS - 1).catch(() => null);
  if (!counted?.ok) return Response.json({ ok: false, error: "studio_used", message: counted && !counted.ok ? counted.message : "" }, { status: 429 });
  const data = await readNumbers(store).catch(() => null);
  if (!data) return Response.json({ ok: false, error: "numbers" }, { status: 503 });
  const done = await askNumbers(store, question, data);
  if (!done.ok) return Response.json({ ok: false, error: done.reason }, { status: done.reason === "failed" ? 502 : 400 });
  return Response.json({ ok: true, value: done.value, left: done.left });
}
