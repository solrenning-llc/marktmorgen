/**
 * A funnel's own address (/@handle/go/<slug>) reads the store's funnels and its steps' products, and the way back from a
 * checkout (/@handle/left) reads the cart's or the product's listings, for anybody who asks. Each is one of the store's
 * counted public requests, and a store whose window's requests are used rests before those reads (lib/traffic.ts,
 * isResting), as the store page does (MR, rule 30): the funnel's address then leads to the store page, which rests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET as goFunnel } from "@/app/[handle]/go/[funnel]/route";
import LeftPage from "@/app/[handle]/left/page";
import { StoreResting } from "@/components/store-resting";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = async () => { throw new Error("No external service in this test"); };
const owner = "funnel-left-admission@example.test", handle = "funnelleftadmit";
let product = "";

async function fixture() {
  redis.clear();
  assert.equal((await claimHandle(owner, handle, "Synthetic funnel shop", "")).ok, true);
  await ensureStatsId(owner);
  assert.ok(await setSubscription(owner, { customerId: "cus_FunnelLeftAdmit", subscriptionId: "sub_FunnelLeftAdmit", active: true, tier: "creator", period: paidPeriod() }));
  const made = await addProduct(owner, "Synthetic course", "", "19", null);
  assert.ok(made.ok);
  product = made.product.id;
  return (await storeForEmail(owner))!;
}

async function watch<T>(run: () => Promise<T>) {
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch) => { commands.push(...batch); return original(batch); };
  let result: T | Error;
  try { result = await run(); } catch (error) { result = error as Error; } finally { redis.pipeline = original; }
  return {
    result,
    counted: commands.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")),
    funnelReads: commands.filter((c) => /^nl:pfunnels?:/.test(String(c[1] ?? ""))).length,
    funnelKeys: commands.filter((c) => /^nl:pfunnels?:/.test(String(c[1] ?? ""))).map((c) => `${c[0]} ${String(c[1]).slice(0, 60)}`),
    listingReads: commands.filter((c) => /^nl:catalog:/.test(String(c[1] ?? ""))).length,
  };
}
const exhaust = async () => {
  const store = await fixture();
  assert.equal(await takePublicRequest(store, "buyer", undefined, publicVisitLimit(requestLimitFor(store))), true);
};
const go = () => goFunnel(new NextRequest(`https://marktmorgen.com/@${handle}/go/launch`), { params: Promise.resolve({ handle: "@" + handle, funnel: "launch" }) });
const left = () => LeftPage({ params: Promise.resolve({ handle: "@" + handle }), searchParams: Promise.resolve({ p: product }) } as never);

test("funnel address: an open store counts the request before it reads its funnels", async () => {
  await fixture();
  const seen = await watch(go);
  assert.equal(seen.counted, true);
});
test("funnel address: a store whose public requests are used reads no funnel and leads to its store page", async () => {
  await exhaust();
  const seen = await watch(go);
  assert.equal(seen.funnelReads, 0, `no funnel is read for a resting store: ${seen.funnelKeys.join(", ")}`);
  assert.ok(seen.result instanceof Response && seen.result.headers.get("location")?.endsWith(`/@${handle}`));
});
test("way back from a checkout: an open store counts the request", async () => {
  await fixture();
  const seen = await watch(left);
  assert.equal(seen.counted, true);
});
test("way back from a checkout: a store whose public requests are used rests, reading no listing", async () => {
  await exhaust();
  const seen = await watch(left);
  assert.equal((seen.result as { type?: unknown }).type, StoreResting);
});
