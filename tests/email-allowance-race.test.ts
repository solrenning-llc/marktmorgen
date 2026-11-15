/**
 * A store's monthly email figure is never passed by emails taken at once (Claude 7's race hunt): takeAllowance counts
 * with INCRBY and compares the count it got back, giving it back when past the figure, so each caller sees its own
 * count. A guard, not a fix: this holds on main and keeps it so. Real MemoryRedis.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { takeAllowance } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

test("more emails at once than the month has left: exactly what is left is taken, the rest refused", async () => {
  redis.clear();
  const OWNER = "owner@mailrace.example";
  await claimHandle(OWNER, "mail-race", "Mail Race", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1MailRaceXXXXXX", true);
  await setSubscription(OWNER, { customerId: "cus_mailrace", subscriptionId: "sub_mailrace", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const first = await takeAllowance(store, "email", 1);
  assert.ok(first.ok, "the first email of the month is taken");
  const left = first.ok ? first.left : 0;
  assert.ok(left > 0);

  const results = await Promise.all(Array.from({ length: left + 10 }, () => takeAllowance(store, "email", 1)));
  assert.equal(results.filter((r) => r.ok).length, left, "exactly the figure left is taken");
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "used"), "the others are refused as used");
  const after = await takeAllowance(store, "email", 1);
  assert.equal(after.ok, false, "and the month stays spent");
});
