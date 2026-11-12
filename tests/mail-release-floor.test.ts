/**
 * release (lib/mail.ts) gives back what reserve took for a batch that did not go, never below zero. It used to take
 * the month's and the day's counts down with a bare DECRBY: a give-back that lands on a window that holds less than
 * it (the window turned between the reserve and the release, or the batch was given back twice) left the count
 * negative, and the next batches could send past the plan by that much. GIVE_BACK_FLOOR already does it right for
 * giveBackToMonth (second review on #3384, HIGH). Synthetic only.
 */
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { monthlyAllowance, release } from "@/lib/mail";
import { allowanceWindow } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "release-floor@example.com";
  await claimHandle(owner, "releasefloor", "Release Floor", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_Floor0001", subscriptionId: "sub_Floor0001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await ensureListId(owner))!;
  const allowance = monthlyAllowance(store);
  const window = allowanceWindow(store)!;
  const monthKey = `nl:mail:used:${store.listId}:${window.id}`;
  const dayKey = `nl:mail:day:${new Date().toISOString().slice(0, 10)}`;
  const count = async (key: string): Promise<number | null> => {
    const [value] = (await redis.pipeline([["GET", key]])) as (string | null)[];
    return value === null ? null : Number(value);
  };

  part("A give-back never takes a count below zero");
  is("setup: a paid plan with monthly emails and a window", [allowance > 0, Boolean(window)], [true, true]);
  // What reserve wrote for a batch of 3 (it needs a configured sender, which a test has none of).
  await redis.pipeline([["SET", monthKey, "3"], ["SET", dayKey, "3"]]);
  await release(store, 3);
  is("control: what was reserved is given back exactly", [await count(monthKey), await count(dayKey)], [0, 0]);
  await release(store, 5);
  const month = await count(monthKey);
  const day = await count(dayKey);
  is("a give-back larger than what the month holds leaves it at zero, not below", month === null || month >= 0, true);
  is("and the day's count too", day === null || day >= 0, true);
  await redis.pipeline([["DEL", monthKey]]);
  await release((await storeForEmail(owner))!, 4);
  is("a give-back on a window with no count yet (it turned after the reserve) leaves none", await count(monthKey), null);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
