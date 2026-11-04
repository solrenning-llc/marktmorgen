import type { NextRequest } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { SESSION_COOKIE, emailForSession, isFreshSession } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { addPasskey, listPasskeys, registrationOptions, removePasskey } from "@/lib/passkeys";
import { lockedUntil } from "@/lib/two-step";

const MAX_BODY_BYTES = 16_000;
/** Changes one account may make to its passkeys in an hour: each one emails the account. */
const CHANGES_PER_HOUR = 30;

const ANSWERS: Record<string, number> = { expired: 400, invalid: 400, full: 409, taken: 409, unknown: 404, reauth: 403 };

/**
 * The signed-in person's own passkeys (lib/passkeys.ts):
 *
 *   { action: "options" }                  what the browser needs to make one
 *   { action: "add", response, name }      the browser's answer, to keep it
 *   { action: "remove", id }               forgets one
 *
 * A passkey belongs to the person, not to a store, so this works the same
 * for an owner and for someone on a team, whichever store is open.
 *
 * Adding one needs a login from the last fifteen minutes (lib/auth.ts,
 * isFreshSession): a passkey outlives the session that adds it, so an old
 * session — or one that walked off on a borrowed laptop — is asked to log in
 * again first ("reauth"). Removing one does not: it can only take a way in
 * away, and the emailed link always works.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const session = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  const email = await emailForSession(session);
  if (!email) return Response.json({ ok: false, error: "signed_out" }, { status: 401 });
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, MAX_BODY_BYTES)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  // A session let in without its second step cannot add a way in of its own, nor take one away from the owner
  // (lib/two-step.ts): removing a passkey could lock the owner out, and it cannot be undone. Asked before
  // the hourly count, so a locked session never spends the owner's own changes.
  if ((body.action === "options" || body.action === "add" || body.action === "remove") && (await lockedUntil(session)) > 0) {
    return Response.json({ ok: false, error: "locked" }, { status: 403 });
  }
  if (!(await withinLimit("passkey-change", email, CHANGES_PER_HOUR, 60 * 60))) {
    return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  if ((body.action === "options" || body.action === "add") && !(await isFreshSession(session))) {
    return Response.json({ ok: false, error: "reauth" }, { status: 403 });
  }

  try {
    if (body.action === "options") {
      return Response.json({ ok: true, options: await registrationOptions(email, session) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "add") {
      const response = body.response as RegistrationResponseJSON | undefined;
      if (!response || typeof response !== "object") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      const name = typeof body.name === "string" ? body.name : "";
      const result = await addPasskey(email, session, response, name);
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: ANSWERS[result.reason] ?? 400 });
      const list = await listPasskeys(email);
      return Response.json({ ok: true, passkeys: list.map(({ id, name, createdAt, lastUsedAt, synced }) => ({ id, name, createdAt, lastUsedAt, synced })) });
    }
    if (body.action === "remove") {
      const id = typeof body.id === "string" ? body.id.slice(0, 1_400) : "";
      if (!(await removePasskey(email, id))) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("a passkey change failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
