import type { NextRequest } from "next/server";
import { CrmSchemaReadUnavailable, readPipelinesExact } from "@/lib/crm";
import { normaliseEmail } from "@/lib/auth";
import { CRM_ID, pipelineNames } from "@/lib/crm-rules";
import { PipelineAccessBusyError, PipelineAccessChangedError, setPipelineChoices } from "@/lib/pipeline-access";
import { type AccessMap, type PipelineAccess, parseAccessMap } from "@/lib/pipeline-access-rules";
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
 * sees none. With `was` (the record the page read), a record changed since is
 * never written over. The change is written in the team's activity log,
 * each pipeline that changed with what it was.
 */

const refusal = (error: string, message: string, status = 400) => Response.json({ ok: false, error, message }, { status });

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "team", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const statsId = store.statsId;
  if (!statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  const email = typeof body.email === "string" ? normaliseEmail(body.email) : "";
  if (!email) return refusal("invalid", "No teammate was named. Reload the page and try again.");
  if (email === normaliseEmail(store.email)) return refusal("owner", "You always see and change every pipeline of your store, so there is nothing to restrict.");
  const isAccess = (v: unknown): v is PipelineAccess => v === "edit" || v === "view" || v === "none";
  // Every pipeline at once (the team page's Save), or one pipeline. A Map, so an id such as "__proto__" is
  // only ever an id, and every id must look like one (CRM_ID) before anything is read.
  const asked = new Map<string, PipelineAccess>();
  if (body.choices && typeof body.choices === "object" && !Array.isArray(body.choices)) {
    const entries = Object.entries(body.choices as Record<string, unknown>);
    if (!entries.length || entries.length > 50 || !entries.every(([id, v]) => CRM_ID.test(id) && isAccess(v))) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    for (const [id, v] of entries) asked.set(id, v as PipelineAccess);
  } else if (typeof body.pipeline === "string" && CRM_ID.test(body.pipeline) && isAccess(body.access)) {
    asked.set(body.pipeline, body.access);
  } else {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  // The record as the page that saves read it: a Save from a page opened before another change never writes
  // over that change. Absent is not checked (one pipeline at a time); null is a record that could not be read.
  let was: AccessMap | null | undefined;
  if (Object.hasOwn(body, "was")) {
    if (body.was !== null && (!body.was || typeof body.was !== "object" || Array.isArray(body.was))) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    was = body.was === null ? null : parseAccessMap(body.was);
    if (was !== null && Object.keys(was).length !== Object.keys(body.was as object).length) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    // Read the teammate and write their access with the team's lock held, so a sign-in moving at the same
    // moment (moveMemberships, under the same lock) never leaves the new address without the change.
    const done = await withTeamLocked(store.sid, async () => {
      // The pipelines exactly as saved: a record that cannot be read refuses (503), never the default pipeline in
      // its place, which would drop the restrictions on every other one.
      const [team, pipelines] = await Promise.all([readTeam(store.sid), readPipelinesExact(statsId)]);
      const member = team.members.find((m) => m.email === email);
      if (!member) {
        if (team.invites.some((i) => i.email === email)) return { ok: false as const, refused: refusal("invited", "This person has not joined your team yet. You can choose their access once they accept the invitation.") };
        return { ok: false as const, refused: refusal("unknown", "That person is no longer on your team. Reload the page.", 404) };
      }
      if (member.role === "admin") return { ok: false as const, refused: refusal("admin", "An Admin sees and changes every pipeline. Change their role to restrict them.") };
      if (!can(member.role, "orders")) return { ok: false as const, refused: refusal("no_deals", "This person's role does not open Deals, so there is nothing to restrict.") };
      const named = [...asked.keys()].map((id) => pipelines.find((p) => p.id === id));
      if (named.some((p) => !p)) return { ok: false as const, refused: refusal("unknown", "That pipeline is no longer there. Reload the page.", 404) };
      const choices: Record<string, PipelineAccess> = Object.fromEntries(asked);
      // Each named as the team page shows it, so two pipelines that share a name are told apart in the log too.
      const names = pipelineNames(pipelines);
      return { ok: true as const, named: (named as { id: string; name: string }[]).map((p) => ({ id: p.id, name: names.get(p.id) ?? p.name })), ...(await setPipelineChoices(statsId, email, pipelines.map((p) => p.id), choices, store, was)) };
    });
    if (!done.ok) return done.refused;
    const { named, before, saved } = done;
    const words = (a: PipelineAccess) => (a === "edit" ? "can change" : a === "view" ? "can only see" : "no access");
    // What each named pipeline was before (an unreadable record opened nothing) and what it is now; only what changed is said.
    const was0 = (id: string): PipelineAccess => (before === null ? "none" : (before[id] ?? "edit"));
    const now = (id: string): PipelineAccess => saved[id] ?? "edit";
    const changed = named.filter((p) => was0(p.id) !== now(p.id));
    const what = !changed.length
      ? `Saved ${email}'s pipeline access with no change`
      : named.length === 1
        ? `Set ${email}'s access to the ${changed[0].name} pipeline: ${words(now(changed[0].id))} (was ${words(was0(changed[0].id))})`
        : `Set ${email}'s pipeline access. ${changed.map((p) => `${p.name}: ${words(now(p.id))} (was ${words(was0(p.id))})`).join("; ")}`;
    await logTeam(store.sid, { who: guarded.email, role: guarded.role, what }).catch(() => {});
    return Response.json({ ok: true, email, access: saved }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    if (error instanceof LockBusyError) return refusal("busy", "Someone else is changing your team right now. Try again in a moment.", 409);
    if (error instanceof PipelineAccessBusyError) return refusal("busy", error.message, 409);
    if (error instanceof PipelineAccessChangedError) return refusal("changed", error.message, 409);
    if (error instanceof CrmSchemaReadUnavailable) return refusal("unavailable", "Your pipelines could not be read just now, so nothing was changed. Try again in a moment.", 503);
    console.error("saving pipeline access failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
