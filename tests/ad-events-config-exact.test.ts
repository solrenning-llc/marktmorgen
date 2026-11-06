/**
 * The sealed setup of server-sent conversions (lib/ad-events.ts) is read
 * exactly before anything is written over it (CX-123 rule 24):
 *
 *   - setServerToken and setTestCode read the setup, change one field and
 *     write it all back. A reply that is not nil and not a JSON object of
 *     strings (cut short, not JSON, a list, a number) is unknown: they refuse
 *     and write nothing, so the other platforms' tokens and Pinterest's ad
 *     account are never wiped by a guess. Nil (nothing kept yet) stays a
 *     fresh, empty setup;
 *   - serverSetup reads the same way, and the route (app/api/store/ads-server)
 *     answers 503 "unavailable" and writes neither the setup nor the store's
 *     own list of platforms when it cannot read it;
 *   - the studio shows that the setup could not be read rather than an empty
 *     one (and does not write an empty list on the store from it);
 *   - customerType: a Stripe list without its `data` list is unknown (null),
 *     never a "new" customer.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { customerType, serverSetup, setServerToken, setTestCode } from "@/lib/ad-events";
import { claimHandle, ensureStatsId, setAdsServer, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as adsServerRoute } from "@/app/api/store/ads-server/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_config_stand_in";

const OWNER = "adconfig@example.com";
const TOKENS = { meta: "EAAB" + "m".repeat(60), tiktok: "t".repeat(40), google: "g".repeat(22), pinterest: "pina_" + "p".repeat(40) };

/** What Stripe's list of checkouts answers for the next customerType. */
let listed: unknown = { object: "list", data: [] };
globalThis.fetch = (async () => new Response(JSON.stringify(listed), { status: 200 })) as typeof fetch;

/**
 * The reply the setup's GET gets instead of the real one: "drop" leaves it
 * out of the pipeline's replies. `where` says which reads: "all", or only
 * serverSetup's two-command read ("setup"), or only its `last` ("last").
 */
let reply: unknown = undefined;
let where: "all" | "setup" | "last" = "all";
let configKey = "";
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const real = await pipeline(commands);
  if (reply === undefined) return real;
  const at = where === "last" ? (commands.length === 2 ? 1 : -1) : commands.findIndex((c) => c[0] === "GET" && c[1] === configKey);
  if (at < 0 || commands[at][0] !== "GET") return real;
  if (where === "setup" && commands.length !== 2) return real;
  if (reply === "drop") return real.filter((_, i) => i !== at);
  return real.map((r, i) => (i === at ? reply : r));
}) as typeof redis.pipeline;

const rejects = async (work: () => Promise<unknown>): Promise<boolean> => {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "adconfig", "Ad Config", "");
  const statsId = (await ensureStatsId(OWNER))!.statsId!;
  await setStripeAccount(OWNER, "acct_1TestAdConfig001", true);
  await setSubscription(OWNER, { customerId: "cus_adc", subscriptionId: "sub_adc", active: true, tier: "creator", period: paidPeriod() });
  configKey = `nl:adsrv:${statsId}`;
  for (const p of ["meta", "tiktok", "google", "pinterest"] as const) await setServerToken(statsId, p, TOKENS[p], { account: "549755885175" });
  await setTestCode(statsId, "TEST111");
  await setAdsServer(OWNER, ["meta", "tiktok", "google", "pinterest"]);
  const kept = async () => (await pipeline([["GET", configKey]]))[0];
  const before = await kept();
  const adsServer = async () => (await storeForEmail(OWNER))!.adsServer;

  part("healthy: a change keeps every other field");
  is("all four on, the account and the code kept", await serverSetup(statsId).then((s) => [s.on, s.pinterestAccount, s.testCode]), [
    { meta: true, tiktok: true, google: true, pinterest: true },
    "549755885175",
    "TEST111",
  ]);

  part("the setters refuse an unknown setup and write nothing");
  const malformed: [string, unknown][] = [
    ["no reply", "drop"],
    ["not JSON", "{cut sh"],
    ["JSON null", "null"],
    ["a JSON list", "[1,2]"],
    ["a JSON string", '"meta"'],
    ["a field that is not a string", '{"meta":5}'],
    ["a number", 42],
    ["a list", ["{}"]],
  ];
  where = "all";
  for (const [label, bad] of malformed) {
    reply = bad;
    const code = await rejects(() => setTestCode(statsId, "TEST123"));
    const token = await rejects(() => setServerToken(statsId, "meta", "EAAB" + "n".repeat(60)));
    const remove = await rejects(() => setServerToken(statsId, "tiktok", ""));
    const setup = await rejects(() => serverSetup(statsId));
    reply = undefined;
    is(`${label}: setTestCode, setServerToken (save and remove) and serverSetup refuse`, [code, token, remove, setup], [true, true, true, true]);
    is(`${label}: the setup is as it was`, (await kept()) === before, true);
  }

  part("serverSetup: an unknown `last` is not 'nothing answered yet'");
  where = "last";
  reply = "{cut sh";
  is("serverSetup refuses", await rejects(() => serverSetup(statsId)), true);
  reply = undefined;

  part("the route answers 503 and writes nothing");
  const session = await openSession(OWNER);
  const post = async (body: Record<string, unknown>) => {
    const response = await adsServerRoute(
      new NextRequest("https://marktmorgen.com/api/store/ads-server", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }),
    );
    return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"];
  };
  where = "all";
  reply = "{cut sh";
  is("a test code: 503 unavailable", await post({ testCode: "TEST222" }), [503, "unavailable"]);
  is("a token: 503 unavailable", await post({ platform: "google", token: "g".repeat(30) }), [503, "unavailable"]);
  is("a removal: 503 unavailable", await post({ platform: "tiktok", token: "" }), [503, "unavailable"]);
  reply = undefined;
  is("the setup is as it was", (await kept()) === before, true);
  is("the store's list is as it was", await adsServer(), ["meta", "tiktok", "google", "pinterest"]);
  where = "setup";
  reply = "drop";
  is("the setup cannot be read after a change: 503 unavailable", await post({ testCode: "TEST333" }), [503, "unavailable"]);
  reply = undefined;
  is("and the store's list is not written empty", await adsServer(), ["meta", "tiktok", "google", "pinterest"]);
  is("healthy: the route answers ok and keeps the tokens", [await post({ testCode: "TEST444" }), (await serverSetup(statsId)).on], [[200, "ok"], { meta: true, tiktok: true, google: true, pinterest: true }]);

  part("confirmed absence: nothing kept yet is an empty setup");
  const fresh = "freshstatsid0001";
  is("nil: serverSetup is empty", (await serverSetup(fresh)).on, { meta: false, tiktok: false, google: false, pinterest: false });
  is("nil: a test code is kept on its own", [await setTestCode(fresh, "TEST555"), JSON.parse(String((await pipeline([["GET", `nl:adsrv:${fresh}`]]))[0]))], [true, { testCode: "TEST555" }]);

  part("the studio does not show an unknown setup as empty");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  is("no fall back to an empty setup", studio.includes("serverSetup(store.statsId).catch(() => NO_SETUP)"), false);
  is("an honest notice instead", studio.includes("Server-sent conversions could not be read just now."), true);

  part("customerType: a list without its data is unknown");
  const store = (await storeForEmail(OWNER))!;
  for (const [label, body] of [
    ["no data", { object: "list" }],
    ["data null", { object: "list", data: null }],
    ["data an object", { object: "list", data: {} }],
    ["data a string", { object: "list", data: "x" }],
  ] as const) {
    listed = body;
    is(`${label}: null, not new`, await customerType(store, "buyer@example.com", "cs_test_adc0000000001", 2_000_000_000), null);
  }
  listed = { object: "list", data: [] };
  is("an empty list: new", await customerType(store, "buyer@example.com", "cs_test_adc0000000001", 2_000_000_000), "new");
  listed = { object: "list", data: [{ id: "cs_test_adc0000000000", payment_status: "paid", created: 1_000 }] };
  is("an earlier paid checkout: returning", await customerType(store, "buyer@example.com", "cs_test_adc0000000001", 2_000_000_000), "returning");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
