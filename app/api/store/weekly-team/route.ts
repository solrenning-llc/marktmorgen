import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { MAX_WEEKLY_TEAM, setWeeklyTeam, weeklyTeam } from "@/lib/stats-report";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";

/**
 * Who on the team gets the weekly email too (lib/stats-report.ts, weeklyTeam):
 * `{ emails: [...] }`, members of the team whose role sees the numbers, at
 * most MAX_WEEKLY_TEAM. For whoever runs the team. Answers the list kept.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "team", 2_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  if (!Array.isArray(body.emails) || body.emails.length > MAX_WEEKLY_TEAM || !store.sid) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    const team = await readTeam(store.sid);
    const allowed = new Set(team.members.filter((m) => can(m.role, "stats")).map((m) => m.email.toLowerCase()));
    const emails = body.emails.filter((e): e is string => typeof e === "string").map((e) => e.trim().toLowerCase());
    if (emails.some((e) => !allowed.has(e))) return Response.json({ ok: false, error: "member" }, { status: 400 });
    // Kept only while the store is live (Codex L-20261121-0144): one whose erasure began after it was read keeps nothing.
    if ((await setWeeklyTeam(store, emails)) === "gone") return Response.json({ ok: false, error: "gone" }, { status: 410 });
    return Response.json({ ok: true, emails: await weeklyTeam(store.handle) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("changing who gets the weekly email failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
