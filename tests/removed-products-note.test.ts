/**
 * A product noted as removed again keeps its latest removal time (review of #4436: ZADD NX
 * kept the first time), and is noted again even when the list is full; a new one is refused
 * then, and no id is ever dropped to make room (Codex X3 on #4436). Synthetic data only.
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
  is("removed again on a full list: noted", await noteRemovedProduct(STATS, "again1", 900_000), "noted");
  is("a new one on a full list: refused", await noteRemovedProduct(STATS, "last01", 900_001), "full");
  const ids = await removedProductIds(STATS);
  is("the list stays at its most", ids.length, MAX_REMOVED_PRODUCTS);
  is("the one removed again is kept, by its latest removal", ids[0], "again1");
  is("the oldest other one is kept too", ids.includes("p0"), true);
  is("and the refused one is not on it", ids.includes("last01"), false);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
