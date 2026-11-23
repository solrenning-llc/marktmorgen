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

let revokes = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (init?.method !== "POST" || !u.pathname.endsWith("/revoke")) throw Error("Unexpected synthetic provider request");
  revokes++;
  return new Response("{}", { status: 200 });
}) as typeof fetch;

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

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
