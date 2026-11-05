import { type NextRequest, after } from "next/server";
import { originFrom } from "@/lib/request-origin";
import {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  emailForSession,
  endSession,
  normaliseEmail,
  noteSignIn,
  openSession,
  sessionCookie,
} from "@/lib/auth";
import { clientAddress, fromAnotherSite, limited, withinEssentialLimit } from "@/lib/request-guard";
import { logTeam, peekInvite, spendInvite } from "@/lib/team";
import { ROLE_NAMES } from "@/lib/team-roles";
import { noticeCreator } from "@/lib/account-notice";
import { storeCookie, studioPath } from "@/lib/studio-route";
import { hasAccount } from "@/lib/account-exists";

/** Taps one connection may make in an hour. */
const TRIES_PER_HOUR = 20;

/**
 * Taking an invitation to a store's team (lib/team.ts).
 *
 * Only a POST does it, for the reason the login link works that way: mail
 * filters open links, and a link a filter could spend would put its person
 * on the team by itself. The owner is told by email (lib/account-notice.ts).
 *
 * The invitation is for one address, and it is read before anything is
 * spent, so that:
 *
 *   - a browser logged in as a different address is refused, and nothing is
 *     spent: taking it would quietly swap whose studio that browser shows,
 *     which is how a link sent by somebody else could put a person to work
 *     in an account that is not theirs;
 *   - a browser already logged in as the invited address simply joins, in
 *     the session it has;
 *   - for an address that has no account yet, the tap proves the inbox is
 *     theirs, so it logs them in as that address with the store open;
 *   - for an address that already has an account (a store, another team, a
 *     passkey, two-step login; lib/account-exists.ts), the invitation only
 *     puts them on the team. It does not log
 *     in: a link that stays good for seven days must not be a seven-day key
 *     to an existing account, whose own login links last fifteen minutes.
 *     They log in the usual way and find the store in their studio.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}` } });

  if (!(await withinEssentialLimit("join", clientAddress(request), TRIES_PER_HOUR, 60 * 60))) {
    return away("/signin?status=invite-slow");
  }

  let token = "";
  try {
    const value = (await (await limited(request, 8_000)).formData()).get("token");
    token = typeof value === "string" ? value : "";
  } catch {
    return away("/signin?status=invite-expired");
  }

  const previous = request.cookies.get(SESSION_COOKIE)?.value;
  let signedInAs: string | null = null;
  let existing = false;
  try {
    const invite = await peekInvite(token);
    if (!invite) return away("/signin?status=invite-expired");
    signedInAs = previous ? await emailForSession(previous) : null;
    if (signedInAs && normaliseEmail(signedInAs) !== invite.email) return away("/signin?status=invite-other");
    existing = !signedInAs && (await hasAccount(invite.email));
  } catch (error) {
    console.error("reading an invitation failed", error);
    return away("/signin?status=invite-error");
  }

  let joined;
  try {
    joined = await spendInvite(token);
  } catch (error) {
    console.error("taking an invitation failed", error);
    return away("/signin?status=invite-error");
  }
  if (!joined.ok) return away(`/signin?status=invite-${joined.reason}`);
  const { store, member } = joined;

  await logTeam(store.sid, { who: member.email, role: member.role, what: `Joined the team as ${ROLE_NAMES[member.role]}` });
  const tell = () => noticeCreator(store, { kind: "team-joined", who: member.email, role: ROLE_NAMES[member.role] });
  // After the answer, inside the route's time; at once, unwaited, where there is no request to wait for (a test).
  try {
    after(tell);
  } catch {
    void tell().catch((error: unknown) => console.error("telling the owner about a new teammate failed", error));
  }

  // Already logged in as this address: nothing about the session changes.
  if (signedInAs) {
    const response = away(studioPath(store, "team=joined"));
    response.headers.append("Set-Cookie", storeCookie(store.sid, request));
    return response;
  }
  // An existing account logs in the way it always does.
  if (existing) return away("/signin?status=invite-joined");

  let sessionId: string;
  try {
    if (previous) await endSession(previous);
    sessionId = await openSession(member.email);
  } catch (error) {
    console.error("logging in after an invitation failed", error);
    return away("/signin?status=invite-error");
  }

  const response = away(studioPath(store, "team=joined"));
  response.headers.append("Set-Cookie", sessionCookie(sessionId));
  response.headers.append("Set-Cookie", storeCookie(store.sid, request));
  response.headers.append(
    "Set-Cookie",
    await noteSignIn(member.email, request.cookies.get(DEVICE_COOKIE)?.value, "invitation", request.headers.get("user-agent") ?? ""),
  );
  return response;
}
