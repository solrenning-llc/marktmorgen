import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinEssentialLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { can } from "@/lib/team-roles";
import { NEXT_ACTION_NEEDS } from "@/lib/next-actions-rules";
import { isDraftable } from "@/lib/next-action-draft-rules";
import { writeNextActionDraft } from "@/lib/next-action-draft";

/**
 * An email draft for one "Do this next" action, written with AI when the creator asks (484 [IT1] complement WG,
 * unit 3; lib/next-action-draft.ts): `{ action: "failed_payments" }`. For whoever may write drafts and may see the
 * action itself (its numbers, lib/next-actions-rules.ts NEXT_ACTION_NEEDS). Paced with the rest of the writing help
 * (AI_PER_MINUTE, the same counter), and taken from the store's own month of AI uses with its dollar ceiling reserved
 * before the call. Nothing is saved and nothing is sent: the draft comes back for the creator to change and send.
 */
const headers = { "Cache-Control": "private, no-store" };
const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status, headers });

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "draft", 1_000);
  if (!guarded.ok) return guarded.response;
  const { store, role, body } = guarded;
  const action = text(body.action, 40);
  if (!isDraftable(action)) return fail("action");
  if (!NEXT_ACTION_NEEDS[action].every((permission) => can(role, permission))) return fail("forbidden", 403);
  if (!(await withinEssentialLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return fail("slow", 429);
  const done = await writeNextActionDraft(store, action);
  if (!done.ok) return fail(done.reason, done.reason === "failed" ? 502 : done.reason === "unknown" ? 503 : done.reason === "gone" ? 409 : 400);
  return Response.json({ ok: true, value: done.value, left: done.left }, { headers });
}
