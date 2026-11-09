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

/**
 * A bundle's items a collection page reads to show what each bundle on it
 * holds (lib/bundles.ts, offeredItems), per request: each one's listing. A
 * bundle holds up to MAX_BUNDLE_ITEMS (lib/bundle-rules.ts), so they are
 * counted once the page knows them and paid for before they are read
 * (Codex G2 on #2583, 5 November 2026).
 */
export const BUNDLE_ITEMS_PER_UNIT = 16;

/** The requests a collection page takes for the bundle items it reads, beyond collectionUnits. */
export function bundleItemUnits(items: number): number {
  return Math.min(MAX_UNITS, whole(items / BUNDLE_ITEMS_PER_UNIT));
}

/**
 * The forms a store's own page asks (app/[handle]/[slug], formsOf), per
 * request: one read of each, a whole form with its fields, choices and
 * results. A page may ask every form the store has (MAX_FORMS, lib/forms.ts),
 * more than a later page's commands hold, so they are counted once its
 * blocks say how many and paid for before the first is read (review of
 * #3331, siblings of R20 finding 3).
 */
export const SITE_PAGE_FORMS_PER_UNIT = 8;

/** The requests a store's own page takes for the forms it asks, beyond the one its drawing counts (isResting). */
export function siteFormUnits(forms: number): number {
  return Math.min(MAX_UNITS, whole(forms / SITE_PAGE_FORMS_PER_UNIT));
}
