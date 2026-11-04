import type { NextRequest } from "next/server";
import { SESSION_COOKIE, dropSecondStep, emailForSession, isFreshSession, sessionMark } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { canSeal } from "@/lib/secret-box";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { cancelReset, finishSetup, lockedUntil, replaceCodes, startSetup, turnOff } from "@/lib/two-step";
import { liveSecondStep, mayAddSecondStep } from "@/lib/second-step-gate";
import { cancelRemoval } from "@/lib/passkeys";
import { LockBusyError } from "@/lib/redis-lock";

/** Changes one account may ask for in an hour: most of them email the account. */
const CHANGES_PER_HOUR = 30;

/**
 * The signed-in person's two-step login (lib/two-step.ts):
 *
 *   { action: "start", backup }    a secret for the app, with its QR address,
 *                                  and a code emailed to the recovery address;
 *                                  needs a login from the last 15 minutes, and,
 *                                  on an account with a passkey, a session
 *                                  opened with it ("second_step")
 *   { action: "finish", code, backupCode }
 *                                  turns it on with a right code from the app and
 *                                  the one the recovery address got; answers the
 *                                  recovery codes, this once
 *   { action: "off", code }        turns it off, with a right code
 *   { action: "codes", code }      ten new recovery codes, with a right code
 *   { action: "cancel" }           calls off a request to turn it off without a
 *                                  code; any logged-in browser not locked may,
 *                                  because keeping things as they are takes
 *                                  nothing away (a session let in without the
 *                                  step is refused above, as it is the one the
 *                                  request is about), except one opened with a
 *                                  passkey that is set to be removed or gone.
 *                                  Passkey removals that wait are called off too,
 *                                  only from a session with a valid second step
 *
 * It belongs to the person, not to a store, like their passkeys.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const session = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  const email = await emailForSession(session);
  if (!email) return Response.json({ ok: false, error: "signed_out" }, { status: 401 });
  // A session let in without its second step changes nothing about it (lib/two-step.ts).
  if ((await lockedUntil(session)) > 0) return Response.json({ ok: false, error: "locked" }, { status: 403 });
  if (!isRedisConfigured() || !canSeal()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, 2_000)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (!(await withinLimit("two-step-change", email, CHANGES_PER_HOUR, 60 * 60))) {
    return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const code = typeof body.code === "string" ? body.code.slice(0, 40) : "";
  const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    if (body.action === "start" || body.action === "finish") {
      if (!(await isFreshSession(session))) return refuse("reauth", 403);
      // An account that already has a passkey turns the app on only from a session opened with one (lib/second-step-gate.ts).
      if (!(await mayAddSecondStep(email, session))) return refuse("second_step", 403);
      if (body.action === "start") {
        const started = await startSetup(email, session, typeof body.backup === "string" ? body.backup.slice(0, 300) : "");
        return typeof started === "string"
          ? refuse(started, started === "already" ? 409 : started === "limited" ? 429 : started === "unsent" ? 503 : 400)
          : Response.json({ ok: true, ...started }, { headers: { "Cache-Control": "no-store" } });
      }
      const done = await finishSetup(email, session, code, typeof body.backupCode === "string" ? body.backupCode.slice(0, 20) : "");
      return typeof done === "string" ? refuse(done) : Response.json({ ok: true, codes: done.codes }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "cancel") {
      // A session opened with a passkey that is set to be removed, or gone, calls off nothing
      // (lib/second-step-gate.ts liveSecondStep): whoever holds that passkey may not be the owner.
      const step = await liveSecondStep(email, session);
      if (step === null && (await sessionMark(session, email))?.startsWith("passkey")) return refuse("second_step", 403);
      await cancelReset(email, "studio");
      // Passkeys set to be removed stay only for a session with a valid second step, as "Keep it" (owner C3-95).
      if (step !== null) await cancelRemoval(email, { by: "studio" });
      return Response.json({ ok: true });
    }
    if (body.action === "off") {
      const done = await turnOff(email, code);
      if (done !== "app" && done !== "recovery") return refuse(done, done === "limited" ? 429 : 400);
      // What the app opened goes with it: other sessions it opened are logged out, this one loses its mark (lib/auth.ts).
      await dropSecondStep(email, (mark) => mark === "app" || mark === "recovery", session);
      return Response.json({ ok: true });
    }
    if (body.action === "codes") {
      const done = await replaceCodes(email, code);
      return typeof done === "object" ? Response.json({ ok: true, codes: done.codes }, { headers: { "Cache-Control": "no-store" } }) : refuse(done, done === "limited" ? 429 : 400);
    }
    return refuse("invalid");
  } catch (error) {
    // Another change to the same passkeys held them past the wait (lib/passkeys.ts): said so, to try again.
    if (error instanceof LockBusyError) return refuse("busy", 503);
    console.error("changing two-step login failed", error);
    return refuse("server_error", 500);
  }
}
