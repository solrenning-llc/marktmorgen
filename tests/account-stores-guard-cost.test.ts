/**
 * The account's stores read exactly before a plan is written on a store or ended for it (lib/store.ts keptElsewhere,
 * money HIGH of 15 November 2026) is priced in tests/plan-cost-registry.ts ("account-stores-guard"). This counts the
 * Redis commands of one read for an account at MAX_STORES_PER_ACCOUNT stores, the most it can hold, and holds the
 * line to the formula. Synthetic data, in-memory Redis.
 */
import { MAX_STORES_PER_ACCOUNT, claimHandle, createStore, ensureStatsId, keptElsewhere, storeForEmail } from "@/lib/store";
import { ACCOUNT_STORES_GUARD, ACCOUNT_STORES_GUARD_MONTHLY_USD, COST_LINES, PLATFORM_SUBSCRIPTION_SEARCH } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "guard-cost@example.com";
  await claimHandle(owner, "guardcost0", "Guard cost", "");
  await ensureStatsId(owner);
  for (let n = 1; n < MAX_STORES_PER_ACCOUNT; n += 1) {
    const made = await createStore(owner, `guardcost${n}`, `Guard cost ${n}`, "");
    if (!made.ok) throw new Error(`store ${n}: ${JSON.stringify(made)}`);
  }
  const first = (await storeForEmail(owner))!;

  part("One read at the most stores an account can hold");
  const real = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands += batch.length;
    return real(batch);
  }) as typeof redis.pipeline;
  try {
    await keptElsewhere(first);
  } finally {
    redis.pipeline = real;
  }
  // The GET and SMEMBERS, then one GET for each of the other MAX_STORES_PER_ACCOUNT - 1; the line prices one more.
  is("no more Redis commands than the line prices", [commands, commands <= ACCOUNT_STORES_GUARD.commandsPerRead], [2 + MAX_STORES_PER_ACCOUNT - 1, true]);

  part("The line, the same for every plan, and above zero");
  const line = COST_LINES.find((row) => row.id === "account-stores-guard");
  const expected = ACCOUNT_STORES_GUARD.commandsPerRead * ACCOUNT_STORES_GUARD.usdPerCommand *
    (ACCOUNT_STORES_GUARD.essentialReadsPerEvent * PLATFORM_SUBSCRIPTION_SEARCH.essentialEventsPerWindow +
      ACCOUNT_STORES_GUARD.closingReadsPerEvent * PLATFORM_SUBSCRIPTION_SEARCH.closingEventsPerWindow);
  is("priced at the formula for each plan", (["creator", "pro", "scale"] as const).map((tier) => line?.monthlyUsd(tier)), [expected, expected, expected]);
  is("above zero, and the company's sync reads unknown, never zero", [ACCOUNT_STORES_GUARD_MONTHLY_USD > 0, ACCOUNT_STORES_GUARD.syncCompanyUsd], [true, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
