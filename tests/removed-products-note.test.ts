/**
 * A product noted as removed again keeps its latest removal time, so the trimming to
 * the newest MAX_REMOVED_PRODUCTS never drops it before products removed earlier
 * (review of #4436: ZADD NX kept the first time). Synthetic data only.
 */
import { MAX_REMOVED_PRODUCTS, noteRemovedProduct, removedProductIds } from "@/lib/removed-products";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "r".repeat(16);

async function main(): Promise<void> {
  redis.clear();
  await noteRemovedProduct(STATS, "again1", 1_000);
  for (let i = 0; i < MAX_REMOVED_PRODUCTS - 1; i += 1) await noteRemovedProduct(STATS, `p${i}`, 2_000 + i);
  // Back in the catalog and removed again: its time is now the newest.
  await noteRemovedProduct(STATS, "again1", 900_000);
  await noteRemovedProduct(STATS, "last01", 900_001);
  const ids = await removedProductIds(STATS);
  is("the list stays at its most", ids.length, MAX_REMOVED_PRODUCTS);
  is("the one removed again is kept, by its latest removal", ids.includes("again1"), true);
  is("the oldest other one went instead", ids.includes("p0"), false);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
