import { type NextRequest, after } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { linkOrigin } from "@/lib/request-origin";
import { noticeCreator } from "@/lib/account-notice";
import { KeysNotSwept, inviteMember, logTeam, readTeam, removeMember, revokeInvite, setMemberRole, setRequireTwoStep } from "@/lib/team";
import { applyPause, pauseForRule, pausePreview, planPause, tellPaused, undoPause } from "@/lib/api-key-pause";
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
  unsaved: 503,
  unsure: 503,
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
  // Taken off, but their API keys could not all be paused after: said, so the removal is repeated (owner C3-100).
  const repeat = () =>
    Response.json(
      { ok: false, error: "repeat", message: "They are off the team, but some of the API keys they made may still work. Press Remove again to finish." },
      { status: 503 },
    );
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
      const removed = await removeMember(store, who).catch((error: unknown) => (error instanceof KeysNotSwept ? "repeat" : Promise.reject(error)));
      if (removed === "repeat") return repeat();
      // Already off the team (a removal repeated): its API keys were swept again all the same (lib/team.ts removeMember).
      if (!removed) return Response.json({ ok: true, already: true });
      await forgetDevices(store, who);
      await logTeam(store.sid, { who: email, role, what: `Took ${who.toLowerCase()} off the team` });
      return Response.json({ ok: true });
    }

    // 612 [WP11], owner C3-100: the owner requires two-step sign-in of the
    // team, or stops. Only from a session opened with the owner's own second
    // step (lib/second-step-gate.ts liveSecondStep), so a session from an
    // emailed link cannot loosen or tighten it. Switching it on pauses the API
    // keys teammates made without a second step, and the webhook endpoints
    // they added (lib/api-key-pause.ts); the page showed which and whose, and
    // `expect` is the stamp of that list: when it changed meanwhile, nothing
    // is saved and the new review is sent back. When the rule cannot be saved
    // the pause is undone, and the answer says whether it was.
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
      const origin = linkOrigin(request);
      // Already on: pressing again finishes what an earlier save could not, the keys still to pause and the people still to tell.
      if ((await readTeam(store.sid)).requireTwoStep) return finish(store, email, role, 0, origin);
      const preview = await pausePreview(store);
      if (body.expect !== preview.stamp) return Response.json({ ok: false, error: "changed", preview }, { status: ANSWERS.changed });
      // The plan is kept, so a pause cut short (some keys held, some not) is undone exactly: each key
      // goes back only if it still holds what the plan gave it (lib/api-key-pause.ts undoPause).
      const plan = await planPause(store);
      const undo = () =>
        undoPause(store, plan).then(
          () => true,
          (error: unknown) => (console.error("undoing the pause failed; those keys stay paused until they are turned back on", error), false),
        );
      let first: string[];
      try {
        first = await applyPause(store, plan);
      } catch (error) {
        console.error("pausing API keys before the team's two-step rule failed; the rule was not saved", error);
        return Response.json({ ok: false, error: "unsaved", undone: await undo() }, { status: ANSWERS.unsaved });
      }
      try {
        await setRequireTwoStep(store, true, email);
      } catch (error) {
        // Was it written after all (an error after the write)? Read again; unreadable, nothing is assumed:
        // the pause stands (closed), and the answer says the state is not known.
        const saved = await readTeam(store.sid).then((t) => t.requireTwoStep === true, () => null);
        if (saved === null) {
          console.error("turning on the team's two-step rule failed and the team could not be read; the pause stands", error);
          return Response.json({ ok: false, error: "unsure" }, { status: ANSWERS.unsure });
        }
        if (!saved) {
          console.error("turning on the team's two-step rule failed; its pause is undone", error);
          return Response.json({ ok: false, error: "unsaved", undone: await undo() }, { status: ANSWERS.unsaved });
        }
      }
      return finish(store, email, role, first.length, origin);
    }

    if (action === "leave") {
      if (role === "owner" || !parseTeamRole(role)) return fail("owner");
      // Off the team even when the sweep after could not finish: a request with any key they made is refused all the same,
      // as its maker is on the team no more (lib/api-keys.ts pauseWhy), and the owner's next removal of anybody sweeps again.
      const left = await removeMember(store, email).catch((error: unknown) => (error instanceof KeysNotSwept ? true : Promise.reject(error)));
      if (!left) return fail("unknown");
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

/**
 * With the rule saved: pauses what is still to pause (a key made in between),
 * emails who is still to be told, and says how it went. When either could not
 * be finished, the answer says so and the rule stays on: pressing again
 * finishes it, with nobody told twice (lib/api-key-pause.ts).
 */
async function finish(store: Parameters<typeof pauseForRule>[0], email: string, role: Parameters<typeof logTeam>[1]["role"], first: number, origin: string): Promise<Response> {
  let paused = first;
  try {
    paused += await pauseForRule(store);
    if (paused) await logTeam(store.sid, { who: email, role, what: `Paused ${paused} API ${paused === 1 ? "key" : "keys"} made without a second step` });
    const told = await tellPaused(store, origin);
    if (told.waiting) return Response.json({ ok: false, error: "incomplete", on: true, paused, emailed: told.emailed.length, waiting: told.waiting }, { status: 502 });
    return Response.json({ ok: true, on: true, paused, emailed: told.emailed.length });
  } catch (error) {
    console.error("finishing the team's two-step rule failed; pressing again finishes it", error);
    return Response.json({ ok: false, error: "incomplete", on: true, paused }, { status: 502 });
  }
}
