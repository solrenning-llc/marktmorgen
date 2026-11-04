import { type NextRequest, after } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { linkOrigin } from "@/lib/request-origin";
import { noticeCreator } from "@/lib/account-notice";
import { inviteMember, logTeam, readTeam, removeMember, revokeInvite, setMemberRole, setRequireTwoStep } from "@/lib/team";
import { pauseForRule, pausePreview, tellPaused } from "@/lib/api-key-pause";
import { SESSION_COOKIE } from "@/lib/auth";
import { hasSecondStep, liveSecondStep } from "@/lib/second-step-gate";
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
  invited: 409,
  full: 409,
  limited: 429,
  unsent: 502,
  unknown: 404,
  same: 400,
  owner_no_step: 409,
  owner_step_session: 403,
  changed: 409,
};

/**
 * The store's team, from the studio's Team page:
 *
 *   { action: "invite", email, role }   emails an invitation (7 days, once)
 *   { action: "revoke", id }            takes an unused invitation back
 *   { action: "role", email, role }     changes someone's role
 *   { action: "remove", email }         takes someone off the team
 *   { action: "leave" }                 takes yourself off it
 *   { action: "two-step", on, expect }  requires two-step sign-in of the
 *                                       team, or stops (612 [WP11], C3-100)
 *
 * All but the last are the owner's alone (lib/team-roles.ts, "team"); leaving
 * is anyone's on the team. Each is written into the store's activity log.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, (body) => (text(body.action, 20) === "leave" ? "member" : "team"), 2_000);
  if (!guarded.ok) return guarded.response;
  const { email, store, role, body } = guarded;
  const session = request.cookies.get(SESSION_COOKIE)?.value;
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

    // 612 [WP11], owner C3-100: the owner requires two-step sign-in of the
    // team, or stops. Only from a session opened with the owner's own second
    // step (lib/second-step-gate.ts liveSecondStep), so a session from an
    // emailed link cannot loosen or tighten it. Switching it on pauses the API
    // keys teammates made without a second step (lib/api-key-pause.ts); the
    // page showed how many and whose, and `expect` is that number: when it
    // changed meanwhile, nothing is saved and the new review is sent back.
    if (action === "two-step") {
      if (role !== "owner") return fail("owner");
      const on = body.on === true;
      if ((await liveSecondStep(email, session)) === null) {
        // An owner with no second step at all (one who removed theirs) may still switch it off: they could never switch it on again, and are not held to a rule they no longer meet.
        if (on) return fail((await hasSecondStep(email)) ? "owner_step_session" : "owner_no_step");
        if (await hasSecondStep(email)) return fail("owner_step_session");
      }
      if (!on) {
        await setRequireTwoStep(store, false, email);
        return Response.json({ ok: true, on: false });
      }
      if ((await readTeam(store.sid)).requireTwoStep) return Response.json({ ok: true, on: true, paused: 0, emailed: 0 });
      const preview = await pausePreview(store);
      if (body.expect !== preview.total) return Response.json({ ok: false, error: "changed", preview }, { status: ANSWERS.changed });
      const first = await pauseForRule(store);
      await setRequireTwoStep(store, true, email);
      const paused = [...first, ...(await pauseForRule(store))];
      if (paused.length) await logTeam(store.sid, { who: email, role, what: `Paused ${paused.length} API ${paused.length === 1 ? "key" : "keys"} made without a second step` });
      const emailed = await tellPaused(store, paused, linkOrigin(request));
      return Response.json({ ok: true, on: true, paused: paused.length, emailed: emailed.length });
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
