import type { NextRequest } from "next/server";
import { finishConnect } from "@/lib/meet-routes";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { finishSearchConsole, isSearchConsoleState } from "@/lib/search-console";
import { originFrom } from "@/lib/request-origin";
import { GOOGLE_STATE_COOKIE, clearGoogleStateCookie, finishGoogleSignIn, isGoogleSignInState, readGoogleStateCookie } from "@/lib/google-signin";
import { finishProvenSignIn } from "@/lib/signin-finish";
import { clientAddress, withinLimit } from "@/lib/request-guard";
import { withPrefill } from "@/lib/handle-prefill";

/**
 * Where Google sends the person back after its consent page: the redirect
 * address registered with it, https://marktmorgen.com/api/integrations/google/callback.
 * A creator connecting Google Calendar (lib/meet-routes.ts checks the state,
 * the session and the store), or the person who runs the site connecting
 * Search Console (lib/search-console.ts), or somebody logging in with Google
 * (lib/google-signin.ts), told apart by the state.
 */
export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state") ?? "";
  if (isGoogleSignInState(state)) return googleSignIn(request, state);
  if (isSearchConsoleState(state)) {
    const email = await emailForSession(request.cookies.get(SESSION_COOKIE)?.value ?? "").catch(() => null);
    const error = request.nextUrl.searchParams.get("error");
    const result = await finishSearchConsole(state, error ? "" : request.nextUrl.searchParams.get("code") ?? "", email);
    return new Response(null, { status: 303, headers: { Location: `${originFrom(request)}/studio?gsc=${result}#numbers`, "Cache-Control": "no-store" } });
  }
  return finishConnect(request, "google");
}

/** Answers back from Google one browser may bring in ten minutes. */
const TRIES = 20;

async function googleSignIn(request: NextRequest, state: string): Promise<Response> {
  const origin = originFrom(request);
  const kept = readGoogleStateCookie(request.cookies.get(GOOGLE_STATE_COOKIE)?.value);
  const back = (status: string) => {
    const response = new Response(null, { status: 303, headers: { Location: `${origin}/signin?status=${status}`, "Cache-Control": "no-store" } });
    response.headers.append("Set-Cookie", clearGoogleStateCookie());
    return response;
  };
  if (!(await withinLimit("google-signin-back", clientAddress(request), TRIES, 10 * 60))) return back("google-slow");
  const result = await finishGoogleSignIn(
    state,
    kept.state,
    request.nextUrl.searchParams.get("code") ?? "",
    Boolean(request.nextUrl.searchParams.get("error")),
  );
  if (!result.ok) return back(result.reason === "expired" ? "google-expired" : `google-${result.reason}`);
  const response = await finishProvenSignIn(request, result.email, "google", withPrefill("/studio", kept.handle), "/signin?status=google-error");
  response.headers.append("Set-Cookie", clearGoogleStateCookie());
  return response;
}
