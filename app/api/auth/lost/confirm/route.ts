import type { NextRequest } from "next/server";
import { pendingRemoval } from "@/lib/passkeys";
import { originFrom } from "@/lib/request-origin";
import { DEVICE_COOKIE, SESSION_COOKIE, endSession, isMoving, noteSignIn, openSession, sessionCookie } from "@/lib/auth";
import { repairMove } from "@/lib/move-repair";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { recoveryLockUntil, spendLostEmailLink } from "@/lib/recovery-address";
import { HOLD_SECONDS, TWO_STEP_COOKIE, holdSignIn, openLockedSession, twoStepOn } from "@/lib/two-step";

/**
 * The tap on /signin/lost/confirm (lib/recovery-address.ts). With two-step
 * login on, it leads to the code page as the emailed link does; without it,
 * the studio opens at once, with what matters locked until the lock's day.
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
  try {
    const email = await spendLostEmailLink(token);
    if (!email) return away("/signin?status=expired");
    // An address in the middle of a move, or left by one that broke, takes no login without a second step until
    // the move is over or repaired (lib/auth.ts isMoving, lib/move-repair.ts; review of 1daa9131e).
    // With the app, the login waits for its code as always (below); without it, it is refused.
    if ((await isMoving(email)) && !((await repairMove(email)) && !(await isMoving(email))) && !(await twoStepOn(email))) return away("/signin?status=move-busy");
    // A passkey removal whose days are over is applied at every login (lib/passkeys.ts).
    await pendingRemoval(email).catch((error) => console.error("applying a passkey removal failed", error));
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    if (await twoStepOn(email)) {
      const held = await holdSignIn(email, true);
      const response = away("/signin/code");
      response.headers.append("Set-Cookie", `${TWO_STEP_COOKIE}=${held}; Path=/; Max-Age=${HOLD_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
      return response;
    }
    const previous = request.cookies.get(SESSION_COOKIE)?.value;
    if (previous) await endSession(previous);
    // Locked until the lock's day; after it has run out unanswered, everything is open (lib/recovery-address.ts).
    const until = await recoveryLockUntil(email);
    const session = until > 0 ? await openLockedSession(email, until) : await openSession(email);
    const response = away("/studio");
    response.headers.append("Set-Cookie", sessionCookie(session));
    response.headers.append("Set-Cookie", await noteSignIn(email, request.cookies.get(DEVICE_COOKIE)?.value, "link", request.headers.get("user-agent") ?? ""));
    return response;
  } catch (error) {
    console.error("logging in through a recovery address failed", error);
    return away("/signin?status=expired");
  }
}
