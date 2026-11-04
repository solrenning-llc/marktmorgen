import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { DEVICE_COOKIE, SESSION_COOKIE, endSession, noteSignIn, openSession, sessionCookie } from "@/lib/auth";
import { TWO_STEP_COOKIE, enterLocked, finishSignIn, sendRescue } from "@/lib/two-step";
import { fromAnotherSite, limited } from "@/lib/request-guard";

/**
 * The second step of logging in (lib/two-step.ts): the code from the app, or
 * a recovery code, for the login this browser's cookie says is waiting. A
 * right one opens the session exactly as the emailed link does for an account
 * without two-step login.
 *
 * `action=rescue` sends a link to the account's recovery address, which turns
 * two-step login off and logs in at once (lib/two-step.ts sendRescue).
 * `action=reset` is somebody with neither a code, a passkey nor the recovery
 * inbox: they are let in at once, with what could take money, data or the
 * account away locked until two-step login turns off (lib/two-step.ts enterLocked).
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });

  let code = "";
  let action = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    const value = form.get("code");
    code = typeof value === "string" ? value.slice(0, 40) : "";
    const asked = form.get("action");
    action = asked === "reset" || asked === "rescue" ? asked : "";
  } catch {
    return away("/signin/code?status=wrong");
  }

  const held = request.cookies.get(TWO_STEP_COOKIE)?.value ?? "";
  // A link to the recovery address: back in at once, without a code (lib/two-step.ts sendRescue).
  if (action === "rescue") {
    try {
      const sent = await sendRescue(held, linkOrigin(request));
      return sent === "expired" ? away("/signin?status=expired") : away(`/signin/code?status=rescue-${sent}`);
    } catch (error) {
      console.error("sending a recovery-address link failed", error);
      return away("/signin/code?status=rescue-unsent");
    }
  }
  if (action === "reset") {
    try {
      const entered = await enterLocked(held);
      if (!entered) return away("/signin?status=expired");
      const previous = request.cookies.get(SESSION_COOKIE)?.value;
      if (previous) await endSession(previous);
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      const response = away("/studio");
      response.headers.append("Set-Cookie", sessionCookie(entered.session));
      response.headers.append("Set-Cookie", `${TWO_STEP_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
      response.headers.append("Set-Cookie", await noteSignIn(entered.email, request.cookies.get(DEVICE_COOKIE)?.value, "link", request.headers.get("user-agent") ?? ""));
      return response;
    } catch (error) {
      console.error("letting somebody in without two-step login failed", error);
      return away("/signin/code?status=wrong");
    }
  }
  let answer: Awaited<ReturnType<typeof finishSignIn>>;
  try {
    answer = await finishSignIn(held, code);
  } catch (error) {
    console.error("checking a two-step code failed", error);
    return away("/signin/code?status=wrong");
  }
  if (!answer.ok) return away(answer.reason === "expired" ? "/signin?status=expired" : `/signin/code?status=${answer.reason}`);

  const previous = request.cookies.get(SESSION_COOKIE)?.value;
  if (previous) await endSession(previous);
  const sessionId = await openSession(answer.email);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const response = away("/studio");
  response.headers.append("Set-Cookie", sessionCookie(sessionId));
  response.headers.append("Set-Cookie", `${TWO_STEP_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  response.headers.append("Set-Cookie", await noteSignIn(answer.email, request.cookies.get(DEVICE_COOKIE)?.value, answer.byGoogle ? "google" : "link", request.headers.get("user-agent") ?? ""));
  return response;
}
