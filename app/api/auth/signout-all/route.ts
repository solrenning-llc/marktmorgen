import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import {
  SESSION_COOKIE,
  endAllSessions,
  sessionEmail,
} from "@/lib/auth";
import { fromAnotherSite } from "@/lib/request-guard";
import { lockedUntil } from "@/lib/two-step";

/**
 * Closes every session this creator has open, on every device.
 *
 * A session lasts thirty days, which is kind on the creator and unkind the day
 * a laptop is lost or borrowed. This is the door that shuts all of them.
 */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  const id = request.cookies.get(SESSION_COOKIE)?.value;
  // Whose session this is, read exactly: one that could not be read is not "nobody's", so nothing is said as
  // logged out everywhere when nothing was (CX-123 rule 24; tests/auth-sessions-exact.test.ts).
  let email: string | null | undefined;
  try {
    email = await sessionEmail(id);
  } catch (error) {
    console.error("reading the session to log out everywhere failed");
    email = undefined;
  }
  // A session let in without its second step cannot log the others out (lib/two-step.ts).
  if (email && (await lockedUntil(id)) > 0) {
    return new Response(null, { status: 303, headers: { Location: `${originFrom(request)}/studio?two-step=locked` } });
  }
  // Said as done only when it was: sessions that could not be read are said as such (audit SG2, rule 27).
  const ended = email === undefined ? null : email ? await endAllSessions(email) : 0;

  const response = new Response(null, {
    status: 303,
    headers: { Location: `${originFrom(request)}/signin?status=${ended === null ? "out-everywhere-unknown" : "out-everywhere"}` },
  });
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
  return response;
}
