/**
 * Whether a store's affiliate page may be drawn, paid for before it reads
 * (4 November 2026, lib/public-read-rules.ts). Until then the page read the
 * whole program's records and the creator's Stripe account on every load
 * of a signed-in affiliate, and counted nothing.
 *
 *   - Somebody not signed in sees the program's terms and the form to apply:
 *     a public page of the store, which rests with the others (isResting) and
 *     takes one more request for each PUBLIC_LISTINGS_PER_UNIT products with
 *     a rate of their own that it reads.
 *   - A signed-in affiliate sees what they already have, their own page, which
 *     rests only once the whole window is used (as a buyer's pages do): the
 *     book is counted first (bookSize, eight commands) and the page takes
 *     affiliatePageUnits of it at once.
 *
 * False means draw the resting page and read nothing more.
 */
import type { Affiliate } from "@/lib/affiliates";
import { bookSize } from "@/lib/affiliates";
import { affiliatePageUnits, listingUnits } from "@/lib/public-read-rules";
import type { Store } from "@/lib/store";
import { isResting, takePublicRequest } from "@/lib/traffic";

/** Listings the page reads: the products with a rate of their own, and a partner's own products. */
export function affiliatePageListings(store: Store, affiliate: Pick<Affiliate, "share"> | null): number {
  return Object.keys(store.affiliates.rates ?? {}).length + (affiliate?.share?.products.length ?? 0);
}

/** The requests an affiliate's own page takes, or null when its book cannot be counted. */
export async function affiliatePageCost(store: Store, affiliate: Pick<Affiliate, "share">): Promise<number | null> {
  const size = await bookSize(store);
  if (!size) return null;
  return affiliatePageUnits({ ...size, listings: affiliatePageListings(store, affiliate) });
}

export async function admitAffiliatePage(store: Store, affiliate: Pick<Affiliate, "share"> | null, now = Date.now()): Promise<boolean> {
  if (!affiliate) {
    if (await isResting(store, now)) return false;
    const extra = listingUnits(affiliatePageListings(store, null));
    return extra === 0 || (await takePublicRequest(store, "public", now, extra));
  }
  const units = await affiliatePageCost(store, affiliate);
  if (units === null) return false;
  return takePublicRequest(store, "buyer", now, units);
}
