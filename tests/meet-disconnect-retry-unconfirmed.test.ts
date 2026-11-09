/**
 * Rule 30 on the store's own path (G review 5815599962, disposition A): a disconnect may stop after the connection
 * was forgotten here, its answer lost, while the provider had refused the revoke. The retry finds nothing, and must
 * not then say the access was given back: only a give-back the provider confirmed in that very request is. A damaged
 * record whose grant was confirmed back still says so; one with no grant to give back does not.
 * Synthetic only: fetch is mocked, no provider is called, every token is made up here.
 */
import { readFileSync } from "node:fs";
import * as connect from "@/lib/meet-connect";
import { seal } from "@/lib/secret-box";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "s0000000000000000-c3121retry";
const HOST = "0123456789abcdef01234567";
type Outcome = { view: connect.DisconnectedView | null; providerAccessRemoved: boolean };
const disconnectFor = (connect as Record<string, unknown>).disconnectFor as ((statsId: string, provider: "google" | "zoom", host?: string) => Promise<Outcome>) | undefined;

let answer: "refuse" | "ok" = "ok";
let requests = 0;
let active = true;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (init?.method !== "POST" || !u.pathname.endsWith("/revoke")) throw Error("Unexpected synthetic provider request");
  const token = u.searchParams.get("token") ?? new URLSearchParams(String(init.body ?? "")).get("token");
  if (token !== "synthetic-grant") throw Error("Unexpected synthetic token");
  requests++;
  if (answer === "refuse") return Response.json({ error: "invalid_request" }, { status: 400 });
  active = false;
  return new Response("{}", { status: 200 });
}) as typeof fetch;

// The deletion is applied, then its reply is lost once: the first disconnect stops after forgetting the connection.
const raw = redis.pipeline.bind(redis);
let loseDeleteReply = "";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const result = await raw(commands);
  if (loseDeleteReply && commands.some((c) => c[0] === "DEL" && c[1] === loseDeleteReply)) {
    loseDeleteReply = "";
    throw Error("synthetic lost deletion reply");
  }
  return result;
}) as typeof redis.pipeline;

function fixture(provider: "google" | "zoom", host: string) {
  const ctx = (which: string) => (host ? `meet|hosts|${provider}|h:${host}|${which}` : `meet|${SID}|${provider}|${which}`);
  const key = host ? `nl:meet:conn:hosts:${provider}:h:${host}` : `nl:meet:conn:${SID}:${provider}`;
  const healthy = {
    provider,
    account: { id: "synthetic-account", email: "creator@example.test", name: "" },
    refresh: seal("synthetic-grant", ctx("refresh")),
    access: seal("synthetic-grant", ctx("access")),
    expires: 0,
    scope: "",
    connectedAt: 1,
    by: "creator@example.test",
    owner: { email: "creator@example.test", handle: "fixture" },
    broken: "",
    brokenAt: 0,
  };
  return { key, healthy };
}

async function reset(how: typeof answer) {
  redis.clear();
  loseDeleteReply = "";
  requests = 0;
  active = true;
  answer = how;
}

async function main() {
  is("an outcome that says whether the give-back was confirmed in this request exists", typeof disconnectFor, "function");
  if (!disconnectFor) return done();
  for (const [label, provider, host] of [
    ["Google store", "google", ""],
    ["Google host", "google", HOST],
    ["Zoom store", "zoom", ""],
  ] as const) {
    const { key, healthy } = fixture(provider, host);

    part(`${label}: the revoke is refused, then the deletion's answer is lost`);
    await reset("refuse");
    await redisPipeline([["SET", key, JSON.stringify(healthy)]]);
    loseDeleteReply = key;
    const first = await disconnectFor(SID, provider, host).then(
      () => "answered",
      () => "unknown",
    );
    is("the first try reports a failure (try again)", first, "unknown");
    is("it is forgotten here; the refused grant is still live; one revoke", [(await redisPipeline([["GET", key]]))[0], active, requests], [null, true, 1]);
    const retry = await disconnectFor(SID, provider, host);
    is("the retry does not say the access was given back", [retry.view, retry.providerAccessRemoved], [null, false]);
    is("the retry calls no provider (nothing left to give back)", requests, 1);

    part(`${label}: the provider confirms, and a later click finds nothing`);
    await reset("ok");
    await redisPipeline([["SET", key, JSON.stringify(healthy)]]);
    const confirmed = await disconnectFor(SID, provider, host);
    is("confirmed in this request: given back", [confirmed.view !== null, confirmed.providerAccessRemoved, active], [true, true, false]);
    const again = await disconnectFor(SID, provider, host);
    is("nothing here: whether the provider took it back is not known, so it is not said", [again.view, again.providerAccessRemoved], [null, false]);

    part(`${label}: the provider refuses on a whole connection`);
    await reset("refuse");
    await redisPipeline([["SET", key, JSON.stringify(healthy)]]);
    const refused = await disconnectFor(SID, provider, host);
    is("forgotten here, and said not confirmed", [refused.view?.providerAccessRemoved, refused.providerAccessRemoved, (await redisPipeline([["GET", key]]))[0]], [false, false, null]);

    part(`${label}: a damaged record`);
    await reset("ok");
    await redisPipeline([["SET", key, JSON.stringify({ ...healthy, account: null })]]);
    const damaged = await disconnectFor(SID, provider, host);
    is("its grant confirmed back: said given back", [damaged.view, damaged.providerAccessRemoved, active, requests], [null, true, false, 1]);
    await reset("ok");
    await redisPipeline([["SET", key, JSON.stringify({ ...healthy, account: null, refresh: "x", access: "x" })]]);
    const empty = await disconnectFor(SID, provider, host);
    is("no grant in it to give back: not said given back", [empty.view, empty.providerAccessRemoved, requests], [null, false, 0]);
  }

  part("disconnect keeps its answer for every caller");
  const { key, healthy } = fixture("google", "");
  await reset("refuse");
  await redisPipeline([["SET", key, JSON.stringify(healthy)]]);
  is("refused: the view with providerAccessRemoved false", (await connect.disconnect(SID, "google"))?.providerAccessRemoved, false);
  is("nothing there: null", await connect.disconnect(SID, "google"), null);

  part("The routes say it from the outcome");
  const meetRoute = readFileSync("app/api/integrations/meetings/route.ts", "utf8");
  is("the store route reads the outcome", /disconnectFor\(store\.statsId, provider\)/.test(meetRoute), true);
  is("the store route's email says not confirmed from the same outcome", /const unconfirmed = providerAccessRemoved === false;/.test(meetRoute), true);
  const host = readFileSync("lib/host-calendar.ts", "utf8");
  is("the host wrapper answers the outcome", /return providerAccessRemoved;/.test(host), true);
  done();
}
void main();
