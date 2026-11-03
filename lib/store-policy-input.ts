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
import { readListings, visibleIds } from "@/lib/catalog";
import { deliversDigitally } from "@/lib/digital-consent";
import { sellsThroughPayPal } from "@/lib/paypal-sales";
import { PIXEL_INFO, PIXEL_KINDS } from "@/lib/pixels";
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

/** The input for a store's policy page, read now. */
export async function policyInput(store: Store): Promise<PolicyFactsInput> {
  // No catch: a page that could not read the products must not quietly leave out the 14-day rules.
  const products = await readListings(store, visibleIds(store));
  return policyInputFrom(store, products as unknown as Sold[], sellsThroughPayPal(store));
}
