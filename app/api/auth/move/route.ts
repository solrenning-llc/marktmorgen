import type { NextRequest } from "next/server";
import { discardTwoStep, moveTwoStep } from "@/lib/two-step";
import { moveRecoveryAddress } from "@/lib/recovery-address";
import { originFrom } from "@/lib/request-origin";
import {
  endAllSessions,
  endMoving,
  markMoving,
  moveDevices,
  openSession,
  sessionCookie,
  spendMoveLink,
} from "@/lib/auth";
import { moveAccount, storeForEmail } from "@/lib/store";
import { moveMemberships } from "@/lib/team";
import { discardPasskeys, movePasskeys, pendingRemoval } from "@/lib/passkeys";
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

  const { from, to } = moved;
  // Both addresses are marked as moving for the whole move (lib/auth.ts markMoving): the ways in leave
  // `from` before the store does, and in that gap `from` counts as having a second step, so a session opened
  // only by the emailed link adds no passkey and no app to it (lib/second-step-gate.ts; review of 8b4ddf6ee).
  // A second move of either address waits until this one is over.
  if (!(await markMoving(from, to).catch(() => false))) return away("/signin?status=move-error");
  try {
    return await finishMove(from, to, away);
  } finally {
    await endMoving(from, to).catch((error) => console.error("unmarking a move failed", error));
  }
}

/**
 * The move itself, with both addresses marked. The ways in move first, and
 * each refuses an address with its own (lib/passkeys.ts movePasskeys,
 * lib/two-step.ts moveTwoStep); when one refuses, or the store cannot move,
 * the account's own ways in go back, whatever `from` gained in the meantime is
 * forgotten and its sessions are logged out, and nothing else moves: a move
 * never ends split between two addresses.
 */
async function finishMove(from: string, to: string, away: (path: string) => Response): Promise<Response> {
  let keysMoved = false;
  let appMoved = false;
  const undo = async () => {
    if (keysMoved) {
      await discardPasskeys(from).catch((error) => console.error("forgetting passkeys added midway failed", error));
      await movePasskeys(to, from).catch((error) => console.error("moving passkeys back failed", error));
    }
    if (appMoved) {
      await discardTwoStep(from).catch((error) => console.error("forgetting two-step login added midway failed", error));
      await moveTwoStep(to, from).catch((error) => console.error("moving two-step login back failed", error));
    }
    await endAllSessions(from).catch((error) => console.error("logging out after an undone move failed", error));
  };
  try {
    await movePasskeys(from, to);
    keysMoved = true;
    await moveTwoStep(from, to);
    appMoved = true;
  } catch (error) {
    console.error("moving the ways in refused", error);
    await undo();
    return away("/signin?status=move-has-login");
  }

  let sessionId: string;
  try {
    const result = await moveAccount(from, to);
    if (!result.ok) {
      await undo();
      return away(`/signin?status=move-${result.reason}`);
    }
    // What belongs to the person rather than to a store goes with them: the
    // teams they are on, the browsers they sign in from, the recovery address.
    await Promise.all([
      moveMemberships(from, to),
      moveDevices(from, to),
      moveRecoveryAddress(from, to),
    ]).catch((error) => console.error("moving what belongs to the account failed", error));
    // Phones follow once the memberships have: an owner's stay the owner's,
    // a team member's become the new address's (lib/phone-alerts.ts).
    await movePhoneDevices(from, to).catch((error) => console.error("moving phone devices failed", error));
    await endAllSessions(from);
    // And whatever the new address had open before: nothing opened there earlier stays open into this account.
    await endAllSessions(to);
    sessionId = await openSession(to);
    // Passkeys set to be removed moved with the rest (lib/passkeys.ts movePasskeys); a removal whose days are over is applied at every login.
    await pendingRemoval(to).catch((error) => console.error("applying a passkey removal failed", error));
  } catch (error) {
    console.error("address move failed", error);
    // Undone only when the store is known to be still at `from`: a passing error reading it never undoes a
    // move whose store already landed at `to`.
    const [there, here] = await Promise.all([storeForEmail(to).catch(() => undefined), storeForEmail(from).catch(() => undefined)]);
    if (there === null && here) await undo();
    else if (there === undefined || here === undefined) console.error("a failed move left in an unknown state", { from, to });
    return away("/signin?status=move-error");
  }

  const response = away("/studio?address=moved");
  response.headers.append("Set-Cookie", sessionCookie(sessionId));
  return response;
}
