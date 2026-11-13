import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { countStudio } from "@/lib/studio-route";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { can } from "@/lib/team-roles";
import { StoreFullError } from "@/lib/store";
import { COPY_ID } from "@/lib/store-copy-rules";
import { copyStep, ownTarget, previewCopy } from "@/lib/store-copy";

const refuse = (error: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ ok: false, error, ...extra }, { status, headers: { "Cache-Control": "private, no-store" } });

/**
 * Copying the whole store the studio is on into another store of the same
 * account (lib/store-copy-rules.ts says what comes across and what never does):
 *
 *   { action: "preview", to, setup }        what the copy would make there, what it leaves out, whether it fits; nothing written
 *   { action: "step", to, copy, setup }     one step of the copy whose id is `copy`; call it again until `done`
 *
 * Only the account's owner, from one of its stores into another of them.
 * Every request is one of the other store's studio requests, and each step
 * is charged more of them, at what it may send, before it writes anything.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", 4_000);
  if (!guarded.ok) return guarded.response;
  const { store, body, role, email } = guarded;
  if (!can(role, "products")) return refuse("forbidden", 403);
  const target = await ownTarget(email, store, role, body.to);
  if (!target.ok) return refuse(target.error, target.status);
  // A request into that store is one of its own studio requests (lib/store-allowance-rules.ts).
  // A funded period's copy into that store needs its paid cohort first (resourceAllocations).
  if (target.store.period?.funded === true && !(await reservePaidResourceWindow(target.store))) return refuse("target_used", 429, { message: "This can't be counted right now. Try again in a minute." });
  const counted = await countStudio(target.store, "page");
  if (!counted.ok) return refuse("target_used", 429, { message: counted.message });
  const to = counted.store ?? target.store;
  const setup = body.setup === true;
  const action = text(body.action, 10);
  try {
    if (action === "preview") {
      const plan = await previewCopy(store, to, setup);
      return Response.json({ ok: true, fits: plan.ok, lines: plan.lines, needs: plan.needs, to: { sid: to.sid, name: to.name || `@${to.handle}` } }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (action === "step") {
      const copyId = text(body.copy, 40);
      if (!COPY_ID.test(copyId)) return refuse("copy_id");
      const step = await copyStep(store, to, copyId, setup);
      if (!step.ok) return refuse(step.error, step.error === "busy" ? 409 : step.error === "studio_used" ? 429 : step.error === "unavailable" ? 503 : 409, { message: step.message, lines: step.lines ?? [] });
      return Response.json({ ...step, to: { sid: to.sid, name: to.name || `@${to.handle}` } }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return refuse("invalid");
  } catch (error) {
    if (error instanceof StoreFullError) return refuse("full", 409, { message: `${to.name || `@${to.handle}`} has no data room left for this. Nothing more was copied; what was copied stays as drafts, and the same copy goes on from there once there is room.` });
    console.error("copying a store failed", error);
    return refuse("server_error", 500, { message: "That could not be done right now. Try the same copy again in a minute: nothing is made twice." });
  }
}
