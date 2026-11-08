/**
 * Rule 24 for a team host's own Google Calendar: when the stored connection
 * cannot be read (Redis failed or answered nothing usable), or Google's
 * calendar list fails for a reason a new connection would not fix, the host
 * is never told "Connect your Google Calendar first" (google_none) and the
 * page never draws the connection as missing. It says the connection could
 * not be checked just now ("unavailable"), nothing is changed, and booking
 * stays blocked. A connection confirmed absent, or one Google says no longer
 * works, still asks for connecting (lib/host-calendar.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { beginConsent, finishConsent, takeConsent } from "@/lib/meet-connect";
import { hostId } from "@/lib/host-claims";
import { GOOGLE_HOST_SCOPES } from "@/lib/meet-providers";
import { POST as hostCalendar } from "@/app/api/store/host-calendar/route";
import { disconnectHostGoogle, hostCalendarView, hostSync, setHostCalendars, setHostSource } from "@/lib/host-calendar";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";
process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "host-unknown-conn@example.com";
const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;

function idToken(email: string): string {
  const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part64({ alg: "none" })}.${part64({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}

/** What Google's calendar list answers: 200 lists the primary calendar. */
let listStatus = 200;
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  asked.push(`${url.hostname}${url.pathname}`);
  if (url.pathname === "/google/token") {
    return answer({ access_token: "at-host", refresh_token: "rt-host", expires_in: 3600, scope: GOOGLE_HOST_SCOPES.join(" "), id_token: idToken(OWNER) });
  }
  if (url.pathname === "/google/calendar/v3/users/me/calendarList") {
    if (listStatus !== 200) return answer({ error: { status: listStatus === 401 ? "UNAUTHENTICATED" : "BACKEND_ERROR" } }, listStatus);
    return answer({ items: [{ id: OWNER, summary: "Mine", primary: true, accessRole: "owner" }] });
  }
  return answer({ error: "not in this test" }, 404);
}) as typeof fetch;

const pipeline = redis.pipeline.bind(redis);
/** How the host's stored Google connection is read: as stored, failing, or with no usable reply. */
function connectionRead(mode: "real" | "throws" | "nothing"): void {
  redis.pipeline = (async (sent: (string | number)[][]) => {
    const reads = sent.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:meet:conn:"));
    if (reads && mode === "throws") throw new Error("connection read failed");
    if (reads && mode === "nothing") return undefined as never;
    return pipeline(sent);
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "host-unknown-conn-shop", "Host Unknown Connection Shop", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const cal = async (body: Record<string, unknown>) => {
    const res = await hostCalendar(new NextRequest(`${ORIGIN}/api/store/host-calendar?store=${store.sid}`, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
      body: JSON.stringify({ tz: "UTC", ...body }),
    }));
    return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
  };

  part("Control: a connected host is shown connected and can choose Google");
  const url = await beginConsent("google", { statsId: store.statsId!, sid: store.sid!, sessionCookie: session, email: OWNER, host: hostId(OWNER), scopes: GOOGLE_HOST_SCOPES });
  const taken = await takeConsent("google", new URL(url).searchParams.get("state") ?? "", { sessionCookie: session, email: OWNER });
  const connected = taken ? await finishConsent("google", { statsId: taken.statsId, code: "good", verifier: taken.verifier, by: OWNER, owner: { email: store.email, handle: store.handle }, host: taken.host }) : { ok: false };
  is("the host's Google Calendar is connected", connected.ok, true);
  const healthy = await hostCalendarView(store, OWNER, "UTC");
  is("the page shows the connection and does not call it unread", [healthy.google?.account ?? null, healthy.googleUnread === true], [OWNER, false]);
  is("choosing calendars goes through", await setHostCalendars(store, OWNER, [], ""), null);
  is("picking Google as the source goes through", await setHostSource(store, OWNER, "google"), null);
  is("picking no source again goes through", await setHostSource(store, OWNER, "none"), null);

  for (const mode of ["throws", "nothing"] as const) {
    part(`The stored connection cannot be read (${mode}): unavailable, never "connect first"`);
    connectionRead(mode);
    const from = asked.length;
    const view = await hostCalendarView(store, OWNER, "UTC");
    is("the page says the connection could not be checked", view.googleUnread, true);
    is("the page does not draw it as connected either", view.google, null);
    is("Google's list is not asked for on an unread connection", asked.slice(from).filter((a) => a.endsWith("/calendarList")), []);
    is("picking Google as the source is unavailable, not google_none", await setHostSource(store, OWNER, "google"), "unavailable");
    is("choosing calendars is unavailable, not google_none", await setHostCalendars(store, OWNER, [], ""), "unavailable");
    const routed = await cal({ action: "source", source: "google" });
    is("the route answers 503 unavailable", [routed.status, routed.body.error], [503, "unavailable"]);
    connectionRead("real");
    is("nothing was changed: the source is still none", (await hostCalendarView(store, OWNER, "UTC")).source, "none");
  }

  part("Busy times with Google as source and an unread connection: blocked, honestly worded");
  is("picking Google as the source goes through while readable", await setHostSource(store, OWNER, "google"), null);
  connectionRead("throws");
  const sync = await hostSync(store, OWNER, "UTC", { refresh: false });
  is("the host stays blocked", [sync.state, sync.blocked], ["failed", true]);
  is("it never says Google is not connected", sync.message === "Google Calendar is not connected.", false);
  is("it says the connection could not be checked just now", /could not be checked just now/.test(sync.message), true);
  connectionRead("real");

  part("Google's list fails: a server error is unavailable, a dead connection asks for connecting");
  listStatus = 503;
  is("a Google server error is unavailable, not google_none", await setHostCalendars(store, OWNER, [], ""), "unavailable");
  listStatus = 401;
  is("Google saying the access no longer works still asks for connecting", await setHostCalendars(store, OWNER, [], ""), "google_none");
  listStatus = 200;

  part("Control: a connection confirmed absent still asks for connecting");
  await disconnectHostGoogle(store, OWNER);
  const absent = await hostCalendarView(store, OWNER, "UTC");
  is("the page offers connecting, not an unread state", [absent.google, absent.googleUnread === true], [null, false]);
  is("picking Google is google_none", await setHostSource(store, OWNER, "google"), "google_none");
  is("choosing calendars is google_none", await setHostCalendars(store, OWNER, [], ""), "google_none");

  part("The screen says it honestly");
  const card = readFileSync(join(process.cwd(), "components/host-calendar.tsx"), "utf8");
  is("the card has its own sentence for unavailable", /unavailable: "[^"]+"/.test(card), true);
  is("the card draws the unread connection state", card.includes("view.googleUnread"), true);
  done();
}

main();
