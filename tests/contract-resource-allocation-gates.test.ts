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
