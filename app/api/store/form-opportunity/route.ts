import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { can } from "@/lib/team-roles";
import { readForm, readResponses } from "@/lib/form-store";
import { FORM_ID } from "@/lib/forms";
import { readPipelines, readStages } from "@/lib/crm";
import { PIPELINE_ACCESS_REFUSAL, accessOf, pipelineOfStage } from "@/lib/pipeline-access-rules";
import { readPipelineAccess } from "@/lib/pipeline-access";
import { MAX_DEAL_CENTS, MAX_DEAL_NOTE, MAX_DEAL_TITLE, parseDeal, readFollowUp } from "@/lib/crm-rules";
import { readTeam } from "@/lib/team";
import { StoreFullError } from "@/lib/store-full";
import { MAX_CONVERTIBLE_FORM_RESPONSES, createFormOpportunity, readFormOpportunity, formOpportunityRef } from "@/lib/form-opportunity";

/** Explicit reviewed conversion only; no marketing enrollment or messaging. */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders", 12_000);
  if (!guarded.ok) return guarded.response;
  const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  if (!can(guarded.role, "export")) return refuse("role", 403);
  const { store, body } = guarded;
  if (!store.statsId) return refuse("unavailable", 503);
  if (typeof body.form !== "string" || !FORM_ID.test(body.form) || typeof body.responseRef !== "string" || !/^[a-f0-9]{64}$/.test(body.responseRef)) return refuse("invalid");
  try {
    const stages = await readStages(store.statsId);
    const restricted = guarded.role !== "owner" && guarded.role !== "admin";
    // A deal already made from this response is shown only to someone who may see its pipeline (639 [GL7](7)),
    // whether it was there before (read here) or made by someone else a moment ago (createFormOpportunity).
    const hidden = async (stage: string) => {
      if (!restricted) return false;
      const pipeline = pipelineOfStage(await readPipelines(store.statsId), stage);
      return pipeline === null || accessOf(guarded.role, await readPipelineAccess(store.statsId, guarded.email), pipeline) === "none";
    };
    const noAccess = () => Response.json({ ok: false, error: "pipeline_access", message: PIPELINE_ACCESS_REFUSAL }, { status: 403 });
    const existing = await readFormOpportunity(store.statsId, body.responseRef, stages);
    if (existing) {
      if (await hidden(existing.stage)) return noAccess();
      return Response.json({ ok: true, state: "existing", deal: existing });
    }
    const form = await readForm(store.statsId, body.form);
    if (!form) return refuse("unknown", 404);
    const { responses } = await readResponses(store.statsId, form.id, MAX_CONVERTIBLE_FORM_RESPONSES);
    const response = responses.find(response => formOpportunityRef(store.statsId!, form.id, response) === body.responseRef);
    if (!response) return refuse("response_gone", 409);
    const raw = body.deal && typeof body.deal === "object" && !Array.isArray(body.deal) ? body.deal as Record<string, unknown> : {};
    if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > MAX_DEAL_TITLE) return refuse("title");
    if (typeof raw.note !== "string" || raw.note.length > MAX_DEAL_NOTE || typeof raw.email !== "string" || raw.email.length > 254 || (raw.email.trim() && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(raw.email.trim()))) return refuse("invalid");
    if (typeof raw.cents !== "number" || !Number.isSafeInteger(raw.cents) || raw.cents < 0 || raw.cents > MAX_DEAL_CENTS) return refuse("invalid");
    const follow = readFollowUp(raw);
    if (!follow.ok) return refuse(follow.error);
    if (!stages.some(stage => stage.id === raw.stage && stage.kind === "open")) return refuse("stage");
    // The pipeline the deal goes into must be theirs to change (639 [GL7](7)).
    if (guarded.role !== "owner" && guarded.role !== "admin") {
      const pipeline = pipelineOfStage(await readPipelines(store.statsId), String(raw.stage));
      if (pipeline === null || accessOf(guarded.role, await readPipelineAccess(store.statsId, guarded.email), pipeline) !== "edit") {
        return Response.json({ ok: false, error: "pipeline_access", message: PIPELINE_ACCESS_REFUSAL }, { status: 403 });
      }
    }
    if (follow.value.assignee) {
      const team = await readTeam(store.sid);
      if (follow.value.assignee !== store.email && !team.members.some(member => member.email === follow.value.assignee && can(member.role, "orders"))) return refuse("assignee");
    }
    const now = Math.floor(Date.now() / 1000);
    const deal = parseDeal({ ...raw, ...follow.value, id: body.responseRef.slice(0, 10), createdAt: now, updatedAt: now }, stages);
    if (!deal) return refuse("invalid");
    const result = await createFormOpportunity(store.statsId, body.responseRef, deal, stages, store);
    if (result.state === "full") return refuse("full");
    if (result.state === "existing" && (await hidden(result.deal.stage))) return noAccess();
    return Response.json({ ok: true, state: result.state, deal: result.deal });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full", message: error.message }, { status: 409 });
    console.error("Converting form response could not be confirmed", error);
    return refuse("conversion_unconfirmed", 502);
  }
}
