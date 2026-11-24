/**
 * Claude 3 K9t's MEDIUM on #5476 @44f80c1b76 (7122794677): a disconnect left its account's index (LEAVE_ACCOUNT) before
 * the give-back and the final deletion. When anything after the leave failed (the deletion's pipeline, an unread
 * answer, the team hosts' read, a damaged connection's give-back the provider refused), the creator was told to try
 * again and the connection stayed kept, with its sealed tokens and the account's email, but no longer listed under its
 * account. Then the provider's removal notice (forgetUser) did not find it and kept that personal data, and another
 * store's disconnect counted nobody and gave back the grant the kept connection still used (issue #4011 the other way).
 *
 * A connection that is kept is now always listed: the healthy disconnect deletes the connection and leaves the index
 * in one step (FORGET_CONNECTION), and a damaged one whose give-back or deletion fails after it left the index is
 * listed again (LIST_KEPT) before the disconnect throws.
 *
 * Synthetic only: fetch is mocked, no provider is called, every token and address is made up here.
 */
import { createHash } from "node:crypto";
import * as connect from "@/lib/meet-connect";
import { seal } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const A = "s0000000000000000-keptlistA1";
const B = "s0000000000000000-keptlistB1";
const ACCOUNT = "synthetic-kept-listed-account";
type Provider = "google" | "zoom";
type Outcome = { view: connect.DisconnectedView | null; providerAccessRemoved: boolean; sharedGrantKept?: boolean };
const disconnectFor = connect.disconnectFor as (statsId: string, provider: Provider, host?: string) => Promise<Outcome>;

let revokes = 0;
let refuse = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (init?.method !== "POST" || !u.pathname.endsWith("/revoke")) throw Error("Unexpected synthetic provider request");
  if (refuse) return Response.json({ error: "invalid_request" }, { status: 400 });
  revokes++;
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const userKey = (provider: Provider) => `nl:meet:user:${provider}:${createHash("sha256").update(`meet-user:${provider}:${ACCOUNT}`).digest("hex").slice(0, 40)}`;
const storeKey = (provider: Provider, statsId: string) => `nl:meet:conn:${statsId}:${provider}`;
function connection(provider: Provider, statsId: string, damaged = false) {
  const ctx = (which: string) => `meet|${statsId}|${provider}|${which}`;
  return JSON.stringify({
    provider,
    account: { id: ACCOUNT, email: "creator@example.test", name: "" },
    // Damaged: a refresh that is no text does not read as a connection (parseConnection), while its account id and its
    // sealed access still open (salvage), so there is a grant to give back first.
    refresh: damaged ? 5 : seal("synthetic-grant", ctx("refresh")),
    access: seal("synthetic-grant", ctx("access")),
    expires: 0,
    scope: "",
    connectedAt: 1,
    by: "creator@example.test",
    owner: { email: "creator@example.test", handle: "fixture" },
    broken: "",
    brokenAt: 0,
  });
}

async function seed(provider: Provider, stores: string[], damaged: string[] = []) {
  redis.clear();
  revokes = 0;
  refuse = false;
  await redis.pipeline([
    ...stores.map((s) => ["SET", storeKey(provider, s), connection(provider, s, damaged.includes(s))]),
    ["SADD", userKey(provider), ...stores],
  ]);
}

// The first pipeline that would delete `failDeleteOf` (a DEL of it, or a script that names it) fails once, before it
// runs, as a request that timed out before Redis read it.
const real = redis.pipeline.bind(redis);
let failDeleteOf = "";
let unreadHosts = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (failDeleteOf && commands.some((c) => (c[0] === "DEL" || c[0] === "EVAL") && c.includes(failDeleteOf))) {
    failDeleteOf = "";
    throw Error("synthetic deletion failure");
  }
  if (unreadHosts && commands.some((c) => c[0] === "MGET")) return [{ unexpected: true }];
  return real(commands);
}) as typeof redis.pipeline;

const get = async (key: string) => (await real([["GET", key]]))[0];
const listed = async (provider: Provider, member: string) => (await real([["SISMEMBER", userKey(provider), member]]))[0];
const threw = (p: Promise<unknown>) => p.then(() => "answered", (error: unknown) => (error instanceof Error ? error.name : "thrown"));

async function main() {
  const quiet = console.error;
  console.error = () => {};
  for (const provider of ["zoom", "google"] as const) {
    part(`${provider}: the deletion fails once; the connection is still kept and still listed`);
    await seed(provider, [A]);
    failDeleteOf = storeKey(provider, A);
    is("the disconnect says try again", (await threw(disconnectFor(A, provider))) !== "answered", true);
    is("the connection is still kept", typeof (await get(storeKey(provider, A))), "string");
    is("and still listed under its account", await listed(provider, A), 1);
    const forgot = await connect.forgetUser(provider, ACCOUNT);
    is("the provider's removal notice then finds it and forgets it", [forgot.map((f) => f.statsId), await get(storeKey(provider, A))], [[A], null]);

    part(`${provider}: after that failed deletion, another store's disconnect keeps the grant the kept one uses`);
    await seed(provider, [A, B]);
    failDeleteOf = storeKey(provider, A);
    await threw(disconnectFor(A, provider));
    revokes = 0;
    const other = await disconnectFor(B, provider);
    is("store A is still kept and listed", [typeof (await get(storeKey(provider, A))), await listed(provider, A)], ["string", 1]);
    is("B's disconnect gives nothing back and says the grant was kept", [revokes, other.sharedGrantKept ?? false], [0, true]);

    part(`${provider}: a damaged connection whose give-back the provider refuses is still listed`);
    await seed(provider, [A], [A]);
    refuse = true;
    is("the disconnect says try again", (await threw(disconnectFor(A, provider))) !== "answered", true);
    is("the damaged text is kept for a retry", typeof (await get(storeKey(provider, A))), "string");
    is("and still listed under its account", await listed(provider, A), 1);
    await real([["SET", storeKey(provider, B), connection(provider, B)], ["SADD", userKey(provider), B]]);
    refuse = false;
    revokes = 0;
    const after = await disconnectFor(B, provider);
    is("another store's disconnect then keeps the grant the damaged one may still hold", [revokes, after.sharedGrantKept ?? false], [0, true]);

    part(`${provider}: a damaged connection given back whose deletion then fails is still listed`);
    await seed(provider, [A], [A]);
    failDeleteOf = storeKey(provider, A);
    is("the disconnect says try again", (await threw(disconnectFor(A, provider))) !== "answered", true);
    is("the damaged text is still kept", typeof (await get(storeKey(provider, A))), "string");
    is("and still listed under its account", await listed(provider, A), 1);
    const retry = await disconnectFor(A, provider);
    is("a retry deletes it and leaves the index", [retry.view, await get(storeKey(provider, A)), await listed(provider, A)], [null, null, 0]);
  }

  part("google: the team hosts' read fails; nothing is deleted and the connection is still listed");
  await seed("google", [A]);
  unreadHosts = true;
  const unread = await threw(disconnectFor(A, "google"));
  unreadHosts = false;
  is("the disconnect throws unknown", unread, "UnknownReplyError");
  is("nothing is given back", revokes, 0);
  is("the connection is still kept and still listed", [typeof (await get(storeKey("google", A))), await listed("google", A)], ["string", 1]);
  const forgot = await connect.forgetUser("google", ACCOUNT);
  is("the removal notice finds it", forgot.map((f) => f.statsId), [A]);

  part("Two disconnects of one account at once still give the grant back exactly once (Claude 3 xy6b's LOW)");
  for (const provider of ["zoom", "google"] as const) {
    await seed(provider, [A, B]);
    const [a, b] = await Promise.all([disconnectFor(A, provider), disconnectFor(B, provider)]);
    is(`${provider}: given back once, by one of the two`, [revokes, [a.providerAccessRemoved, b.providerAccessRemoved].filter(Boolean).length], [1, 1]);
    is(`${provider}: both deleted and the index empty`, [await get(storeKey(provider, A)), await get(storeKey(provider, B)), (await real([["SCARD", userKey(provider)]]))[0]], [null, null, 0]);
  }
  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
