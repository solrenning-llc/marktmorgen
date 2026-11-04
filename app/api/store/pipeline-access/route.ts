import type { NextRequest } from "next/server";
import { readPipelines } from "@/lib/crm";
import { normaliseEmail } from "@/lib/auth";
import { PipelineAccessBusyError, setPipelineChoices } from "@/lib/pipeline-access";
import type { PipelineAccess } from "@/lib/pipeline-access-rules";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { LockBusyError } from "@/lib/redis-lock";
import { logTeam, readTeam, withTeamLocked } from "@/lib/team";
import { can } from "@/lib/team-roles";

/**
 * What one teammate may do with each pipeline: 639 [GL7](7), unit 3. POST
 * `{ email, choices: { <pipeline id>: "edit" | "view" | "none" } }` (the team
 * page's Save, every pipeline at once) or `{ email, pipeline, access }` (one).
 * Only the store's owner ("team"; an Admin does not have it). Only a teammate who is neither
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
  const isAccess = (v: unknown): v is PipelineAccess => v === "edit" || v === "view" || v === "none";
  // Every pipeline at once (the team page's Save), or one pipeline.
  const asked: Record<string, PipelineAccess> = {};
  if (body.choices && typeof body.choices === "object" && !Array.isArray(body.choices)) {
    const entries = Object.entries(body.choices as Record<string, unknown>);
    if (!entries.length || entries.length > 50 || !entries.every(([, v]) => isAccess(v))) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    for (const [id, v] of entries) asked[id] = v as PipelineAccess;
  } else if (typeof body.pipeline === "string" && isAccess(body.access)) {
    asked[body.pipeline] = body.access;
  } else {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    // Read the teammate and write their access with the team's lock held, so a sign-in moving at the same
    // moment (moveMemberships, under the same lock) never leaves the new address without the change.
    const done = await withTeamLocked(store.sid, async () => {
      const [team, pipelines] = await Promise.all([readTeam(store.sid), readPipelines(statsId)]);
      const member = team.members.find((m) => m.email === email);
      if (!member) return { ok: false as const, refused: Response.json({ ok: false, error: "unknown", message: "That person is no longer on your team. Reload the page." }, { status: 404 }) };
      if (member.role === "admin") return { ok: false as const, refused: Response.json({ ok: false, error: "admin", message: "An Admin sees and changes every pipeline. Change their role to restrict them." }, { status: 400 }) };
      if (!can(member.role, "orders")) return { ok: false as const, refused: Response.json({ ok: false, error: "no_deals", message: "This person's role does not open Deals, so there is nothing to restrict." }, { status: 400 }) };
      const named = Object.keys(asked).map((id) => pipelines.find((p) => p.id === id));
      if (named.some((p) => !p)) return { ok: false as const, refused: Response.json({ ok: false, error: "unknown", message: "That pipeline is no longer there. Reload the page." }, { status: 404 }) };
      return { ok: true as const, named: named as { id: string; name: string }[], saved: await setPipelineChoices(statsId, email, pipelines.map((p) => p.id), asked, store) };
    });
    if (!done.ok) return done.refused;
    const { named, saved } = done;
    const words = (a: PipelineAccess) => (a === "edit" ? "can change" : a === "view" ? "can only see" : "no access");
    const said = named.map((p) => `${p.name}: ${words(saved[p.id] ?? "edit")}`).join("; ");
    await logTeam(store.sid, { who: guarded.email, role: guarded.role, what: named.length === 1 ? `Set ${email}'s access to the ${named[0].name} pipeline: ${words(saved[named[0].id] ?? "edit")}` : `Set ${email}'s pipeline access. ${said}` }).catch(() => {});
    return Response.json({ ok: true, email, access: saved }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    if (error instanceof LockBusyError) return Response.json({ ok: false, error: "busy", message: "Someone else is changing your team right now. Try again in a moment." }, { status: 409 });
    if (error instanceof PipelineAccessBusyError) return Response.json({ ok: false, error: "busy", message: error.message }, { status: 409 });
    console.error("saving pipeline access failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
