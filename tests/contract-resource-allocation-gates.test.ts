/**
 * resourceAllocations, part 1b: the takes from the monthly figures that were
 * pending in tests/contract-resource-allocation-inventory.test.ts now prove
 * the paid contract cohort (reservePaidResourceWindow) before they take, for
 * a period marked funded. Here the real functions run against the in-memory
 * Redis with no reviewed policy, so the cohort can never be proved: a funded
 * period is refused with nothing taken, and a removal (switching a discount
 * code off) still passes. An unfunded period is untouched.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { allowanceUsed } from "@/lib/store-allowance";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { withinServiceWhy } from "@/lib/metered-limits";
import { countUnits } from "@/lib/person-agenda-read";
import { chargeStudio } from "@/lib/path";
import { takeAnswer } from "@/lib/answers";
import { windowId } from "@/lib/allowance-window";
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

// The generic studio door (countStudio, holdStudio) is not gated here: it also serves removal and disconnection,
// and gating it refused Discord role removal and disconnect (tests/discord.test.ts). Its new-work callers gate themselves.

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

test("studio readings behind the door: a funded period without its cohort reads nothing and takes nothing", async () => {
  const store = await payingStore("gatesreadings");
  const funded = fundedOf(store);
  const counted = await countUnits(funded, 3);
  assert.equal(counted.ok, false);
  assert.equal(counted.ok ? "" : counted.reason, "unknown");
  assert.equal(await chargeStudio(funded)(3), false);
  assert.equal(await allowanceUsed(store, "studio"), 0);
  assert.equal((await countUnits(store, 2)).ok, true);
  assert.equal(await chargeStudio(store)(1), true);
  assert.equal(await allowanceUsed(store, "studio"), 3);
});

test("AI answers and the store guide: a funded period without its cohort takes no answer", async () => {
  const store = await payingStore("gatesanswers");
  const key = `nl:ask:${store.statsId}:${windowId(store, Date.now())}`;
  assert.equal(await takeAnswer(fundedOf(store)), false);
  assert.deepEqual(await redis.pipeline([["GET", key]]), [null]);
  // An unfunded period reaches the month's count (given back at once when its plan has no answers).
  await takeAnswer(store);
  assert.notDeepEqual(await redis.pipeline([["GET", key]]), [null]);
});
