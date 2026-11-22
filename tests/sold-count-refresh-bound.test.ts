/**
 * A store's public sold-count refresh (lib/sold-count.ts refreshSoldCounts, started after a store or product page is
 * sent) reads the creator's Stripe account, up to ALL_TIME_PAGES pages, and is priced per attempt (line
 * "sold-count-refresh" in tests/plan-cost-registry.ts). An attempt is bounded to one per store per SOLD_FRESH_MS,
 * whatever its outcome: a read that fails or keeps nothing must not let the next visit, five minutes later, read
 * Stripe again (coordinator 20261122T023645Z-claude-1-coord-0cb0 on #4966).
 *
 * Synthetic data, a stand-in read.
 */
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail, updateLook } from "@/lib/store";
import { DEFAULT_LOOK } from "@/lib/store-look";
import { SOLD_FRESH_MS, SOLD_REFRESH_ATTEMPTS_PER_DAY, refreshSoldCounts } from "@/lib/sold-count";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "sold-bound@example.com";

async function freshStore() {
  redis.clear();
  await claimHandle(OWNER, "soldbound", "Sold Bound", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSoldBound1", true);
  await updateLook(OWNER, { ...DEFAULT_LOOK, sold: true });
  return (await storeForEmail(OWNER))!;
}

async function main(): Promise<void> {
  part("A failed read waits SOLD_FRESH_MS before Stripe is read again");
  {
    const store = await freshStore();
    let reads = 0;
    const failing = async () => {
      reads += 1;
      throw new Error("synthetic Stripe failure");
    };
    const now = 1_800_000_000_000;
    is("the first attempt reads and keeps nothing", [await refreshSoldCounts(store, failing, now), reads], [null, 1]);
    advance(301_000);
    is("a visit five minutes later reads nothing", [await refreshSoldCounts(store, failing, now + 301_000), reads], [null, 1]);
    advance(SOLD_FRESH_MS - 301_000 - 1_000);
    is("nor one just before SOLD_FRESH_MS", [await refreshSoldCounts(store, failing, now + SOLD_FRESH_MS - 1_000), reads], [null, 1]);
    advance(2_000);
    is("after SOLD_FRESH_MS it is read again", [await refreshSoldCounts(store, failing, now + SOLD_FRESH_MS + 1_000), reads], [null, 2]);
  }

  part("A read that answers nothing is bounded the same way");
  {
    const store = await freshStore();
    let reads = 0;
    const empty = async () => {
      reads += 1;
      return null;
    };
    await refreshSoldCounts(store, empty);
    advance(301_000);
    await refreshSoldCounts(store, empty);
    is("one read in five minutes", reads, 1);
  }

  part("The priced number of attempts a day follows SOLD_FRESH_MS");
  is("SOLD_REFRESH_ATTEMPTS_PER_DAY", SOLD_REFRESH_ATTEMPTS_PER_DAY, Math.ceil(86_400_000 / SOLD_FRESH_MS));

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
