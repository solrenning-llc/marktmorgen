import type { NextRequest } from "next/server";
import { discardTwoStep, moveTwoStep } from "@/lib/two-step";
import { moveRecoveryAddress } from "@/lib/recovery-address";
import { originFrom } from "@/lib/request-origin";
import {
  SessionsUnknownError,
  endAllSessions,
  endMoving,
  clearBrokenMove,
  markBrokenMove,
  markMoving,
  moveDevices,
  openSession,
  sessionCookie,
  spendMoveLink,
} from "@/lib/auth";
import { moveAccount, storeForEmail } from "@/lib/store";
import { moveMemberships } from "@/lib/team";
import { MoveSplitError, discardPasskeys, movePasskeys, pendingRemoval } from "@/lib/passkeys";
import { holdsSecondStep } from "@/lib/second-step-gate";
import { repairMove } from "@/lib/move-repair";
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
  // A question that could not be answered refuses the move as one that could not be finished just now, never as an
  // address with ways in of its own (CX-123 rule 24; audit of the API routes, 11 Nov 2026): nothing has moved yet.
  const holds = await holdsSecondStep(moved.to).catch((error: unknown) => (console.error("reading the new address's ways in failed", error), null));
  if (holds === null) return away("/signin?status=move-unread");
  if (holds) return away("/signin?status=move-has-login");

  const { from, to } = moved;
  // A move left broken earlier is repaired first (lib/move-repair.ts); while it cannot be, nothing moves.
  if (!(await repairMove(from)) || !(await repairMove(to))) return away("/signin?status=move-error");
  // Both addresses are marked as moving for the whole move (lib/auth.ts markMoving): the ways in leave
  // `from` before the store does, and in that gap `from` counts as having a second step, so a session opened
  // only by the emailed link adds no passkey and no app to it (lib/second-step-gate.ts; review of 8b4ddf6ee).
  // A second move of either address waits until this one is over.
  const mark = await markMoving(from, to).catch(() => null);
  if (!mark) return away("/signin?status=move-error");
  // Written before anything moves, with no expiry, and cleared only when the move finished or was undone
  // without an error (lib/auth.ts markBrokenMove): a process that dies midway leaves it, so the store on one
  // address and its ways in on the other are never left with a login by the emailed link let in, and the
  // next login or move repairs it (lib/move-repair.ts, which waits while this move's mark is there).
  // Not written: nothing moves, and the 5-minute mark lapses on its own.
  if (!(await markBrokenMove(from, to).then(() => true, () => false))) return away("/signin?status=move-error");
  let broken = false;
  try {
    return await finishMove(from, to, away, () => {
      broken = true;
    });
  } finally {
    const cleared = broken ? false : await clearBrokenMove(from, to).then(() => true, (error) => (console.error("clearing a move's record failed", error), false));
    // Kept when the record could not be cleared either way: it holds the addresses until it is repaired.
    if (cleared || broken) await endMoving(from, to, mark).catch((error) => console.error("unmarking a move failed", error));
  }
}

/** Runs one step of an undo; false, logged, when it failed. */
async function step(what: string, work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (error) {
    console.error(`${what} failed`, error);
    return false;
  }
}

/**
 * The move itself, with both addresses marked. The ways in move first, and
 * each refuses an address with its own (lib/passkeys.ts movePasskeys,
 * lib/two-step.ts moveTwoStep); when one refuses, or the store cannot move,
 * the account's own ways in go back, whatever `from` gained in the meantime is
 * forgotten and its sessions are logged out, and nothing else moves. When
 * that cannot be done, or where the store is cannot be told, `broke` is
 * called and the move is kept marked until it is repaired.
 */
async function finishMove(from: string, to: string, away: (path: string) => Response, broke: () => void): Promise<Response> {
  let keysMoved = false;
  let appMoved = false;
  // A copy of two-step login that may have been left at `to` when moving it refused (lib/two-step.ts moveTwoStep).
  let appCopy = false;
  const undo = async () => {
    let ok = true;
    if (keysMoved) {
      ok = (await step("forgetting passkeys added midway", () => discardPasskeys(from))) && ok;
      ok = (await step("moving passkeys back", () => movePasskeys(to, from))) && ok;
    }
    if (appMoved) {
      ok = (await step("forgetting two-step login added midway", () => discardTwoStep(from))) && ok;
      ok = (await step("moving two-step login back", () => moveTwoStep(to, from))) && ok;
    } else if (appCopy) {
      ok = (await step("forgetting a copy of two-step login", () => discardTwoStep(to))) && ok;
    }
    // Sessions that could not be read are not logged out (audit SG2): the move is then left marked to repair.
    ok = (await step("logging out after an undone move", async () => {
      if ((await endAllSessions(from)) === null) throw new Error("the sessions could not be read");
    })) && ok;
    if (!ok) broke();
    return ok;
  };
  try {
    await movePasskeys(from, to);
    keysMoved = true;
    appCopy = true;
    await moveTwoStep(from, to);
    appMoved = true;
  } catch (error) {
    console.error("moving the ways in refused", error);
    // Passkeys that could not be put back cleanly: the move is kept marked until it is repaired.
    if (error instanceof MoveSplitError) broke();
    const undone = await undo();
    // The new address's sessions could not be read (lib/two-step.ts moveTwoStep; review of #2556 at df8030300):
    // it holds no way in of its own, so that is never what the person is told. Put back cleanly, the account
    // stays where it was; otherwise it is kept marked to repair, said as a move that did not finish.
    if (error instanceof SessionsUnknownError) return away(undone ? "/signin?status=move-unread" : "/signin?status=move-error");
    return away("/signin?status=move-has-login");
  }

  let sessionId: string;
  // Whether every session both addresses had open was closed; never said as closed when it could not be read.
  let closed = true;
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
    // Sessions that could not be read are not closed (lib/auth.ts endAllSessions answers null; review of #2556):
    // the move stands, as the store and its ways in are all at `to`, and the studio says so, not "every session closed".
    closed = (await endAllSessions(from)) !== null;
    // And whatever the new address had open before: nothing opened there earlier stays open into this account.
    closed = (await endAllSessions(to)) !== null && closed;
    sessionId = await openSession(to);
    // Passkeys set to be removed moved with the rest (lib/passkeys.ts movePasskeys); a removal whose days are over is applied at every login.
    await pendingRemoval(to).catch((error) => console.error("applying a passkey removal failed", error));
  } catch (error) {
    console.error("address move failed", error);
    // Undone only when the store is known to be still at `from` alone: a passing error reading it never undoes
    // a move whose store already landed at `to`. Known at `to` alone, the move stands with its ways in. Any
    // other state (unknown, or on both addresses) is kept marked until it is repaired.
    const [there, here] = await Promise.all([storeForEmail(to).catch(() => undefined), storeForEmail(from).catch(() => undefined)]);
    if (there === null && here) await undo();
    else if (!(there && here === null)) {
      console.error("a failed move left in an unknown state", { from, to });
      broke();
    }
    return away("/signin?status=move-error");
  }

  const response = away(closed ? "/studio?address=moved" : "/studio?address=moved-sessions-open");
  response.headers.append("Set-Cookie", sessionCookie(sessionId));
  return response;
}
