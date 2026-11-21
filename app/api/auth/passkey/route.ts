import type { NextRequest } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { SESSION_COOKIE, emailForSession, isFreshSession } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { RemovalBusyError, RemovalUnsentError, addPasskey, cancelRemoval, listPasskeys, registrationOptions, removePasskey, scheduleRemovalSaid } from "@/lib/passkeys";
import { LockBusyError } from "@/lib/redis-lock";
import { liveSecondStep, mayAddNow, mayAddSecondStep, mayKeepPasskey } from "@/lib/second-step-gate";
import { lockedUntil, twoStepOn } from "@/lib/two-step";
import { lockRead } from "@/lib/two-step-unknown";

const MAX_BODY_BYTES = 16_000;
/** Changes one account may make to its passkeys in an hour: each one emails the account. */
const CHANGES_PER_HOUR = 30;
/** Removals a session let in without its second step may ask for in an hour, on a count of its own: each emails the account. */
const LOCKED_REMOVALS_PER_HOUR = 5;

const ANSWERS: Record<string, number> = { expired: 400, invalid: 400, full: 409, taken: 409, unknown: 404, reauth: 403, second_step: 403 };

/** What went wrong, in JSON: another change to the same passkeys holding them (lib/passkeys.ts) is "busy", to try again. */
function failed(error: unknown, doing: string): Response {
  if (error instanceof LockBusyError) return Response.json({ ok: false, error: "busy" }, { status: 503 });
  // Another request's notice of a removal is still going out: nothing was set, try again (lib/passkeys.ts scheduleRemoval).
  if (error instanceof RemovalBusyError) return Response.json({ ok: false, error: "busy" }, { status: 503 });
  // The email that tells the account could not be sent, so nothing was set (lib/passkeys.ts scheduleRemoval).
  if (error instanceof RemovalUnsentError) return Response.json({ ok: false, error: "unsent" }, { status: 503 });
  console.error(doing, error);
  return Response.json({ ok: false, error: "server_error" }, { status: 500 });
}

/**
 * The signed-in person's own passkeys (lib/passkeys.ts):
 *
 *   { action: "options" }                  what the browser needs to make one
 *   { action: "add", response, name }      the browser's answer, to keep it
 *   { action: "remove", id }               forgets one (or, from a session
 *                                          without the step, asks it to wait)
 *   { action: "keep", id }                 calls off a removal that waits
 *
 * A passkey belongs to the person, not to a store, so this works the same
 * for an owner and for someone on a team, whichever store is open.
 *
 * Adding one needs a login from the last fifteen minutes (lib/auth.ts,
 * isFreshSession): a passkey outlives the session that adds it, so an old
 * session — or one that walked off on a borrowed laptop — is asked to log in
 * again first ("reauth"). On an account that already has a passkey or an
 * authenticator app, adding one also needs a session opened with one of them
 * ("second_step", lib/second-step-gate.ts): an emailed link alone, however
 * fresh, adds nothing. Removing one from such a session is at once; from a
 * session without the step it waits REMOVAL_DAYS, with an email to the
 * account (lib/passkeys.ts scheduleRemoval), so somebody who only reads the
 * inbox cannot clear the passkeys and add their own, and somebody who lost
 * theirs still gets back.
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
  // (lib/two-step.ts): removing a passkey could lock the owner out, and it cannot be undone. Every request of
  // one is refused, whatever it names, and before the hourly count, so a locked session never spends the
  // owner's own changes (31 requests of any kind would otherwise keep the owner out for the hour). The one
  // exception: it may ask for a removal that waits, on a count of its own (below), so somebody who lost the
  // app and the passkey waits once, not twice.
  const until = await lockRead(lockedUntil(session));
  if (until instanceof Response) return until;
  const locked = until > 0;
  if (locked && body.action !== "remove") {
    return Response.json({ ok: false, error: "locked" }, { status: 403 });
  }
  if (body.action === "remove" && locked) {
    if (!(await withinLimit("passkey-remove-locked", email, LOCKED_REMOVALS_PER_HOUR, 60 * 60))) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    try {
      const set = await scheduleRemovalSaid(email, typeof body.id === "string" ? body.id.slice(0, 1_400) : "", session, await twoStepOn(email));
      return set === null ? Response.json({ ok: false, error: "unknown" }, { status: 404 }) : Response.json({ ok: true, removeOn: set.at, loggedOut: set.loggedOut });
    } catch (error) {
      return failed(error, "asking for a passkey removal failed");
    }
  }
  if (!(await withinLimit("passkey-change", email, CHANGES_PER_HOUR, 60 * 60))) {
    return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  if ((body.action === "options" || body.action === "add") && !(await isFreshSession(session))) {
    return Response.json({ ok: false, error: "reauth" }, { status: 403 });
  }
  try {
    if ((body.action === "options" || body.action === "add") && !(await mayAddSecondStep(email, session))) {
      return Response.json({ ok: false, error: "second_step" }, { status: 403 });
    }
    if (body.action === "keep") {
      const id = typeof body.id === "string" ? body.id.slice(0, 1_400) : "";
      // Keeping one needs a session with a valid second step, never the passkey's own (owner C3-95, lib/second-step-gate.ts).
      if (!mayKeepPasskey(await liveSecondStep(email, session))) return Response.json({ ok: false, error: "second_step" }, { status: 403 });
      // Checked again under the account's lock (lib/passkeys.ts cancelRemoval).
      const kept = await cancelRemoval(email, id, session);
      return kept === "kept" ? Response.json({ ok: true }) : Response.json({ ok: false, error: kept }, { status: ANSWERS[kept] ?? 400 });
    }
    if (body.action === "options") {
      return Response.json({ ok: true, options: await registrationOptions(email, session) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "add") {
      const response = body.response as RegistrationResponseJSON | undefined;
      if (!response || typeof response !== "object") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      const name = typeof body.name === "string" ? body.name : "";
      // Asked again under the account's lock, just before the write (lib/second-step-gate.ts mayAddNow).
      const result = await addPasskey(email, session, response, name, () => mayAddNow(email, session));
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: ANSWERS[result.reason] ?? 400 });
      const list = await listPasskeys(email);
      return Response.json({ ok: true, passkeys: list.map(({ id, name, createdAt, lastUsedAt, synced }) => ({ id, name, createdAt, lastUsedAt, synced })) });
    }
    if (body.action === "remove") {
      const id = typeof body.id === "string" ? body.id.slice(0, 1_400) : "";
      // At once only from a session with a valid second step (not one opened with a passkey that is itself set to be removed).
      if ((await liveSecondStep(email, session)) === null) {
        const set = await scheduleRemovalSaid(email, id, session, await twoStepOn(email));
        if (set === null) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
        // Set either way; browsers that could not be logged out are said as such (review of #2556).
        return Response.json({ ok: true, removeOn: set.at, loggedOut: set.loggedOut });
      }
      // Checked again under the account's lock (lib/passkeys.ts removePasskey).
      const removed = await removePasskey(email, id, session);
      // Gone either way; sessions that could not be read are said as not logged out (audit SG2, finding 6).
      if (removed === "removed" || removed === "removed-sessions-open") return Response.json({ ok: true, loggedOut: removed === "removed" });
      return Response.json({ ok: false, error: removed }, { status: ANSWERS[removed] ?? 400 });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    return failed(error, "a passkey change failed");
  }
}
