/**
 * What the ad check (lib/ad-creative-check.ts, checkAdText) needs to know
 * about a product, read on the server from the store's own records: 632
 * [AA2] (m), unit 3. Nothing here comes from the request, so an ad can never
 * pass the check by claiming a sale, a stock limit or a review it does not
 * have.
 *
 *   - priceCents: the one price a buyer pays today, sale included; null when
 *     the product is free or its options have different prices, so an ad
 *     that names a price is refused rather than matched against a guess.
 *   - ownHosts: the creator's own domain while it is live and their plan
 *     allows it (Marktmorgen's own hosts are added by the check itself).
 *   - realDeadline: a store sale with a real end date is taking money off
 *     this product now.
 *   - realStockLimit: the creator set a limited quantity on it.
 *   - verifiedReviews: the words of the product's visible reviews, each from
 *     a real order, never hidden or refunded; at most AD_REVIEWS of them.
 */
import type { AdContext } from "@/lib/ad-creative-check";
import { canUseDomain } from "@/lib/domains";
import { limitedStock } from "@/lib/product-extras";
import { visibleReviews } from "@/lib/reviews";
import { type Listing, type Store, isFree } from "@/lib/store";
import { sellableOptions } from "@/lib/store-checkout";
import { saleClock, saleOff, salePrice } from "@/lib/store-sale";

/** The most reviews read for one check: an ad quotes one, and the newest are the ones a creator picks from. */
export const AD_REVIEWS = 50;

/**
 * The most one review record weighs as read (lib/review-summary.ts Review at every field's longest, three bytes a
 * character): held by tests/ad-context-cost.test.ts against a review written at its longest.
 */
export const AD_REVIEW_BYTES = 8_000;

/** What one studio request covers of what the database moves (UNIT_COST.studio in tests/plan-cost-registry.ts; held by the same test). */
export const STUDIO_REQUEST_BYTES = 50_000;

/**
 * The studio requests a check of an ad's words takes besides the request that asks for it, before anything is read:
 * its reviews at their heaviest (Claude 5 on #1950). A check reads them all, so it is counted at all of them.
 */
export const AD_CONTEXT_UNITS = Math.ceil((AD_REVIEWS * AD_REVIEW_BYTES) / STUDIO_REQUEST_BYTES);

/** The studio requests reading a product's page of `bytes` takes, besides the request that asks for it (Claude 5 on #1950). */
export function pageReadUnits(bytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / STUDIO_REQUEST_BYTES) : 0;
}

type Facts = Pick<Store, "currency" | "domain" | "sale" | "subscriptionActive" | "tier">;

/** The price a buyer pays today, sale included, or null when there is no single one. Pure. */
export function adPriceCents(store: Pick<Store, "sale">, product: Listing, nowSeconds: number): number | null {
  if (isFree(product)) return null;
  const options = sellableOptions(product);
  const prices = new Set(options.length ? options.map((option) => option.priceCents) : [product.priceCents]);
  if (prices.size !== 1) return null;
  const [cents] = [...prices];
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return salePrice(cents, saleOff(store.sale, product, nowSeconds));
}

/** Everything but the reviews, from the store's record alone. Pure. */
export function adFacts(store: Facts, product: Listing, nowSeconds: number): Omit<AdContext, "verifiedReviews"> {
  const sale = store.sale;
  const domain = store.domain?.liveAt && canUseDomain(store) ? store.domain.name.replace(/^www\./, "").toLowerCase() : "";
  return {
    priceCents: adPriceCents(store, product, nowSeconds),
    currency: store.currency,
    ownHosts: domain ? [domain] : [],
    // A running sale always has a real end (lib/store-sale.ts, saleRunning).
    realDeadline: saleOff(sale, product, nowSeconds) > 0,
    realStockLimit: limitedStock(product) !== null,
  };
}

/** The ad check's context for a product of this store. A review that cannot be read counts as none: the check then refuses a quote rather than passing it. */
export async function adContext(store: Facts & Pick<Store, "statsId">, product: Listing, nowSeconds = saleClock()): Promise<AdContext> {
  const reviews = await visibleReviews(store.statsId, product.id, 0, AD_REVIEWS).catch(() => []);
  return {
    ...adFacts(store, product, nowSeconds),
    verifiedReviews: reviews.filter((review) => !review.hidden && !review.refunded && review.text.trim()).map((review) => review.text),
  };
}
