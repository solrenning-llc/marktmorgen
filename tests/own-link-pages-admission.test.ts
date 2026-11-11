/**
 * Pages a person reaches through their own link (a group purchase's places, a private podcast's page, a win-back
 * offer to renew, a purchase move, the button that confirms joining a creator's list) read the store's records for
 * whoever holds or guesses the address. Each is one of the store's counted requests, and rests once the whole month's
 * are used, as a buyer's course does (lib/traffic.ts, isResting, "buyer"): never a Redis read with no ceiling (MR,
 * rule 30), and never before the store's public pages rest.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import GroupPage from "@/app/[handle]/group/[group]/page";
import PodcastPage from "@/app/[handle]/podcast/[product]/page";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import MovePage from "@/app/[handle]/move/[product]/page";
import JoinPage from "@/app/[handle]/join/page";
import { StoreResting } from "@/components/store-resting";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = async () => { throw new Error("No external service in this test"); };
const owner = "own-link-admission@example.test", handle = "ownlinkadmit";

async function fixture() {
  redis.clear();
  assert.equal((await claimHandle(owner, handle, "Synthetic own-link shop", "")).ok, true);
  await ensureStatsId(owner);
  assert.ok(await setSubscription(owner, { customerId: "cus_OwnLinkAdmit", subscriptionId: "sub_OwnLinkAdmit", active: true, tier: "creator", period: paidPeriod() }));
  return (await storeForEmail(owner))!;
}

const token = "A".repeat(43);
const at = (params: Record<string, string>, query: Record<string, string>) => ({ params: Promise.resolve({ handle: "@" + handle, ...params }), searchParams: Promise.resolve(query) }) as never;
const pages: Record<string, () => Promise<unknown>> = {
  "group purchase": () => GroupPage(at({ group: "grp_0123456789abcdef01234567" }, {})),
  "private podcast": () => PodcastPage(at({ product: "prod00000001" }, { token })),
  "win-back renewal": () => RenewPage(at({ product: "prod00000001" }, { back: token })),
  "purchase move": () => MovePage(at({ product: "prod00000001" }, { token })),
  "list confirmation": () => JoinPage(at({}, { token })),
};

async function render(page: () => Promise<unknown>) {
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch) => { commands.push(...batch); return original(batch); };
  let tree: unknown;
  try { tree = await page(); } catch (error) { tree = error; } finally { redis.pipeline = original; }
  return { tree: tree as { type?: unknown } | null, counted: commands.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) };
}

for (const [name, page] of Object.entries(pages)) {
  test(`${name}: an open store counts the page as one of its requests`, async () => {
    await fixture();
    assert.equal((await render(page)).counted, true);
  });
  test(`${name}: with only the public share used it is still drawn, as a buyer's course is`, async () => {
    const store = await fixture();
    assert.equal(await takePublicRequest(store, "buyer", undefined, publicVisitLimit(requestLimitFor(store))), true);
    assert.notEqual((await render(page)).tree?.type, StoreResting);
  });
  test(`${name}: a store whose whole month is used rests`, async () => {
    const store = await fixture();
    assert.equal(await takePublicRequest(store, "buyer", undefined, requestLimitFor(store)), true);
    assert.equal((await render(page)).tree?.type, StoreResting);
  });
}
