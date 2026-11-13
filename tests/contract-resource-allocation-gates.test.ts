/**
 * resourceAllocations, part 1b: the takes from the monthly figures that were
 * pending in tests/contract-resource-allocation-inventory.test.ts now prove
 * the paid contract cohort (reservePaidResourceWindow) before they take, for
 * a period marked funded. Here the real functions run against the in-memory
 * Redis with no reviewed policy, so the cohort can never be proved: a funded
 * period is refused with nothing taken, and the rights that are never refused
 * (paying, leaving, exporting the store, a member's own access, switching
 * a discount code off) still pass. An unfunded period is untouched.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { allowanceUsed } from "@/lib/store-allowance";
import { countStudio, holdStudio } from "@/lib/studio-route";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { withinServiceWhy } from "@/lib/metered-limits";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";

beforeEach(() => {
  redis.clear();
});

async function payingStore(handle: string): Promise<Store> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, handle, "");
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "creator", period: paidPeriod() });
  await ensureStatsId(email);
  return (await storeForEmail(email))!;
}
const fundedOf = (store: Store): Store => ({ ...store, period: { ...store.period!, funded: true as const } });

test("studio requests: a funded period without its cohort is refused before the take", async () => {
  const store = await payingStore("gatesstudio");
  const funded = fundedOf(store);
  const counted = await countStudio(funded, null, 3);
  assert.equal(counted.ok, false);
  assert.equal(counted.ok ? "" : counted.reason, "unknown");
  assert.equal((await holdStudio(funded, 3)).ok, false);
  assert.equal(await allowanceUsed(store, "studio"), 0);
});

test("studio requests: paying, leaving, exporting and a member's own access still pass", async () => {
  const funded = fundedOf(await payingStore("gatesessential"));
  for (const need of ["billing", "delete", "export", "member"] as const) assert.equal((await countStudio(funded, need)).ok, true, need);
});

test("studio requests: an unfunded paid period is untouched", async () => {
  const store = await payingStore("gatesplain");
  assert.equal((await countStudio(store, null, 2)).ok, true);
  const held = await holdStudio(store, 3);
  assert.equal(held.ok, true);
  assert.equal(await allowanceUsed(store, "studio"), 5);
});

test("API follow-on units: a funded period without its cohort is refused before the take, a removal is not", async () => {
  const store = await payingStore("gatesapi");
  const funded = fundedOf(store);
  const more = await takeMoreApi(funded, 3);
  assert.ok(more instanceof Response);
  assert.equal(more.status, 429);
  assert.equal(((await more.json()) as { error: string }).error, "unavailable");
  assert.ok((await holdMoreApi(funded, 3)) instanceof Response);
  assert.equal(await allowanceUsed(store, "api"), 0);
  // Switching a discount code off (DELETE /api/v1/codes) is a removal: never refused for the cohort.
  assert.equal(await takeMoreApi(funded, 2, 0, "removal"), null);
  assert.equal(await allowanceUsed(store, "api"), 2);
});

test("API follow-on units: an unfunded paid period is untouched", async () => {
  const store = await payingStore("gatesapiplain");
  assert.equal(await takeMoreApi(store, 2), null);
  assert.equal(typeof (await holdMoreApi(store, 3)), "function");
  assert.equal(await allowanceUsed(store, "api"), 5);
});

test("calls to connected services: a funded period without its cohort is refused before the take", async () => {
  const store = await payingStore("gatesservice");
  const refused = await withinServiceWhy("gates-test", "who", 5, 60, fundedOf(store));
  assert.equal(refused?.reason, "unknown");
  assert.equal(await allowanceUsed(store, "integration"), 0);
  assert.equal(await withinServiceWhy("gates-test", "plain", 5, 60, store), null);
  assert.equal(await allowanceUsed(store, "integration"), 1);
});
