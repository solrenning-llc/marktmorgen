import type { NextRequest } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { DEVICE_COOKIE, SESSION_COOKIE, endSession, noteSignIn, openSession, sessionCookie } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { PASSKEY_COOKIE, cancelRemoval, signInOptions, signInWith } from "@/lib/passkeys";
import { cancelReset, endRecoveryAccess } from "@/lib/two-step";

const MAX_BODY_BYTES = 16_000;
/** Tries one browser may make in ten minutes. */
const TRIES = 20;

/**
 * Logging in with a passkey, from /signin (lib/passkeys.ts):
 *
 *   { action: "options" }             what the browser needs to offer its
 *                                     passkeys, with a cookie tying the
 *                                     answer to this browser for 5 minutes
 *   { action: "verify", response }    the answer; a session opens if it holds
 *
 * The answer never says whether an address has an account, because none is
 * typed: the passkey itself says whose it is, or nothing happens.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, MAX_BODY_BYTES)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (!(await withinLimit("passkey", clientAddress(request), TRIES, 10 * 60))) {
    return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  try {
    if (body.action === "options") {
      const { options, nonce } = await signInOptions();
      const response = Response.json({ ok: true, options }, { headers: { "Cache-Control": "no-store" } });
      response.headers.append("Set-Cookie", `${PASSKEY_COOKIE}=${nonce}; Path=/api/auth/passkey; Max-Age=300; HttpOnly; SameSite=Strict${secure}`);
      return response;
    }
    if (body.action === "verify") {
      const nonce = request.cookies.get(PASSKEY_COOKIE)?.value ?? "";
      const answer = body.response as AuthenticationResponseJSON | undefined;
      const signed = answer && typeof answer === "object" ? await signInWith(nonce, answer) : null;
      const email = signed?.email ?? null;
      if (!signed || !email) return Response.json({ ok: false, error: "not_recognised" }, { status: 401 });

      // As with the emailed link: whatever session this browser held before
      // is closed, and only the new one is kept.
      const previous = request.cookies.get(SESSION_COOKIE)?.value;
      if (previous) await endSession(previous);
      // Opened with its second step: a passkey (lib/auth.ts SecondStep), which a team that asks for one reads (lib/team.ts).
      const id = await openSession(email, "passkey", signed.id);
      // A passkey is the second step: a pending request to turn two-step login off is called off (lib/two-step.ts).
      await cancelReset(email, "login").catch((error) => console.error("calling off a two-step reset failed", error));
      await endRecoveryAccess(email).catch((error) => console.error("closing a recovery login failed", error));
      // And the passkeys set to be removed from a session without it stay (lib/passkeys.ts scheduleRemoval).
      await cancelRemoval(email).catch((error) => console.error("calling off a passkey removal failed", error));
      const response = Response.json({ ok: true, next: "/studio" });
      response.headers.append("Set-Cookie", sessionCookie(id));
      response.headers.append("Set-Cookie", `${PASSKEY_COOKIE}=; Path=/api/auth/passkey; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
      response.headers.append(
        "Set-Cookie",
        await noteSignIn(email, request.cookies.get(DEVICE_COOKIE)?.value, "passkey", request.headers.get("user-agent") ?? ""),
      );
      return response;
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("logging in with a passkey failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
