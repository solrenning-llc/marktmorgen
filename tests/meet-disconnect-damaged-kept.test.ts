/**
 * A damaged meeting connection (text kept that does not read as one) is
 * forgotten only after its access is given back, when a token in it still
 * opens (lib/meet-connect.ts, disconnect; Codex G on #3121). The give-back
 * itself is in tests/meet-disconnect-damaged-revoke.test.ts; here, the cases
 * around it:
 *   - the provider refuses, fails or does not answer: disconnect throws (the
 *     route answers 500, "try again") and the text is kept, so a retry can
 *     still give the access back;
 *   - Google's "already given back" (400 invalid_token) is done, as for a
 *     healthy one; a Google 400 with any other code, or none, is not;
 *   - Google's refresh token does not open but its access token does: the
 *     access token gives the grant back;
 *   - an account id still in the text: its store is taken off that account's
 *     list, as for a healthy one;
 *   - nothing in it opens (sealed for another store): deleted at once, and
 *     nothing is sent to any provider.
 *
 * Synthetic store, sealing and Redis (tests/redis-stub.ts); the provider is a
 * mocked fetch that only answers the revoke address, so no provider is reached.
 */
import { createHash } from "node:crypto";
import { disconnect } from "@/lib/meet-connect";
import { seal } from "@/lib/secret-box";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "s0000000000000000-meetkept";
const HOST = "0123456789abcdef01234567";
const GRANT = "synthetic-kept-grant";

let asked = 0;
let answer: number | "throw" = 200;
let body = "{}";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (init?.method !== "POST" || !url.pathname.endsWith("/revoke")) throw Error("Unexpected external request in a synthetic test");
  const token = url.searchParams.get("token") ?? new URLSearchParams(String(init.body ?? "")).get("token");
  if (token !== GRANT) throw Error("Unexpected synthetic token");
  asked++;
  if (answer === "throw") throw Error("synthetic network failure");
  return new Response(body, { status: answer });
}) as typeof fetch;

type Provider = "google" | "zoom";
const ctx = (provider: Provider, part: string, host = "", sid = SID) => (host ? `meet|hosts|${provider}|h:${host}|${part}` : `meet|${sid}|${provider}|${part}`);
const keyOf = (provider: Provider, host = "") => (host ? `nl:meet:conn:hosts:${provider}:h:${host}` : `nl:meet:conn:${SID}:${provider}`);
const userKey = (provider: Provider, id: string) =>
  `nl:meet:user:${provider}:${createHash("sha256").update(`meet-user:${provider}:${id}`).digest("hex").slice(0, 40)}`;
/** A connection whose account metadata is damaged, with both tokens sealed in its own context. */
const damaged = (provider: Provider, host = "", sid = SID) => ({
  provider,
  account: null as unknown,
  refresh: seal(GRANT, ctx(provider, "refresh", host, sid)) as unknown,
  access: seal(GRANT, ctx(provider, "access", host, sid)) as unknown,
  expires: 0,
  scope: "",
  connectedAt: 1,
  by: "creator@example.test",
});
const outcome = async (provider: Provider, host = "") => {
  try {
    return (await disconnect(SID, provider, host)) ? "view" : "none";
  } catch {
    return "unknown";
  }
};
const kept = async (key: string) => typeof (await redisPipeline([["GET", key]]))[0] === "string";
const start = async (key: string, record: object, reply: number | "throw", replyBody = "{}") => {
  redis.clear();
  asked = 0;
  answer = reply;
  body = replyBody;
  await redisPipeline([["SET", key, JSON.stringify(record)]]);
};

async function main(): Promise<void> {
  part("The give-back is not confirmed: the text is kept and disconnect throws");
  for (const [label, provider, host, reply] of [
    ["Google store, the provider answered 503", "google", "", 503],
    ["Google store, the provider could not be reached", "google", "", "throw"],
    ["Google host, the provider answered 500", "google", HOST, 500],
    ["Google store, the provider answered 400 with no error code", "google", "", 400],
    ["Google host, the provider answered 400 with no error code", "google", HOST, 400],
    ["Zoom store, the provider answered 400", "zoom", "", 400],
    ["Zoom store, the provider answered 401", "zoom", "", 401],
  ] as const) {
    const key = keyOf(provider, host);
    await start(key, damaged(provider, host), reply);
    is(`${label}: unknown, asked once, and the connection is kept`, [await outcome(provider, host), asked, await kept(key)], ["unknown", 1, true]);
    answer = 200;
    is(`${label}: a retry that is confirmed gives it back, then it is gone`, [await outcome(provider, host), asked, await kept(key)], ["none", 2, false]);
  }

  part("Confirmed give-backs");
  await start(keyOf("google"), damaged("google"), 400, JSON.stringify({ error: "invalid_token", error_description: "Token expired or revoked" }));
  is("Google's \"already given back\" (400 invalid_token) is done: none, and nothing kept", [await outcome("google"), asked, await kept(keyOf("google"))], ["none", 1, false]);
  await start(keyOf("google"), { ...damaged("google"), refresh: 7 }, 200);
  is("Google with only its access token opening: given back by it, and nothing kept", [await outcome("google"), asked, await kept(keyOf("google"))], ["none", 1, false]);

  part("An account id still in the text: the store is taken off its list");
  await start(keyOf("zoom"), { ...damaged("zoom"), account: { id: "acct-kept", email: 3 }, refresh: null }, 200);
  await redisPipeline([["SADD", userKey("zoom", "acct-kept"), SID]]);
  is("the account's list no longer has this store", [await outcome("zoom"), asked, (await redisPipeline([["SISMEMBER", userKey("zoom", "acct-kept"), SID]]))[0]], ["none", 1, 0]);

  part("Nothing in it opens: deleted at once, nothing sent");
  for (const [label, provider, host] of [["Google store", "google", ""], ["Google host", "google", HOST], ["Zoom store", "zoom", ""]] as const) {
    const key = keyOf(provider, host);
    await start(key, damaged(provider, host, "s0000000000000000-another"), 200);
    if (host) await redisPipeline([["SET", key, JSON.stringify(damaged(provider, "fedcba9876543210fedcba98"))]]);
    is(`${label}, sealed for another place: none, no request, and nothing kept`, [await outcome(provider, host), asked, await kept(key)], ["none", 0, false]);
  }
  await start(keyOf("zoom"), { ...damaged("zoom"), access: "" }, 200);
  is("Zoom with only a refresh token: nothing Zoom takes back opens, deleted at once", [await outcome("zoom"), asked, await kept(keyOf("zoom"))], ["none", 0, false]);

  done();
}

void main();
