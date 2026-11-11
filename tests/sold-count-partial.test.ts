/**
 * VR: "Bought N times" (lib/sold-count.ts) says exactly what was counted. A reading of the creator's Stripe sales that
 * stopped before the end (readAllTimeSales, `partial`: past its pages, or a page that did not read) is an undercount, so
 * it is never kept as the count: the page shows the last whole reading, or nothing, never a smaller number as exact.
 */
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail, updateLook } from "@/lib/store";
import { DEFAULT_LOOK } from "@/lib/store-look";
import { readSoldCounts, refreshSoldCounts } from "@/lib/sold-count";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "sold-partial@example.com";
  await claimHandle(owner, "soldpartial", "Sold Partial", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestSoldPart01", true);
  await updateLook(owner, { ...DEFAULT_LOOK, sold: true });
  const store = (await storeForEmail(owner))!;

  part("A whole reading is kept");
  const whole = await refreshSoldCounts(store, async () => ({ byProduct: { p1: { sales: 42 } }, partial: false }));
  is("kept as counted", whole?.byProduct.p1, 42);
  is("and read back", (await readSoldCounts(store))?.byProduct.p1, 42);

  part("A reading that stopped before the end is never kept as the count");
  await redis.run(["DEL", `nl:sold:lock:${store.statsId}`]);
  const partial = await refreshSoldCounts(store, async () => ({ byProduct: { p1: { sales: 12 } }, partial: true }) as never);
  is("not taken as the count", partial, null);
  is("the last whole reading stays", (await readSoldCounts(store))?.byProduct.p1, 42);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
