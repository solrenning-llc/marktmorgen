import type { NextRequest } from "next/server";
import { readPipelines } from "@/lib/crm";
import { normaliseEmail } from "@/lib/auth";
import { readPipelineAccess, writePipelineAccess } from "@/lib/pipeline-access";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { logTeam, readTeam } from "@/lib/team";

/**
 * What one teammate may do with one pipeline: 639 [GL7](7), unit 3. POST
 * `{ email, pipeline, access: "edit" | "view" | "none" }`. For whoever runs
 * the team ("team": the owner and Admins). Only a teammate who is neither
 * the owner nor an Admin can be restricted, since those always edit every
 * pipeline; the change is written in the team's activity log.
 */

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "team", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const statsId = store.statsId;
  if (!statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  const email = typeof body.email === "string" ? normaliseEmail(body.email) : "";
  const pipelineId = typeof body.pipeline === "string" ? body.pipeline : "";
  const access = body.access === "edit" || body.access === "view" || body.access === "none" ? body.access : null;
  if (!access) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  try {
    const [team, pipelines] = await Promise.all([readTeam(store.sid), readPipelines(statsId)]);
    const member = team.members.find((m) => m.email === email);
    if (!member) return Response.json({ ok: false, error: "unknown", message: "That person is no longer on your team. Reload the page." }, { status: 404 });
    if (member.role === "admin") return Response.json({ ok: false, error: "admin", message: "An Admin sees and changes every pipeline. Change their role to restrict them." }, { status: 400 });
    const pipeline = pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) return Response.json({ ok: false, error: "unknown", message: "That pipeline is no longer there. Reload the page." }, { status: 404 });
    const before = (await readPipelineAccess(statsId, email)) ?? {};
    const next = { ...before };
    if (access === "edit") delete next[pipeline.id];
    else next[pipeline.id] = access;
    const saved = await writePipelineAccess(statsId, email, next, store);
    await logTeam(store.sid, { who: guarded.email, role: guarded.role, what: `Set ${email}'s access to the ${pipeline.name} pipeline: ${access === "edit" ? "can change" : access === "view" ? "can only see" : "no access"}` }).catch(() => {});
    return Response.json({ ok: true, email, access: saved }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    console.error("saving pipeline access failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
