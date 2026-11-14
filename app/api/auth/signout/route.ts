import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { SESSION_COOKIE, endSession } from "@/lib/auth";
import { fromAnotherSite } from "@/lib/request-guard";
import { clearedSessionCookies } from "@/lib/session-cookie";

/** Closes the session here and in the browser. */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  // This browser's cookie goes whatever happens; "logged out" is said only when the session is known gone at the
  // server too. Otherwise the page says it may still be open (CX-123 rule 24; tests/auth-sessions-exact.test.ts).
  const ended = await endSession(request.cookies.get(SESSION_COOKIE)?.value);

  const response = new Response(null, {
    status: 303,
    headers: { Location: `${originFrom(request)}/signin?status=${ended ? "out" : "out-unknown&to=login"}` },
  });
  // Both names the session may be under (lib/session-cookie.ts).
  for (const cleared of clearedSessionCookies(process.env.NODE_ENV === "production")) response.headers.append("Set-Cookie", cleared);
  return response;
}
