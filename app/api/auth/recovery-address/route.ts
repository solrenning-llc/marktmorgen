import type { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession, isFreshSession } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { confirmRecoveryAddress, removeRecoveryAddress, startRecoveryAddress } from "@/lib/recovery-address";
import { lockedUntil } from "@/lib/two-step";
import { hasSecondStep, liveSecondStep } from "@/lib/second-step-gate";

/**
 * The signed-in person's recovery address (lib/recovery-address.ts):
 *
 *   { action: "start", address }   emails a six-digit code to it
 *   { action: "confirm", code }    keeps it once the code is right
 *   { action: "remove" }           forgets it
 *
 * Each needs a login from the last 15 minutes and a session that got in with
 * everything open: a way into the account is added or taken away here. On an
 * account with a passkey or an app, each also needs a session opened with one
 * (lib/second-step-gate.ts liveSecondStep): the recovery address is where the
 * notices go that the sign-in inbox may not be trusted with (MM-SA-19), so an
 * emailed link alone never changes it, and the old address is told.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const session = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  const email = await emailForSession(session);
  if (!email) return Response.json({ ok: false, error: "signed_out" }, { status: 401 });
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  if ((await lockedUntil(session)) > 0) return Response.json({ ok: false, error: "locked" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, 2_000)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (!(await withinLimit("recovery-address-change", email, 20, 60 * 60))) return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  if (!(await isFreshSession(session))) return Response.json({ ok: false, error: "reauth" }, { status: 403 });
  if ((await hasSecondStep(email)) && (await liveSecondStep(email, session)) === null) return Response.json({ ok: false, error: "second_step" }, { status: 403 });

  try {
    if (body.action === "start") {
      const sent = await startRecoveryAddress(email, session, typeof body.address === "string" ? body.address.slice(0, 300) : "");
      return sent === "sent" ? Response.json({ ok: true }) : Response.json({ ok: false, error: sent }, { status: sent === "limited" ? 429 : sent === "unsent" ? 503 : 400 });
    }
    if (body.action === "confirm") {
      const done = await confirmRecoveryAddress(email, session, typeof body.code === "string" ? body.code.slice(0, 20) : "");
      return typeof done === "string" ? Response.json({ ok: false, error: done }, { status: 400 }) : Response.json({ ok: true, address: done.address });
    }
    if (body.action === "remove") {
      await removeRecoveryAddress(email);
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing a recovery address failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
