import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import {
  EMAIL_PATTERN,
  MAX_EMAIL_LENGTH,
  SESSION_COOKIE,
  addressLimitAnswer,
  emailForSession,
  isAuthConfigured,
  isFreshSession,
  normaliseEmail,
  sendMoveLink,
} from "@/lib/auth";
import { storeForEmail } from "@/lib/store";
import { fromAnotherSite, limited, withinEssentialLimit } from "@/lib/request-guard";
import { lockedUntil } from "@/lib/two-step";
import { hasSecondStep, holdsSecondStep, liveSecondStep } from "@/lib/second-step-gate";

/** Addresses one account may ask to move to in an hour. */
const MOVE_ASKS_PER_HOUR = 5;

/**
 * Asks to move the sign-in address.
 *
 * Nothing moves here. This only sends the link that can finish the move, and
 * it sends it to the address being moved to, because holding that inbox is
 * the whole proof being asked for.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  const back = (status: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${origin}/studio?address=${status}` },
    });

  const session = request.cookies.get(SESSION_COOKIE)?.value;
  const email = await emailForSession(session);
  if (!email) {
    return new Response(null, {
      status: 303,
      headers: { Location: `${origin}/signin?status=expired` },
    });
  }

  // A session let in without its second step cannot move the account (lib/two-step.ts).
  if ((await lockedUntil(session)) > 0) return back("locked");

  let wanted = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    const value = form.get("email");
    wanted = typeof value === "string" ? value.trim() : "";
  } catch {
    return back("invalid");
  }

  if (!wanted || wanted.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(wanted)) {
    return back("invalid");
  }
  if (normaliseEmail(wanted) === normaliseEmail(email)) return back("same");

  // Moving the account outlives the session that asks, so an account with a passkey or an app asks it
  // from a session opened with one (lib/second-step-gate.ts): an emailed link alone never moves it.
  if ((await hasSecondStep(email)) && (await liveSecondStep(email, session)) === null) return back("second-step");
  // Moving is moving a store. With no store there is nothing to carry, and the
  // creator simply signs in with the other address instead.
  const store = await storeForEmail(email);
  if (!store) return back("none");

  // Refused here rather than at the tap, so that a store which could never
  // land there does not put an invitation in a stranger's inbox first.
  if (await storeForEmail(wanted)) return back("taken");

  if (!isAuthConfigured()) return back("unavailable");
  // Moving the account outlives any session, so it needs a recent login, as
  // adding a passkey does: a session cookie that walked off cannot start it.
  if (!(await isFreshSession(session))) return back("reauth");

  try {
    // Past the address's hourly count is "limited"; a count that could not be read is an error, said as one
    // (CX-123 rules 24 and 27): nothing is sent either way.
    const inbox = await addressLimitAnswer(wanted);
    if (inbox === "unknown") return back("error");
    if (inbox === "over") return back("limited");
    // Never onto an address with ways in of its own: they would join this account's (checked again at the
    // tap). Asked only after the store, a recent login, the address's hourly count and the account's own
    // (five addresses an hour), so finding out which addresses have passkeys this way stays slow and limited.
    if (!(await withinEssentialLimit("move-ask", normaliseEmail(email), MOVE_ASKS_PER_HOUR, 60 * 60))) return back("limited");
    if (await holdsSecondStep(wanted)) return back("has-login");
    await sendMoveLink(email, wanted, linkOrigin(request), session as string);
  } catch (error) {
    console.error("address move request failed", error);
    return back("error");
  }

  return back("sent");
}
