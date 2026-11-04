import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { DEVICE_COOKIE, SESSION_COOKIE, endSession, noteSignIn, openSession, sessionCookie } from "@/lib/auth";
import { HOLD_SECONDS, TWO_STEP_COOKIE, endRecoveryAccess, holdSignIn, resetIfDue, twoStepOn } from "@/lib/two-step";

/**
 * What happens once an address has proved it holds its inbox: by the emailed
 * link (app/api/auth/callback), or by Google confirming an address it answers
 * for (lib/google-signin.ts). One place, so the two never drift apart.
 *
 *   - With two-step login on (lib/two-step.ts), no session opens: the login
 *     waits for the app's code behind a cookie of this browser alone. A
 *     request to turn it off that has waited its days turns it off here.
 *   - Otherwise a session opens, and what the recovery address opened is
 *     closed, as the sign-in inbox itself has now been used.
 *   - A session this browser already held is closed, not kept alongside.
 *   - A browser the account has never used is worth an email (noteSignIn).
 *
 * `failed` is where to send the person when nothing could be opened.
 */
export async function finishProvenSignIn(
  request: NextRequest,
  owner: string | null,
  way: "link" | "google",
  next: string,
  failed = "/signin?status=expired",
): Promise<Response> {
  const origin = originFrom(request);
  const redirect = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });

  let sessionId: string | null = null;
  try {
    if (owner && (await twoStepOn(owner)) && !(await resetIfDue(owner))) {
      const held = await holdSignIn(owner, false, way === "google");
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      const response = redirect("/signin/code");
      response.headers.append("Set-Cookie", `${TWO_STEP_COOKIE}=${held}; Path=/; Max-Age=${HOLD_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
      return response;
    }
    sessionId = owner ? await openSession(owner) : null;
    if (owner) await endRecoveryAccess(owner).catch((error) => console.error("closing a recovery login failed", error));
  } catch (error) {
    console.error("finishing a login failed", error);
  }
  if (!sessionId || !owner) return redirect(failed);

  const previous = request.cookies.get(SESSION_COOKIE)?.value;
  if (previous && previous !== sessionId) await endSession(previous);

  const response = redirect(next);
  response.headers.append("Set-Cookie", sessionCookie(sessionId));
  response.headers.append(
    "Set-Cookie",
    await noteSignIn(owner, request.cookies.get(DEVICE_COOKIE)?.value, way, request.headers.get("user-agent") ?? ""),
  );
  return response;
}
