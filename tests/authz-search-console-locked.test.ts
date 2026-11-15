/**
 * Authorization sweep (claude7/authz-hunt): the operator's Search Console
 * form (POST /api/operator/search-console) checked the origin, the session
 * and that it is the operator's, but not whether the session was let in
 * without its second step (lib/two-step.ts enterLocked). Every studio route
 * that changes a setting refuses such a session (studioAccess -> lockedOut:
 * "settings" is in LOCKED_NEEDS); someone holding only the operator's inbox
 * could otherwise take the site's Search Console connection away or start a
 * new one. A locked session is now answered as anybody else is (404), and
 * nothing is changed. Synthetic operator, in-memory Redis, no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { openLockedSession } from "@/lib/two-step";
import { POST } from "@/app/api/operator/search-console/route";
import { store as redis } from "@/tests/redis-stub";
import { done, is, part } from "@/tests/check";

// tests/test-config.mjs testEnvironment sets DEMO_STUDIO_ADMIN to this address.
const OPERATOR = "operator@example.test";
const CONN = "nl:gsc:conn";

globalThis.fetch = async () => {
  throw new Error("External fetch forbidden");
};

const disconnect = (session: string) =>
  POST(
    new NextRequest("https://marktmorgen.com/api/operator/search-console", {
      method: "POST",
      headers: {
        host: "marktmorgen.com",
        origin: "https://marktmorgen.com",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${session}`,
      },
      body: "action=disconnect",
    }),
  );

async function main(): Promise<void> {
  redis.clear();
  await redis.pipeline([["SET", CONN, "synthetic-connection"]]);

  part("a session let in without its second step changes nothing");
  const locked = await openLockedSession(OPERATOR, Date.now() + 7 * 86_400_000);
  const refused = await disconnect(locked);
  is("locked operator session is answered as anybody else", refused.status, 404);
  is("the connection is kept", redis.keys().includes(CONN), true);

  part("the operator's full session still disconnects");
  const full = await openSession(OPERATOR);
  const done303 = await disconnect(full);
  is("full session is sent back to the studio", done303.status, 303);
  is("and the connection is gone", redis.keys().includes(CONN), false);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
