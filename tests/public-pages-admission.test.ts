/**
 * The creator's own site pages (/@handle/<slug>) and media kit (/@handle/media-kit) are public pages anybody can ask
 * for, and each reads the store's records to draw itself (the page's product, its funnel and forms; the reviews'
 * summaries and the counted numbers). As the store and product pages, each is one of the store's counted public
 * requests and rests once the window's requests are used (lib/traffic.ts, isResting), before those reads: never a
 * Redis read with no ceiling (MR, rule 30).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import StoreOwnPage from "@/app/[handle]/[slug]/page";
import MediaKitPage from "@/app/[handle]/media-kit/page";
import { StoreResting } from "@/components/store-resting";
import { claimHandle, ensureStatsId, setKit, setSitePages, setSubscription, storeForEmail } from "@/lib/store";
import { requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = async () => { throw new Error("No external service in this test"); };
const owner = "public-pages-admission@example.test", handle = "publicpagesadmit";

async function fixture() {
  redis.clear();
  assert.equal((await claimHandle(owner, handle, "Synthetic pages shop", "")).ok, true);
  await ensureStatsId(owner);
  assert.ok(await setSubscription(owner, { customerId: "cus_PublicPagesAdmit", subscriptionId: "sub_PublicPagesAdmit", active: true, tier: "creator", period: paidPeriod() }));
  assert.ok((await setSitePages(owner, [{ id: "abcdefghij", slug: "about", title: "About us" }])).ok);
  assert.ok(await setKit(owner, { on: true, pitch: "Synthetic pitch for brands.", counted: { visitors: true, sales: true, countries: true } }));
  return (await storeForEmail(owner))!;
}

const pages = {
  "site page": () => StoreOwnPage({ params: Promise.resolve({ handle: "@" + handle, slug: "about" }), searchParams: Promise.resolve({}) } as never),
  "media kit": () => MediaKitPage({ params: Promise.resolve({ handle: "@" + handle }) }),
};

async function render(page: () => Promise<unknown>) {
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch) => { commands.push(...batch); return original(batch); };
  let tree: unknown;
  try { tree = await page(); } finally { redis.pipeline = original; }
  const counted = commands.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:"));
  return { tree: tree as { type?: unknown } | null, counted };
}

for (const [name, page] of Object.entries(pages)) {
  test(`${name}: an open store's page is counted as one of its public requests`, async () => {
    await fixture();
    const seen = await render(page);
    assert.ok(seen.tree && seen.tree.type !== StoreResting, "the page is drawn");
    assert.equal(seen.counted, true, "the page counts one of the store's public requests");
  });
  test(`${name}: a store whose public requests are used rests`, async () => {
    const store = await fixture();
    assert.equal(await takePublicRequest(store, "buyer", undefined, requestLimitFor(store)), true);
    const seen = await render(page);
    assert.equal(seen.tree?.type, StoreResting, "the page rests, as the store page does");
  });
}
