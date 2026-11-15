import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store-full";
import { guardStoreWrite } from "@/lib/store-request";
import { refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";
import { lockRead } from "@/lib/two-step-unknown";
import { ensureStatsId } from "@/lib/store";
import { type Deal, DEAL_ID, FIRST_PIPELINE_ID, newCrmId, pipelineLimit, readFollowUp, parseDeal, parseFields, parseStages } from "@/lib/crm-rules";
import { type AccessMap, PIPELINE_ACCESS_REFUSAL, accessOf, pipelineOfStage, visiblePipelines } from "@/lib/pipeline-access-rules";
import { readPipelineAccess } from "@/lib/pipeline-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dealEnteredStage } from "@/lib/deal-stage-trigger";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { CrmFieldsKept, CrmSchemaConflict, CrmValueWriteUnconfirmed, CrmSchemaReadUnavailable, CrmSchemaWriteUnconfirmed, savePipelineChange, CrmDealReadUnavailable, CrmDealWriteUnconfirmed, dealVersion, dropDeal, readDeal, readDealExact, readFields, readPipelines, readStages, setValue, writeDeal, writeDealOver, writeFields, writeStages } from "@/lib/crm";

/** Ten fields of ten choices, a pipeline with its stages and moves, or a deal with its note, as JSON. */
const MAX_BODY_BYTES = 20_000;

/**
 * A store's own fields about each person and its deals (lib/crm-rules.ts),
 * for whoever may read orders with buyers' addresses ("orders"):
 *
 *   { action: "fields", fields }               saves the fields; a field taken away takes its answers
 *                                              (not from a session let in without its second step)
 *   { action: "value", person, field, value }   one person's answer to one field; "" clears it
 *   { action: "stages", stages }               saves the first pipeline's stages (older studio pages)
 *   { action: "pipeline", pipeline, moves }     saves one pipeline, or adds one with a new id;
 *                                              `moves` names where each removed stage's deals go
 *   { action: "unpipeline", id, moveTo }        removes a pipeline; its deals go to the stage `moveTo`
 *   { action: "deal", deal }                    saves a deal, new without an id; a deal that enters
 *                                              a stage starts the workflow that stage starts
 *   { action: "deal", version, deal: { id, … } } changes a deal: only the fields sent, and only over
 *                                              the record whose version (dealVersion) the board read;
 *                                              otherwise 409 crm_conflict with the deal as it is now
 *   { action: "undeal", id }                    removes one
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.ref);
    if (!store?.statsId) return refuse("unavailable", 503);
    const statsId = store.statsId;
    // Which pipelines this person may change (639 [GL7](7)): the owner and Admins every one, a teammate as the store set.
    const restricted = guarded.role !== "owner" && guarded.role !== "admin";
    // A reply in an unknown shape is never taken for no restriction: nothing is changed (lib/pipeline-access.ts).
    let access: AccessMap | null = {};
    try {
      if (restricted) access = await readPipelineAccess(statsId, guarded.email);
    } catch (error) {
      if (error instanceof UnknownReplyError) return refuse("unavailable", 503);
      throw error;
    }
    const mayEdit = (pipelineId: string | null) => pipelineId !== null && accessOf(guarded.role, access, pipelineId) === "edit";
    const noAccess = () => Response.json({ ok: false, error: "pipeline_access", message: PIPELINE_ACCESS_REFUSAL }, { status: 403 });

    if (body.action === "fields") {
      const sent = Array.isArray(body.fields) ? body.fields : [];
      const fields = parseFields(sent);
      if (fields.length !== Math.min(sent.length, 10) || sent.length > 10) return refuse("fields");
      // A field left out takes its answers off every person: a session let in without its
      // second step keeps every field (lib/two-step.ts), checked against the fields as written.
      const keepAll = await lockRead(lockedFor(request, "orders", "fields-remove"));
      if (keepAll instanceof Response) return keepAll;
      return Response.json({ ok: true, fields: await writeFields(statsId, fields, keepAll) });
    }
    if (body.action === "value") {
      const field = (await readFields(statsId)).find((f) => f.id === body.field);
      if (!field) return refuse("unknown", 404);
      const ok = await setValue(statsId, typeof body.person === "string" ? body.person : "", field, body.value, store);
      return ok ? Response.json({ ok: true }) : refuse("value");
    }
    if (body.action === "stages") {
      if (!mayEdit(FIRST_PIPELINE_ID)) return noAccess();
      const stages = parseStages(body.stages);
      if (!stages) return refuse("stages");
      return Response.json({ ok: true, stages: await writeStages(statsId, stages, store) });
    }
    if (body.action === "pipeline" || body.action === "unpipeline") {
      const removing = body.action === "unpipeline";
      const id = typeof body.id === "string" ? body.id : "";
      const moveTo = typeof body.moveTo === "string" ? body.moveTo : "";
      // Removing a pipeline sends every deal in it to the one stage the creator chose.
      const moves = removing ? moveTo : body.moves;
      if (restricted) {
        const pipelines = await readPipelines(statsId);
        const sent = body.pipeline && typeof body.pipeline === "object" ? (body.pipeline as { id?: unknown }).id : undefined;
        const changing = removing ? id : typeof sent === "string" && pipelines.some((p) => p.id === sent) ? sent : null;
        // A new pipeline is anyone's to add; one that exists, and where a removed one's deals go, need edit.
        if (changing !== null && !mayEdit(changing)) return noAccess();
        // An empty pipeline is removed with no destination; a destination, when there is one, must be theirs to change.
        if (removing && moveTo !== "" && !mayEdit(pipelineOfStage(pipelines, moveTo))) return noAccess();
        // Deals of a removed stage may be sent to another pipeline's stage: that one must be theirs to change too.
        // Moves may be one stage for every removed stage (a string) or one per stage (an object): every target is checked.
        const sentMoves = body.moves;
        const targets = removing ? [] : typeof sentMoves === "string" ? [sentMoves] : sentMoves && typeof sentMoves === "object" ? Object.values(sentMoves as Record<string, unknown>).filter((v): v is string => typeof v === "string") : [];
        const sentStages = body.pipeline && typeof body.pipeline === "object" && Array.isArray((body.pipeline as { stages?: unknown }).stages) ? ((body.pipeline as { stages: { id?: unknown }[] }).stages.map((st) => st?.id).filter((v): v is string => typeof v === "string")) : [];
        if (targets.some((stage) => !sentStages.includes(stage) && !mayEdit(pipelineOfStage(pipelines, stage)))) return noAccess();
      }
      const result = await savePipelineChange(statsId, removing ? { remove: id } : { pipeline: body.pipeline }, moves, pipelineLimit(store), store);
      // Someone restricted gets back only the pipelines they may see, never the names and stages of the others.
      const shown = restricted ? visiblePipelines(result.ok ? result.pipelines : [], guarded.role, access).map((p) => ({ id: p.id, name: p.name, stages: p.stages })) : result.ok ? result.pipelines : [];
      return result.ok ? Response.json({ ok: true, pipelines: shown, moved: Object.keys(result.moves).length }) : refuse(result.error, result.error === "unknown" ? 404 : 400);
    }
    const stages = await readStages(statsId);
    if (body.action === "deal") {
      const raw = body.deal && typeof body.deal === "object" ? (body.deal as Record<string, unknown>) : {};
      const asked = typeof raw.id === "string" && DEAL_ID.test(raw.id) ? raw.id : "";
      // A change lands only over the exact record the board read (635 [GL3]): never over what a workflow step, a
      // pipeline change or a teammate wrote since. The board sends only the fields the creator changed.
      const exact = asked ? await readDealExact(statsId, asked, stages) : null;
      const existing = exact?.deal ?? null;
      if (asked && !existing) return refuse("unknown", 404);
      const pipelines = restricted ? await readPipelines(statsId) : null;
      // The deal as it is now, for the board to put the creator's changes back on: never to someone who may not
      // change it there (a pipeline they cannot see, or may only see), who gets the conflict alone.
      const conflict = (current: { deal: Deal | null; raw: string | null }) => {
        if (!current.deal || current.raw === null) return refuse("unknown", 404);
        // A stage in no pipeline is in none this person may change.
        const where = pipelines === null ? null : pipelineOfStage(pipelines, current.deal.stage);
        const closed = pipelines !== null && (where === null || accessOf(guarded.role, access, where) !== "edit");
        return Response.json({ ok: false, error: "crm_conflict", ...(closed ? {} : { current: { deal: current.deal, version: dealVersion(current.raw) } }) }, { status: 409 });
      };
      // A board that read an older copy hears first that the deal changed (and, if it moved where they cannot
      // change it, that it did), never only "your access does not let you change this pipeline" on every save.
      if (exact && (typeof body.version !== "string" || body.version !== dealVersion(exact.raw!))) return conflict(exact);
      if (pipelines) {
        const target = typeof raw.stage === "string" ? raw.stage : (existing?.stage ?? "");
        // Both the pipeline it is in and the one it goes to must be theirs to change.
        if ((existing && !mayEdit(pipelineOfStage(pipelines, existing.stage))) || !mayEdit(pipelineOfStage(pipelines, target))) return noAccess();
      }
      const merged = { ...existing, ...raw };
      const follow = readFollowUp(merged);
      if (!follow.ok) return refuse(follow.error);
      if (follow.value.assignee && follow.value.assignee !== existing?.assignee) {
        const team = await readTeam(store.sid);
        const eligible = follow.value.assignee === store.email || team.members.some(m => m.email === follow.value.assignee && can(m.role, "orders"));
        if (!eligible) return refuse("assignee");
      }
      const now = Math.floor(Date.now() / 1000);
      const deal = parseDeal({ ...merged, ...follow.value, formResponseRef: existing?.formResponseRef, id: existing?.id ?? newCrmId(10), createdAt: existing?.createdAt ?? now, updatedAt: now }, stages);
      if (!deal) return refuse(typeof merged.title === "string" && merged.title.trim() ? "stage" : "title");
      // Nothing but the time would change: nothing is written, and the deal keeps its version.
      if (exact && existing && JSON.stringify({ ...deal, updatedAt: 0 }) === JSON.stringify({ ...existing, updatedAt: 0 })) return Response.json({ ok: true, deal: existing, version: dealVersion(exact.raw!) });
      if (exact) {
        // Changed between the read and the write: nothing written; the board gets the deal as it is now.
        if ((await writeDealOver(statsId, deal, exact.raw!, store)) === "changed") return conflict(await readDealExact(statsId, asked, stages));
      } else if (!(await writeDeal(statsId, deal, store))) return refuse("full");
      // Saved first: the workflow its stage starts never holds up, or undoes, the deal itself.
      const workflows = await dealEnteredStage(store, deal, existing);
      return Response.json({ ok: true, deal, version: dealVersion(JSON.stringify(deal)), workflows });
    }
    if (body.action === "undeal") {
      const id = typeof body.id === "string" ? body.id : "";
      if (restricted) {
        const existing = DEAL_ID.test(id) ? await readDeal(statsId, id, stages) : null;
        // A deal that cannot be read (or is not there) is never removed by someone whose access is limited.
        if (!existing || !mayEdit(pipelineOfStage(await readPipelines(statsId), existing.stage))) return noAccess();
      }
      return (await dropDeal(statsId, id, store)) ? Response.json({ ok: true }) : refuse("unknown", 404);
    }
    return refuse("invalid");
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return refuse("store_full", 409);
    if (error instanceof CrmValueWriteUnconfirmed) return refuse("crm_write_unconfirmed", 502);
    if (error instanceof CrmSchemaReadUnavailable) return refuse("crm_schema_read_unavailable", 503);
    if (error instanceof CrmSchemaWriteUnconfirmed) return refuse("crm_write_unconfirmed", 502);
    if (error instanceof CrmSchemaConflict) return refuse("crm_conflict", 409);
    if (error instanceof CrmFieldsKept) return refusedJson("locked");
    if (error instanceof CrmDealReadUnavailable) return refuse("crm_deal_read_unavailable", 503);
    if (error instanceof CrmDealWriteUnconfirmed) return refuse("crm_write_unconfirmed", 502);
    console.error("saving a store's fields or deals failed", error);
    return refuse("server_error", 500);
  }
}
