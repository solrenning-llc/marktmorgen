/**
 * A give-back never leaves a window's counter below zero, not even between two
 * round trips (Codex V on #4072 @8baa4a796e, ALTO). giveAllowanceIn sent DECRBY,
 * read a negative answer and repaired it with INCRBY in a second round trip; in
 * between, a take running at the same time read the negative counter and admitted
 * up to n more than the plan has. Now the give-back is one script: a missing
 * counter is left missing, and one that would fall below zero stops at zero,
 * keeping its expiry. Synthetic data only.
 */
import { allowanceUsed, giveAllowance, giveAllowanceIn, takeAllowance } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = {
  sid: "8".repeat(32),
  handle: "givebackatomic",
  statsId: null,
  tier: "creator" as const,
  cycle: "month" as const,
  subscriptionId: "sub_GiveBackAtomic01",
  subscriptionActive: true,
  trialEnds: 0,
  planEndedAt: "",
  period: paidPeriod(),
};
const counters = () => redis.keys().filter((k) => k.startsWith("nl:allow:studio:"));
type Pipeline = typeof redis.pipeline;
const real = redis.pipeline.bind(redis) as Pipeline;

/** Runs `give` and answers the lowest value the counter held after any round trip it made. */
async function lowestSeen(counter: string, give: () => Promise<void>): Promise<number | null> {
  let lowest: number | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    const [value] = await real([["GET", counter]]);
    if (value !== null) lowest = Math.min(lowest ?? Infinity, Number(value));
    return replies;
  }) as Pipeline;
  try {
    await give();
  } finally {
    redis.pipeline = real;
  }
  return lowest;
}

async function main(): Promise<void> {
  part("A counter gone before the give-back");
  redis.clear();
  is("taken", (await takeAllowance(owner, "studio", 3)).ok, true);
  const [counter] = counters();
  await redis.pipeline([["DEL", counter]]);
  const seen = await lowestSeen(counter, () => giveAllowance(owner, "studio", 3));
  is("is never below zero between round trips", seen === null || seen >= 0, true);
  const [value, ttl] = await redis.pipeline([["GET", counter], ["TTL", counter]]);
  is("and is not made again with no expiry", value === null || Number(ttl) > 0, true);
  is("the figure shows nothing used", await allowanceUsed(owner, "studio"), 0);

  part("A counter lower than what is given back");
  redis.clear();
  await takeAllowance(owner, "studio", 2);
  const [lower] = counters();
  const [ttlBefore] = await redis.pipeline([["TTL", lower]]);
  const window = lower.split(":").pop()!;
  const seenLower = await lowestSeen(lower, () => giveAllowanceIn(owner, "studio", 5, window));
  is("is never below zero between round trips", seenLower === null || seenLower >= 0, true);
  const [after, ttlAfter] = await redis.pipeline([["GET", lower], ["TTL", lower]]);
  is("stops at zero", Number(after), 0);
  is("keeping its expiry", Number(ttlAfter) > 0 && Number(ttlAfter) <= Number(ttlBefore), true);

  part("An ordinary give-back");
  redis.clear();
  await takeAllowance(owner, "studio", 5);
  await giveAllowance(owner, "studio", 2);
  is("still gives back exactly", await allowanceUsed(owner, "studio"), 3);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
