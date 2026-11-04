import type { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession, isFreshSession } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { canSeal } from "@/lib/secret-box";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { cancelReset, finishSetup, lockedUntil, replaceCodes, startSetup, turnOff } from "@/lib/two-step";
import { mayAddSecondStep } from "@/lib/second-step-gate";

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
 *                                  code; any logged-in browser may, because a
 *                                  session here only ever opened past the second step
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
      await cancelReset(email, "studio");
      return Response.json({ ok: true });
    }
    if (body.action === "off") {
      const done = await turnOff(email, code);
      return done === "app" || done === "recovery" ? Response.json({ ok: true }) : refuse(done, done === "limited" ? 429 : 400);
    }
    if (body.action === "codes") {
      const done = await replaceCodes(email, code);
      return typeof done === "object" ? Response.json({ ok: true, codes: done.codes }, { headers: { "Cache-Control": "no-store" } }) : refuse(done, done === "limited" ? 429 : 400);
    }
    return refuse("invalid");
  } catch (error) {
    console.error("changing two-step login failed", error);
    return refuse("server_error", 500);
  }
}
