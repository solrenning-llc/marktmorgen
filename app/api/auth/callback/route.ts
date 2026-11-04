import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { takeSignInLink } from "@/lib/auth";
import { finishProvenSignIn } from "@/lib/signin-finish";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { withPrefill } from "@/lib/handle-prefill";

/**
 * Finishing the emailed link.
 *
 * A GET spends nothing. Mail filters fetch every link in a message to inspect
 * it, and a one-time link that a GET could spend would be used up before the
 * creator ever tapped it. So a GET only carries the token to the page that
 * asks for a tap, and the POST that tap makes is what opens the session.
 */

function redirectTo(origin: string, path: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin}${path}` },
  });
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const origin = originFrom(request);
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return redirectTo(origin, "/signin?status=expired");
  }
  return redirectTo(origin, withPrefill(`/signin/confirm?token=${token}`, request.nextUrl.searchParams.get("handle")));
}

export async function POST(request: NextRequest) {
  const origin = originFrom(request);

  // A form on another site must not be able to sign this browser into an
  // account of the attacker's choosing.
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let token = "";
  let handle: unknown = null;
  try {
    const form = await (await limited(request, 8_000)).formData();
    const value = form.get("token");
    token = typeof value === "string" ? value : "";
    // The store address from the home page, if the link carried a valid one:
    // read again here and only ever put in the studio's address, never kept.
    handle = form.get("handle");
  } catch {
    return redirectTo(origin, "/signin?status=expired");
  }

  let owner: string | null = null;
  try {
    owner = await takeSignInLink(token);
  } catch (error) {
    console.error("sign-in callback failed", error);
  }
  // Two-step login, the session, the recovery address, the browser this was
  // in: the same for every proven address (lib/signin-finish.ts).
  return finishProvenSignIn(request, owner, "link", withPrefill("/studio", handle));
}
