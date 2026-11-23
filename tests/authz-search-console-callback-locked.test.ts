/**
 * #5285 row #3930 (Codex X6's MEDIUM on the merged head 7bff5c173f): the operator's Search Console form refuses a
 * session let in without its second step (lib/two-step.ts enterLocked), but Google's way back
 * (app/api/integrations/google/callback/route.ts) did not. A connection started while the session was full could be
 * finished by a locked session of the same operator: the code exchanged and the sealed refresh token kept. The way
 * back now refuses a locked session as the form does, before Google is asked anything, and keeps nothing.
 * Synthetic operator, in-memory Redis, no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { openLockedSession } from "@/lib/two-step";
import { beginSearchConsole } from "@/lib/search-console";
import { GET } from "@/app/api/integrations/google/callback/route";
import { store as redis } from "@/tests/redis-stub";
import { done, is, part } from "@/tests/check";

// tests/test-config.mjs testEnvironment sets DEMO_STUDIO_ADMIN to this address.
const OPERATOR = "operator@example.test";
const CONN = "nl:gsc:conn";
process.env.GOOGLE_OAUTH_CLIENT_ID ??= "synthetic-client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET ??= "synthetic-client-secret";

let asked = 0;
globalThis.fetch = (async () => {
  asked += 1;
  // What Google answers a good code with: the scope asked and a refresh token.
  return new Response(JSON.stringify({ scope: "openid email https://www.googleapis.com/auth/webmasters.readonly", refresh_token: "synthetic-refresh-token" }));
}) as typeof fetch;

const back = (session: string, state: string) =>
  GET(new NextRequest(`https://marktmorgen.com/api/integrations/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` } }));
const stateOf = (url: string | null) => new URL(String(url)).searchParams.get("state") ?? "";

async function main(): Promise<void> {
  redis.clear();

  part("A locked session of the operator does not finish a connection");
  const lockedState = stateOf(await beginSearchConsole(OPERATOR));
  is("a consent page was started", lockedState.startsWith("gsc."), true);
  const locked = await openLockedSession(OPERATOR, Date.now() + 7 * 86_400_000);
  asked = 0;
  const refused = await back(locked, lockedState);
  is("RED: it is sent back with nothing connected", new URL(String(refused.headers.get("location"))).searchParams.get("gsc") === "connected", false);
  is("RED: Google is not asked to exchange the code", asked, 0);
  is("RED: no connection is kept", redis.keys().includes(CONN), false);

  part("The operator's full session still finishes one");
  const fullState = stateOf(await beginSearchConsole(OPERATOR));
  const full = await openSession(OPERATOR);
  const connected = await back(full, fullState);
  is("connected", new URL(String(connected.headers.get("location"))).searchParams.get("gsc"), "connected");
  is("and the connection is kept", redis.keys().includes(CONN), true);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
