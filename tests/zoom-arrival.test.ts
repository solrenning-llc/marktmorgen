/**
 * Arriving for Zoom, and checking that a connection works.
 *
 * Zoom's reviewer opened the Video calls page (1 October 2026) and found no
 * place to authorize Zoom. The listing's link offers Zoom on the visit that
 * carries its word — but somebody who opens it without being logged in is
 * sent to log in and make a store first, and the word is gone by the time
 * they are back. And once connected, nothing on the page showed that a
 * meeting is really made until a buyer booked a call. Zoom is played by a
 * stand-in for `fetch`. What is checked:
 *
 *   - opening the link sets a cookie that says only "came for Zoom", on that
 *     page and with those words alone;
 *   - a browser that carries it is offered Zoom's form with no word in the
 *     address, and one that does not is still refused;
 *   - a test meeting is made on the connected account with the same call a
 *     booking's is, one at a time, and deleted there when asked;
 *   - it is forgotten with the connection, and a provider that fails says so.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingConnections } from "@/components/meeting-connections";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { NotConnected, beginConsent, disconnect, finishConsent, meetView } from "@/lib/meet-connect";
import { GOOGLE_HOST_SCOPES, ProviderError, ZOOM_ARRIVAL_COOKIE, cameForZoom } from "@/lib/meet-providers";
import { startConnect, startHostConnect, finishConnect } from "@/lib/meet-routes";
import { TEST_MEETING_MINUTES, TEST_MEETING_TITLE, TEST_MOVE_MINUTES, makeTest, moveTest, readTests, removeTest, TestMeetingUnavailable } from "@/lib/meet-test";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { proxy } from "@/proxy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { allowanceUsed } from "@/lib/store-allowance";
import { hostId } from "@/lib/host-claims";

const HOST = "marktmorgen.com";

type Seen = { method: string; url: string; body: string };
const seen: Seen[] = [];
let failMeetings = 0;
let meetingNumber = 86_000_000_000;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  seen.push({ method, url: `${url.origin}${url.pathname}`, body: typeof init?.body === "string" ? init.body : "" });
  const json = (status: number, value: unknown) => new Response(status === 204 ? null : JSON.stringify(value), { status });
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/token") {
    return json(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "meeting:write:meeting meeting:read:meeting user:read:user" });
  }
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/revoke") return json(200, { status: "success" });
  if (url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me") return json(200, { id: "zoomUser01", email: "host@example.com", first_name: "Jenny", last_name: "Park" });
  if (url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me/meetings" && method === "POST") {
    if (failMeetings > 0) {
      failMeetings -= 1;
      return json(500, { code: 500, message: "Internal error" });
    }
    meetingNumber += 1;
    return json(201, { id: meetingNumber, join_url: `https://us05web.zoom.us/j/${meetingNumber}?pwd=abc` });
  }
  if (url.hostname === "api.zoom.us" && /^\/v2\/meetings\/\d+$/.test(url.pathname) && method === "DELETE") return json(204, null);
  if (url.hostname === "api.zoom.us" && /^\/v2\/meetings\/\d+$/.test(url.pathname) && method === "PATCH") return json(204, null);
  return json(404, { message: "no stand-in" });
}) as typeof fetch;

function page(path: string, cookie = ""): NextRequest {
  return new NextRequest(`https://${HOST}${path}`, { headers: { host: HOST, ...(cookie ? { cookie } : {}) } });
}

function post(path: string, cookie: string): NextRequest {
  return new NextRequest(`https://${HOST}${path}`, { method: "POST", headers: { host: HOST, origin: `https://${HOST}`, cookie } });
}

async function main(): Promise<void> {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "g-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "g-secret";
  process.env.ZOOM_CLIENT_ID = "z-id";
  process.env.ZOOM_CLIENT_SECRET = "z-secret";
  process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";
  delete process.env.ZOOM_LIVE;
  redis.clear();

  part("The link in Zoom's listing leaves a note in the browser");
  const cookieOf = async (path: string) => (await proxy(page(path))).cookies.get(ZOOM_ARRIVAL_COOKIE);
  const fromListing = await cookieOf("/studio/meetings?from=zoom");
  is("opened from the listing: the cookie is set", fromListing?.value, "1");
  is("for thirty days, out of reach of scripts, sent on a link followed back", [fromListing?.maxAge, fromListing?.httpOnly, fromListing?.sameSite, fromListing?.secure, fromListing?.path], [30 * 86_400, true, "lax", true, "/"]);
  is("the review link sets it too", (await cookieOf("/studio/meetings?zoom=review"))?.value, "1");
  is("the page without a word does not", await cookieOf("/studio/meetings"), undefined);
  is("nor another word", await cookieOf("/studio/meetings?from=google&zoom=1"), undefined);
  is("nor the same words on another page", [await cookieOf("/studio?from=zoom"), await cookieOf("/?from=zoom"), await cookieOf("/@harbor?from=zoom")], [undefined, undefined, undefined]);
  is("it is read as it was set, and nothing else is", [cameForZoom(page("/", `${ZOOM_ARRIVAL_COOKIE}=1`).cookies), cameForZoom(page("/", `${ZOOM_ARRIVAL_COOKIE}=yes`).cookies), cameForZoom(page("/").cookies)], [true, false, false]);

  part("A browser that carries it is offered Zoom");
  const claimed = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!claimed.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  const shop = (await storeForEmail("owner@example.com"))!;
  const statsId = shop.statsId as string;
  const session = await openSession("owner@example.com");
  const pin = `store=${shop.sid}`;
  const without = await startConnect(post(`/api/integrations/zoom/start?${pin}`, `${SESSION_COOKIE}=${session}`), "zoom");
  is("without it, and without the word: not found", without.status, 404);
  const carried = await startConnect(post(`/api/integrations/zoom/start?${pin}`, `${SESSION_COOKIE}=${session}; ${ZOOM_ARRIVAL_COOKIE}=1`), "zoom");
  is("with it: sent to Zoom's consent page", [carried.status, new URL(carried.headers.get("location") ?? "https://none.invalid/").hostname], [303, "zoom.us"]);
  const google = await startConnect(post(`/api/integrations/google/start?${pin}`, `${SESSION_COOKIE}=${session}; ${ZOOM_ARRIVAL_COOKIE}=1`), "google");
  is("Google's form is not changed by it", new URL(google.headers.get("location") ?? "https://none.invalid/").hostname, "accounts.google.com");
  const pages = ["app/studio/meetings/page.tsx", "app/studio/page.tsx"].map((f) => readFileSync(f, "utf8"));
  is("the Video calls page and the studio both read it", pages.map((p) => p.includes("cameForZoom(")), [true, true]);
  is("the studio says where to go", pages[1].includes("You came here to connect Zoom."), true);
  is("the proxy reads rules that import nothing", /^import /m.test(readFileSync("lib/zoom-arrival.ts", "utf8")), false);

  part("Nothing to test before an account is connected");
  const early = await makeTest(shop, "zoom").catch((error) => error);
  is("says it is not connected", early instanceof NotConnected, true);
  is("and removing one that is not there does nothing", await removeTest(statsId, "zoom"), false);

  part("A test meeting on the connected account");
  // startedAt: when the consent flow began, which finishConsent now needs (lib/meet-connect.ts KEEP_UNLESS_GONE, Claude 5 zoom-forget-race).
  const connected = await finishConsent("zoom", { statsId, code: "code-1", verifier: "v".repeat(43), by: "owner@example.com", owner: { email: "owner@example.com", handle: "harbor" }, startedAt: Date.now() });
  is("connected", connected.ok && connected.view.account, "host@example.com");
  is("and it stays in sight, offered or not", (await meetView(statsId, shop)).providers, ["google", "zoom"]);
  seen.length = 0;
  const NOW = Date.UTC(2026, 9, 5, 17, 2, 30);
  const test = await makeTest(shop, "zoom", NOW);
  const made = seen.filter((s) => s.method === "POST" && s.url === "https://api.zoom.us/v2/users/me/meetings");
  is("one meeting is asked of Zoom, on the user's own account", made.length, 1);
  const sent = JSON.parse(made[0].body) as { topic: string; type: number; start_time: string; duration: number; timezone: string };
  is("a scheduled meeting, named as a test", [sent.topic, sent.type], [TEST_MEETING_TITLE, 2]);
  is("an hour from now, on the next five minutes", [new Date(test.start).toISOString(), sent.duration, sent.timezone], ["2026-10-05T18:05:00.000Z", TEST_MEETING_MINUTES, "UTC"]);
  is("its join link comes back", [test.id, test.link], [String(meetingNumber), `https://us05web.zoom.us/j/${meetingNumber}?pwd=abc`]);
  is("and is kept for the page", (await readTests(statsId, ["google", "zoom"])).zoom?.id, test.id);
  const again = await makeTest(shop, "zoom", NOW + 60_000);
  is("asked twice: the same one, and Zoom is not asked again", [again.id, seen.filter((s) => s.method === "POST" && s.url.endsWith("/users/me/meetings")).length], [test.id, 1]);

  part("Moving it, as a buyer's move does");
  seen.length = 0;
  const moved = await moveTest(shop, "zoom");
  const patched = seen.filter((s) => s.method === "PATCH");
  is("one change is asked of Zoom, on that meeting", patched.map((s) => s.url), [`https://api.zoom.us/v2/meetings/${test.id}`]);
  const shifted = JSON.parse(patched[0].body) as { start_time: string; duration: number; timezone: string };
  is(
    "an hour later, the same length",
    [shifted.start_time.replace(/Z$/, ".000Z").replace(/\.000\.000Z$/, ".000Z"), shifted.duration, shifted.timezone],
    [new Date(test.start + TEST_MOVE_MINUTES * 60_000).toISOString(), TEST_MEETING_MINUTES, "UTC"],
  );
  is("the same meeting and link, at the new time, kept for the page", [moved?.id, moved?.link, moved?.start, (await readTests(statsId, ["zoom"])).zoom?.start], [test.id, test.link, test.start + TEST_MOVE_MINUTES * 60_000, test.start + TEST_MOVE_MINUTES * 60_000]);

  part("Deleting it");
  seen.length = 0;
  is("deleted", await removeTest(statsId, "zoom"), true);
  is("on Zoom, by its own number", seen.filter((s) => s.method === "DELETE").map((s) => s.url), [`https://api.zoom.us/v2/meetings/${test.id}`]);
  is("and forgotten here", await readTests(statsId, ["zoom"]), {});
  is("with none left, there is nothing to move", await moveTest(shop, "zoom"), null);

  part("A provider that fails");
  failMeetings = 1;
  const failed = await makeTest(shop, "zoom", NOW).catch((error) => error);
  is("says what happened", failed instanceof ProviderError && failed.kind, "server");
  is("and nothing is kept as if it had worked", await readTests(statsId, ["zoom"]), {});
  const after = await makeTest(shop, "zoom", NOW);
  is("the next try makes it", /^\d{11}$/.test(after.id), true);

  part("Funded new test work refuses while the existing meeting and cleanup remain accessible");
  await setSubscription("owner@example.com", { customerId: "cus_MeetFunded001", subscriptionId: "sub_MeetFunded001", active: true, tier: "creator", cycle: "month", trialEnds: 0, period: { ...paidPeriod(), funded: true } });
  const funded = (await storeForEmail("owner@example.com"))!;
  seen.length = 0;
  is("an existing meeting is returned without new work", (await makeTest(funded, "zoom")).id, after.id);
  const refusedMove = await moveTest(funded, "zoom").catch((error) => error);
  is("a new provider move needs financial approval", refusedMove instanceof TestMeetingUnavailable, true);
  is("no credential refresh or provider request, and the meeting is unchanged", [seen.length, (await readTests(statsId, ["zoom"])).zoom], [0, after]);
  is("retained removal is still available", await removeTest(statsId, "zoom"), true);
  is("removal uses the existing provider cleanup", seen.filter((entry) => entry.method === "DELETE").length, 1);
  seen.length = 0;
  const refusedCreate = await makeTest(funded, "zoom").catch((error) => error);
  is("a new test meeting requires financial approval", refusedCreate instanceof TestMeetingUnavailable, true);
  is("no provider request or test record", [seen.length, await readTests(statsId, ["zoom"])], [0, {}]);
  part("Funded optional connection starts refuse before OAuth state and integration allowance");
  const beforeConnectUnits = await allowanceUsed(funded, "integration");
  const ownerStart = await startConnect(post(`/api/integrations/zoom/start?${pin}`, `${SESSION_COOKIE}=${session}; ${ZOOM_ARRIVAL_COOKIE}=1`), "zoom");
  const ownerDestination = new URL(ownerStart.headers.get("location") ?? "https://none.invalid/");
  is("owner remains at the studio instead of a new consent", [ownerStart.status, ownerDestination.hostname, ownerDestination.searchParams.get("meet")], [303, HOST, "funding"]);
  const previousHostScopes = process.env.GOOGLE_CALENDAR_SYNC_SCOPES;
  try {
    process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";
    const hostStart = await startHostConnect(post(`/api/integrations/google/host/start?${pin}`, `${SESSION_COOKIE}=${session}`));
    const hostDestination = new URL(hostStart.headers.get("location") ?? "https://none.invalid/");
    is("a member's optional host consent is also refused", [hostStart.status, hostDestination.hostname, hostDestination.searchParams.get("cal")], [303, HOST, "funding"]);
  } finally {
    if (previousHostScopes === undefined) delete process.env.GOOGLE_CALENDAR_SYNC_SCOPES;
    else process.env.GOOGLE_CALENDAR_SYNC_SCOPES = previousHostScopes;
  }
  is("no provider request or extra integration allowance", [seen.length, await allowanceUsed(funded, "integration")], [0, beforeConnectUnits]);
  part("A callback rechecks funding before exchanging new provider credentials");
  const consentInput = { statsId, sid: funded.sid, sessionCookie: session, email: "owner@example.com" };
  const callbackFor = async (provider: "zoom" | "google", host = false, decline = false) => {
    // Synthetic state models consent started before funding ceased to be available.
    const consentUrl = await beginConsent(provider, { ...consentInput, ...(host ? { host: hostId("owner@example.com"), scopes: GOOGLE_HOST_SCOPES } : {}) });
    const state = new URL(consentUrl).searchParams.get("state") ?? "";
    const query = new URLSearchParams({ state });
    query.set(decline ? "error" : "code", decline ? "access_denied" : "synthetic-code");
    return finishConnect(page(`/api/integrations/${provider}/callback?${query}`, `${SESSION_COOKIE}=${session}`), provider);
  };
  const ownerReturn = await callbackFor("zoom");
  is("new owner credentials are refused after state validation", [ownerReturn.status, new URL(ownerReturn.headers.get("location")!).searchParams.get("meet")], [303, "funding"]);
  const ownerDecline = await callbackFor("zoom", false, true);
  is("canceling remains available without funding", new URL(ownerDecline.headers.get("location")!).searchParams.get("meet"), "declined");
  const previousReturnScopes = process.env.GOOGLE_CALENDAR_SYNC_SCOPES;
  try {
    process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";
    const hostReturn = await callbackFor("google", true);
    is("new host credentials are also refused", [hostReturn.status, new URL(hostReturn.headers.get("location")!).searchParams.get("cal")], [303, "funding"]);
    const hostDecline = await callbackFor("google", true, true);
    is("host canceling remains available", new URL(hostDecline.headers.get("location")!).searchParams.get("cal"), "declined");
  } finally {
    if (previousReturnScopes === undefined) delete process.env.GOOGLE_CALENDAR_SYNC_SCOPES;
    else process.env.GOOGLE_CALENDAR_SYNC_SCOPES = previousReturnScopes;
  }
  is("no token exchange, provider lookup or new connection", seen.length, 0);



  part("Forgotten with the connection");
  await disconnect(statsId, "zoom");
  is("disconnecting forgets the test meeting", await readTests(statsId, ["zoom"]), {});
  const gone = await makeTest(shop, "zoom").catch((error) => error);
  is("and a new one cannot be made", gone instanceof NotConnected, true);

  part("Where it is offered");
  const route = readFileSync("app/api/integrations/meetings/route.ts", "utf8");
  is("only the owner and Admins can make or delete one", /guardStoreWrite\(request, "settings"/.test(route) && route.includes('action === "test"'), true);
  is("a failure is written where every meeting's failure is", route.includes("logProblem("), true);
  // Render the real card instead of matching the spelling of its JSX guard.
  // A working connection still offers the test; broken or disabled ones do not.
  const card = (broken: string, disabled = false) => renderToStaticMarkup(createElement(MeetingConnections, {
    view: { providers: ["zoom"], connected: { zoom: { provider: "zoom", account: "host@example.com", connectedAt: 1, by: "owner@example.com", broken } }, problems: [] },
    pin: "", disabledProviders: disabled ? ["zoom"] : [],
  }));
  is("the card offers a test only for a working configured connection", [card("").includes('data-meet-test="zoom"'), card("Access was withdrawn").includes('data-meet-test="zoom"'), card("", true).includes('data-meet-test="zoom"')], [true, false, false]);
  is("and the guide says how", readFileSync("app/help/zoom/page.tsx", "utf8").includes("Make a test meeting"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
