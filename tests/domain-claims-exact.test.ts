/**
 * Rule 24 in a store's own domain (lib/domains.ts):
 *
 *   - connectDomain: the domain's claim (SET NX) is ours only on "OK" or our own value read back (claimMark). A
 *     reply cut short or of another shape never takes a domain another store holds, and nothing is asked of Vercel
 *     (a paid API) for it; when Vercel refuses, only our own claim is let go (releaseMark), never another store's;
 *   - disconnectDomain: who holds the domain (GET) read in another shape is unknown: nothing is removed at Vercel and
 *     no claim is deleted, never "nobody holds it", which took another store's domain off and deleted its claim.
 *
 * Synthetic only: a stand-in for Vercel's API.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { connectDomain, disconnectDomain, domainKey } from "@/lib/domains";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.VERCEL_API_TOKEN = "vercel_test_domain_claims_only";
const calls: string[] = [];
let postStatus = 200;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.vercel.com") {
    calls.push(`${method} ${url.pathname}`);
    if (method === "POST") return new Response(JSON.stringify({}), { status: postStatus });
    return new Response(JSON.stringify({}), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const OTHER = "?otherstore";

const fixture = (async () => {
  redis.clear();
  await claimHandle("domains@example.com", "domainshop", "Domain Shop", "");
  await ensureStatsId("domains@example.com");
  await setSubscription("domains@example.com", { customerId: "cus_Domain00001", subscriptionId: "sub_Domain00001", active: true, tier: "pro", period: paidPeriod() });
  return (await storeForEmail("domains@example.com")) as Store;
})();

async function withReply<T>(pick: (b: Batch) => boolean, reply: unknown[], run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (b: Batch) => {
    const real = await pipeline(b);
    return pick(b) ? reply : real;
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = pipeline;
  }
}

for (const [label, reply] of [["cut short", []], ["a number", [7]], ["an object", [{ result: "OK" }]]] as [string, unknown[]][]) {
  test(`connectDomain: another store's domain, its claim answered ${label}, is never taken and Vercel is not asked`, async () => {
    const store = await fixture;
    const name = `taken-${label.replace(/\W/g, "")}.example.com`;
    await pipeline([["SET", domainKey(name), OTHER, "EX", 3600]]);
    calls.length = 0;
    const claim = (b: Batch) => b.length === 1 && b[0][0] === "SET" && b[0][1] === domainKey(name) && b[0].includes("NX");
    const result = await withReply(claim, reply, () => connectDomain(store, name).catch(() => ({ ok: false as const, reason: "threw" })));
    assert.notEqual(result.ok, true);
    assert.deepEqual(calls.filter((c) => c.startsWith("POST")), [], "nothing asked of Vercel");
    assert.deepEqual(await pipeline([["GET", domainKey(name)]]), [OTHER], "the other store keeps its claim");
  });
}

test("connectDomain: Vercel refusing lets go of our own claim only", async () => {
  const store = await fixture;
  const name = "refused.example.com";
  postStatus = 500;
  try {
    const result = await connectDomain(store, name);
    assert.equal(result.ok, false);
  } finally {
    postStatus = 200;
  }
  assert.deepEqual(await pipeline([["GET", domainKey(name)]]), [null], "our claim is let go");
});

for (const [label, reply] of [["cut short", []], ["a number", [7]], ["an object", [{}]]] as [string, unknown[]][]) {
  test(`disconnectDomain: who holds it read as ${label}: nothing removed at Vercel, no claim deleted`, async () => {
    await fixture;
    const name = `held-${label.replace(/\W/g, "")}.example.com`;
    await pipeline([["SET", domainKey(name), OTHER, "EX", 3600]]);
    calls.length = 0;
    const get = (b: Batch) => b.length === 1 && b[0][0] === "GET" && b[0][1] === domainKey(name);
    const done = await withReply(get, reply, () => disconnectDomain(name, ["domainshop"]));
    assert.equal(done, false, "not done, to be tried again");
    assert.deepEqual(calls.filter((c) => c.startsWith("DELETE")), [], "nothing removed at Vercel");
    assert.deepEqual(await pipeline([["GET", domainKey(name)]]), [OTHER], "the other store keeps its claim");
  });
}

test("read exactly: a free domain connects, and our own disconnects", async () => {
  const store = await fixture;
  const result = await connectDomain(store, "mine.example.com");
  assert.equal(result.ok, true);
  assert.equal(await disconnectDomain("mine.example.com", ["domainshop"]), true);
  assert.deepEqual(await pipeline([["GET", domainKey("mine.example.com")]]), [null]);
});
