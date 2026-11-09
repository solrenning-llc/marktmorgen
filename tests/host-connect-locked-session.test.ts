/**
 * A session let in without its second step cannot connect a host's own
 * Google Calendar (pre-review C of claude5/auth-failure-caps, the sibling of
 * the phone in tests/phone-locked-session.test.ts, rule 30).
 *
 * The connection is the person's, not the session's: it reads when they are
 * busy and writes the team bookings they host, and logging that session out
 * leaves it on. So, like a new phone, it waits for a session opened with the
 * second step. Checked through app/api/integrations/google/start (?for=host)
 * and the callback, with the in-memory Redis:
 *
 *   - a locked session is sent back as locked, never to Google's consent;
 *   - a consent started before the lock is not finished by a locked session;
 *   - a session with its second step (or without two-step login) still goes
 *     to Google's consent.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { lockedOut, openLockedSession } from "@/lib/two-step";
import { beginConsent } from "@/lib/meet-connect";
import { hostId } from "@/lib/host-claims";
import { GOOGLE_HOST_SCOPES } from "@/lib/meet-providers";
import { POST as googleStart } from "@/app/api/integrations/google/start/route";
import { GET as googleCallback } from "@/app/api/integrations/google/callback/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";
const ORIGIN = "https://marktmorgen.com";
const start = (session: string) =>
  googleStart(new NextRequest(`${ORIGIN}/api/integrations/google/start?for=host`, { method: "POST", headers: { Host: "marktmorgen.com", Origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session}` } }));

async function main(): Promise<void> {
  redis.clear();
  const owner = "host@host-locked.example";
  await claimHandle(owner, "host-locked", "Host Locked", "");
  const store = (await ensureStatsId(owner))!;

  part("A locked session tries to connect its own Google Calendar");
  const locked = await openLockedSession(owner, Date.now() + 7 * 86_400_000);
  const where = (await start(locked)).headers.get("location") ?? "";
  is("it is sent back as locked, not to Google's consent", [/two-step=locked/.test(where), where.startsWith("https://accounts.google.com/")], [true, false]);
  is("the action is held by name, under the permission every team member has", lockedOut("member", "host-connect"), true);

  part("A consent that reaches the callback in a locked session is not finished");
  const state = new URL(await beginConsent("google", { statsId: store.statsId!, sid: store.sid, sessionCookie: locked, email: owner, host: hostId(owner), scopes: GOOGLE_HOST_SCOPES })).searchParams.get("state") ?? "";
  const back = await googleCallback(new NextRequest(`${ORIGIN}/api/integrations/google/callback?state=${encodeURIComponent(state)}&code=abc`, { headers: { Host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${locked}` } }));
  is("sent back as locked", /two-step=locked/.test(back.headers.get("location") ?? ""), true);

  part("A session with its second step, or without two-step login, still goes to Google");
  const open = await openSession(owner);
  is("to Google's consent page", ((await start(open)).headers.get("location") ?? "").startsWith("https://accounts.google.com/"), true);
  done();
}

void main();
