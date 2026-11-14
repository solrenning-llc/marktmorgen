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
 *   - the postal address on its emails, when set and the creator chose to show it there too.
 */
import type { Store } from "@/lib/store";
import { type Listing, readListingsAll, visibleIds } from "@/lib/catalog";
import { deliversDigitally } from "@/lib/digital-consent";
import { sellsThroughPayPal } from "@/lib/paypal-sales";
import { PIXEL_INFO, PIXEL_KINDS } from "@/lib/pixels";
import type { PolicyFactsInput } from "@/lib/store-policy-facts";
import { takePublicRequest } from "@/lib/traffic";
import { bundleItemUnits } from "@/lib/page-read-rules";
import { canManage } from "@/lib/membership-manage";

/**
 * The fields the policy reads, each named as Listing's own (Pick fails to compile on a name Listing does not have),
 * so a rename or removal there cannot quietly drop a policy section (Codex T's LOW on #1824).
 */
type Read = keyof Pick<Listing, "priceCents" | "recurring" | "pwyw" | "plan" | keyof Parameters<typeof deliversDigitally>[0]>;
type Sold = { priceCents?: number } & Partial<Record<Exclude<Read, "priceCents">, unknown>> & Parameters<typeof deliversDigitally>[0];

/** Whether a product is paid for: a price, a membership, a choose-your-price or a payment plan. */
const paid = (p: Sold) => (p.priceCents ?? 0) > 0 || Boolean(p.recurring) || Boolean(p.pwyw) || Boolean(p.plan);

/** The input from products already read: kept apart so it can be checked without a store. */
export function policyInputFrom(store: Pick<Store, "name" | "pixels" | "mail">, products: readonly Sold[], paypal: boolean, selfCancel = false): PolicyFactsInput {
  const sold = products.filter(paid);
  return {
    storeName: store.name,
    sellsDigital: sold.some((p) => !p.recurring && deliversDigitally(p)),
    sellsMemberships: sold.some((p) => Boolean(p.recurring)),
    paypal,
    pixels: PIXEL_KINDS.filter((kind) => Boolean(store.pixels?.[kind])).map((kind) => PIXEL_INFO[kind].name),
    // Only by the creator's own choice where the address is typed: the email footer's address is never public by default (#1824).
    postalAddress: store.mail?.onPolicies === true ? store.mail.address : "",
    membersSelfCancel: selfCancel,
  };
}

/** The input for a store's policy page, read now. */
export async function policyInput(store: Store): Promise<PolicyFactsInput> {
  // No catch, and every listed product read exactly (readListingsAll): a page that could not read one
  // must not quietly leave out the 14-day rules or the subscription terms (Codex G's review of #1824).
  const products = await readListingsAll(store, visibleIds(store));
  // The same check the purchase email makes before it sends the /manage link (lib/purchase-email.ts).
  return policyInputFrom(store, products, sellsThroughPayPal(store), canManage(store));
}

/**
 * The input for the public policy page, its reads paid for first (Claude 1 on #1824, owner's rule MR): every visible
 * product's listing is read, one listing a product, as a bundle's items are (bundleItemUnits, held over their cost in
 * tests/store-policy-paid-read.test.ts for every catalog size), so they are taken from the store's public requests
 * before any is read. "resting" when they are refused: nothing is read, and the page shows the resting page.
 */
export async function policyInputPaid(store: Store): Promise<PolicyFactsInput | "resting"> {
  const listed = visibleIds(store).length;
  if (listed > 0 && !(await takePublicRequest(store, "public", undefined, bundleItemUnits(listed)))) return "resting";
  return policyInput(store);
}
