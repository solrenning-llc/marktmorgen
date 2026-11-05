import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_KEY_NAME, makeKey } from "@/lib/api-keys";
import { afterMake, makerFor, revokeChecked, shownKeys, turnKeyOn } from "@/lib/api-key-pause";
import { SESSION_COOKIE } from "@/lib/auth";
import { hasSecondStep, liveSecondStep } from "@/lib/second-step-gate";
import { can } from "@/lib/team-roles";

/**
 * Making and revoking the keys a creator's own tools read the store with.
 *
 * `{ action: "make", name }` returns the key — the only time it is ever sent
 * whole. `{ action: "revoke", id }` takes one away at once.
 *
 * The same permission as taking the list away as a file ("export",
 * lib/team-roles.ts): the owner and an Admin. A key reads the same things an
 * export does, so it is handed out by the same people. A key that may also
 * write (`write: true`) gives products and adds people to the list, as an
 * import does, so it also needs the permission to import.
 *
 * A key is made only from a session as strong as the account (security
 * review after #2140): on an account that has a second step (a passkey or an
 * authenticator app), the session must have been opened with it
 * (lib/second-step-gate.ts liveSecondStep). An emailed link proves only the
 * inbox, and a key made from it would outlive the session it came from. An
 * account with neither makes keys as before. The key's record says who made
 * it and whether the session had a second step (lib/api-key-pause.ts).
 *
 * `{ action: "turn_on", id }` turns back on a key the team's two-step rule
 * paused (owner C3-100): by whoever made it, from a session with a second
 * step.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "export");
  if (!guarded.ok) return guarded.response;
  const { store, body, role, email } = guarded;
  const action = text(body.action, 10);
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  const keys = () => shownKeys(store, email, role);

  try {
    if (action === "make") {
      const write = body.write === true;
      if (write && !can(role, "import")) return Response.json({ ok: false, error: "role" }, { status: 403 });
      const step = (await liveSecondStep(email, session)) !== null;
      if (!step && (await hasSecondStep(email))) return Response.json({ ok: false, error: "second_step" }, { status: 403 });
      const maker = makerFor(store.sid, role, email, step);
      const made = await makeKey(store.sid, text(body.name, MAX_KEY_NAME * 2), Date.now(), write, "none", maker);
      if (!made.ok) return Response.json({ ok: false, error: made.reason }, { status: made.reason === "unavailable" ? 503 : 400 });
      // Checked again once written: the door let them in a moment before (owner C3-100).
      const paused = await afterMake(store, made.made.id, maker, email, write);
      return Response.json(
        { ok: true, key: made.key, made: made.made, paused, keys: await keys() },
        // A key in a cached response is a key in somebody's cache.
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (action === "revoke") {
      // The webhook endpoints the key added stop with it (owner C3-100); a key whose maker left the team is the owner's to revoke.
      const gone = await revokeChecked(store, role, text(body.id, 20));
      if (gone !== "ok") return Response.json({ ok: false, error: gone }, { status: gone === "unknown" ? 404 : 403 });
      return Response.json({ ok: true, keys: await keys() }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "turn_on") {
      if ((await liveSecondStep(email, session)) === null) return Response.json({ ok: false, error: "second_step_on" }, { status: 403 });
      // For a key whose maker could not be matched to the team, or was never recorded, `as` says whose it is: "owner" or a teammate's address.
      const turned = await turnKeyOn(store, email, role, text(body.id, 20), text(body.as, 300));
      if (turned !== "ok") return Response.json({ ok: false, error: turned }, { status: turned === "unknown" ? 404 : turned === "whose" ? 400 : 409 });
      return Response.json({ ok: true, keys: await keys() }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing an API key failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
