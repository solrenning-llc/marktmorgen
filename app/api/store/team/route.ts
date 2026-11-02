import { type NextRequest, after } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { linkOrigin } from "@/lib/request-origin";
import { noticeCreator } from "@/lib/account-notice";
import { hasSecondStep, inviteMember, logTeam, removeMember, revokeInvite, setMemberRole, setRequireTwoStep } from "@/lib/team";
import { ROLE_NAMES, parseTeamRole } from "@/lib/team-roles";
import { forgetPerson } from "@/lib/phone-alerts";

/** A person off the team keeps no device here (lib/phone-alerts.ts). Never fails the change itself. */
async function forgetDevices(store: Parameters<typeof forgetPerson>[0], who: string): Promise<void> {
  await forgetPerson(store, who).catch((error: unknown) => console.error("forgetting a team member's devices failed", error));
}

const ANSWERS: Record<string, number> = {
  shape: 400,
  role: 400,
  owner: 400,
  member: 409,
  owner_two_step: 409,
  invited: 409,
  full: 409,
  limited: 429,
  unsent: 502,
  unknown: 404,
  same: 400,
};

/**
 * The store's team, from the studio's Team page:
 *
 *   { action: "invite", email, role }   emails an invitation (7 days, once)
 *   { action: "revoke", id }            takes an unused invitation back
 *   { action: "role", email, role }     changes someone's role
 *   { action: "remove", email }         takes someone off the team
 *   { action: "leave" }                 takes yourself off it
 *
 * All but the last are the owner's alone (lib/team-roles.ts, "team"); leaving
 * is anyone's on the team. Each is written into the store's activity log.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, (body) => (text(body.action, 20) === "leave" ? "member" : "team"), 2_000);
  if (!guarded.ok) return guarded.response;
  const { email, store, role, body } = guarded;
  const action = text(body.action, 20);
  const fail = (error: string) => Response.json({ ok: false, error }, { status: ANSWERS[error] ?? 400 });
  if (!store.sid) return fail("unknown");

  try {
    if (action === "invite") {
      const result = await inviteMember(store, text(body.email, 300), body.role, linkOrigin(request));
      if (!result.ok) return fail(result.reason);
      await logTeam(store.sid, { who: email, role, what: `Invited ${result.invite.email} as ${ROLE_NAMES[result.invite.role]}` });
      return Response.json({ ok: true, invite: result.invite });
    }

    if (action === "revoke") {
      const id = text(body.id, 20);
      if (!(await revokeInvite(store, id))) return fail("unknown");
      await logTeam(store.sid, { who: email, role, what: "Took back an invitation" });
      return Response.json({ ok: true });
    }

    if (action === "role") {
      const who = text(body.email, 300);
      const result = await setMemberRole(store, who, body.role);
      if (!result.ok) return fail(result.reason);
      const from = ROLE_NAMES[result.before];
      const to = ROLE_NAMES[result.role];
      await logTeam(store.sid, { who: email, role, what: `Changed ${who.toLowerCase()} from ${from} to ${to}` });
      after(() => noticeCreator(store, { kind: "team-role", who: who.toLowerCase(), from, to }));
      return Response.json({ ok: true });
    }

    if (action === "remove") {
      const who = text(body.email, 300);
      if (!(await removeMember(store, who))) return fail("unknown");
      await forgetDevices(store, who);
      await logTeam(store.sid, { who: email, role, what: `Took ${who.toLowerCase()} off the team` });
      return Response.json({ ok: true });
    }

    // 612 [WP11]: the owner requires two-step sign-in of the team, or stops.
    // Only an owner who has a second step themselves may require one.
    if (action === "two-step") {
      if (role !== "owner") return fail("owner");
      const on = body.on === true;
      if (on && !(await hasSecondStep(email))) return fail("owner_two_step");
      await setRequireTwoStep(store, on, email);
      return Response.json({ ok: true, on });
    }

    if (action === "leave") {
      if (role === "owner" || !parseTeamRole(role)) return fail("owner");
      if (!(await removeMember(store, email))) return fail("unknown");
      await forgetDevices(store, email);
      await logTeam(store.sid, { who: email, role, what: "Left the team" });
      return Response.json({ ok: true });
    }

    return fail("invalid");
  } catch (error) {
    console.error("a team change failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
