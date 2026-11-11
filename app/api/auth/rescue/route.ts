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
    console.error("using a recovery-address link failed");
  }
  if (!email) return away("/signin?status=expired");

  const previous = request.cookies.get(SESSION_COOKIE)?.value;
  if (previous) await endSession(previous);
  const sessionId = await openSession(email);
  // A passkey removal whose days are over is applied at every login (lib/passkeys.ts).
  await pendingRemoval(email).catch(() => console.error("applying a passkey removal failed"));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const response = away("/studio#two-step");
  response.headers.append("Set-Cookie", sessionCookie(sessionId));
  response.headers.append("Set-Cookie", `${TWO_STEP_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  response.headers.append("Set-Cookie", await noteSignIn(email, request.cookies.get(DEVICE_COOKIE)?.value, "link", request.headers.get("user-agent") ?? ""));
  return response;
}
