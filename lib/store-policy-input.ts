/**
 * What a store's policy facts are built from (617 [SZ1], unit 3,
 * lib/store-policy-facts.ts), read from the store as it is now, so the page
 * changes by itself when a setting does:
 *
 *   - what it sells, from the products it lists (visibleIds: not drafts),
 *     counting only what is paid for: digital content sold once
 *     (deliversDigitally, not a membership) and memberships;
 *   - whether it takes PayPal right now (sellsThroughPayPal);
 *   - the ad pixels switched on, by their platforms' own names (PIXEL_INFO);
 *   - the postal address on its emails, when set.
 */
import type { Store } from "@/lib/store";
import { readListingsAll, visibleIds } from "@/lib/catalog";
import { deliversDigitally } from "@/lib/digital-consent";
import { sellsThroughPayPal } from "@/lib/paypal-sales";
import { PIXEL_INFO, PIXEL_KINDS } from "@/lib/pixels";
import { POLICY_LISTINGS_PER_UNIT } from "@/lib/public-read-rules";
import { takePublicRequest } from "@/lib/traffic";
import type { PolicyFactsInput } from "@/lib/store-policy-facts";

type Sold = { priceCents?: number; recurring?: unknown; pwyw?: unknown; plan?: unknown } & Parameters<typeof deliversDigitally>[0];

/** Whether a product is paid for: a price, a membership, a choose-your-price or a payment plan. */
const paid = (p: Sold) => (p.priceCents ?? 0) > 0 || Boolean(p.recurring) || Boolean(p.pwyw) || Boolean(p.plan);

/** The input from products already read: kept apart so it can be checked without a store. */
export function policyInputFrom(store: Pick<Store, "name" | "pixels" | "mail">, products: readonly Sold[], paypal: boolean): PolicyFactsInput {
  const sold = products.filter(paid);
  return {
    storeName: store.name,
    sellsDigital: sold.some((p) => !p.recurring && deliversDigitally(p)),
    sellsMemberships: sold.some((p) => Boolean(p.recurring)),
    paypal,
    pixels: PIXEL_KINDS.filter((kind) => Boolean(store.pixels?.[kind])).map((kind) => PIXEL_INFO[kind].name),
    postalAddress: store.mail?.address ?? "",
  };
}

/**
 * The public requests the policy page takes for its listings: POLICY_LISTINGS_PER_UNIT each, fewer than the
 * PUBLIC_LISTINGS_PER_UNIT other pages take, because past the catalog head each listing is its own GET, and the
 * page's requests are priced as any public request (laterPageCost) while covering those commands
 * (tests/k-policy-page-units.test.ts; Claude 1's review of #3696 at 1cd1f8a1).
 */
export function policyListingUnits(listings: number): number {
  return Number.isFinite(listings) && listings > 0 ? Math.ceil(listings / POLICY_LISTINGS_PER_UNIT) : 0;
}

/** The input for a store's policy page, read now. */
export async function policyInput(store: Store): Promise<PolicyFactsInput> {
  // No catch, and every listed product read exactly (readListingsAll): a page that could not read one
  // must not quietly leave out the 14-day rules or the subscription terms (Codex G's review of #1824).
  const products = await readListingsAll(store, visibleIds(store));
  return policyInputFrom(store, products as unknown as Sold[], sellsThroughPayPal(store));
}

/**
 * The input for the public page, its listings paid for first (Claude 1's review of #1824): the page is public and
 * reads every visible product's listing, so those reads are taken as the store's own public requests
 * (policyListingUnits, POLICY_LISTINGS_PER_UNIT listings each, held against the reads in tests/k-policy-page-units.test.ts)
 * before any is made, as the collection page and the store's map do. Null when the window refuses them: nothing
 * of the catalog is read, and the page rests.
 */
export async function paidPolicyInput(store: Store): Promise<PolicyFactsInput | null> {
  const units = policyListingUnits(visibleIds(store).length);
  if (units > 0 && !(await takePublicRequest(store, "public", undefined, units))) return null;
  return policyInput(store);
}
