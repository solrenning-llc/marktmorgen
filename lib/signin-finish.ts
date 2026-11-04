import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { pendingRemoval } from "@/lib/passkeys";
import { DEVICE_COOKIE, SESSION_COOKIE, endSession, isMoving, noteSignIn, openSession, sessionCookie } from "@/lib/auth";
import { repairMove } from "@/lib/move-repair";
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
 *     closed, as the sign-in inbox itself has now been used. It opens without
 *     a second step, even for an account that owns a passkey: a team that asks
 *     for one holds it at the door (lib/team.ts teamTwoStepBlocks).
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
    // An address in the middle of a move, or left by one that broke, takes no login without a second step until
    // the move is over or repaired (lib/auth.ts isMoving, lib/move-repair.ts; reviews of 1daa9131e and
    // b42237ca6): with the app, the login waits for its code as always (and a request to turn it off never
    // ends here); without it, it is refused.
    const blocked = owner ? (await isMoving(owner)) && !((await repairMove(owner)) && !(await isMoving(owner))) : false;
    if (owner && blocked && !(await twoStepOn(owner))) return redirect("/signin?status=move-busy");
    if (owner && (await twoStepOn(owner)) && (blocked || !(await resetIfDue(owner)))) {
      const held = await holdSignIn(owner, false, way === "google");
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      const response = redirect("/signin/code");
      response.headers.append("Set-Cookie", `${TWO_STEP_COOKIE}=${held}; Path=/; Max-Age=${HOLD_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
      return response;
    }
    sessionId = owner ? await openSession(owner) : null;
    // A passkey removal whose days are over is applied at every login (lib/passkeys.ts).
    if (owner) await pendingRemoval(owner).catch((error) => console.error("applying a passkey removal failed", error));
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
