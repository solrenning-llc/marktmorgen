/**
 * Giving back an allowance never makes a counter below zero with no expiry.
 *
 * giveAllowance sent a bare DECRBY to the window's counter. A counter that was not there any more (it ran out at its
 * expiry, or was erased with the store, between the take and the give-back) was made again at -n, with no expiry: the
 * store got n more uses of that window than its plan has, and the key was kept for ever (Claude 7, Redis race hunt).
 * giveAllowanceIn already guarded this; giveAllowance now gives back through it, so a missing counter is never made
 * below zero, and one that falls below zero is brought back to zero with an expiry.
 */
import { allowanceUsed, giveAllowance, takeAllowance } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const owner = {
  sid: "7".repeat(32),
  handle: "givebackmissing",
  statsId: null,
  tier: "creator" as const,
  cycle: "month" as const,
  subscriptionId: "sub_GiveBackMissing01",
  subscriptionActive: true,
  trialEnds: 0,
  planEndedAt: "",
  period: paidPeriod(),
};
const counters = () => redis.keys().filter((k) => k.startsWith("nl:allow:studio:"));

async function main(): Promise<void> {
  redis.clear();
  // Taken, then the counter is gone before the give-back (its expiry, or the store erased).
  is("taken", (await takeAllowance(owner, "studio", 3)).ok, true);
  const [counter] = counters();
  await redis.pipeline([["DEL", counter]]);
  await giveAllowance(owner, "studio", 3);
  const [value, ttl] = await redis.pipeline([["GET", counter], ["TTL", counter]]);
  is("a missing counter is not made below zero", value === null || Number(value) >= 0, true);
  is("nor kept with no expiry", value === null || Number(ttl) > 0, true);
  is("the figure shows nothing used, never more than the plan has", await allowanceUsed(owner, "studio"), 0);

  // The ordinary give-back still gives back what was taken.
  redis.clear();
  await takeAllowance(owner, "studio", 5);
  await giveAllowance(owner, "studio", 2);
  is("an ordinary give-back still gives back", await allowanceUsed(owner, "studio"), 3);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
