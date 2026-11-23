/**
 * Claude 3 wSUb3's MEDIUM on #5476 (7114365391, again 7116084958): a team host's own Google Calendar connected before
 * the account's index listed hosts (h:<host>) is not in that index, so a store's disconnect counted nobody else on
 * the account and gave back the grant the host's calendar still used: its next refresh fails (invalid_grant), the
 * failure of issue #4011.
 *
 * A store's Google disconnect that finds nobody else listed now also reads the host connections the store may have
 * (its owner and its team, by their host ids) before giving the grant back: one on the same Google account keeps the
 * grant, is answered as shared, and is listed in the account's index (a repair). One on another account changes
 * nothing. A read that does not answer throws before anything is deleted or given back.
 *
 * The same review, again (7116841447): the other places that give a store's grant back decided on the index only. A
 * store reconnecting Google with another account gave back the old grant the owner's unlisted calendar used; a keep
 * that lost its lock, or a flow that expired while its code was traded, gave back the new one. Each now counts the
 * unlisted host calendars too, before it gives a store's Google grant back.
 *
 * Synthetic only: fetch is mocked, no provider is called, every token and address is made up here.
 */
import { createHash } from "node:crypto";
import * as connect from "@/lib/meet-connect";
import { hostId } from "@/lib/host-claims";
import { seal } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const A = "s0000000000000000-unlistA01";
const SID = "0123456789abcdef0123456789abcdef";
const OWNER = "owner-unlisted@example.test";
const MEMBER = "member-unlisted@example.test";
const ACCOUNT = "synthetic-unlisted-account";
const OTHER = "synthetic-other-account";
type Outcome = { view: connect.DisconnectedView | null; providerAccessRemoved: boolean; sharedGrantKept?: boolean };
const disconnectFor = connect.disconnectFor as (
  statsId: string,
  provider: "google" | "zoom",
  host?: string,
  store?: { sid: string; email: string },
) => Promise<Outcome>;
const STORE = { sid: SID, email: OWNER };

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";

/** The Google account a consent comes back with (the id token's sub), and the refresh token it trades. */
const NEW_EMAIL = "new-account@example.test";
const NEW_ACCOUNT = `sub-${NEW_EMAIL}`;
function idToken(email: string): string {
  const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part64({ alg: "none" })}.${part64({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}

let revokes = 0;
const revoked: string[] = [];
/** Run once the code is traded, before the keep (the expired-flow case moves the clock there). */
let afterTrade: () => void = () => {};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (init?.method === "POST" && u.pathname === "/google/token") {
    afterTrade();
    return new Response(
      JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/calendar.events", id_token: idToken(NEW_EMAIL) }),
      { status: 200 },
    );
  }
  if (init?.method !== "POST" || !u.pathname.endsWith("/revoke")) throw Error("Unexpected synthetic provider request");
  revokes++;
  revoked.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? "");
  return new Response("{}", { status: 200 });
}) as typeof fetch;

type Consent = { statsId: string; sid?: string; code: string; verifier: string; by: string; owner: { email: string; handle: string }; startedAt: number };
const finishConsent = connect.finishConsent as unknown as (provider: "google", input: Consent) => Promise<connect.ConnectResult>;
/** Store A's owner connecting Google from the store's settings, the consent's store id passed along (beginConsent's sid). */
async function reconnect(): Promise<string> {
  try {
    const result = await finishConsent("google", { statsId: A, sid: SID, code: "code", verifier: "v".repeat(43), by: OWNER, owner: { email: OWNER, handle: "fixture" }, startedAt: Date.now() });
    return result.ok ? `kept ${result.view.account}` : `refused ${result.error}`;
  } catch (error) {
    return (error as Error).name;
  }
}

const userKey = (account: string) => `nl:meet:user:google:${createHash("sha256").update(`meet-user:google:${account}`).digest("hex").slice(0, 40)}`;
const storeKey = `nl:meet:conn:${A}:google`;
const hostKey = (email: string) => `nl:meet:conn:hosts:google:h:${hostId(email)}`;
function connection(account: string, host = "") {
  const ctx = (which: string) => (host ? `meet|hosts|google|h:${host}|${which}` : `meet|${A}|google|${which}`);
  return JSON.stringify({
    provider: "google",
    account: { id: account, email: "shared@example.test", name: "" },
    refresh: seal("synthetic-grant", ctx("refresh")),
    access: seal("synthetic-grant", ctx("access")),
    expires: 0,
    scope: "",
    connectedAt: 1,
    by: OWNER,
    owner: { email: OWNER, handle: "fixture" },
    broken: "",
    brokenAt: 0,
  });
}

/** Store A connected and listed; the host connected before hosts were listed, so the index holds [A] only. */
async function seed(hostEmail: string, hostAccount: string, storeRecord = connection(ACCOUNT)) {
  redis.clear();
  revokes = 0;
  revoked.length = 0;
  await redis.pipeline([
    ["SET", storeKey, storeRecord],
    ["SADD", userKey(ACCOUNT), A],
    ["SET", hostKey(hostEmail), connection(hostAccount, hostId(hostEmail))],
    ["SET", `nl:team:${SID}`, JSON.stringify({ members: [{ email: MEMBER, role: "editor", joinedAt: "" }], invites: [] })],
  ]);
}

const get = async (key: string) => (await redis.pipeline([["GET", key]]))[0];
const listed = async (account: string, member: string) => (await redis.pipeline([["SISMEMBER", userKey(account), member]]))[0];

async function main() {
  for (const [who, email] of [["the store's owner", OWNER], ["a team member", MEMBER]] as const) {
    part(`${who}'s own calendar, kept before hosts were listed, on the store's Google account`);
    await seed(email, ACCOUNT);
    const hostText = await get(hostKey(email));
    const kept = await disconnectFor(A, "google", "", STORE);
    is("the store's disconnect keeps the grant the host's calendar uses", revokes, 0);
    is("and says it was kept for another connection", [kept.providerAccessRemoved, kept.sharedGrantKept ?? false], [false, true]);
    is("the store is disconnected here", await get(storeKey), null);
    is("the host's calendar connection is untouched", [typeof hostText, await get(hostKey(email))], ["string", hostText]);
    is("and the host is now listed in the account's index", await listed(ACCOUNT, `h:${hostId(email)}`), 1);

    part(`${who}'s own calendar on another Google account`);
    await seed(email, OTHER);
    const back = await disconnectFor(A, "google", "", STORE);
    is("the store's grant is given back once", revokes, 1);
    is("and said so", [back.providerAccessRemoved, back.sharedGrantKept ?? false], [true, false]);
    is("nothing is listed under the store's account", (await redis.pipeline([["SCARD", userKey(ACCOUNT)]]))[0], 0);
    is("the other account's host is not listed by it either", await listed(OTHER, `h:${hostId(email)}`), 0);
  }

  part("A damaged store connection with its account id still in it, the owner's calendar unlisted on that account");
  // The text does not read as a connection (no refresh field in the shape parseConnection needs), but its account id
  // and a sealed access still open (salvage): the same unlisted host check runs before the grant is given back.
  const damaged = JSON.parse(connection(ACCOUNT)) as Record<string, unknown>;
  damaged.provider = "something-else";
  await seed(OWNER, ACCOUNT, JSON.stringify(damaged));
  const salvaged = await disconnectFor(A, "google", "", STORE);
  is("the grant the owner's calendar uses is kept", [revokes, salvaged.sharedGrantKept ?? false], [0, true]);
  is("the damaged text is deleted", await get(storeKey), null);
  is("and the owner's calendar is listed", await listed(ACCOUNT, `h:${hostId(OWNER)}`), 1);

  part("The hosts' connections cannot be read: nothing is deleted or given back");
  await seed(MEMBER, ACCOUNT);
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "MGET")) return [{ unexpected: true }];
    return real(commands);
  }) as typeof redis.pipeline;
  const unread = await disconnectFor(A, "google", "", STORE).catch((error: unknown) => error);
  redis.pipeline = real;
  is("the disconnect throws unknown", unread instanceof Error ? unread.name : "answered", "UnknownReplyError");
  is("nothing is revoked", revokes, 0);
  is("and the store's connection is still there", typeof (await get(storeKey)), "string");

  part("The store's team cannot be read: nothing is deleted or given back");
  await seed(MEMBER, ACCOUNT);
  await redis.pipeline([["SET", `nl:team:${SID}`, "{not a team"]]);
  const noTeam = await disconnectFor(A, "google", "", STORE).catch((error: unknown) => error);
  is("the disconnect throws unknown", noTeam instanceof Error ? noTeam.name : "answered", "UnknownReplyError");
  is("nothing is revoked", revokes, 0);
  is("and the store's connection is still there", typeof (await get(storeKey)), "string");
  await redis.pipeline([["SET", `nl:team:${SID}`, JSON.stringify({ members: [{ email: MEMBER, role: "editor", joinedAt: "" }], invites: [] })]]);
  const retried = await disconnectFor(A, "google", "", STORE);
  is("a retry that reads keeps the grant the member's calendar uses", [revokes, retried.sharedGrantKept ?? false], [0, true]);

  // Claude 3 wSUb3, 7116841447: the store reconnects Google with another account.
  for (const [who, email] of [["the store's owner", OWNER], ["a team member", MEMBER]] as const) {
    part(`A store reconnecting Google with another account, ${who}'s unlisted calendar on the old one`);
    await seed(email, ACCOUNT);
    const hostText = await get(hostKey(email));
    is("the new account is connected", await reconnect(), `kept ${NEW_EMAIL}`);
    is("the old grant the host's calendar uses is not given back", revoked, []);
    is("the host's calendar connection is untouched", await get(hostKey(email)), hostText);
    is("and the host is now listed under the old account", await listed(ACCOUNT, `h:${hostId(email)}`), 1);
    is("the store left the old account's index", await listed(ACCOUNT, A), 0);
  }

  part("A store reconnecting Google with another account, the owner's calendar on a third account");
  await seed(OWNER, OTHER);
  is("the new account is connected", await reconnect(), `kept ${NEW_EMAIL}`);
  is("the old grant, used by nothing here, is given back once", revoked, ["synthetic-grant"]);
  is("and the owner's calendar is not listed under the old account", await listed(ACCOUNT, `h:${hostId(OWNER)}`), 0);

  part("A store reconnecting with another account, the hosts' connections unread: the old grant is kept");
  await seed(OWNER, ACCOUNT);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "MGET")) return [{ unexpected: true }];
    return real(commands);
  }) as typeof redis.pipeline;
  const quiet = console.error;
  console.error = () => {};
  const unreadHosts = await reconnect();
  console.error = quiet;
  redis.pipeline = real;
  is("the new account is still connected", unreadHosts, `kept ${NEW_EMAIL}`);
  is("and nothing is given back on an unread answer", revoked, []);

  part("A store's keep that loses its lock, the owner's unlisted calendar on the account it came back with");
  await seed(OWNER, NEW_ACCOUNT);
  await redis.pipeline([["DEL", storeKey], ["SREM", userKey(ACCOUNT), A]]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const keep = commands.find((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:meet-keep:"));
    if (keep) await real([["DEL", String(keep[3])]]);
    return real(commands);
  }) as typeof redis.pipeline;
  const lostLock = await reconnect();
  redis.pipeline = real;
  is("the keep fails as a lost lock", lostLock, "LockBusyError");
  is("no store connection is kept", await get(storeKey), null);
  is("the new grant the owner's calendar uses is not given back", revoked, []);
  is("and the owner is listed under that account", await listed(NEW_ACCOUNT, `h:${hostId(OWNER)}`), 1);

  part("Control: a lost lock with nothing here on that account gives the new grant back");
  await seed(OWNER, OTHER);
  await redis.pipeline([["DEL", storeKey], ["SREM", userKey(ACCOUNT), A]]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const keep = commands.find((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:meet-keep:"));
    if (keep) await real([["DEL", String(keep[3])]]);
    return real(commands);
  }) as typeof redis.pipeline;
  const lostAlone = await reconnect();
  redis.pipeline = real;
  is("the keep fails as a lost lock", lostAlone, "LockBusyError");
  is("and the new grant goes back", revoked, ["rt-new"]);

  part("A store's earlier connection that does not read, the owner's unlisted calendar on the new account");
  await seed(OWNER, NEW_ACCOUNT);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === storeKey) return [{ unexpected: true }];
    return real(commands);
  }) as typeof redis.pipeline;
  const priorUnread = await reconnect();
  redis.pipeline = real;
  is("the keep stops on the unread prior", priorUnread, "UnknownReplyError");
  is("the new grant the owner's calendar uses is not given back", revoked, []);

  part("A store's flow that expires while its code is traded, the owner's unlisted calendar on the new account");
  await seed(OWNER, NEW_ACCOUNT);
  await redis.pipeline([["DEL", storeKey], ["SREM", userKey(ACCOUNT), A]]);
  const realNow = Date.now;
  afterTrade = () => {
    const later = realNow() + 3 * 600_000;
    Date.now = () => later;
  };
  const expired = await reconnect();
  Date.now = realNow;
  afterTrade = () => {};
  is("the flow keeps nothing", expired, "refused expired");
  is("the new grant the owner's calendar uses is not given back", revoked, []);
  is("and the owner is listed under that account", await listed(NEW_ACCOUNT, `h:${hostId(OWNER)}`), 1);

  part("Control: an expired flow with nothing here on that account gives the new grant back");
  await seed(OWNER, OTHER);
  await redis.pipeline([["DEL", storeKey], ["SREM", userKey(ACCOUNT), A]]);
  afterTrade = () => {
    const later = realNow() + 3 * 600_000;
    Date.now = () => later;
  };
  const expiredAlone = await reconnect();
  Date.now = realNow;
  afterTrade = () => {};
  is("the flow keeps nothing", expiredAlone, "refused expired");
  is("and the new grant goes back", revoked, ["rt-new"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
