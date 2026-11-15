import type { NextRequest } from "next/server";
import { inviterFor } from "@/lib/creator-invites";
import { INVITE_CODE_PATTERN, INVITE_COOKIE, INVITE_COOKIE_DAYS, INVITE_PROGRAM_OPEN } from "@/lib/creator-invite-rules";
import { fromAnotherSite } from "@/lib/request-guard";

/**
 * "Accept the invite": keeps the code on this browser so the store made next
 * counts as invited (lib/creator-invites.ts), then goes on to sign-up.
 *
 * The cookie is set only here, when the person presses the button that asks
 * for it — opening an invite link sets nothing. A code nobody has, or whose
 * store is gone, sets nothing either and leads back to the page that says so.
 *
 * Only on a POST from this site (MM-SA-55): the button is a form, and a GET, which any other site can make with a link
 * or an image, keeps nothing and leads back to the invite's page, where the button is.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toLowerCase();
  return new Response(null, { status: 303, headers: { Location: `/invite/${encodeURIComponent(code)}`, "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  // Refused before anything else is read: another site, by Origin or by Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (!INVITE_PROGRAM_OPEN) return new Response(null, { status: 303, headers: { Location: "/signin?status=invite-paused", "Cache-Control": "no-store" } });
  const code = (await params).code.toLowerCase();
  const inviter = INVITE_CODE_PATTERN.test(code) ? await inviterFor(code).catch(() => null) : null;
  if (!inviter) {
    return new Response(null, { status: 303, headers: { Location: `/invite/${encodeURIComponent(code)}`, "Cache-Control": "no-store" } });
  }
  const secure = request.nextUrl.protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/signin?status=invite-accepted",
      "Cache-Control": "no-store",
      "Set-Cookie": `${INVITE_COOKIE}=${code}; Path=/; Max-Age=${INVITE_COOKIE_DAYS * 86_400}; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
