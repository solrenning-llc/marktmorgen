import type { NextRequest } from "next/server";
import { moveTwoStep } from "@/lib/two-step";
import { moveRecoveryAddress } from "@/lib/recovery-address";
import { originFrom } from "@/lib/request-origin";
import {
  endAllSessions,
  moveDevices,
  openSession,
  sessionCookie,
  spendMoveLink,
} from "@/lib/auth";
import { moveAccount } from "@/lib/store";
import { moveMemberships } from "@/lib/team";
import { movePasskeys, pendingRemoval } from "@/lib/passkeys";
import { holdsSecondStep } from "@/lib/second-step-gate";
import { movePhoneDevices } from "@/lib/phone-alerts";
import { fromAnotherSite, limited } from "@/lib/request-guard";

/**
 * Finishes a move of the sign-in address.
 *
 * Only a POST does this, for the same reason the sign-in link works that way:
 * mail filters open links, and a link that a filter could spend would move an
 * account on its own.
 *
 * Every session the old address had is closed afterward. A move is exactly
 * the moment where a session left open somewhere else stops being harmless.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);

  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  const away = (path: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}${path}` } });

  let token = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    const value = form.get("token");
    token = typeof value === "string" ? value : "";
  } catch {
    return away("/signin?status=expired");
  }

  let moved: { from: string; to: string } | null = null;
  try {
    moved = await spendMoveLink(token);
  } catch (error) {
    console.error("address move failed", error);
  }
  if (!moved) return away("/signin?status=expired");

  // Never onto an address with ways in of its own (a passkey, an app and its codes, a removal waiting):
  // two addresses' ways in are never merged (security review of da5191515).
  if (await holdsSecondStep(moved.to).catch(() => true)) return away("/signin?status=move-has-login");

  let sessionId: string;
  try {
    const result = await moveAccount(moved.from, moved.to);
    if (!result.ok) return away(`/signin?status=move-${result.reason}`);
    // What belongs to the person rather than to a store goes with them: the
    // teams they are on, their passkeys, the browsers they sign in from.
    await Promise.all([
      moveMemberships(moved.from, moved.to),
      movePasskeys(moved.from, moved.to),
      moveDevices(moved.from, moved.to),
      moveTwoStep(moved.from, moved.to),
      moveRecoveryAddress(moved.from, moved.to),
    ]).catch((error) => console.error("moving what belongs to the account failed", error));
    // Phones follow once the memberships have: an owner's stay the owner's,
    // a team member's become the new address's (lib/phone-alerts.ts).
    await movePhoneDevices(moved.from, moved.to).catch((error) => console.error("moving phone devices failed", error));
    await endAllSessions(moved.from);
    // And whatever the new address had open before: nothing opened there earlier stays open into this account.
    await endAllSessions(moved.to);
    sessionId = await openSession(moved.to);
    // Passkeys set to be removed moved with the rest (lib/passkeys.ts movePasskeys); a removal whose days are over is applied at every login.
    await pendingRemoval(moved.to).catch((error) => console.error("applying a passkey removal failed", error));
  } catch (error) {
    console.error("address move failed", error);
    return away("/signin?status=move-error");
  }

  const response = away("/studio?address=moved");
  response.headers.append("Set-Cookie", sessionCookie(sessionId));
  return response;
}
