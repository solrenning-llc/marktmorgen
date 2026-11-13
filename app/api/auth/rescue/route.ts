import type { NextRequest } from "next/server";
import { pendingRemoval } from "@/lib/passkeys";
import { originFrom } from "@/lib/request-origin";
import { DEVICE_COOKIE, SESSION_COOKIE, endSession, noteSignIn, openSession, sessionCookie } from "@/lib/auth";
import { TWO_STEP_COOKIE, spendRescue } from "@/lib/two-step";
import { fromAnotherSite, limited } from "@/lib/request-guard";

/**
 * The tap on /signin/rescue: spends the link sent to the recovery address,
 * turns two-step login off and opens the session (lib/two-step.ts spendRescue).
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });

  let token = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    const value = form.get("token");
    token = typeof value === "string" ? value : "";
  } catch {
    return away("/signin?status=expired");
  }

  let email: string | null = null;
  try {
    email = await spendRescue(token);
  } catch (error) {
    console.error("using a recovery-address link failed", error);
    // Not known (CX-123 rule 24): the link may be spent and two-step login off, so it is never called expired.
    // Nothing was opened; a fresh link logs in either way (with the app's code or a new rescue link if it is still on).
    return away("/signin?status=login-unknown");
  }
  if (!email) return away("/signin?status=expired");

  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const noWait = `${TWO_STEP_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
  let sessionId = "";
  try {
    const previous = request.cookies.get(SESSION_COOKIE)?.value;
    if (previous) await endSession(previous);
    sessionId = await openSession(email);
    // A passkey removal whose days are over is applied at every login (lib/passkeys.ts).
    await pendingRemoval(email).catch((error) => console.error("applying a passkey removal failed", error));
    const response = away("/studio#two-step");
    response.headers.append("Set-Cookie", sessionCookie(sessionId));
    response.headers.append("Set-Cookie", noWait);
    response.headers.append("Set-Cookie", await noteSignIn(email, request.cookies.get(DEVICE_COOKIE)?.value, "link", request.headers.get("user-agent") ?? ""));
    return response;
  } catch (error) {
    console.error("logging in after turning two-step login off failed", error);
    // Two-step login is off and the link spent, but no session could be confirmed (CX-123 rule 24): nothing is
    // handed out (one opened before the failure is closed), the waiting login's cookie goes, and a fresh emailed
    // link logs in without the app (/signin login-unknown), never an error page.
    if (sessionId) await endSession(sessionId).catch((end: unknown) => console.error("closing a login that could not be finished failed", end));
    const response = away("/signin?status=login-unknown");
    response.headers.append("Set-Cookie", noWait);
    return response;
  }
}
