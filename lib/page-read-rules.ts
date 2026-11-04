/**
 * What a collection page costs in the store's own requests, taken before it
 * reads its products (4 November 2026; the inventory of reads with no
 * ceiling, item 17). It was one request whatever it read.
 *
 * Charged as requests of the plan's window (lib/traffic.ts,
 * takePublicRequest), each priced as a later page (tests/traffic-cost.ts,
 * laterPageCost), sized by how many products it shows, known before it
 * reads them. The figure is held against what the reads cost in
 * tests/plan-cost-registry.test.ts.
 */

const MAX_UNITS = 1_000_000;
const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0);

/**
 * A collection page's products past the page's own request: each one's
 * listing, the listings its checkout boxes offer (MAX_BUMPS), the bundles
 * holding it, and its stock and its keys, per request.
 */
export const COLLECTION_PRODUCTS_PER_UNIT = 4;

/** The requests a collection page takes beyond the one its drawing counts (isResting). */
export function collectionUnits(products: number): number {
  return Math.min(MAX_UNITS, whole(products / COLLECTION_PRODUCTS_PER_UNIT));
}
