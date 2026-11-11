/**
 * A store's Google Calendar or Zoom connection, and a team host's own Google
 * one (lib/meet-connect.ts), is read only in its exact shape (CX-123 rule 24;
 * found during #3158).
 *
 * "Not connected" is said only for a confirmed none: the slot of the GET
 * answered null. Text kept there that is not a connection (damaged) is still
 * no usable connection, and connecting again replaces it. Any other reply (a
 * slot that is missing, a number, true, a list, an object, a pipeline answer
 * that is not one reply per command, a problem list that is not a list of
 * text) is unknown and throws UnknownReplyError. Then:
 *   - the Video calls view and the providers a booking can use are not said
 *     as "none connected";
 *   - an access token is never refused as "not connected", and nothing is
 *     disconnected, forgotten or given back over a connection that may be there;
 *   - saving a call or a live event that uses Google or Zoom answers 503
 *     "meet_unknown" (nothing saved, nothing to reconnect), never
 *     "meet_google"/"meet_zoom", which asks the creator to connect again;
 *   - the community's event form says the connection could not be checked,
 *     instead of "connect it again".
 *
 * Synthetic store and Redis (tests/redis-stub.ts); every outbound request
 * throws and is counted, so no provider is reached.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { accessFor, disconnect, finishConsent, forgetUser, hostConnectionView, meetSettingsView, meetView, NotConnected, usableProviders } from "@/lib/meet-connect";
import { POST as saveCall } from "@/app/api/store/call/route";
import { POST as manageCommunity } from "@/app/api/store/community/manage/route";
import { POST as saveEvent } from "@/app/api/store/community/events/route";
import { MESSAGES as CALL_MESSAGES } from "@/components/call-editor";
import { redisPipeline } from "@/lib/redis";
import { seal } from "@/lib/secret-box";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import type { MeetProvider } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_meet_connect_unknown";
process.env.GOOGLE_OAUTH_CLIENT_ID = "synthetic-google-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "synthetic-google-secret";
process.env.ZOOM_CLIENT_ID = "synthetic-zoom-client";
process.env.ZOOM_CLIENT_SECRET = "synthetic-zoom-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "synthetic-zoom-token";

let outbound: string[] = [];
/** Only while true does a stand-in Zoom answer its consent: the code traded, the user read, a grant given back. */
let zoomAnswers = false;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  // Stripe's list reads of the call route (bookings to come): none.
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  outbound.push(`${url.origin}${url.pathname}`);
  if (zoomAnswers && url.hostname === "zoom.us" && url.pathname === "/oauth/token") {
    return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: "meeting:write:meeting user:read:user" });
  }
  if (zoomAnswers && url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me") return json({ id: "acct-zoom-new", email: "new@example.test", first_name: "New" });
  if (zoomAnswers && url.hostname === "zoom.us" && url.pathname === "/oauth/revoke") return json({ status: "success" });
  throw Error("Unexpected external request in a synthetic test");
}) as typeof fetch;

type Commands = (string | number)[][];
const OWNER = "meet.unknown@example.com";
const HOST = "a".repeat(24);
const ORIGIN = "https://marktmorgen.com";
const connKey = (statsId: string, provider: MeetProvider) => `nl:meet:conn:${statsId}:${provider}`;
const hostKey = (host: string) => `nl:meet:conn:hosts:google:h:${host}`;

/** A working connection, as keepConnection writes one, with an access token good for an hour. */
function connection(statsId: string, provider: MeetProvider, host = ""): string {
  const context = (part: string) => (host ? `meet|hosts|${provider}|h:${host}|${part}` : `meet|${statsId}|${provider}|${part}`);
  return JSON.stringify({
    provider,
    account: { id: `acct-${provider}`, email: `${provider}@example.test`, name: provider },
    access: seal(`tok-${provider}`, context("access")),
    expires: Date.now() + 3_600_000,
    refresh: seal(`refresh-${provider}`, context("refresh")),
    scope: "calendar",
    connectedAt: 1,
    by: OWNER,
    owner: { email: OWNER, handle: "meetshop" },
    broken: "",
    brokenAt: 0,
  });
}

const pipe = redis.pipeline.bind(redis);
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
/** Where Zoom's uninstall notice finds the stores a Zoom user connected. */
const userKey = (provider: MeetProvider, id: string) => `nl:meet:user:${provider}:${hash(`meet-user:${provider}:${id}`)}`;
const isConn = (command: (string | number)[]) => command[0] === "GET" && typeof command[1] === "string" && command[1].startsWith("nl:meet:conn:");
/** The real store's replies, with every GET of a connection's key answered as given. */
const answering = (reply: unknown) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (isConn(commands[i]) ? reply : r));
  }) as typeof redis.pipeline;
};
/** The whole answer of a pipeline that reads a connection replaced as given; every other pipeline is real. */
const answeringAll = (replies: unknown) => {
  redis.pipeline = (async (commands: Commands) => (commands.some(isConn) ? replies : pipe(commands))) as unknown as typeof redis.pipeline;
};
/** The problem list's reply (LRANGE) answered as given. */
const answeringLog = (reply: unknown) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (commands[i][0] === "LRANGE" ? reply : r));
  }) as typeof redis.pipeline;
};
const restore = () => {
  redis.pipeline = pipe as typeof redis.pipeline;
};
const outcome = async <T,>(run: () => Promise<T>): Promise<string> => {
  try {
    return JSON.stringify(await run());
  } catch (error) {
    if (error instanceof NotConnected) return `not connected: ${error.message}`;
    // Main's deletion pass wraps what stopped it (IncompleteForget, lib/meet-connect.ts): its cause is what is read.
    const cause = (error as Error).name === "IncompleteForget" ? ((error as Error).cause as Error | undefined) : (error as Error);
    return cause?.name === "UnknownReplyError" ? "unknown" : `other: ${(error as Error).message}`;
  }
};
const kept = async (key: string) => (await redisPipeline([["GET", key]]))[0];

type World = { sid: string; statsId: string; session: string; productId: string };

/** A fresh synthetic store, on a paid plan with Stripe, one product and a signed-in session. */
async function setUp(): Promise<World> {
  redis.clear();
  restore();
  await claimHandle(OWNER, "meetshop", "Meet Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMeet00001", true);
  await setSubscription(OWNER, { customerId: "cus_meet00001", subscriptionId: "sub_meet00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  return { sid: store.sid, statsId: store.statsId as string, session: await openSession(OWNER), productId: made.product.id };
}

async function keepBoth(statsId: string): Promise<void> {
  await redisPipeline([
    ["SET", connKey(statsId, "google"), connection(statsId, "google")],
    ["SET", connKey(statsId, "zoom"), connection(statsId, "zoom")],
    ["SET", hostKey(HOST), connection(statsId, "google", HOST)],
  ]);
}

async function post(world: World, route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>): Promise<[number, string]> {
  const response = await route(
    new NextRequest(`${ORIGIN}/api/store/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nimbus-store": world.sid, cookie: `${SESSION_COOKIE}=${world.session}` },
      body: JSON.stringify(body),
    }),
  );
  return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
}

const SAY_UNKNOWN = "Your video call connections could not be checked just now, so nothing was saved. They may still be connected, so you do not need to connect again. Try again in a moment.";

async function main(): Promise<void> {
  part("Controls: kept connections, and a confirmed none, read as before");
  let world = await setUp();
  let SID = world.statsId;
  await keepBoth(SID);
  const view = await meetView(SID);
  is("healthy: both accounts are in the view", [view.providers, Object.keys(view.connected), view.problems], [["google", "zoom"], ["google", "zoom"], []]);
  is("healthy: both can be used for bookings", await usableProviders(SID), ["google", "zoom"]);
  is(
    "healthy: Google's and Zoom's tokens are opened, no request out",
    [await outcome(() => accessFor(SID, "google")), await outcome(() => accessFor(SID, "zoom")), outbound.length],
    [JSON.stringify({ token: "tok-google", account: "acct-google" }), JSON.stringify({ token: "tok-zoom", account: "acct-zoom" }), 0],
  );
  is("healthy: a team host's own Google is read", (await hostConnectionView(SID, HOST))?.account, "google@example.test");
  world = await setUp();
  SID = world.statsId;
  is("confirmed none: no account in the view", Object.keys((await meetView(SID)).connected), []);
  is("confirmed none: none for bookings", await usableProviders(SID), []);
  is(
    "confirmed none: Google and Zoom say not connected",
    [await outcome(() => accessFor(SID, "google")), await outcome(() => accessFor(SID, "zoom"))],
    ["not connected: Google Calendar is not connected", "not connected: Zoom is not connected"],
  );
  is("confirmed none: a host has none", await outcome(() => hostConnectionView(SID, HOST)), "null");
  is("confirmed none: disconnecting says there was none", await outcome(() => disconnect(SID, "google")), "null");
  await redisPipeline([["SET", connKey(SID, "google"), "{cut"]]);
  is("damaged text kept there is no usable connection (connecting again replaces it)", [Object.keys((await meetView(SID)).connected), await usableProviders(SID)], [[], []]);

  const odd: [string, unknown][] = [
    ["a missing slot (undefined)", undefined],
    ["a number", 42],
    ["true", true],
    ["a list", ["{}"]],
    ["an object, not text", { provider: "google" }],
  ];
  for (const [label, reply] of odd) {
    part(`A connection's reply that is ${label}: unknown, never "not connected"`);
    world = await setUp();
    SID = world.statsId;
    await keepBoth(SID);
    await redisPipeline([["SADD", userKey("zoom", "acct-zoom"), SID]]);
    outbound = [];
    answering(reply);
    is(`${label}: the view throws unknown`, await outcome(() => meetView(SID)), "unknown");
    is(`${label}: the settings view throws unknown`, await outcome(() => meetSettingsView(SID, { sid: world.sid, email: OWNER })), "unknown");
    is(`${label}: the providers for bookings throw unknown`, await outcome(() => usableProviders(SID)), "unknown");
    is(`${label}: Google's access is unknown, not "not connected"`, await outcome(() => accessFor(SID, "google")), "unknown");
    is(`${label}: Zoom's access is unknown, not "not connected"`, await outcome(() => accessFor(SID, "zoom")), "unknown");
    is(`${label}: a host's own Google is unknown, not none`, await outcome(() => hostConnectionView(SID, HOST)), "unknown");
    is(`${label}: disconnecting is unknown, not "there was none"`, await outcome(() => disconnect(SID, "zoom")), "unknown");
    is(`${label}: Zoom's uninstall notice is unknown, not "nothing to forget"`, await outcome(() => forgetUser("zoom", "acct-zoom")), "unknown");
    restore();
    is(
      `${label}: every connection is still kept, the uninstall list too, and nothing was given back`,
      [Boolean(await kept(connKey(SID, "google"))), Boolean(await kept(connKey(SID, "zoom"))), Boolean(await kept(hostKey(HOST))), (await redisPipeline([["SCARD", userKey("zoom", "acct-zoom")]]))[0], outbound],
      [true, true, true, 1, []],
    );
  }

  // The uninstall list itself (SMEMBERS) answered in another shape: Zoom's
  // notice is unknown, so Zoom retries, and the list that finds the store's
  // connection is kept, never deleted as if nobody were on it.
  const oddMembers: [string, unknown][] = [
    ["a number", 42],
    ["an object", { 0: SID }],
    ["missing", undefined],
    ["a list with a number", [SID, 7]],
    ["null", null],
  ];
  for (const [label, reply] of oddMembers) {
    part(`Zoom's uninstall list answered as ${label}: unknown, never "nobody to forget"`);
    await keepBoth(SID);
    await redisPipeline([["SADD", userKey("zoom", "acct-zoom"), SID]]);
    redis.pipeline = (async (commands: Commands) => {
      const replies = await pipe(commands);
      return replies.map((r, i) => (commands[i][0] === "SMEMBERS" ? reply : r));
    }) as typeof redis.pipeline;
    is(`${label}: forgetUser is unknown (so Zoom retries), not "nothing to forget"`, await outcome(() => forgetUser("zoom", "acct-zoom")), "unknown");
    restore();
    is(`${label}: the uninstall list and the connection are still kept`, [(await redisPipeline([["SCARD", userKey("zoom", "acct-zoom")]]))[0], Boolean(await kept(connKey(SID, "zoom")))], [1, true]);
  }
  part("Zoom's uninstall list, healthy and confirmed empty");
  await keepBoth(SID);
  await redisPipeline([["SADD", userKey("zoom", "acct-zoom"), SID]]);
  is("healthy: the store's connection is forgotten, and the list with it", [await outcome(async () => (await forgetUser("zoom", "acct-zoom")).map((f) => f.statsId)), Boolean(await kept(connKey(SID, "zoom"))), (await redisPipeline([["SCARD", userKey("zoom", "acct-zoom")]]))[0]], [JSON.stringify([SID]), false, 0]);
  is("confirmed empty: nothing to forget", await outcome(() => forgetUser("zoom", "acct-nobody")), "[]");

  part("A new Zoom grant whose earlier connection cannot be read: given back, never left granted");
  await keepBoth(SID);
  outbound = [];
  zoomAnswers = true;
  answering(42);
  const consent = { statsId: SID, code: "code-1", verifier: "v".repeat(43), by: OWNER, owner: { email: OWNER, handle: "meetshop" } };
  is("finishConsent throws unknown", await outcome(() => finishConsent("zoom", consent)), "unknown");
  restore();
  zoomAnswers = false;
  is("the grant Zoom just gave is given back", outbound.filter((u) => u === "https://zoom.us/oauth/revoke").length, 1);
  is("and the connection kept before is untouched", JSON.parse(String(await kept(connKey(SID, "zoom")))).account.id, "acct-zoom");
  part("Control: a healthy new Zoom grant is kept, not given back");
  outbound = [];
  zoomAnswers = true;
  const healthy = await outcome(async () => (await finishConsent("zoom", consent)).ok);
  zoomAnswers = false;
  is("healthy: kept", [healthy, JSON.parse(String(await kept(connKey(SID, "zoom")))).account.id], ["true", "acct-zoom-new"]);
  is("healthy: only the replaced account's grant is given back", outbound.filter((u) => u === "https://zoom.us/oauth/revoke").length, 1);

  const oddAll: [string, unknown][] = [
    ["a number", 42],
    ["an object", { 0: null }],
    ["an empty list", []],
    ["one reply too many", [null, null, null, null]],
  ];
  for (const [label, replies] of oddAll) {
    part(`A whole answer that is ${label}: unknown`);
    answeringAll(replies);
    is(`${label}: the view throws unknown`, await outcome(() => meetView(SID)), "unknown");
    is(`${label}: Google's access throws unknown`, await outcome(() => accessFor(SID, "google")), "unknown");
    is(`${label}: a host's own Google throws unknown`, await outcome(() => hostConnectionView(SID, HOST)), "unknown");
    restore();
  }

  part("The problem list in another shape: unknown, never an empty list");
  for (const [label, reply] of [["a number", 7], ["a list with a number", ["{}", 7]], ["missing", undefined]] as [string, unknown][]) {
    answeringLog(reply);
    is(`${label}: the view throws unknown`, await outcome(() => meetView(SID)), "unknown");
    restore();
  }
  is("control: an empty problem list reads as none", (await meetView(SID)).problems, []);

  part("Saving a call that uses Google: unknown is 503 meet_unknown, never meet_google");
  world = await setUp();
  SID = world.statsId;
  const call = { kind: "weekly", minutes: 30, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []], noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: "google", seats: 1 };
  const meetOf = async () => (await readProduct((await storeForEmail(OWNER))!, world.productId))?.call?.meet ?? null;
  is("confirmed none: refused as not connected (meet_google)", await post(world, saveCall, "call", { id: world.productId, call }), [400, "meet_google"]);
  await keepBoth(SID);
  answering(42);
  is("unknown: 503 meet_unknown", await post(world, saveCall, "call", { id: world.productId, call }), [503, "meet_unknown"]);
  restore();
  is("and nothing was saved", await meetOf(), null);
  is("healthy: saved", await post(world, saveCall, "call", { id: world.productId, call }), [200, "ok"]);
  is("and it uses Google", await meetOf(), "google");
  is("the call editor says it in words: nothing saved, no need to connect again", CALL_MESSAGES.meet_unknown, SAY_UNKNOWN);

  part("Saving a live event that uses Zoom: unknown is 503 meet_unknown, never meet_zoom");
  is("the community is set up", await post(world, manageCommunity, "community/manage", { action: "enable", on: true }), [200, "ok"]);
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const event = { title: "Live Q&A", about: "", date: day, time: "15:00", tz: "UTC", minutes: 60, where: "meet", meet: "zoom", cap: "" };
  answering(true);
  is("unknown: 503 meet_unknown", await post(world, saveEvent, "community/events", { action: "create", ...event }), [503, "meet_unknown"]);
  answering(null);
  is("confirmed none: refused as not connected (meet_zoom)", await post(world, saveEvent, "community/events", { action: "create", ...event }), [400, "meet_zoom"]);
  restore();
  const eventsSource = readFileSync("components/community-events-studio.tsx", "utf8");
  is("the event editor says it in words", eventsSource.includes(`meet_unknown: "${SAY_UNKNOWN}"`), true);

  part("The community's event form, when the connections could not be read");
  // Inside the open form, which a page drawn on the server never shows open: read in its source.
  is("the page passes the unread state to the form", readFileSync("app/studio/community/page.tsx", "utf8").includes("meetUnread={meetUnread}"), true);
  is(
    "a saved Google or Zoom choice says it could not be checked, not 'connect it again'",
    eventsSource.includes("connection just now. It may still be connected, so you do not need to connect it again. Reload this page in a moment."),
    true,
  );
  is(
    "and the place choice says, as a status, why Google and Zoom are not offered",
    /role="status"[^>]*>\s*Your Google Calendar and Zoom connections could not be checked just now, so they are not offered here\. Reload this page in a moment\./.test(eventsSource),
    true,
  );
  // An event saved with Zoom keeps its Zoom choice on screen (with its own "could not check" note): "not offered
  // here" beside it would contradict what the page shows, and say the same thing twice (VR item 2; AX274 3.3.5).
  is(
    "that status is drawn only when no Google or Zoom choice is on screen above it",
    [/const meetChoices = \(\["google", "zoom"\] as const\)\.filter\(/.test(eventsSource), /\{meetChoices\.map\(/.test(eventsSource), /\{meetUnread && meetChoices\.length === 0 \? \(\s*<p className="mt-1 text-sm text-ink-soft" role="status">/.test(eventsSource)],
    [true, true, true],
  );

  restore();
  done();
}

void main();
