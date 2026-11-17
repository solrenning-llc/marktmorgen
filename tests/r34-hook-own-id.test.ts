/**
 * R34 finding 2: adding a webhook endpoint answers with the endpoint it added, never the one that happens to be
 * last in the store's list after the write.
 *
 * POST /api/v1/hooks used to answer with `view.endpoints[length - 1]`, read again after the write
 * (lib/webhooks.ts addEndpoint returns only a fresh view). When another endpoint is added between that write and
 * that view (Zapier and Make subscribing at the same moment), both answers carried the other's id and address:
 * Zapier's unsubscribe (DELETE /api/v1/hooks { id }, zapier/index.js) then removed Make's endpoint, while Zapier's
 * stayed and kept receiving buyers' names and addresses. The creator's notice ("webhook-added", the protection
 * against new endpoints) named the other address too, in the API and in the studio (app/api/store/webhooks).
 *
 * Checked through the real routes, with two real keys and the real studio session:
 *   - one add alone answers its own endpoint (control, unchanged);
 *   - two adds at the same moment get two different ids, each at its own address; an unsubscribe removes only
 *     its own endpoint;
 *   - when the endpoint just added cannot be told apart in the view (two endpoints with the same short address
 *     and the same time), or is no longer in it, the answer carries no id at all (rule 24: never another
 *     endpoint's id);
 *   - the studio's add, run inside a request scope as Next runs it, is still answered with its secret and view;
 *   - both routes give the creator's notice the address they added (read from the source: the notice goes out by
 *     email, whose fallback transport needs a reviewed proof that a test cannot hold, so it is not sent here).
 *
 * Synthetic: in-memory Redis, no webhook and no email sent; the race is made by running the second add right
 * after the first add's compare-and-set on the store's webhook settings.
 */
import "./r34-hook-own-id-scope";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { DELETE as deleteHook, POST as postHook } from "@/app/api/v1/hooks/route";
import { POST as studioHooks } from "@/app/api/store/webhooks/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { makeKey } from "@/lib/api-keys";
import { makerFor } from "@/lib/api-key-pause";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { removeEndpoint, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
let afterOnce: ((commands: Commands, replies: unknown[]) => Promise<void>) | null = null;
redis.pipeline = (async (commands: Commands) => {
  const replies = await real(commands);
  if (afterOnce) await afterOnce(commands, replies);
  return replies;
}) as typeof redis.pipeline;

const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;
const OWNER = "r34-hook-own-id@example.com";
type Added = { data?: { id: string; where: string; secret: string }; error?: string };

/** What a route left for after its answer, run once the answer is in, as Next does in a request. */
async function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const tasks: (() => unknown)[] = [];
  const workStore = { afterContext: { after: (task: () => unknown) => void tasks.push(task) } };
  const answer = await workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run({ type: "request" } as never, run));
  for (const task of tasks) await task(); // no email sender is configured here: nothing leaves
  return answer;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "r34-hook-own-id", "R34 Hook Own Id", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_r34ownid", subscriptionId: "sub_r34ownid", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const zapier = await makeKey(store.sid, "Zapier", Date.now(), true, "none", makerFor(store.sid, "owner", OWNER, true));
  const make = await makeKey(store.sid, "Make", Date.now(), true, "none", makerFor(store.sid, "owner", OWNER, true));
  if (!zapier.ok || !make.ok) throw new Error("setup: keys");
  const cfg = `nl:hooks:cfg:${store.statsId}`;
  const isCfgWrite = (commands: Commands) => commands[0]?.[0] === "EVAL" && commands[0]?.[3] === cfg;

  const addRaw = async (key: string, url: string) =>
    postHook(new Request(`${ORIGIN}/api/v1/hooks`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ url, events: ["sale.completed"] }) }));
  const add = async (key: string, url: string) => (await (await addRaw(key, url)).json()) as Added;
  const remove = async (key: string, id: string) =>
    (await deleteHook(new Request(`${ORIGIN}/api/v1/hooks`, { method: "DELETE", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ id }) }))).status;
  const wheres = async () => (await webhooksView(store)).endpoints.map((e) => e.where);
  const clearAll = async () => {
    for (const e of (await webhooksView(store)).endpoints) await removeEndpoint(store, e.id);
  };

  part("Control: one add alone answers its own endpoint");
  const alone = await add(zapier.key, "https://alone.example.com/hook");
  const listed = (await webhooksView(store)).endpoints.find((e) => e.id === alone.data?.id);
  is("the id answered is the endpoint at alone.example.com", listed?.where, "alone.example.com/hook");
  is("the address answered is its own", alone.data?.where, "alone.example.com/hook");
  is("the secret is answered", /^whsec_/.test(alone.data?.secret ?? ""), true);
  await clearAll();

  part("Two tools subscribe at the same moment");
  let bAnswer: Added = {};
  afterOnce = async (commands) => {
    if (isCfgWrite(commands)) {
      afterOnce = null; // only once: the second add runs between the first add's write and its view
      bAnswer = await add(make.key, "https://make-scenario.example.org/hook");
    }
  };
  const aAnswer = await add(zapier.key, "https://zap-one.example.com/hook");
  afterOnce = null;
  const view = (await webhooksView(store)).endpoints;
  is("both endpoints were added", view.length, 2);
  is("Zapier's answer names its own endpoint (zap-one.example.com)", view.find((e) => e.id === aAnswer.data?.id)?.where, "zap-one.example.com/hook");
  is("Make's answer names its own endpoint (make-scenario.example.org)", view.find((e) => e.id === bAnswer.data?.id)?.where, "make-scenario.example.org/hook");
  is("the two answers carry two different ids", Boolean(aAnswer.data?.id) && aAnswer.data?.id !== bAnswer.data?.id, true);
  is("each answer's address is its own", [aAnswer.data?.where, bAnswer.data?.where], ["zap-one.example.com/hook", "make-scenario.example.org/hook"]);

  part("Zapier unsubscribes with the id it was given");
  const status = await remove(zapier.key, aAnswer.data?.id ?? "");
  const after = await wheres();
  is("the removal is answered 200", status, 200);
  is("Make's endpoint is still there", after.includes("make-scenario.example.org/hook"), true);
  is("Zapier's own endpoint is gone", after.includes("zap-one.example.com/hook"), false);
  await clearAll();

  part("Unknown: two endpoints added at the same moment that the view cannot tell apart");
  // Same host, long paths that shortAddress shortens to the same text, at the same millisecond.
  const realNow = Date.now;
  const fixed = realNow();
  Date.now = () => fixed;
  const longA = "https://twin.example.com/aaaaaaaaaa-first-xxxxxxxxxx/hook12";
  const longB = "https://twin.example.com/aaaaaaaaaa-second-yyyyyyyyy/hook12";
  const twinB: Response[] = [];
  afterOnce = async (commands) => {
    if (isCfgWrite(commands)) {
      afterOnce = null;
      twinB.push(await addRaw(make.key, longB));
    }
  };
  const twinA = await addRaw(zapier.key, longA);
  afterOnce = null;
  Date.now = realNow;
  const twins = (await webhooksView(store)).endpoints;
  is("both twin endpoints were added and share one short address", [twins.length, twins[0]?.where === twins[1]?.where], [2, true]);
  const twinABody = (await twinA.json()) as Added;
  is("the first add answers 502 unavailable, with no id", [twinA.status, twinABody.error, twinABody.data?.id], [502, "unavailable", undefined]);
  const twinBBody = twinB[0] ? ((await twinB[0].json()) as Added) : {};
  is("the second add, which sees both in its view too, answers 502 unavailable, with no id", [twinB[0]?.status, twinBBody.error, twinBBody.data?.id], [502, "unavailable", undefined]);
  await clearAll();

  part("Unknown: the endpoint just added is gone from the view (removed at once by another change)");
  const other = await add(make.key, "https://other.example.net/hook");
  afterOnce = async (commands) => {
    if (isCfgWrite(commands)) {
      afterOnce = null;
      const fresh = (await webhooksView(store)).endpoints.find((e) => e.where === "gone.example.com/hook");
      if (fresh) await removeEndpoint(store, fresh.id);
    }
  };
  const goneRes = await addRaw(zapier.key, "https://gone.example.com/hook");
  afterOnce = null;
  const goneBody = (await goneRes.json()) as Added;
  is("answered 502 unavailable, with no id", [goneRes.status, goneBody.error, goneBody.data?.id], [502, "unavailable", undefined]);
  is("never the other endpoint's id", goneBody.data?.id === other.data?.id, false);
  is("the other endpoint stays", await wheres(), ["other.example.net/hook"]);
  await clearAll();

  part("The studio's add, with another add landing at the same moment, is answered as before");
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const studioAdd = (url: string) =>
    studioHooks(new NextRequest(`${ORIGIN}/api/store/webhooks?store=${store.sid}`, { method: "POST", headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "add", url, events: ["sale.completed"] }) }));
  afterOnce = async (commands) => {
    if (isCfgWrite(commands)) {
      afterOnce = null;
      await add(make.key, "https://make-scenario.example.org/hook");
    }
  };
  const studio = await inRequest(() => studioAdd("https://studio-own.example.com/hook"));
  afterOnce = null;
  const studioBody = (await studio.json()) as { ok?: boolean; secret?: string; view?: { endpoints: unknown[] } };
  is("the studio's add is answered 200 with its secret and the view", [studio.status, studioBody.ok, /^whsec_/.test(studioBody.secret ?? ""), studioBody.view?.endpoints.length], [200, true, true, 2]);
  is("both endpoints were added", (await wheres()).sort(), ["make-scenario.example.org/hook", "studio-own.example.com/hook"]);

  part("The creator's notice names the address each route added, never the last one in the list");
  for (const file of ["app/api/v1/hooks/route.ts", "app/api/store/webhooks/route.ts"]) {
    const source = readFileSync(file, "utf8");
    is(`${file} no longer takes the last endpoint of the list`, /endpoints\[[^\]]*\.length\s*-\s*1\]/.test(source), false);
    is(`${file} names the address it added in the notice`, /kind: "webhook-added", where: addedWhere\b/.test(source), true);
  }

  done();
}

void main();
