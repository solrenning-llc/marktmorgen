/**
 * Issue #4011 (Claude 1 cloud, integrations): Google's and Zoom's revoke end the user's grant for the whole app, not
 * for one store. Disconnecting store A gave its grant back even when store B, or a team host's own calendar, was
 * connected to the same account, so B's next refresh failed (invalid_grant) and its bookings lost their meeting link.
 *
 * A grant is given back only when nothing else here uses that account: the account's index lists the stores and the
 * team hosts connected to it, and a connection that is still listed elsewhere keeps the grant at the provider. The
 * answer says why (`sharedGrantKept`), so the studio never tells the creator to remove at Google an access their
 * other store still needs. An index that cannot be read keeps the grant too: never revoked on an unread answer.
 *
 * Synthetic only: fetch is mocked, no provider is called, every token is made up here.
 */
import { createHash } from "node:crypto";
import * as connect from "@/lib/meet-connect";
import { seal } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const A = "s0000000000000000-sharedA01";
const B = "s0000000000000000-sharedB01";
const HOST = "0123456789abcdef01234567";
const ACCOUNT = "synthetic-shared-account";
type Outcome = { view: connect.DisconnectedView | null; providerAccessRemoved: boolean; sharedGrantKept?: boolean };
const disconnectFor = connect.disconnectFor as (statsId: string, provider: "google" | "zoom", host?: string) => Promise<Outcome>;

let revokes = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (init?.method !== "POST" || !u.pathname.endsWith("/revoke")) throw Error("Unexpected synthetic provider request");
  revokes++;
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const userKey = (provider: string) => `nl:meet:user:${provider}:${createHash("sha256").update(`meet-user:${provider}:${ACCOUNT}`).digest("hex").slice(0, 40)}`;
function connection(provider: "google" | "zoom", statsId: string, host = "") {
  const ctx = (which: string) => (host ? `meet|hosts|${provider}|h:${host}|${which}` : `meet|${statsId}|${provider}|${which}`);
  return JSON.stringify({
    provider,
    account: { id: ACCOUNT, email: "creator@example.test", name: "" },
    refresh: seal("synthetic-grant", ctx("refresh")),
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
const storeKey = (provider: string, statsId: string) => `nl:meet:conn:${statsId}:${provider}`;
const hostKey = (provider: string) => `nl:meet:conn:hosts:${provider}:h:${HOST}`;

async function seed(provider: "google" | "zoom", members: string[]) {
  redis.clear();
  revokes = 0;
  const commands: (string | number)[][] = [];
  for (const m of members) {
    if (m.startsWith("h:")) commands.push(["SET", hostKey(provider), connection(provider, "", HOST)]);
    else commands.push(["SET", storeKey(provider, m), connection(provider, m)]);
  }
  commands.push(["SADD", userKey(provider), ...members]);
  await redis.pipeline(commands);
}

async function main() {
  for (const provider of ["google", "zoom"] as const) {
    part(`${provider}: two stores on one account`);
    await seed(provider, [A, B]);
    const shared = await disconnectFor(A, provider);
    is("store A is disconnected here", (await redis.pipeline([["GET", storeKey(provider, A)]]))[0], null);
    is("the grant store B still uses is not given back", revokes, 0);
    is("store B is still connected", typeof (await redis.pipeline([["GET", storeKey(provider, B)]]))[0], "string");
    is("the answer says the grant was kept for the other connection", [shared.providerAccessRemoved, shared.sharedGrantKept], [false, true]);

    part(`${provider}: the last store on the account`);
    await seed(provider, [A]);
    const last = await disconnectFor(A, provider);
    is("its grant is given back", revokes, 1);
    is("and said so", [last.providerAccessRemoved, last.sharedGrantKept ?? false], [true, false]);

    part(`${provider}: a store and a team host's own calendar on one account`);
    await seed(provider, [A, `h:${HOST}`]);
    await disconnectFor(A, provider);
    is("the store's disconnect keeps the grant the host's calendar uses", revokes, 0);
    await seed(provider, [A, `h:${HOST}`]);
    const host = await disconnectFor(A, provider, HOST);
    is("the host's disconnect keeps the grant the store uses", [revokes, host.sharedGrantKept], [0, true]);
    is("and the host is taken out of the account's index", (await redis.pipeline([["SISMEMBER", userKey(provider), `h:${HOST}`]]))[0], 0);
  }

  part("A removal notice from the provider leaves a team host's member in the account's index (Claude 5 iYwjc's MEDIUM on #5476)");
  // The index lists a team host's own calendar as h:<host>, which is no store's id: the notice that the person removed
  // the app reads its members as stores, so it must leave a host's alone, never drop it as a store with no connection.
  // Dropped, a store's later disconnect would see nothing else on the account and end the grant the host's calendar uses.
  await seed("google", [A, `h:${HOST}`]);
  const forgot = await connect.forgetUser("google", ACCOUNT);
  is("the store's connection is forgotten by the notice", [forgot.map((f) => f.statsId), (await redis.pipeline([["GET", storeKey("google", A)]]))[0]], [[A], null]);
  is("the host's member stays in the account's index", (await redis.pipeline([["SISMEMBER", userKey("google"), `h:${HOST}`]]))[0], 1);
  is("and the host's own calendar connection is untouched", typeof (await redis.pipeline([["GET", hostKey("google")]]))[0], "string");
  await redis.pipeline([["SET", storeKey("google", B), connection("google", B)], ["SADD", userKey("google"), B]]);
  revokes = 0;
  await disconnectFor(B, "google");
  is("a store connected since that disconnects keeps the grant the host still uses", revokes, 0);

  for (const provider of ["google", "zoom"] as const) {
    part(`${provider}: two disconnects of one account at once give the grant back once (Claude 3 xy6b's LOW on #5476)`);
    // Each connection has its own renewal lock, so two disconnects of one account run together: each read the index
    // before either left it, saw the other and kept the grant, and the grant stayed at the provider with nothing here
    // left to give it back. The last one is now decided in the same step as leaving the index.
    await seed(provider, [A, B]);
    const [a, b] = await Promise.all([disconnectFor(A, provider), disconnectFor(B, provider)]);
    is("the grant is given back exactly once", revokes, 1);
    is("by exactly one of the two, and the other says it was kept for the other connection",
      [a.providerAccessRemoved, b.providerAccessRemoved].filter(Boolean).length === 1 && [a.sharedGrantKept, b.sharedGrantKept].filter(Boolean).length === 1, true);
    is("and the account's index is empty", (await redis.pipeline([["SCARD", userKey(provider)]]))[0], 0);
  }

  part("An index that cannot be read keeps the grant");
  // The store alone on its account, so an index read as empty would give the grant back: a read that does not answer,
  // whether the index's members or the count left after leaving it (LEAVE_ACCOUNT), never does.
  await seed("google", [A]);
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SMEMBERS" || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:meet-leave-account:")))) return [{ unexpected: true }];
    return real(commands);
  }) as typeof redis.pipeline;
  const unread = await disconnectFor(A, "google").catch((error: unknown) => error);
  redis.pipeline = real;
  is("nothing is revoked on an unread index", revokes, 0);
  is("and the disconnect is never told the grant was given back", unread instanceof Error || (unread as Outcome).providerAccessRemoved === false, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
