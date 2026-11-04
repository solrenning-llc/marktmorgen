import type { NextRequest } from "next/server";
import { readPipelines } from "@/lib/crm";
import { normaliseEmail } from "@/lib/auth";
import { PipelineAccessBusyError, setPipelineAccess } from "@/lib/pipeline-access";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { LockBusyError } from "@/lib/redis-lock";
import { logTeam, readTeam, withTeamLocked } from "@/lib/team";
import { can } from "@/lib/team-roles";

/**
 * What one teammate may do with one pipeline: 639 [GL7](7), unit 3. POST
 * `{ email, pipeline, access: "edit" | "view" | "none" }`. For whoever runs
 * the team ("team": the owner and Admins). Only a teammate who is neither
 * the owner nor an Admin, and whose role opens Deals, can be restricted:
 * the owner and Admins always edit every pipeline, and a role without Deals
 * sees none. The change is written in the team's activity log.
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
    // Read the teammate and write their access with the team's lock held, so a sign-in moving at the same
    // moment (moveMemberships, under the same lock) never leaves the new address without the change.
    const done = await withTeamLocked(store.sid, async () => {
      const [team, pipelines] = await Promise.all([readTeam(store.sid), readPipelines(statsId)]);
      const member = team.members.find((m) => m.email === email);
      if (!member) return { ok: false as const, refused: Response.json({ ok: false, error: "unknown", message: "That person is no longer on your team. Reload the page." }, { status: 404 }) };
      if (member.role === "admin") return { ok: false as const, refused: Response.json({ ok: false, error: "admin", message: "An Admin sees and changes every pipeline. Change their role to restrict them." }, { status: 400 }) };
      if (!can(member.role, "orders")) return { ok: false as const, refused: Response.json({ ok: false, error: "no_deals", message: "This person's role does not open Deals, so there is nothing to restrict." }, { status: 400 }) };
      const pipeline = pipelines.find((p) => p.id === pipelineId);
      if (!pipeline) return { ok: false as const, refused: Response.json({ ok: false, error: "unknown", message: "That pipeline is no longer there. Reload the page." }, { status: 404 }) };
      return { ok: true as const, pipeline, saved: await setPipelineAccess(statsId, email, pipelines.map((p) => p.id), pipeline.id, access, store) };
    });
    if (!done.ok) return done.refused;
    const { pipeline, saved } = done;
    await logTeam(store.sid, { who: guarded.email, role: guarded.role, what: `Set ${email}'s access to the ${pipeline.name} pipeline: ${access === "edit" ? "can change" : access === "view" ? "can only see" : "no access"}` }).catch(() => {});
    return Response.json({ ok: true, email, access: saved }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    if (error instanceof LockBusyError) return Response.json({ ok: false, error: "busy", message: "Someone else is changing your team right now. Try again in a moment." }, { status: 409 });
    if (error instanceof PipelineAccessBusyError) return Response.json({ ok: false, error: "busy", message: error.message }, { status: 409 });
    console.error("saving pipeline access failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
