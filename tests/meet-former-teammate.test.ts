/**
 * Issue #4010 (synthetic only): a Google Calendar or Zoom account an Admin
 * connected with their own sign-in kept being used after that Admin was taken
 * off the team, or moved to a role without "settings". Every new booking then
 * put an event with the buyer's name and address in that former teammate's own
 * calendar (lib/meet-providers.ts googleCreate, from lib/meet-links.ts).
 *
 * Expected, read at each use (lib/meet-connect.ts accessFor) and in the
 * studio's view (meetView, meetSettingsView): a store's connection is used only
 * when whoever connected it is the store's owner (now, or the owner it was
 * connected for, who may have moved their address since) or someone on the
 * team now whose role allows "settings"; a team host's own calendar only while
 * that host is the owner or on the team. Anything else needs connecting again:
 * it is neither deleted nor given back here (#4011), and works again if the
 * person is put back. A team read in an unknown shape (CX-123 rule 24) refuses
 * the access, never takes it as allowed. The owner's own connection never
 * waits on the team record.
 */
import { finishConsent, accessFor, meetView, meetSettingsView, NotConnected } from "@/lib/meet-connect";
import { meetingFor } from "@/lib/meet-links";
import { hostId } from "@/lib/host-claims";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { putMember, removeMember, setMemberRole } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "meet-left-owner@example.com";
const ADMIN = "meet-left-admin@example.com";
const HOSTED = "meet-left-host@example.com";
const OTHER = "meet-left-other@example.com";

function idToken(email: string): string {
  const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part64({ alg: "none" })}.${part64({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}

/** Every request that left this process. The code traded is the address of the Google account it connects. */
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  asked.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
  if (url.pathname === "/google/token") {
    const code = new URLSearchParams(String(init?.body ?? "")).get("code") ?? "unknown@example.com";
    return answer({ access_token: `at-${code}`, refresh_token: `rt-${code}`, expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/calendar.events", id_token: idToken(code) });
  }
  if (url.pathname.includes("/events")) return answer({ id: "evt", hangoutLink: "https://meet.google.com/abc-defg-hij", conferenceData: { createRequest: { status: { statusCode: "success" } } } });
  return answer({ error: "not in this test" }, 404);
}) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/** Runs work with every GET of `key` answered by `reply`. */
async function withGet<T>(key: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    return commands.map((c, at) => (c[0] === "GET" && c[1] === key ? reply : replies[at]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** What accessFor answered, in words: the Google account it handed out, or why it refused. */
async function access(store: Store, host = ""): Promise<string> {
  try {
    const got = await accessFor(store.statsId as string, "google", undefined, host, store);
    return `account ${got.account}`;
  } catch (error) {
    if (error instanceof NotConnected) return error.broken ? "needs connecting again" : "not connected";
    if (error instanceof UnknownReplyError) return "unknown";
    return `other: ${String(error).slice(0, 80)}`;
  }
}

async function connect(store: Store, by: string, host = ""): Promise<boolean> {
  const result = await finishConsent("google", { statsId: store.statsId as string, code: by || "nobody@example.com", verifier: "v".repeat(43), by, owner: { email: store.email, handle: store.handle }, ...(host ? { host } : {}) });
  return result.ok;
}

const brokenIn = async (view: Promise<{ connected: { google?: { broken: string } } }>) => {
  const google = (await view).connected.google;
  return google ? (google.broken ? "needs connecting again" : "works") : "none";
};

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "meet-left-shop", "Meet Left Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MeetLeft001", subscriptionId: "sub_MeetLeft001", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  is("(setup) the store has a team id and a stats id", Boolean(store.sid && store.statsId), true);
  is("(setup) an Admin and a host on the team", [await putMember(store, ADMIN, "admin"), await putMember(store, HOSTED, "support")], [true, true]);
  is("(setup) an Admin may change settings, an Editor may not", [can("admin", "settings"), can("editor", "settings")], [true, false]);
  const teamKey = `nl:team:${store.sid}`;

  part("Control: the Admin's own Google account, while they are an Admin");
  is("(setup) the Admin connects Google with their own account", await connect(store, ADMIN), true);
  is("it is used", await access(store), `account sub-${ADMIN}`);
  is("the studio shows it working", await brokenIn(meetView(store.statsId, store)), "works");

  part("A: the Admin is moved to a role without settings");
  is("(setup) moved to Editor", (await setMemberRole(store, ADMIN, "editor")).ok, true);
  is("their account is not used", await access(store), "needs connecting again");
  is("the studio asks to connect it again", await brokenIn(meetView(store.statsId, store)), "needs connecting again");
  is("the settings view says the same", await brokenIn(meetSettingsView(store.statsId, store)), "needs connecting again");
  is("(setup) moved back to Admin", (await setMemberRole(store, ADMIN, "admin")).ok, true);
  is("nothing was deleted: it is used again", await access(store), `account sub-${ADMIN}`);

  part("B: the Admin is taken off the team");
  is("(setup) removed", await removeMember(store, ADMIN), true);
  store = (await storeForEmail(OWNER))!;
  is("their account is not used", await access(store), "needs connecting again");
  is("the studio asks to connect it again", await brokenIn(meetView(store.statsId, store)), "needs connecting again");
  const before = asked.length;
  const record = await meetingFor({
    store,
    provider: "google",
    scope: "meet-left:booking-1",
    group: false,
    product: "p1",
    session: "cs_meet_left_1",
    title: "Intro call",
    description: "A call",
    start: Date.now() + 86_400_000,
    end: Date.now() + 86_400_000 + 1_800_000,
    tz: "UTC",
    guest: "buyer.meet-left@example.com",
    fallback: async () => "https://example.com/own-room",
  });
  is("a new booking puts nothing in the former Admin's calendar", asked.slice(before).filter((a) => a.includes("/events")), []);
  is("the booking gets the creator's own link instead", record.link, "https://example.com/own-room");
  is("nothing was given back to Google here (#4011)", asked.filter((a) => a.includes("revoke")), []);

  part("Rule 24: the team read in an unknown shape refuses a teammate's connection");
  is("(setup) the Admin is put back", await putMember(store, ADMIN, "admin"), true);
  is("(setup) used again once back", await access(store), `account sub-${ADMIN}`);
  for (const [label, reply] of [["a number", 42], ["text that is not JSON", "not json"], ["JSON without members", JSON.stringify({ invites: [] })], ["undefined", undefined]] as [string, unknown][]) {
    is(`team read as ${label}: refused as unknown`, await withGet(teamKey, reply, () => access(store)), "unknown");
  }

  part("Control: the owner's own connection");
  is("(setup) the owner connects their own Google account", await connect(store, OWNER), true);
  is("it is used", await access(store), `account sub-${OWNER}`);
  is("it never waits on the team record", await withGet(teamKey, 42, () => access(store)), `account sub-${OWNER}`);
  is("after the owner moves their address, it is still theirs", await access({ ...store, email: "meet-left-owner-new@example.com" }), `account sub-${OWNER}`);
  const elsewhere = await accessFor(store.statsId as string, "google", undefined, "", { ...store, statsId: "x".repeat(24) }).then(() => "used", (e) => (e instanceof NotConnected ? "not connected" : "other"));
  is("never used with another store's team", elsewhere, "not connected");

  part("A connection with nobody recorded as having connected it");
  is("(setup) written with no maker", await connect(store, ""), true);
  is("not used", await access(store), "needs connecting again");

  part("A team host's own calendar");
  const host = hostId(HOSTED);
  is("(setup) the host connects their own Google Calendar", await connect(store, HOSTED, host), true);
  is("used while they are on the team", await access(store, host), `account sub-${HOSTED}`);
  is("(setup) the host is taken off the team", await removeMember(store, HOSTED), true);
  store = (await storeForEmail(OWNER))!;
  is("not used once they left", await access(store, host), "needs connecting again");
  const ownHost = hostId(OWNER);
  is("(setup) the owner connects their own host calendar", await connect(store, OWNER, ownHost), true);
  is("the owner's host calendar is used", await access(store, ownHost), `account sub-${OWNER}`);
  is("a stranger's host slot is not used for this store", await access(store, hostId(OTHER)), "not connected");

  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
