import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { SESSION_COOKIE, endOtherSessions, isFreshSession, sessionEmail } from "@/lib/auth";
import { fromAnotherSite } from "@/lib/request-guard";
import { lockedUntil } from "@/lib/two-step";

/**
 * Closes every session of this creator except the one asking (757 [STN4], unit 1).
 *
 * Reached only from the studio's devices page, which asks first (app/studio/devices). This browser stays logged
 * in; the answer goes back to that page, which says what happened. It answers as app/api/auth/signout-all does:
 * an unknown read or delete is said as such, never as done, and a locked session may not use it.
 */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const origin = originFrom(request);
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });

  const id = request.cookies.get(SESSION_COOKIE)?.value;
  // Whose session this is, read exactly: one that could not be read is not "nobody's" (CX-123 rule 24).
  let email: string | null;
  try {
    email = await sessionEmail(id);
  } catch (error) {
    console.error("reading the session to log out the other devices failed", error);
    return away("/studio/devices?status=out-others-unknown");
  }
  // No session (confirmed absent): there is nothing of this person's to close.
  if (!email) return away("/signin");
  // A session let in without its second step cannot log the others out (lib/two-step.ts), as with signout-all.
  if ((await lockedUntil(id)) > 0) return away("/studio?two-step=locked");
  // Unlike signout-all, this keeps the presser logged in, so it needs a login from the last FRESH_LOGIN_SECONDS, as
  // adding a passkey does: a session cookie that walked off could otherwise log the owner out everywhere and stay in
  // (Claude 3 on #3459). A freshness read that is not exact is not fresh (lib/auth.ts isFreshSession); nothing is closed.
  if (!(await isFreshSession(id))) return away("/studio/devices?status=out-others-reauth");

  const ended = await endOtherSessions(email, id);
  return away(`/studio/devices?status=${ended === null ? "out-others-unknown" : "out-others"}`);
}
