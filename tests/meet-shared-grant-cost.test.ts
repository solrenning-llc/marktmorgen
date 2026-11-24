/**
 * Claude 5 iYwjc's MEDIUM on #5476 @44f80c1b76 (7122788780), cost: counting who else uses a Google or Zoom grant
 * before it is given back (issue #4011) sends Redis commands the disconnect did not send before, and a Google one with
 * unlisted team host calendars sent up to about 29 billed commands where it sent about 6, with no figure or test.
 *
 * Upstash bills a script as one command plus one for each redis.call it runs. Each path is driven here at its worst
 * against the stand-in, every command sent counted and every script counted at the redis.calls in its own text (the
 * scripts here run no loop, so that is the most each one runs): a store's Google disconnect with its owner now, the
 * owner it was connected for and a full team (MAX_TEAM) all on the account and unlisted, its deletion's answer lost; a
 * damaged one with its deletion lost before it ran, so it is listed again; a consent that kept nothing; a team host's
 * account change. What each adds over the same request before #4011 (the shape it had on main, counted from the same
 * scripts) is held to SHARED_GRANT_EXTRA_COMMANDS, and that figure is priced on every studio request of the month in
 * the studio line of tests/plan-cost-registry.ts (meetSharedGrantUsd).
 *
 * Synthetic only: fetch is mocked, no provider is called, every token and address is made up here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as connect from "@/lib/meet-connect";
import { hostId } from "@/lib/host-claims";
import { RELEASE } from "@/lib/redis-lock";
import { MAX_TEAM } from "@/lib/team";
import { seal } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";

const named = connect as unknown as Record<string, unknown>;
const EXTRA = named.SHARED_GRANT_EXTRA_COMMANDS as number | undefined;
const A = "s0000000000000000-grantcostA";
const SID = "0123456789abcdef0123456789abcdef";
const OWNER = "owner-cost@example.test";
const OWNER_THEN = "owner-then-cost@example.test";
const TEAM = Array.from({ length: MAX_TEAM }, (_, i) => `member-${i}-cost@example.test`);
const ACCOUNT = "synthetic-cost-account";
const NEW_EMAIL = "new-cost@example.test";
const STORE = { sid: SID, email: OWNER };
type Outcome = { view: connect.DisconnectedView | null; providerAccessRemoved: boolean; sharedGrantKept?: boolean };
const disconnectFor = connect.disconnectFor as (statsId: string, provider: "google", host?: string, store?: { sid: string; email: string }) => Promise<Outcome>;
type Consent = { statsId: string; sid?: string; host?: string; code: string; verifier: string; by: string; owner: { email: string; handle: string }; startedAt: number };
const finishConsent = connect.finishConsent as unknown as (provider: "google", input: Consent) => Promise<connect.ConnectResult>;

function idToken(email: string): string {
  const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part64({ alg: "none" })}.${part64({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}
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
  return new Response("{}", { status: 200 });
}) as typeof fetch;

/** The redis.calls in a script's own text: the most it runs, since none of these loops. */
const calls = (script: string) => (script.match(/redis\.call\(/g) ?? []).length;
/** As Upstash bills them: each command, and each redis.call a script runs. */
const billedOf = (commands: (string | number)[][]) => commands.reduce((n, c) => n + 1 + (c[0] === "EVAL" ? calls(String(c[1])) : 0), 0);

const real = redis.pipeline.bind(redis);
let sent = 0;
/** "lose": the deletion script runs and its answer is lost; "drop": it is lost before it runs. */
let forget: "" | "lose" | "drop" = "";
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent += billedOf(commands);
  if (forget && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:meet-forget:"))) {
    const how = forget;
    forget = "";
    if (how === "lose") await real(commands);
    return [{ unexpected: true }];
  }
  return real(commands);
}) as typeof redis.pipeline;

const userKey = (account: string) => `nl:meet:user:google:${createHash("sha256").update(`meet-user:google:${account}`).digest("hex").slice(0, 40)}`;
const storeKey = `nl:meet:conn:${A}:google`;
const hostKey = (email: string) => `nl:meet:conn:hosts:google:h:${hostId(email)}`;
function connection(host = "", damaged = false) {
  const ctx = (which: string) => (host ? `meet|hosts|google|h:${host}|${which}` : `meet|${A}|google|${which}`);
  return JSON.stringify({
    provider: damaged ? "something-else" : "google",
    account: { id: ACCOUNT, email: "shared-cost@example.test", name: "" },
    refresh: seal("synthetic-grant", ctx("refresh")),
    access: seal("synthetic-grant", ctx("access")),
    expires: 0,
    scope: "",
    connectedAt: 1,
    by: OWNER,
    owner: { email: OWNER_THEN, handle: "fixture" },
    broken: "",
    brokenAt: 0,
  });
}

/**
 * The worst: every host a Google grant's read can find (the owner now, the owner the connection was kept for, the full
 * team) has a calendar on the account and none is listed; the store, when given, is the only member of its index.
 */
async function seed(store: "" | "healthy" | "damaged", skip = "") {
  redis.clear();
  const hosts = [OWNER, OWNER_THEN, ...TEAM].filter((e) => e !== skip);
  await real([
    ...(store ? [["SET", storeKey, connection("", store === "damaged")], ["SADD", userKey(ACCOUNT), A]] : []),
    ...hosts.map((e) => ["SET", hostKey(e), connection(hostId(e))]),
    ["SET", `nl:team:${SID}`, JSON.stringify({ members: TEAM.map((email) => ({ email, role: "editor", joinedAt: "" })), invites: [] })],
  ]);
}

async function measure(run: () => Promise<unknown>): Promise<{ billed: number; outcome: string }> {
  sent = 0;
  const outcome = await run().then(
    (r) => JSON.stringify(r && typeof r === "object" && "error" in r ? (r as { error: unknown }).error : (r as Outcome | null)?.sharedGrantKept ?? "answered"),
    (error: unknown) => (error instanceof Error ? error.name : "thrown"),
  );
  return { billed: sent, outcome };
}

// The same requests before #4011, from the same scripts: the renewal lock taken (SET NX) and let go (RELEASE).
const LOCK = 1 + 1 + calls(RELEASE);
const lockSource = readFileSync("lib/redis-lock.ts", "utf8");
const FENCED_SET = lockSource.match(/const FENCED_SET_ONLY = '([^']*)'/)?.[1] ?? "";
/** A disconnect: the connection's GET and one pipeline of DEL, DEL (its test meeting) and SREM. */
const DISCONNECT_BEFORE = LOCK + 1 + 3;
/** A consent that kept nothing: the earlier connection's GET, then the revoke (no command). */
const KEPT_NOTHING_BEFORE = LOCK + 1;
/** A team host's account change: the earlier connection's GET and its fenced SET (setIfHeld), then the revoke. */
const HOST_CHANGE_BEFORE = LOCK + 1 + 1 + calls(FENCED_SET);

async function main() {
  is("the figure is in lib/meet-connect.ts", typeof EXTRA, "number");
  if (typeof EXTRA !== "number") return done();
  const quiet = console.error;
  console.error = () => {};

  part("The figures are derived from MAX_TEAM and the scripts' own text");
  is("the hosts a Google grant's read counts: the owner now, the owner then and the team", named.POSSIBLE_HOSTS, MAX_TEAM + 2);
  for (const [script, figure] of [
    ["FORGET_CONNECTION", "FORGET_CONNECTION_COMMANDS"],
    ["LIST_KEPT", "LIST_KEPT_COMMANDS"],
    ["LEAVE_ACCOUNT", "LEAVE_ACCOUNT_COMMANDS"],
  ] as const) {
    is(`${figure}: the EVAL and each redis.call of ${script}`, named[figure], 1 + calls(String(named[script] ?? "")));
  }
  is("the fenced set of a host's keep before is read from lib/redis-lock.ts", calls(FENCED_SET), 2);

  part("A store's Google disconnect, every possible host unlisted on its account, the deletion's answer lost");
  await seed("healthy");
  const healthyWorst = await measure(() => {
    forget = "lose";
    return disconnectFor(A, "google", "", STORE);
  });
  is("it says try again", healthyWorst.outcome, "UnknownReplyError");
  is("the connection is deleted and the grant kept for the hosts", [(await real([["GET", storeKey]]))[0], (await real([["SCARD", userKey(ACCOUNT)]]))[0]], [null, MAX_TEAM + 2]);
  is(`what it adds is within the figure (${healthyWorst.billed} billed, ${DISCONNECT_BEFORE} before)`, healthyWorst.billed - DISCONNECT_BEFORE <= EXTRA, true);
  await seed("healthy");
  const healthy = await measure(() => disconnectFor(A, "google", "", STORE));
  is("answered when nothing is lost, the grant kept for the hosts", healthy.outcome, "true");
  is(`and within the figure (${healthy.billed} billed)`, healthy.billed - DISCONNECT_BEFORE <= EXTRA, true);

  part("A damaged store connection, every possible host unlisted, its deletion lost before it ran");
  await seed("damaged");
  const damaged = await measure(() => {
    forget = "drop";
    return disconnectFor(A, "google", "", STORE);
  });
  is("it says try again", damaged.outcome, "UnknownReplyError");
  is("the damaged text is still kept, and listed again", [typeof (await real([["GET", storeKey]]))[0], (await real([["SISMEMBER", userKey(ACCOUNT), A]]))[0]], ["string", 1]);
  is(`what it adds is within the figure (${damaged.billed} billed, ${DISCONNECT_BEFORE} before)`, damaged.billed - DISCONNECT_BEFORE <= EXTRA, true);

  part("A consent that kept nothing (its flow expired while the code was traded), every possible host unlisted");
  await seed("");
  const realNow = Date.now;
  afterTrade = () => {
    const later = realNow() + 3 * 600_000;
    Date.now = () => later;
  };
  const keptNothing = await measure(() =>
    finishConsent("google", { statsId: A, sid: SID, code: "code", verifier: "v".repeat(43), by: OWNER, owner: { email: OWNER, handle: "fixture" }, startedAt: realNow() }),
  );
  Date.now = realNow;
  afterTrade = () => {};
  is("it keeps nothing", keptNothing.outcome, JSON.stringify("expired"));
  is(`what it adds is within the figure (${keptNothing.billed} billed, ${KEPT_NOTHING_BEFORE} before)`, keptNothing.billed - KEPT_NOTHING_BEFORE <= EXTRA, true);

  part("A team host's account change, every other possible host unlisted on the old account");
  await seed("", TEAM[0]);
  await real([["SET", hostKey(TEAM[0]), connection(hostId(TEAM[0]))]]);
  const change = await measure(() =>
    finishConsent("google", { statsId: A, sid: SID, host: hostId(TEAM[0]), code: "code", verifier: "v".repeat(43), by: TEAM[0], owner: { email: OWNER, handle: "fixture" }, startedAt: Date.now() }),
  );
  is("the new account is kept", change.outcome, JSON.stringify("answered"));
  is(`what it adds is within the figure (${change.billed} billed, ${HOST_CHANGE_BEFORE} before)`, change.billed - HOST_CHANGE_BEFORE <= EXTRA, true);

  part("The figure is the worst of them, and is priced");
  is(
    "no path is left out of it, and it is no larger than the worst",
    Math.max(healthyWorst.billed - DISCONNECT_BEFORE, damaged.billed - DISCONNECT_BEFORE, keptNothing.billed - KEPT_NOTHING_BEFORE, change.billed - HOST_CHANGE_BEFORE),
    EXTRA,
  );
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("the registry prices it on every studio request", /return STORE_ALLOWANCES\[tier\]\.studio \* SHARED_GRANT_EXTRA_COMMANDS \* COMMAND;/.test(registry), true);
  is("in the studio line", /\+ teamLogFenceUsd\(tier\) \+ meetSharedGrantUsd\(tier\),/.test(registry), true);
  is("with lib/meet-connect.ts as its source", /\{ file: "lib\/meet-connect\.ts", names: \["SHARED_GRANT_EXTRA_COMMANDS"/.test(registry), true);
  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
