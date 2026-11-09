import type { NextRequest } from "next/server";
import { discardTwoStep, moveTwoStep } from "@/lib/two-step";
import { forgetMovedRecovery, moveRecoveryAddress } from "@/lib/recovery-address";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { linkOrigin, originFrom } from "@/lib/request-origin";
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
import { dropMemberships, moveMemberships } from "@/lib/team";
import type { Role } from "@/lib/team-roles";
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
  // Where this answer sends the browser back to: the host it asked. Links we email are another thing (below).
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
    // The links in the notices are built by linkOrigin (lib/request-origin.ts): a request sent to one store's domain
    // never puts that domain in an email, where the host it names could be one somebody else points elsewhere.
    return await finishMove(from, to, linkOrigin(request), away, () => {
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
async function finishMove(from: string, to: string, link: string, away: (path: string) => Response, broke: () => void): Promise<Response> {
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
  // Whether the recovery address is known to have come along; never said as moved when that is not known.
  let carried = true;
  // Whether every place on another store's team is known to have come along; the same.
  let teams = true;
  // Whether every API key the old address made on another store's team is known to be held, once its place there was
  // taken off (lib/team.ts dropMemberships); never said as held when a sweep could not be finished, even repeated.
  let keys = true;
  // Stores where the old address's place was taken off but the sweep of its API keys was not finished (KeysNotSwept),
  // with the role it had: filled by moveMemberships as it goes, so a carry that throws later does not lose them.
  const unswept = new Map<string, Role>();
  try {
    const result = await moveAccount(from, to);
    if (!result.ok) {
      await undo();
      return away(`/signin?status=move-${result.reason}`);
    }
    // What belongs to the person rather than to a store goes with them: the
    // teams they are on, the browsers they sign in from, the recovery address.
    // The recovery address is carried on its own (review of #2883): a carry that failed, or whose answer is not
    // known, never passes as moved. The move itself stands, as the store and its ways in are already at `to` and
    // undoing them is more writes that can fail and leave the account split; instead the new address is told too,
    // and the studio says it, so it is never only an email that may not arrive.
    // The places on other stores' teams are the same: a place that stayed on `from` (its restrictions or keys could
    // not be carried), or a carry that failed midway, is said, and taken off below.
    [carried, teams] = await Promise.all([
      moveRecoveryAddress(from, to).then(
        () => true,
        (error) => (console.error("carrying the recovery address failed", error), false),
      ),
      moveMemberships(from, to, unswept).then(
        (stayed) => stayed.length === 0,
        (error) => (console.error("carrying the places on other teams failed", error), false),
      ),
      // Low risk, only logged: a browser left listed under `from` lets nobody in, it only goes unlisted (lib/auth.ts).
      moveDevices(from, to).catch((error) => console.error("moving the browsers the account signs in from failed", error)),
    ]);
    // Not carried, whatever is still kept under `from` is forgotten (it may be the address itself, when the carry
    // failed before writing, or a value that could not be read): an account made at `from` later would otherwise
    // inherit it as its own way back in. Tried twice; still unanswered, it is logged, the person is told anyway.
    if (!carried && !(await forgetLeftRecovery(from))) console.error("a recovery address may be left under an address an account moved away from", { from });
    // Likewise a place on a team not carried: an account made at `from` later would otherwise be on that team. And a
    // place taken off whose sweep of the API keys was not finished has it repeated there, as `from` has no role left
    // on that team to be taken off for (Claude 2's third review of #3326). Unanswered, the keys are not known as held.
    if (!teams || unswept.size) {
      const dropped = await dropMemberships(from, unswept).catch(() => null);
      if (!dropped?.settled) console.error("a place on a team, or an API key made from one, may be left under an address an account moved away from", { from });
      keys = dropped !== null && dropped.unswept.length === 0;
    }
    // The old address is told the move finished every time, now, before anything else can stop it: the notice when
    // the move was asked for (lib/auth.ts sendMoveLink) says only that it may happen, and a move nobody there made is
    // learned of while there is still somebody to ask for help.
    await tellMoved(from, to, link, { recovery: !carried, teams: !teams, keys: !keys });
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

  const response = away(`/studio?address=${closed ? "moved" : "moved-sessions-open"}${carried ? "" : "-no-recovery"}${teams ? "" : "-no-teams"}${keys ? "" : "-keys-open"}`);
  response.headers.append("Set-Cookie", sessionCookie(sessionId));
  return response;
}

/** forgetMovedRecovery (lib/recovery-address.ts), tried twice; false when neither try was answered. */
async function forgetLeftRecovery(from: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await forgetMovedRecovery(from).catch(() => false)) return true;
  }
  return false;
}

/** What did not come along with a move, said in its notices and on the page it lands on. */
type LeftBehind = { recovery: boolean; teams: boolean; keys: boolean };

/**
 * The notices at the end of a move. The old sign-in address is always told that the account now logs in with the new
 * one, with what did not come along; the new address is told only when something did not, with what to do. At most
 * two emails a move (tests/plan-cost-registry.ts, EMAIL_SITES). Neither ever names the recovery address. Best
 * effort, like every account notice: the studio says what did not come along on the page the move lands on
 * (app/studio/page.tsx), which is the notice that cannot be lost.
 */
async function tellMoved(from: string, to: string, link: string, left: LeftBehind): Promise<void> {
  const when = `When: ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`;
  const send = (address: string, subject: string, lines: string[]) =>
    sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: address, replyTo: "support@marktmorgen.com", subject, text: lines.join("\n") }).catch(() => false);
  // Not "may have none": a carry whose answer was lost may still have written it, and the studio shows which.
  const lostFor = (whose: "its" | "your", invite: string, made: string) => [
    ...(left.recovery ? [`We could not confirm that ${whose} recovery address came along.`] : []),
    ...(left.teams ? [`We could not carry ${whose} places on other stores' teams. Ask each store's owner to invite ${invite} again.`] : []),
    // The move is not complete on that team: only its owner can revoke the keys, and we emailed them where we could.
    ...(left.keys ? [`Some API keys made with ${made} on another store's team may still work. Ask that store's owner to revoke the ones you no longer use.`] : []),
  ];
  const lost = lostFor("its", to, "this address");
  const todo = left.recovery ? ", then check Recovery address in your studio and add a recovery address again if none is shown" : "";
  const subject =
    left.recovery && left.teams
      ? "Your recovery address and team places did not move with your account"
      : left.teams
        ? "Your places on other teams did not move with your account"
        : left.recovery
          ? "Your recovery address did not move with your account"
          : "Some API keys from your old address may still work";
  await Promise.all([
    send(from, "The email your Marktmorgen account logs in with changed", [
      `The Marktmorgen account that logged in with this address now logs in with ${to}. This address no longer logs in to it.`,
      ...(lost.length ? ["", ...lost] : []),
      "",
      when,
      "",
      // Said before the way in: somebody else holding the account is what this notice is for.
      "If you did not make this change, reply to this email right away so we can help, and change the password of this inbox: somebody may be able to read it.",
      "",
      `Log in with ${to} at ${link}/signin${todo}.`,
    ]),
    ...(lost.length
      ? [
          send(to, subject, [
            "Your Marktmorgen account now logs in with this address, but not everything came along with it.",
            "",
            ...lostFor("your", "this address", from),
            "",
            when,
            "",
            "If you did not move your account, reply to this email so we can help.",
            "",
            `Log in at ${link}/signin${todo}.`,
          ]),
        ]
      : []),
  ]);
}
